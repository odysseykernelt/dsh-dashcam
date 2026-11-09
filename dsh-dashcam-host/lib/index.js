/**
 * dsh-dashcam-host —— 把 dsh-dashcam 的判定链接入 DeepSeek Harness（cordis 宿主）。
 *
 * 接线（2026-11-06 实跑验证后修正）：
 *  - DSH 工具拦截点只有 `tools/pre-execute`（waterfall，签名 `async (exec, next)`）：
 *    放行必须 `return next()`，拦截 `return { kind: 'deny', reason }`。
 *    旧版监听 'pre-execute'——该事件在 DSH 里不存在（asar 内出现 0 次），
 *    判定链从未被调用过，账本恒为空。
 *  - 映射层：DSH tool exec → dashcam capability。见工具集合与 mapToolRequests。
 *    一次工具调用可展开为**多条**判定请求（copy=读源+写目标、move=读+删源+写目标、
 *    ops_batch 逐条展开 operations[]、ops_read_files 逐 path）。
 *  - 定位边界（重要）：工具的真实执行在子进程/工具层，本判定链是**入口策略门**
 *    （拦命令/拦路径参数），不覆盖工具执行后的真实副作用；进程内 Node 调用
 *    由 patchBuiltins 的 Bridge 看护（默认关闭，见下）。
 *
 * 模式（与 dsh-dashcam 设计讨论的「先观测后收紧」路线一致）：
 *  - 默认 advisory：映射到的调用照常走 guard.check 记账（含 deny 落账），但放行——
 *    账本先积累「插件实际在碰什么」的事实，供后续 suggest / 增量授权。
 *  - `enforce: true`：判定不允许即拦截（{ kind: 'deny' }）。此时需在 config.grants
 *    里授予对应能力（Two-Key：声明在 MANIFEST，钥匙在 grants）。
 *    无法判定目标的调用（如 batch 缺 operations[]、glob 缺搜索基目录）按 fail-closed
 *    拒绝，且拒绝前必落 deny 账（F2：审计先于执行）。
 *  - enforce 默认只覆盖映射表；`enforceUnmapped: true` 才把未映射工具也纳入总闸（F6）。
 *
 * 1.10.12 复核修复（F1–F6）：目录语义判定对象转子树形态 dir/**（F3，SPEC 的
 * `dir/**` 不含 dir 本身语义不变）；命令行存档默认 hash-only（F4，full 需显式
 * 开启且打码）；存档 decision 随处置改写（F5）；MAC 在 v2 历史账本上启用会被
 * 防呆拦截并给出迁移路径（F1）。详见宿主 README。
 *
 * 设计取舍：默认 `patchBuiltins = false`。宿主是 Electron 主进程，Bridge 是进程级补丁，
 * 一装就会接管应用自身的 fs/net。需要真实拦截时，在 cordis 配置里显式 `patchBuiltins: true`。
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, statSync, existsSync, appendFileSync, mkdirSync, renameSync } from 'node:fs';
import { attachIngress } from './ingress.js';
import { registerPanelRoutes } from './panel.js';

const require = createRequire(import.meta.url);
const dashcam = require('../../src/index.js');
// manifestHash 要与守卫链同源同算法：同一段声明清单、同一个稳定序列化函数，
// 两处算出的哈希才可比（对账本时能对出「当时声明了什么」）。
const { stableStringify, sha256 } = require('../../src/util/stable.js');
// 零契约记录的凭证升级与 deriveOperation 同源：读到 id_rsa/.npmrc 这类路径时
// capability 升级为 cred.read——零契约只是不判定，不降低记录口径。
const { credentialCapabilityForPath } = require('../../src/contract/capabilities.js');

export const name = 'dsh-dashcam-host';
export const inject = [];

const PLUGIN_VERSION = '1.14.0';

const MANIFEST = {
  id: 'dsh-dashcam-host',
  name: 'dsh-dashcam-host',
  version: PLUGIN_VERSION,
  entry: 'lib/index.js',
  dashcam: {
    spec: 'dsh-dashcam/1',
    capabilities: { requests: [] },
    content: {
      rating: 'general',
      scenes: ['host'],
      commercialUse: 'allowed',
      sourceFingerprint: `sha256:${'0'.repeat(64)}`,
      enterpriseExcluded: false,
    },
  },
};

// ── 映射层：DSH tool exec → dashcam capability ────────────────────
// 口径保守：只映射确知名字与参数形状的工具；未列入表的工具直接放行，
// 但走「未映射遥测」（console 点名 + 账本 telemetry 记录，同名只记一次），
// 让覆盖缺口可见、可补——否则 shell 主力通道换了名字（如 dsh-ops 的 ops_bash）
// 就会静默绕过账本，「先观测后收紧」的底账不完整。
//
// dsh-ops（TOOL_PREFIX='ops_'）把工具公开名统一加前缀：ops_bash / ops_read_files /
// ops_glob / ops_grep / ops_write_file / ops_edit_file / ops_replace / ops_copy /
// ops_move / ops_remove / ops_stat / ops_diff / ops_read_table / ops_read_docx /
// ops_read_pdf / ops_inspect_local_file / ops_discover_tools / ops_result / ops_batch。
// 映射按「剥掉 ops_ 前缀的裸名」进行，避免逐个枚举前缀组合。

/** shell 系：arguments.command 是整条命令行 → proc.spawn（判定口径=首词）。 */
const SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd']);
/** 读文件系：arguments 里的路径字段 → fs.read。glob/grep/stat/diff 只读不写，一并按 fs.read 记账。 */
const READ_TOOLS = new Set([
  'read_file', 'read', 'read_files', 'read_table', 'read_docx', 'read_pdf',
  'read_image', 'inspect_local_file', 'stat', 'diff', 'glob', 'grep',
]);
/** 写/改文件系：→ fs.write（dryRun:true 时降级为 fs.read）。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'write', 'edit', 'replace']);
/** 删除系：→ fs.delete（破坏性落盘，1.10.11 起不再伪装成 fs.write）。 */
const DELETE_TOOLS = new Set(['remove']);
/** 复制系：读源 + 写目标（源不再记 fs.write——复制不改写源文件）。 */
const COPY_TOOLS = new Set(['copy']);
/** 移动系：读源 + 删源 + 写目标（跨盘 move = copy+unlink，同盘 rename 不读内容；
 *  三项全记是保守口径：enforce 下少授 fs.read 会被拒，fail-closed 可接受）。 */
const MOVE_TOOLS = new Set(['move']);
/** 批量操作系：operations[] 逐条展开为 copy/move/remove。 */
const BATCH_TOOLS = new Set(['batch']);
/** 出网系：arguments.url → net.outbound。 */
const FETCH_TOOLS = new Set(['web_fetch', 'fetch']);
/** 已知无副作用的工具（能力发现、结果引用释放）：不映射也不遥测，避免噪音。 */
const NOOP_TOOLS = new Set(['discover_tools', 'result']);

/** 批量展开的单次上限（dsh-ops 原生 worker 上限 512，超出直接视为无法判定）。 */
const MAX_BATCH_OPERATIONS = 512;
/** 完整命令行存档的截断长度（full 模式打码文本的截断上限）。 */
const COMMANDLINE_ARCHIVE_LIMIT = 1024;
/**
 * L4：目录探测的进程级缓存（带 TTL）。fsScopePath/判断目录需要同步 stat，
 * 每次工具调用都探测会在主线程做 IO（网络盘会阻塞）；缓存把重复探测压到
 * 每 path 每 TTL 一次。判定与执行之间的 TOCTOU 依然存在（已知边界，README 有注）。
 *
 * R1（1.10.13 复核）：**只缓存正结果（isDir=true）**。负缓存（file→dir）会在
 * 「先删文件、30s 内换成目录再删」的窗口里让 deleteRequests 跳过子树判定，
 * 绕过 M1——那是 fail-open。正缓存方向相反：目录被换成文件后仍多判一条
 * 子树，是 fail-closed，可接受。负结果每次 fresh 探测。
 */
const DIRECTORY_PROBE_TTL_MS = 30_000;
const directoryProbeCache = new Map();

/** L4：探测某路径当前是否为目录（正结果 30s TTL 缓存；异常一律按「非目录」处理且不缓存）。 */
function pathIsDirectory(pathValue) {
  const key = String(pathValue);
  const now = Date.now();
  const cached = directoryProbeCache.get(key);
  if (cached && now - cached.at < DIRECTORY_PROBE_TTL_MS) return true; // 正结果才有缓存
  let isDir = false;
  try {
    isDir = existsSync(key) && statSync(key).isDirectory();
  } catch {
    isDir = false; // 探测失败（权限/竞态删除）按非目录处理：保留原路径，fail-closed
  }
  if (isDir) directoryProbeCache.set(key, { at: now, isDir: true });
  else directoryProbeCache.delete(key); // 负结果不缓存：R1，防 30s 窗口绕过 M1
  return isDir;
}

/** L2：allowlist 匹配——全名或前缀通配（mcp__* / memory_*），大小写不敏感。 */
function matchesAllowlist(name, allowlist) {
  const lowered = String(name).toLowerCase();
  return allowlist.some((entry) => {
    const pattern = String(entry).toLowerCase();
    if (pattern.endsWith('*')) return lowered.startsWith(pattern.slice(0, -1));
    return lowered === pattern;
  });
}

/** DSH 的 exec.arguments 是工具参数 JSON（实测为对象；容错 JSON 字符串写法）。 */
function normalizeArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

function firstString(args, keys) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** ops_read_files 的 files:[{ path, offset, limit }] 数组形态：取全部 path（P4：逐个判定）。 */
function pathsFromFiles(args) {
  const files = args.files;
  if (!Array.isArray(files)) return [];
  return files
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item)
      && typeof item.path === 'string' && item.path.length > 0)
    .map((item) => item.path);
}

/**
 * 命令判定口径 = 首词（与 dashcam Bridge 的 firstCommand 同型，含引号形态）。
 * 工具级入口门与进程内 Bridge 必须同一把尺子，否则账本口径漂移。
 * 完整命令行（含 `cd X && rm -f …` 的后续部分）另存存档记录（见 commandlineArchive）。
 */
function firstCommandWord(command) {
  const trimmed = command.trim();
  const matched = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return matched ? (matched[1] || matched[2] || matched[3]) : trimmed;
}

/**
 * F3：目录作为判定对象时的 scope 形态修正。
 *
 * SPEC 语义（docs/SPEC.md 77）：授权 `dir/**` 只覆盖 `dir/` 之下，不覆盖 `dir` 本身。
 * 但 glob/grep/replace/stat/copy 这些工具的 path 语义就是「扫/写这个子树」——真实
 * 触达的是 dir 之下的内容。按裸 dir 判定会与 `dir/**` 授权错配（F3 实测整片误拒）。
 *
 * 修正：**只读/子树写**语义的判定对象若实测是目录，改用子树形态 `dir/**`。
 * **破坏性操作（remove/move 源）例外**——见 deleteRequests（M1）：删的是目录节点
 * 本身，节点必须按节点判，不能被子树授权放大。
 * 注意：`patchBuiltins: true` 时探测本身会过 Bridge（多一条 fs.read 记录），
 * 见 README「与 Bridge 叠加」一节。
 */
function fsScopePath(pathValue) {
  return pathIsDirectory(pathValue)
    ? `${String(pathValue).replace(/\\/g, '/').replace(/\/+$/, '')}/**`
    : pathValue;
}

/**
 * M1（1.10.12 复核）：破坏性删除的判定请求组。
 *
 * `remove(目录)` / `move(目录, …)` 删掉的是**节点本身 + 整棵子树**。若按 F3 只转成
 * `dir/**`，仅授 `dir/**` 时会放行——与 SPEC「`dir/**` 不含 dir 本身」矛盾，等于把
 * 目录节点的删除权塞进了子树授权（复核实测越权）。修正：目录删除 = 节点判定
 * （fs.delete{dir}，需要显式授权 dir 本身）**加**子树判定（fs.delete{dir/**}），
 * enforce 下两条都要过；文件删除维持单条 fs.delete{path}。
 */
function deleteRequests(pathValue) {
  const requests = [{ operation: 'fs.delete', payload: { path: pathValue } }];
  if (pathIsDirectory(pathValue)) {
    requests.push({ operation: 'fs.delete', payload: { path: fsScopePath(pathValue) } });
  }
  return requests;
}

/**
 * F4：命令行里的敏感串打码（best-effort，配合默认 hash-only 使用）。
 * MAC 只防篡改不加密，账本是普通文件——Authorization/Bearer、sk-/ghp-/xox 系
 * token、password/token= 赋值一律替换成 ***。要全文存档必须显式
 * `commandlineArchive: 'full'`（且接受打码后仍可能漏的残余风险）。
 */
function maskSecrets(text) {
  return String(text)
    .replace(/((?:authorization|proxy-authorization)["'=:\s]*bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/((?:--)?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|passphrase)["'=:\s]+)[^\s"'&]+/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '***');
}

/**
 * batch 操作展开（dsh-ops PTC batch：op ∈ {copy, move, remove}，path 必填，copy/move 带 to）。
 * 与单工具同口径：copy=读源+写目标，move=读源+删源+写目标，remove=删源；
 * 目录语义的 path/to 经 fsScopePath 转子树形态（F3 同规则）；
 * 删除走 deleteRequests（M1：目录节点 + 子树两条都判）。
 */
function expandBatchOperation(op) {
  if (!op || typeof op !== 'object') return null;
  const { op: kind, path, to } = op;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (kind === 'copy') {
    if (typeof to !== 'string' || to.length === 0) return null;
    return [
      { operation: 'fs.read', payload: { path: fsScopePath(path) } },
      { operation: 'fs.write', payload: { path: fsScopePath(to) } },
    ];
  }
  if (kind === 'move') {
    if (typeof to !== 'string' || to.length === 0) return null;
    return [
      { operation: 'fs.read', payload: { path: fsScopePath(path) } },
      ...deleteRequests(path),
      { operation: 'fs.write', payload: { path: fsScopePath(to) } },
    ];
  }
  if (kind === 'remove') {
    return deleteRequests(path);
  }
  return null;
}

/**
 * 把一次 DSH 工具调用映射成 dashcam 判定请求；映射不了返回 null（放行 + 遥测）。
 *
 * options（L2：per-挂载配置，随调用传入，不再用模块级可变状态）：
 *   commandlineArchive: 'hash' | 'full' —— 命令行存档模式。
 *
 * 返回形状：
 *   null                          —— 完全未映射（遥测 unmapped-tool）
 *   { requests, aux, unjudgeable } —— requests: guard.check 逐条判定并记账；
 *                                    aux: 直接落账本的附加记录（命令行存档 / 遥测）；
 *                                    unjudgeable: 无法判定目标的说明文本——
 *                                    advisory 下只落遥测放行，enforce 下 fail-closed 拒绝。
 */
function mapToolRequests(exec, options = {}) {
  const commandlineArchiveMode = options.commandlineArchive === 'full' ? 'full' : 'hash';
  if (!exec || typeof exec.name !== 'string') return null;
  const name = exec.name.toLowerCase();
  // dsh-ops 公开名带 ops_ 前缀：剥掉后按裸名匹配（ops_bash → bash）。
  const bare = name.startsWith('ops_') ? name.slice(4) : name;
  const args = normalizeArguments(exec.arguments);
  const requests = [];
  const aux = [];

  if (SHELL_TOOLS.has(bare)) {
    const command = firstString(args, ['command', 'cmd']);
    // pwsh 的 command 里常见 `bash -c "…"` 套娃：入口门判的是首词（与 Bridge
    // 同口径），套娃内部的副作用不在覆盖范围（见文件头「定位边界」）。
    if (command) {
      requests.push({ operation: 'proc.spawn', payload: { command: firstCommandWord(command) } });
      // P6/F4：判定只认首词，但账本要能对出整条命令——默认 hash-only
      //（sha256 + 长度，可离线对账不含明文）；显式 commandlineArchive:'full'
      // 才落打码后的文本。decision 由调用结果决定（F5：被拒不记 allow）。
      const trimmed = command.trim();
      if (trimmed !== firstCommandWord(command)) {
        const hash = `sha256:${createHash('sha256').update(trimmed, 'utf8').digest('hex')}`;
        const truncated = trimmed.length > COMMANDLINE_ARCHIVE_LIMIT;
        const scope = commandlineArchiveMode === 'full'
          ? {
            commandLine: maskSecrets(truncated ? trimmed.slice(0, COMMANDLINE_ARCHIVE_LIMIT) : trimmed),
            commandLineTruncated: truncated,
            commandLineMasked: true,
            commandLineHash: hash,
          }
          : {
            commandLineHash: hash,
            commandLineLength: trimmed.length,
            commandLineTruncated: truncated,
          };
        aux.push({
          capability: 'telemetry',
          action: 'proc.commandline',
          scope,
          decision: 'allow', // handler 会按最终处置改写（F5）
          ruleId: 'commandline-audit',
          reason: commandlineArchiveMode === 'full'
            ? '完整命令行存档（打码后文本 + 哈希；判定口径仍为首词）'
            : '完整命令行哈希存档（默认 hash-only，不含明文；判定口径仍为首词）',
        });
      }
      return { requests, aux, unjudgeable: null };
    }
    // ops_bash 的 script_path 形态（命令超过 ~1KB 时要求走脚本文件）：
    // 脚本文件本身是执行主体，按路径整串记账（Scope 归一交给 guard）。
    const scriptPath = firstString(args, ['script_path']);
    if (scriptPath) {
      requests.push({ operation: 'proc.spawn', payload: { command: scriptPath } });
      return { requests, aux, unjudgeable: null };
    }
    return null;
  }

  if (BATCH_TOOLS.has(bare)) {
    // P3：ops_batch 一次可 plan/resume/run 512 条 copy/move/remove——批量破坏性
    // 通道必须展开。operations[] 缺席（plan 校验 / resume 续跑 / operationsRef
    // 引用）时子操作不可见，无法判定：advisory 落遥测，enforce fail-closed。
    const operations = Array.isArray(args.operations) ? args.operations : [];
    if (operations.length === 0 || operations.length > MAX_BATCH_OPERATIONS) {
      return {
        requests,
        aux,
        unjudgeable: operations.length > MAX_BATCH_OPERATIONS
          ? `batch operations 超限：${operations.length} > ${MAX_BATCH_OPERATIONS}`
          : `batch 未携带 operations[]（action=${String(args.action || '?')}），子操作不可见`,
      };
    }
    for (const op of operations) {
      const expanded = expandBatchOperation(op);
      if (!expanded) {
        return { requests, aux, unjudgeable: `batch operations 含无法展开的条目：${JSON.stringify(op).slice(0, 200)}` };
      }
      requests.push(...expanded);
    }
    return { requests, aux, unjudgeable: null };
  }

  if (READ_TOOLS.has(bare)) {
    if (bare === 'read_files') {
      // P4：逐 path 判定记账——只记首个会让 files[1..] 的越界读静默通过。
      const paths = pathsFromFiles(args);
      if (paths.length === 0) return null;
      for (const p of paths) requests.push({ operation: 'fs.read', payload: { path: fsScopePath(p) } });
      return { requests, aux, unjudgeable: null };
    }
    if (bare === 'glob' || bare === 'grep') {
      const basePath = firstString(args, ['path']);
      if (basePath) {
        // F3：glob/grep 的 path 语义是「扫这个子树」，目录时判 dir/**（与 dir/** 授权对齐）。
        requests.push({ operation: 'fs.read', payload: { path: fsScopePath(basePath) } });
        return { requests, aux, unjudgeable: null };
      }
      // P5：缺显式 path 时 DSH 用 session cwd——宿主进程拿不到 session cwd，
      // 猜一个写进账就是假数据。落遥测让缺口可见：advisory 放行，enforce 拒绝。
      return {
        requests,
        aux,
        unjudgeable: `${bare} 未显式给 path（DSH 默认 session cwd，宿主不可见）`,
      };
    }
    const filePath = firstString(args, ['path', 'file_path', 'filePath']);
    if (filePath) {
      // stat/diff 等对目录的只读触达同样按子树形态判（F3）。
      requests.push({ operation: 'fs.read', payload: { path: fsScopePath(filePath) } });
      return { requests, aux, unjudgeable: null };
    }
    return null;
  }

  if (WRITE_TOOLS.has(bare) || DELETE_TOOLS.has(bare) || COPY_TOOLS.has(bare) || MOVE_TOOLS.has(bare)) {
    const filePath = firstString(args, ['path', 'file_path', 'filePath']);
    if (!filePath) return null;
    // P9：dryRun 只读不写（write_file / edit_file / replace 支持），按 fs.read 记账，
    // 不再让账本高估副作用。
    const dryRun = args.dryRun === true;
    if (dryRun) {
      requests.push({ operation: 'fs.read', payload: { path: fsScopePath(filePath) } });
      return { requests, aux, unjudgeable: null };
    }
    if (WRITE_TOOLS.has(bare)) {
      // P10：replace 以根目录为 scope，glob 批量替换的实际目标文件不逐个展开——
      // 审计粒度到「替换基目录」为止，属已知且接受的粗粒度（dsh-ops replace 语义）。
      // F3：replace 的 path 是目录语义（批量写子树），目录时判 dir/**。
      requests.push({ operation: 'fs.write', payload: { path: fsScopePath(filePath) } });
      return { requests, aux, unjudgeable: null };
    }
    if (DELETE_TOOLS.has(bare)) {
      // M1：remove 删的是节点本身（目录则是节点 + 整棵子树）。目录必须同时判
      // 节点（fs.delete{dir}，需显式授权 dir）与子树（fs.delete{dir/**}），
      // 不能被 dir/** 子树授权放大（见 deleteRequests 注释）。
      requests.push(...deleteRequests(filePath));
      return { requests, aux, unjudgeable: null };
    }
    const targetPath = firstString(args, ['to']);
    if (!targetPath) {
      return { requests, aux, unjudgeable: `${bare} 缺目标路径 to` };
    }
    if (COPY_TOOLS.has(bare)) {
      // P1：目标端必须单独判定记账——只判源时，enforce 下「源在域内、目标在域外」
      // 的复制会把数据带出授权域。F3：目标是已存在目录时按 to/** 判（复制进目录）。
      requests.push({ operation: 'fs.read', payload: { path: fsScopePath(filePath) } });
      requests.push({ operation: 'fs.write', payload: { path: fsScopePath(targetPath) } });
      return { requests, aux, unjudgeable: null };
    }
    // move：读源 + 删源（M1：目录源 = 节点 + 子树两条都判）+ 写目标。
    requests.push({ operation: 'fs.read', payload: { path: fsScopePath(filePath) } });
    requests.push(...deleteRequests(filePath));
    requests.push({ operation: 'fs.write', payload: { path: fsScopePath(targetPath) } });
    return { requests, aux, unjudgeable: null };
  }

  if (FETCH_TOOLS.has(bare)) {
    const url = firstString(args, ['url', 'href']);
    if (url) {
      try {
        const parsed = new URL(url);
        const port = parsed.port
          ? Number(parsed.port)
          : (parsed.protocol === 'https:' ? 443 : 80);
        requests.push({ operation: 'net.outbound', payload: { host: parsed.hostname, port } });
        return { requests, aux, unjudgeable: null };
      } catch {
        return null; // 非法 URL 交回工具层自己的报错路径
      }
    }
  }
  return null;
}

/**
 * F1 防呆辅助：账本文件里是否已有无 mac 的历史行（v2 或缺 mac 字段）。
 * 空文件/不存在 → false（可以直接以 v3 起账）。解析失败的行跳过——
 * 真正的完整性校验交给 dashcam 的 verify。
 */
function ledgerHasUnmacedHistory(ledgerPath) {
  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch {
    return false; // 文件不存在/不可读：不算历史问题，交给 activate 的常规路径
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && (record.v !== 3 || typeof record.mac !== 'string')) return true;
    } catch {
      // 非 JSON 行忽略
    }
  }
  return false;
}

export function apply(ctx, config = {}) {
  const enforce = config.enforce === true;
  const advisory = !enforce;
  // F6：enforce 默认只覆盖映射表（enforce 不是全部工具的总闸）；
  // enforceUnmapped:true 把未映射工具也纳入 fail-closed（总闸口径）。
  const enforceUnmapped = config.enforceUnmapped === true;
  // F4：命令行存档模式，'hash'（默认）| 'full'（打码文本）。
  // L2：per-挂载局部常量（随 mapToolRequests 调用传入），不再用模块级可变状态——
  // 同进程多次挂载（测试/多 profile）不会互相串。
  const commandlineArchiveMode = config.commandlineArchive === 'full' ? 'full' : 'hash';
  // L6：enforceUnmapped 的豁免清单（全名或前缀通配，如 mcp__* / memory_*）。
  // R3（1.10.13 复核）：非数组 fail-fast——静默按空数组会把本想豁免的
  // compress/present 等全拦掉且无告警（写成逗号分隔字符串是人之常情）。
  if (config.unmappedAllowlist !== undefined
      && config.unmappedAllowlist !== null
      && !Array.isArray(config.unmappedAllowlist)) {
    console.error(
      '[dsh-dashcam] 配置错误：unmappedAllowlist 必须是数组（如 ["mcp__demo__*", "memory_*"]），'
      + `当前是 ${typeof config.unmappedAllowlist}——fail-closed 不挂载，防止静默拦掉全部未映射工具`,
    );
    return;
  }
  const unmappedAllowlist = Array.isArray(config.unmappedAllowlist)
    ? config.unmappedAllowlist.map((entry) => String(entry))
    : [];
  // 1.11.0 改名迁移：默认路径下若只有旧名（dsh-covenant）的账本，原地搬到新目录。
  // 不合并、不改内容、不改哈希链；显式配置 ledgerPath 时完全不动。
  const DEFAULT_LEDGER_PATH = join(homedir(), '.dsh', 'dsh-dashcam', 'ledger.jsonl');
  const LEGACY_LEDGER_PATH = join(homedir(), '.dsh', 'dsh-covenant', 'ledger.jsonl');
  function migrateLegacyLedger() {
    try {
      if (existsSync(DEFAULT_LEDGER_PATH)) return DEFAULT_LEDGER_PATH;
      if (!existsSync(LEGACY_LEDGER_PATH)) return DEFAULT_LEDGER_PATH;
      mkdirSync(dirname(DEFAULT_LEDGER_PATH), { recursive: true });
      renameSync(LEGACY_LEDGER_PATH, DEFAULT_LEDGER_PATH);
      const legacyLog = LEGACY_LEDGER_PATH + '.guard.log';
      if (existsSync(legacyLog)) renameSync(legacyLog, DEFAULT_LEDGER_PATH + '.guard.log');
      console.warn(`[dsh-dashcam] 账本迁移：${LEGACY_LEDGER_PATH} → ${DEFAULT_LEDGER_PATH}`);
    } catch (error) {
      console.warn(`[dsh-dashcam] 账本迁移失败（沿用旧位置）：${error.message}`);
    }
    return existsSync(DEFAULT_LEDGER_PATH) ? DEFAULT_LEDGER_PATH : LEGACY_LEDGER_PATH;
  }
  const ledgerPath = config.ledgerPath || migrateLegacyLedger();

  // L3：防呆拒绝挂载也要留痕——此时账本不能写，落到旁边 side 日志
  //（<ledgerPath>.guard.log），桌面版看不到 stdout 也能事后查原因。
  function appendGuardLog(stage, detail) {
    try {
      appendFileSync(
        `${ledgerPath}.guard.log`,
        `${new Date().toISOString()} stage=${stage} version=${PLUGIN_VERSION} ${detail}\n`,
        'utf8',
      );
    } catch {
      // side 日志写不进去就只剩 console——不因此阻断
    }
  }

  // L1：先区分「取不到密钥」与「历史行无 mac」两种 fail-closed，别让 env 未设置
  // 的报错冒充「不能原地启用」。
  if (config.ledgerMacKeyEnv && !process.env[config.ledgerMacKeyEnv]) {
    const message = `环境变量 ${config.ledgerMacKeyEnv} 未设置，取不到 MAC 密钥（fail-closed 不挂载）——`
      + `请设置该环境变量，或改用 ledgerMacKey / ledgerMacKeyFile，或去掉 ledgerMacKeyEnv 配置`;
    console.error(`[dsh-dashcam] 配置错误：${message}`);
    appendGuardLog('mac-env-missing', message);
    return;
  }

  // F1：MAC 不能在既有 v2 账本上原地启用——verify 会把全部历史判成 mac_missing、
  // ok=false，metrics 先校验后统计直接非零退出（复核实测生产账本 190 行全中）。
  // 防呆：配置了 MAC 密钥且账本里已有无 mac 的历史行 → 拒绝挂载并给出迁移路径。
  // 迁移方案（详见宿主 README「MAC 启用与账本迁移」）：换新账本文件、旧账归档，
  // 不要原地开关。
  const macKeyConfigured = Boolean(
    config.ledgerMacKey || config.ledgerMacKeyFile || config.ledgerMacKeyEnv,
  );
  if (macKeyConfigured && ledgerHasUnmacedHistory(ledgerPath)) {
    const message = `检测到账本 ${ledgerPath} 存在无 MAC 的历史记录（v2），不能原地启用账本 MAC`
      + `——verify 会把全部历史判成 mac_missing。\n`
      + `迁移步骤：1) mv ledger.jsonl ledger-v2-archive.jsonl（归档，标注 v2 无 mac）；`
      + `2) 保留 ledgerMacKey 配置重启，判定链会在新文件上从 v3 开始；`
      + `3) 归档文件用无密钥 Ledger.verify()（ok=false 是预期，历史本就无 mac）。`
      + `详见 dsh-dashcam-host/README.md「MAC 启用与账本迁移」。`;
    console.error(`[dsh-dashcam] 配置错误：${message}`);
    appendGuardLog('mac-v2-history', message.replace(/\n/g, ' | '));
    return;
  }

  // ── fail-fast：配置前置校验（问题 1，1.10.8）─────────────────
  // mount 时就把写错的 config.requests 拦下来，而不是等到运行时判成 not_declared。
  // activate 内部直接吃 manifest，不走 parseManifest，所以宿主必须自己做 normalize。
  let normalizedRequests = [];
  try {
    const raw = Array.isArray(config.requests) ? config.requests : [];
    normalizedRequests = raw.map((item, index) => dashcam.normalizeRequest(item, { home: homedir() }));
  } catch (error) {
    console.error(
      `[dsh-dashcam] 配置错误：config.requests 非法——${error.message}`,
      `（正确格式见 README 3.4：每个 request 是 { capability, scope, reason } 对象，`
      + `字符串数组会静默变成「未声明」）`,
    );
    // 不装判定链，让宿主在启动期就显式看到配置有问题，而不是默默跑起来再运行期拒一切。
    return;
  }
  // grants 也顺便校验一下，写错了同样 fail-fast（契约要求是对象数组）。
  const rawGrants = Array.isArray(config.grants) ? config.grants : [];
  let normalizedGrants = [];
  try {
    normalizedGrants = rawGrants.map((item, index) => dashcam.normalizeGrant(item, { home: homedir() }, index));
  } catch (error) {
    console.error(`[dsh-dashcam] 配置错误：config.grants 非法——${error.message}`);
    return;
  }

  // Two-Key 成对原则：enforce 模式下宿主既要授 grants（钥匙），也要在 manifest
  // 里声明 requests（能力清单）。advisory 模式两者皆空，只记账。
  // 注意两处都要放：运行时 two-key 读 manifest.dashcam.requests，
  // DSH 插件清单格式是 dashcam.capabilities.requests——保持同源不漂移。
  const manifest = {
    ...MANIFEST,
    dashcam: {
      ...MANIFEST.dashcam,
      requests: normalizedRequests,
      capabilities: { requests: normalizedRequests },
    },
  };

  // 归属标注（v4 账本字段）：宿主侧的 profiled / manifestHash 与守卫链同源——
  // 有契约时每条记录都能对出「当时声明了什么」；零契约时 profiled=false、
  // manifestHash=null，本身就是「装上时没给契约」的证明。
  const profiledRequests = normalizedRequests.length > 0;
  const manifestHash = profiledRequests ? sha256(stableStringify(normalizedRequests)) : null;

  // R2 façade 化之后 activate() 不再外借 Ledger（防插件顺藤摸瓜拿走审计密钥）。
  // 宿主自建实例经 host.ledger 传入：activate 优先使用注入的账本，mac 密钥解析
  // 与 activate 内部同函数同参数，行为完全一致；进程内共享账本状态（H6）保证
  // 两个实例的 seq/size 基准一致。
  let ledger;
  try {
    const resolvedMac = dashcam.resolveLedgerMacKey({
      ledgerMacKey: config.ledgerMacKey || null,
      ledgerMacKeyFile: config.ledgerMacKeyFile || null,
      ledgerMacKeyEnv: config.ledgerMacKeyEnv || null,
    });
    ledger = new dashcam.Ledger(ledgerPath, { macKey: resolvedMac.key });
  } catch (error) {
    console.warn(`[dsh-dashcam] activate failed: ${error.message}`);
    return;
  }

  let runtime;
  try {
    runtime = dashcam.activate({
      manifest,
      grants: normalizedGrants,
      policy: config.policy || {},
      ledger,
      // Bridge 是进程级补丁，默认必须关（宿主是 Electron 主进程，一装就接管
      // 应用自身的 fs/net）；需要真实拦截时显式 config.patchBuiltins: true。
      patchBuiltins: config.patchBuiltins === true,
      // 判定不再经由 registerPreExecute 直挂事件：waterfall 契约要求
      // (exec, next) 包装与映射层，check 在下面的 handler 里手动调用。
    });
  } catch (error) {
    // 装载失败只标记本插件，不拖垮宿主其余插件树。
    console.warn(`[dsh-dashcam] activate failed: ${error.message}`);
    return;
  }
  // activate() 返回最小 façade：guard 只有 check/enforce/coverage 只读面。
  const guard = runtime.guard;

  /** 附加审计记录（遥测 / 命令行存档 / mount）直接落账本；失败只警告不阻断放行。 */
  function appendAuxRecord(record) {
    if (!ledger) return;
    try {
      ledger.append({
        plugin: MANIFEST.id,
        pluginVersion: PLUGIN_VERSION,
        profiled: profiledRequests,
        manifestHash,
        ...record,
      });
    } catch (error) {
      console.warn(`[dsh-dashcam] 附加审计记录写入失败：${error.message}`);
    }
  }

  // 零契约模式（行车记录仪出厂态）：没配置 config.requests（且不在 enforce）时，
  // 不产生 Two-Key 判定——对着不存在的契约判「未声明」，账本会塞满没人看的
  // not_declared 噪音。改为把每次被观测的工具调用按 unprofiled 如实记录。
  const zeroContract = !enforce && normalizedRequests.length === 0;

  // 遗留 P4（1.10.10 报告）：挂载事件落账本——桌面版看不到 stdout，
  // 「判定链是否挂载」从此可以直接从账本文件判断。
  appendAuxRecord({
    capability: 'telemetry',
    action: 'mount',
    scope: {
      mode: enforce ? 'enforce' : (zeroContract ? 'unprofiled' : 'advisory'),
      contract: zeroContract ? 'unprofiled' : 'declared',
      enforceUnmapped,
      commandlineArchive: commandlineArchiveMode,
      patchBuiltins: config.patchBuiltins === true,
      requests: normalizedRequests.length,
      grants: normalizedGrants.length,
      ledgerPath,
    },
    decision: 'allow',
    ruleId: 'mount',
    reason: zeroContract
      ? 'dsh-dashcam-host 判定链挂载（零契约模式：全部观测活动按 unprofiled 记录）'
      : 'dsh-dashcam-host 判定链挂载',
  });

  // ingress 审计：请求出口 + 消息入口的元数据。事件名可配；接不上必须留痕，
  // 不能让「没记录」看起来像「没有异常」。
  const ingress = attachIngress(ctx, {
    ledger,
    policy: { ingress: config.ingress || {} },
    plugin: MANIFEST.id,
    pluginVersion: PLUGIN_VERSION,
    config: config.ingress || {},
    log: (message) => console.warn(message),
  });
  appendAuxRecord({
    capability: 'telemetry',
    action: ingress.enabled ? 'ingress-mount' : 'ingress-disabled',
    scope: {
      enabled: ingress.enabled,
      requestEvent: ingress.requestEvent,
      inboundEvent: ingress.inboundEvent,
      headBytes: ingress.recorder ? ingress.recorder.settings.headBytes : null,
    },
    decision: 'allow',
    ruleId: ingress.enabled ? 'ingress-mount' : 'ingress-disabled',
    reason: ingress.enabled ? 'ingress 审计接线' : 'ingress 审计未启用（配置关闭或账本不可用）',
  });

  // 面板只读 API（1.13.0）：webServer 可用时挂 /api/dsh-dashcam/* 路由，供注入
  // DSH Web 的浏览器面板（lib/client.js）消费。optional-safe——webServer 缺席或
  // 挂载失败只丢面板入口，不影响判定链与账本；config.panel.enabled=false 可关。
  if (config.panel && config.panel.enabled === false) {
    console.info('[dsh-dashcam] 面板 API 已通过 config.panel.enabled=false 关闭');
  } else {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (hostCtx) => {
          hostCtx.effect(() => {
            const webServer =
              typeof hostCtx.get === 'function' ? hostCtx.get('webServer') : hostCtx.webServer;
            try {
              const dispose = registerPanelRoutes(webServer, {
                ledgerPath,
                version: PLUGIN_VERSION,
                log: (message) => console.info(message),
              });
              console.info(`[dsh-dashcam] 面板 API 已挂载（/api/dsh-dashcam/*，ledger=${ledgerPath}）`);
              return dispose;
            } catch (error) {
              console.warn(`[dsh-dashcam] 面板 API 挂载失败：${error.message}`);
              return () => {};
            }
          }, 'dsh-dashcam: panel routes');
        });
      } else {
        console.info('[dsh-dashcam] 当前宿主未提供 ctx.inject，面板 API 不挂载');
      }
    } catch (error) {
      console.warn(`[dsh-dashcam] 面板 API 不可用：${error.message}`);
    }
  }

  // tools/pre-execute waterfall：判定链的真正入口（旧版监听 'pre-execute'，
  // DSH 核心只发 tools/pre-execute——判定链因此一次都没跑过）。
  // 未映射遥测：console 点名 + 账本 telemetry 记录同名只记一次（seenUnmapped
  // 去重——**只去重日志/遥测**）。
  // P1（1.10.13 复核）：enforceUnmapped 的拒绝逻辑必须对**每次**未映射调用执行，
  // 不能被去重短路——否则同名工具第 2 次起 fail-open，对 agent 反复调用同一工具
  // 的形态等于没拦。
  // L6：unmappedAllowlist 支持全名与前缀通配（mcp__* / memory_*）——enforceUnmapped
  // 是总闸，不开 allowlist 会把 compress/workflow/subagent/mcp__* 等宿主工具全打死。
  const seenUnmapped = new Set();
  ctx.on('tools/pre-execute', async (exec, next) => {
    const mapped = mapToolRequests(exec, { commandlineArchive: commandlineArchiveMode });
    if (!mapped) {
      if (exec && typeof exec.name === 'string') {
        const lowered = exec.name.toLowerCase();
        const bare = lowered.startsWith('ops_') ? lowered.slice(4) : lowered;
        if (!NOOP_TOOLS.has(bare)) {
          const allowlisted = matchesAllowlist(exec.name, unmappedAllowlist);
          const denyUnmapped = enforce && enforceUnmapped && !allowlisted;
          if (zeroContract && !denyUnmapped) {
            // 零契约：每一次未映射调用都逐次记账（观测记录，不去重）——
            // 否则默认出厂路径下大部分活动根本不进账本，「装上就能用」
            // 变成「装上就装了」。参数预览只截 512 字符并过打码。
            const inputText = JSON.stringify(exec.arguments ?? '') ?? '';
            appendAuxRecord({
              capability: 'telemetry',
              action: 'unmapped-tool',
              scope: {
                tool: exec.name,
                allowlisted,
                inputLength: inputText.length,
                inputPreview: maskSecrets(inputText.slice(0, 512)),
              },
              decision: 'allow',
              intercepted: false,
              ruleId: 'unprofiled',
              reason: '零契约模式：未映射工具按观测逐次记录（无声明清单，不做 Two-Key 判定）',
            });
          }
          if (!seenUnmapped.has(lowered)) {
            // 去重只作用于日志与 allow 遥测；拦截判定每次都做（P1）。
            // 零契约下逐次 unprofiled 记录已覆盖这件事，allow 遥测不再重复落。
            seenUnmapped.add(lowered);
            console.info(
              `[dsh-dashcam] 未映射工具（${denyUnmapped ? 'enforceUnmapped 拒绝' : allowlisted ? 'allowlist 豁免放行' : zeroContract ? '放行，按 unprofiled 记账' : '放行，不记账'}）：`
              + `${exec.name}——如需纳管请补充映射表`,
            );
            if (!denyUnmapped && !zeroContract) {
              appendAuxRecord({
                capability: 'telemetry',
                action: 'unmapped-tool',
                scope: { tool: exec.name, allowlisted },
                decision: 'allow',
                intercepted: false,
                ruleId: 'unmapped',
                reason: allowlisted
                  ? '未映射工具命中 unmappedAllowlist 豁免放行（不产生能力判定）'
                  : '未映射工具放行（不产生能力判定），如需纳管请补充映射表',
              });
            }
          }
          if (denyUnmapped) {
            // R2（1.10.13 复核）：拒绝**每次**都落账——「拒绝必落账」不因遥测去重而缩水；
            // console 点名仍只一次。telemetryDenies 因此逐次可见。
            appendAuxRecord({
              capability: 'telemetry',
              action: 'unmapped-tool',
              scope: { tool: exec.name, allowlisted },
              decision: 'deny',
              intercepted: true,
              ruleId: 'unmapped',
              reason: 'enforceUnmapped 开启：未映射工具按 fail-closed 拒绝（不在映射表内且不在 allowlist）',
            });
            return {
              kind: 'deny',
              reason: `[dsh-dashcam] 未映射工具（enforceUnmapped）：${exec.name} 不在映射表内，按 fail-closed 拒绝`,
            };
          }
        }
      }
      return next();
    }

    // 无法判定目标：审计先于执行（F2）——拒绝也要落账。
    // advisory：telemetry allow + 放行；enforce：telemetry deny(intercepted) + 拒绝。
    if (mapped.unjudgeable) {
      appendAuxRecord({
        capability: 'telemetry',
        action: 'unjudgeable-tool',
        scope: { tool: exec && exec.name, detail: mapped.unjudgeable },
        decision: enforce ? 'deny' : 'allow',
        intercepted: enforce,
        ruleId: 'unjudgeable',
        reason: enforce
          ? `fail-closed 拒绝（无法判定）：${mapped.unjudgeable}`
          : `放行（无法判定，advisory）：${mapped.unjudgeable}`,
      });
      if (enforce) {
        return {
          kind: 'deny',
          reason: `[dsh-dashcam] 无法判定调用目标，按 fail-closed 拒绝：${mapped.unjudgeable}`,
        };
      }
      return next();
    }

    // 零契约：映射到的请求也只记录、不判定——判定要对着声明清单，而这里没有。
    // 记录粒度与映射层一致（copy=读源+写目标、move=读+删源+写目标……），
    // capability 取操作前缀；读路径命中凭证特征时与 derive 同源升级为 cred.*，
    // scope 保存原始目标（路径/主机/命令首词）。
    // 命令行存档等附加记录照常落账（零契约下没有 deny 处置可改写，保持 allow）。
    if (zeroContract) {
      for (const req of mapped.requests) {
        let capability = String(req.operation || '').split('.')[0] || 'unknown';
        if (req.operation === 'fs.read' && req.payload && typeof req.payload.path === 'string') {
          const upgraded = credentialCapabilityForPath(req.payload.path, 'fs.read');
          if (upgraded !== 'fs.read') capability = upgraded;
        }
        appendAuxRecord({
          capability,
          action: req.operation,
          scope: req.payload,
          decision: 'allow',
          intercepted: false,
          ruleId: 'unprofiled',
          reason: '零契约模式：映射请求按观测记录（无声明清单，不做 Two-Key 判定）',
        });
      }
      for (const auxRecord of mapped.aux) appendAuxRecord(auxRecord);
      return next();
    }

    const decisions = [];
    for (const req of mapped.requests) {
      let decision;
      try {
        // guard.check 自带账本落盘（含 deny 明细与 ledgerSeq）：审计先于放行/拦截，
        // 与 dashcam 的 fail-closed 记账语义一致。
        // advisory 模式：告诉 guard 「我会自行放行」，让账本 decision=deny 但
        // intercepted=false——这样 metrics 与审计不会把「would-deny 放行」误算
        // 成真正的拦截（问题 2，1.10.8）。
        decision = guard.check(req.operation, req.payload, { advisory });
      } catch (error) {
        // check 正常不抛（derive 失败已折算成拒绝结果）；真抛了按模式兜底。
        console.warn(`[dsh-dashcam] 判定异常：${error.message}`);
        if (enforce) return { kind: 'deny', reason: `[dsh-dashcam] 判定异常：${error.message}` };
        return next();
      }
      decisions.push(decision);
    }
    // 附加审计记录（命令行存档）在任何处置之前落账（F5：decision 随最终处置改写，
    // 被拒的调用不再记 allow）。
    const denied = decisions.find((decision) => !decision.allowed);
    for (const auxRecord of mapped.aux) {
      if (auxRecord.ruleId === 'commandline-audit') {
        auxRecord.decision = denied && enforce ? 'deny' : 'allow';
        auxRecord.intercepted = Boolean(denied && enforce);
      }
      appendAuxRecord(auxRecord);
    }

    // enforce：多请求任一不允许即拒绝整次工具调用（整批按最严处置）。
    if (denied && enforce) {
      return { kind: 'deny', reason: `[dsh-dashcam] ${denied.reason}` };
    }
    // advisory 模式：deny 也放行——账本已如实落了 decision=deny + intercepted=false，
    // 收紧交给后续决策。allow 路径 decision.intercepted 本来就是 false，账本照原样落。
    return next();
  });

  ctx.effect(() => () => {
    try {
      ingress.dispose();
    } catch (error) {
      console.warn(`[dsh-dashcam] ingress dispose failed: ${error.message}`);
    }
    try {
      runtime.deactivate();
    } catch (error) {
      console.warn(`[dsh-dashcam] deactivate failed: ${error.message}`);
    }
  });
  console.info(
    `[dsh-dashcam] 判定链已挂载（event=tools/pre-execute，mode=${enforce ? 'enforce' : (zeroContract ? 'unprofiled' : 'advisory')}，`
    + `enforceUnmapped=${enforceUnmapped}，commandlineArchive=${commandlineArchiveMode}，`
    + `patchBuiltins=${config.patchBuiltins === true}，ledger=${ledgerPath}，`
    + `requests=${normalizedRequests.length}，grants=${normalizedGrants.length}）`,
  );
}
