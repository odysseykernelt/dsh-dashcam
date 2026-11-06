/**
 * dsh-covenant-host —— 把 dsh-covenant 的判定链接入 DeepSeek Harness（cordis 宿主）。
 *
 * 接线（2026-11-06 实跑验证后修正）：
 *  - DSH 工具拦截点只有 `tools/pre-execute`（waterfall，签名 `async (exec, next)`）：
 *    放行必须 `return next()`，拦截 `return { kind: 'deny', reason }`。
 *    旧版监听 'pre-execute'——该事件在 DSH 里不存在（asar 内出现 0 次），
 *    判定链从未被调用过，账本恒为空。
 *  - 映射层：DSH tool exec → covenant capability。见 TOOL_MAP 与 mapToolRequest。
 *  - 定位边界（重要）：工具的真实执行在子进程/工具层，本判定链是**入口策略门**
 *    （拦命令/拦路径参数），不覆盖工具执行后的真实副作用；进程内 Node 调用
 *    由 patchBuiltins 的 Bridge 看护（默认关闭，见下）。
 *
 * 模式（与 dsh-covenant 设计讨论的「先观测后收紧」路线一致）：
 *  - 默认 advisory：映射到的调用照常走 guard.check 记账（含 deny 落账），但放行——
 *    账本先积累「插件实际在碰什么」的事实，供后续 suggest / 增量授权。
 *  - `enforce: true`：判定不允许即拦截（{ kind: 'deny' }）。此时需在 config.grants
 *    里授予对应能力（Two-Key：声明在 MANIFEST，钥匙在 grants）。
 *
 * 设计取舍：默认 `patchBuiltins = false`。宿主是 Electron 主进程，Bridge 是进程级补丁，
 * 一装就会接管应用自身的 fs/net。需要真实拦截时，在 cordis 配置里显式 `patchBuiltins: true`。
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const covenant = require('../../dsh-covenant/src/index.js');

export const name = 'dsh-covenant-host';
export const inject = [];

const MANIFEST = {
  id: 'dsh-covenant-host',
  name: 'dsh-covenant-host',
  version: '1.10.9',
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
// 口径保守：只映射确知名字与参数形状的工具；未列入表的工具直接放行
// （不记账不拦截——宁缺毋滥，避免误拦宿主自有工具）。表随 DSH 工具面扩充。

/** shell 系：arguments.command 是整条命令行 → proc.spawn。 */
const SHELL_TOOLS = new Set(['pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd']);
/** 读文件系：arguments 里的路径字段 → fs.read。 */
const READ_TOOLS = new Set(['read_file', 'read']);
/** 写/改文件系：→ fs.write。 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'write']);
/** 出网系：arguments.url → net.outbound。 */
const FETCH_TOOLS = new Set(['web_fetch', 'fetch']);

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

/**
 * 命令判定口径 = 首词（与 covenant Bridge 的 firstCommand 同型，含引号形态）。
 * 工具级入口门与进程内 Bridge 必须同一把尺子，否则账本口径漂移。
 */
function firstCommandWord(command) {
  const trimmed = command.trim();
  const matched = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return matched ? (matched[1] || matched[2] || matched[3]) : trimmed;
}

/**
 * 把一次 DSH 工具调用映射成 covenant 判定请求；映射不了返回 null（放行）。
 * 返回 { operation, payload }，直接交给 guard.check。
 */
function mapToolRequest(exec) {
  if (!exec || typeof exec.name !== 'string') return null;
  const name = exec.name.toLowerCase();
  const args = normalizeArguments(exec.arguments);

  if (SHELL_TOOLS.has(name)) {
    const command = firstString(args, ['command', 'cmd']);
    // pwsh 的 command 里常见 `bash -c "…"` 套娃：入口门判的是首词（与 Bridge
    // 同口径），套娃内部的副作用不在覆盖范围（见文件头「定位边界」）。
    if (command) return { operation: 'proc.spawn', payload: { command: firstCommandWord(command) } };
  }
  const filePath = firstString(args, ['path', 'file_path', 'filePath']);
  if (filePath) {
    if (READ_TOOLS.has(name)) return { operation: 'fs.read', payload: { path: filePath } };
    if (WRITE_TOOLS.has(name)) return { operation: 'fs.write', payload: { path: filePath } };
  }
  if (FETCH_TOOLS.has(name)) {
    const url = firstString(args, ['url', 'href']);
    if (url) {
      try {
        const parsed = new URL(url);
        const port = parsed.port
          ? Number(parsed.port)
          : (parsed.protocol === 'https:' ? 443 : 80);
        return { operation: 'net.outbound', payload: { host: parsed.hostname, port } };
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
      patchBuiltins: config.patchBuiltins === true,
      // 判定不再经由 registerPreExecute 直挂事件：waterfall 契约要求
      // (exec, next) 包装与映射层，check 在下面的 handler 里手动调用。
    });
  } catch (error) {
    // 装载失败只标记本插件，不拖垮宿主其余插件树。
    console.warn(`[dsh-covenant] activate failed: ${error.message}`);
    return;
  }
  // activate() 返回 { id, runtime, deactivate }：guard 在内层 runtime 上。
  const guard = runtime.runtime.guard;

  // tools/pre-execute waterfall：判定链的真正入口（旧版监听 'pre-execute'，
  // DSH 核心只发 tools/pre-execute——判定链因此一次都没跑过）。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const req = mapToolRequest(exec);
    if (!req) return next();
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
    if (!decision.allowed && enforce) {
      return { kind: 'deny', reason: `[dsh-covenant] ${decision.reason}` };
    }
    // advisory 模式：deny 也放行——账本已如实落了一条 decision=deny + intercepted=false，
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
