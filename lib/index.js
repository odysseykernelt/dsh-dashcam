/**
 * dsh-covenant-host —— 把 dsh-covenant 的判定链接入 DeepSeek Harness（cordis 宿主）。
 *
 * 接线（2026-11-06 实跑验证后修正）：
 *  - DSH 工具拦截点只有 `tools/pre-execute`（waterfall，签名 `async (exec, next)`）：
 *    放行必须 `return next()`，拦截 `return { kind: 'deny', reason }`。
 *    旧版监听 'pre-execute'——该事件在 DSH 里不存在（asar 内出现 0 次），
 *    判定链从未被调用过，账本恒为空。
 *  - 映射层：DSH tool exec → covenant capability。见工具集合与 mapToolRequests。
 *    一次工具调用可展开为**多条**判定请求（copy=读源+写目标、move=读+删源+写目标、
 *    ops_batch 逐条展开 operations[]、ops_read_files 逐 path）。
 *  - 定位边界（重要）：工具的真实执行在子进程/工具层，本判定链是**入口策略门**
 *    （拦命令/拦路径参数），不覆盖工具执行后的真实副作用；进程内 Node 调用
 *    由 patchBuiltins 的 Bridge 看护（默认关闭，见下）。
 *
 * 模式（与 dsh-covenant 设计讨论的「先观测后收紧」路线一致）：
 *  - 默认 advisory：映射到的调用照常走 guard.check 记账（含 deny 落账），但放行——
 *    账本先积累「插件实际在碰什么」的事实，供后续 suggest / 增量授权。
 *  - `enforce: true`：判定不允许即拦截（{ kind: 'deny' }）。此时需在 config.grants
 *    里授予对应能力（Two-Key：声明在 MANIFEST，钥匙在 grants）。
 *    无法判定目标的调用（如 batch 缺 operations[]、glob 缺搜索基目录）按 fail-closed 拒绝。
 *
 * 设计取舍：默认 `patchBuiltins = false`。宿主是 Electron 主进程，Bridge 是进程级补丁，
 * 一装就会接管应用自身的 fs/net。需要真实拦截时，在 cordis 配置里显式 `patchBuiltins: true`。
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const covenant = require('../../dsh-covenant/src/index.js');

export const name = 'dsh-covenant-host';
export const inject = [];

const PLUGIN_VERSION = '1.10.11';

const MANIFEST = {
  id: 'dsh-covenant-host',
  name: 'dsh-covenant-host',
  version: PLUGIN_VERSION,
  entry: 'lib/index.js',
  covenant: {
    spec: 'dsh-covenant/1',
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

// ── 映射层：DSH tool exec → covenant capability ────────────────────
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
/** 完整命令行存档的截断长度（账本另存截断文本 + 整串 SHA-256）。 */
const COMMANDLINE_ARCHIVE_LIMIT = 1024;

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
 * 命令判定口径 = 首词（与 covenant Bridge 的 firstCommand 同型，含引号形态）。
 * 工具级入口门与进程内 Bridge 必须同一把尺子，否则账本口径漂移。
 * 完整命令行（含 `cd X && rm -f …` 的后续部分）另存存档记录（见 commandlineArchive）。
 */
function firstCommandWord(command) {
  const trimmed = command.trim();
  const matched = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return matched ? (matched[1] || matched[2] || matched[3]) : trimmed;
}

/**
 * batch 操作展开（dsh-ops PTC batch：op ∈ {copy, move, remove}，path 必填，copy/move 带 to）。
 * 与单工具同口径：copy=读源+写目标，move=读源+删源+写目标，remove=删源。
 */
function expandBatchOperation(op) {
  if (!op || typeof op !== 'object') return null;
  const { op: kind, path, to } = op;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (kind === 'copy') {
    if (typeof to !== 'string' || to.length === 0) return null;
    return [
      { operation: 'fs.read', payload: { path } },
      { operation: 'fs.write', payload: { path: to } },
    ];
  }
  if (kind === 'move') {
    if (typeof to !== 'string' || to.length === 0) return null;
    return [
      { operation: 'fs.read', payload: { path } },
      { operation: 'fs.delete', payload: { path } },
      { operation: 'fs.write', payload: { path: to } },
    ];
  }
  if (kind === 'remove') {
    return [{ operation: 'fs.delete', payload: { path } }];
  }
  return null;
}

/**
 * 把一次 DSH 工具调用映射成 covenant 判定请求；映射不了返回 null（放行 + 遥测）。
 *
 * 返回形状：
 *   null                          —— 完全未映射（遥测 unmapped-tool）
 *   { requests, aux, unjudgeable } —— requests: guard.check 逐条判定并记账；
 *                                    aux: 直接落账本的附加记录（命令行存档 / 遥测）；
 *                                    unjudgeable: 无法判定目标的说明文本——
 *                                    advisory 下只落遥测放行，enforce 下 fail-closed 拒绝。
 */
function mapToolRequests(exec) {
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
      // P6：判定只认首词，但账本必须能看到整条命令行——否则 `cd X && rm -f …`
      // 在账上只剩 "cd"。截断 + SHA-256 存档，完整性可离线核对。
      const trimmed = command.trim();
      if (trimmed !== firstCommandWord(command)) {
        aux.push({
          capability: 'proc.spawn',
          action: 'proc.commandline',
          scope: {
            commandLine: trimmed.length > COMMANDLINE_ARCHIVE_LIMIT
              ? trimmed.slice(0, COMMANDLINE_ARCHIVE_LIMIT)
              : trimmed,
            commandLineTruncated: trimmed.length > COMMANDLINE_ARCHIVE_LIMIT,
            commandLineHash: `sha256:${createHash('sha256').update(trimmed, 'utf8').digest('hex')}`,
          },
          decision: 'allow',
          ruleId: 'commandline-audit',
          reason: '完整命令行存档（判定口径仍为首词）',
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
      for (const p of paths) requests.push({ operation: 'fs.read', payload: { path: p } });
      return { requests, aux, unjudgeable: null };
    }
    if (bare === 'glob' || bare === 'grep') {
      const basePath = firstString(args, ['path']);
      if (basePath) {
        requests.push({ operation: 'fs.read', payload: { path: basePath } });
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
      requests.push({ operation: 'fs.read', payload: { path: filePath } });
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
      requests.push({ operation: 'fs.read', payload: { path: filePath } });
      return { requests, aux, unjudgeable: null };
    }
    if (WRITE_TOOLS.has(bare)) {
      // P10：replace 以根目录为 scope，glob 批量替换的实际目标文件不逐个展开——
      // 审计粒度到「替换基目录」为止，属已知且接受的粗粒度（dsh-ops replace 语义）。
      requests.push({ operation: 'fs.write', payload: { path: filePath } });
      return { requests, aux, unjudgeable: null };
    }
    if (DELETE_TOOLS.has(bare)) {
      requests.push({ operation: 'fs.delete', payload: { path: filePath } });
      return { requests, aux, unjudgeable: null };
    }
    const targetPath = firstString(args, ['to']);
    if (!targetPath) {
      return { requests, aux, unjudgeable: `${bare} 缺目标路径 to` };
    }
    if (COPY_TOOLS.has(bare)) {
      // P1：目标端必须单独判定记账——只判源时，enforce 下「源在域内、目标在域外」
      // 的复制会把数据带出授权域。
      requests.push({ operation: 'fs.read', payload: { path: filePath } });
      requests.push({ operation: 'fs.write', payload: { path: targetPath } });
      return { requests, aux, unjudgeable: null };
    }
    // move：读源 + 删源 + 写目标（保守口径，见 MOVE_TOOLS 注释）。
    requests.push({ operation: 'fs.read', payload: { path: filePath } });
    requests.push({ operation: 'fs.delete', payload: { path: filePath } });
    requests.push({ operation: 'fs.write', payload: { path: targetPath } });
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

export function apply(ctx, config = {}) {
  const enforce = config.enforce === true;
  const advisory = !enforce;
  const ledgerPath = config.ledgerPath || join(homedir(), '.dsh', 'dsh-covenant', 'ledger.jsonl');

  // ── fail-fast：配置前置校验（问题 1，1.10.8）─────────────────
  // mount 时就把写错的 config.requests 拦下来，而不是等到运行时判成 not_declared。
  // activate 内部直接吃 manifest，不走 parseManifest，所以宿主必须自己做 normalize。
  let normalizedRequests = [];
  try {
    const raw = Array.isArray(config.requests) ? config.requests : [];
    normalizedRequests = raw.map((item, index) => covenant.normalizeRequest(item, { home: homedir() }));
  } catch (error) {
    console.error(
      `[dsh-covenant] 配置错误：config.requests 非法——${error.message}`,
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
    normalizedGrants = rawGrants.map((item, index) => covenant.normalizeGrant(item, { home: homedir() }, index));
  } catch (error) {
    console.error(`[dsh-covenant] 配置错误：config.grants 非法——${error.message}`);
    return;
  }

  // Two-Key 成对原则：enforce 模式下宿主既要授 grants（钥匙），也要在 manifest
  // 里声明 requests（能力清单）。advisory 模式两者皆空，只记账。
  // 注意两处都要放：运行时 two-key 读 manifest.covenant.requests，
  // DSH 插件清单格式是 covenant.capabilities.requests——保持同源不漂移。
  const manifest = {
    ...MANIFEST,
    covenant: {
      ...MANIFEST.covenant,
      requests: normalizedRequests,
      capabilities: { requests: normalizedRequests },
    },
  };
  let runtime;
  try {
    runtime = covenant.activate({
      manifest,
      grants: normalizedGrants,
      policy: config.policy || {},
      ledgerPath,
      // D4：账本 MAC 密钥透传（covenant v3 账本）。密钥不落仓库——可显式给
      // ledgerMacKey / 指向文件的 ledgerMacKeyFile / 环境变量名 ledgerMacKeyEnv
      //（默认还会尝试 DSH_COVENANT_MAC_KEY）。密钥非法时 activate 抛错，走下面的兜底。
      ledgerMacKey: config.ledgerMacKey || null,
      ledgerMacKeyFile: config.ledgerMacKeyFile || null,
      ledgerMacKeyEnv: config.ledgerMacKeyEnv || null,
      patchBuiltins: config.patchBuiltins === true,
      // 判定不再经由 registerPreExecute 直挂事件：waterfall 契约要求
      // (exec, next) 包装与映射层，check 在下面的 handler 里手动调用。
    });
  } catch (error) {
    // 装载失败只标记本插件，不拖垮宿主其余插件树。
    console.warn(`[dsh-covenant] activate failed: ${error.message}`);
    return;
  }
  // activate() 返回 { id, runtime, deactivate }：guard 在内层 runtime 上，ledger 同层。
  const guard = runtime.runtime.guard;
  const ledger = runtime.runtime.ledger;

  /** 附加审计记录（遥测 / 命令行存档 / mount）直接落账本；失败只警告不阻断放行。 */
  function appendAuxRecord(record) {
    if (!ledger) return;
    try {
      ledger.append({
        plugin: MANIFEST.id,
        pluginVersion: PLUGIN_VERSION,
        ...record,
      });
    } catch (error) {
      console.warn(`[dsh-covenant] 附加审计记录写入失败：${error.message}`);
    }
  }

  // 遗留 P4（1.10.10 报告）：挂载事件落账本——桌面版看不到 stdout，
  // 「判定链是否挂载」从此可以直接从账本文件判断。
  appendAuxRecord({
    capability: 'telemetry',
    action: 'mount',
    scope: {
      mode: enforce ? 'enforce' : 'advisory',
      patchBuiltins: config.patchBuiltins === true,
      requests: normalizedRequests.length,
      grants: normalizedGrants.length,
      ledgerPath,
    },
    decision: 'allow',
    ruleId: 'mount',
    reason: 'dsh-covenant-host 判定链挂载',
  });

  // tools/pre-execute waterfall：判定链的真正入口（旧版监听 'pre-execute'，
  // DSH 核心只发 tools/pre-execute——判定链因此一次都没跑过）。
  // 未映射遥测：同名只报一次（seenUnmapped 去重），console 点名 + 账本 telemetry
  // 记录（P7：桌面版看不到 stdout，覆盖缺口必须落盘可见）。
  const seenUnmapped = new Set();
  ctx.on('tools/pre-execute', async (exec, next) => {
    const mapped = mapToolRequests(exec);
    if (!mapped) {
      if (exec && typeof exec.name === 'string') {
        const lowered = exec.name.toLowerCase();
        const bare = lowered.startsWith('ops_') ? lowered.slice(4) : lowered;
        if (!NOOP_TOOLS.has(bare) && !seenUnmapped.has(lowered)) {
          seenUnmapped.add(lowered);
          console.info(`[dsh-covenant] 未映射工具（放行，不记账）：${exec.name}——如需纳管请补充映射表`);
          appendAuxRecord({
            capability: 'telemetry',
            action: 'unmapped-tool',
            scope: { tool: exec.name },
            decision: 'allow',
            ruleId: 'unmapped',
            reason: '未映射工具放行（不产生能力判定），如需纳管请补充映射表',
          });
        }
      }
      return next();
    }

    // 无法判定目标：advisory 落遥测放行；enforce fail-closed 拒绝。
    if (mapped.unjudgeable) {
      if (enforce) {
        return {
          kind: 'deny',
          reason: `[dsh-covenant] 无法判定调用目标，按 fail-closed 拒绝：${mapped.unjudgeable}`,
        };
      }
      appendAuxRecord({
        capability: 'telemetry',
        action: 'unjudgeable-tool',
        scope: { tool: exec && exec.name, detail: mapped.unjudgeable },
        decision: 'allow',
        ruleId: 'unjudgeable',
        reason: mapped.unjudgeable,
      });
      return next();
    }

    const decisions = [];
    for (const req of mapped.requests) {
      let decision;
      try {
        // guard.check 自带账本落盘（含 deny 明细与 ledgerSeq）：审计先于放行/拦截，
        // 与 covenant 的 fail-closed 记账语义一致。
        // advisory 模式：告诉 guard 「我会自行放行」，让账本 decision=deny 但
        // intercepted=false——这样 metrics 与审计不会把「would-deny 放行」误算
        // 成真正的拦截（问题 2，1.10.8）。
        decision = guard.check(req.operation, req.payload, { advisory });
      } catch (error) {
        // check 正常不抛（derive 失败已折算成拒绝结果）；真抛了按模式兜底。
        console.warn(`[dsh-covenant] 判定异常：${error.message}`);
        if (enforce) return { kind: 'deny', reason: `[dsh-covenant] 判定异常：${error.message}` };
        return next();
      }
      decisions.push(decision);
    }
    // 附加审计记录（命令行存档）在任何处置之前落账。
    for (const auxRecord of mapped.aux) appendAuxRecord(auxRecord);

    // enforce：多请求任一不允许即拒绝整次工具调用（整批按最严处置）。
    const denied = decisions.find((decision) => !decision.allowed);
    if (denied && enforce) {
      return { kind: 'deny', reason: `[dsh-covenant] ${denied.reason}` };
    }
    // advisory 模式：deny 也放行——账本已如实落了 decision=deny + intercepted=false，
    // 收紧交给后续决策。allow 路径 decision.intercepted 本来就是 false，账本照原样落。
    return next();
  });

  ctx.effect(() => () => {
    try {
      runtime.deactivate();
    } catch (error) {
      console.warn(`[dsh-covenant] deactivate failed: ${error.message}`);
    }
  });
  console.info(
    `[dsh-covenant] 判定链已挂载（event=tools/pre-execute，mode=${enforce ? 'enforce' : 'advisory'}，`
    + `patchBuiltins=${config.patchBuiltins === true}，ledger=${ledgerPath}，`
    + `requests=${normalizedRequests.length}，grants=${normalizedGrants.length}）`,
  );
}
