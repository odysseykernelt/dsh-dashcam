'use strict';

const path = require('node:path');
const { loadPolicy, resolveLimits } = require('./policy');
const { Ledger } = require('./runtime/ledger');
const { OneSealStore } = require('./runtime/one-seal');
const { createGuardChain } = require('./runtime/guards');
const { isQuarantined } = require('./contract/manifest');
const { resolveLedgerMacKey } = require('./host/local-host');
const { createCapabilityHandles, createModuleRedirect } = require('./runtime/handles');

const PLUGIN_ID = 'dsh-covenant';

/**
 * 进程内只能有一个活动运行时。
 * 原生 Hook 会叠加：第二个 Bridge 把第一个的包装器当成「原始函数」，
 * 于是判定只落在最外层那个 guard 上，内层账本静默漏记。
 * LocalHost 用 `if (this.active) throw` 保证了这一点，activate 以前没有。
 */
let activeRuntimes = 0;

/** 为一个插件建立独立受控运行时：守卫 + 一次性 grant + 可选 Bridge。 */
function createPluginRuntime({
  manifest,
  grants = [],
  policy: policyInput = {},
  ledgerPath = path.join(process.cwd(), '.dsh-ledger.jsonl'),
  ledgerMacKey = null,
  ledgerMacKeyFile = null,
  ledgerMacKeyEnv = null,
  ledger = null,
  seal = null,
  blacklist = null,
  pluginRoot = process.cwd(),
  patchBuiltins = true,
  autoSweep = true,
  sandbox = null,
} = {}) {
  const policy = loadPolicy(policyInput);
  // sandbox 的单一真相是 policy.sandbox.mode（默认 'global'）。
  // 参数 sandbox 只是显式覆盖，兼容两种写法：'handles' 字符串，或 { mode: 'handles' }。
  // 不能在这里硬编码 'global'：那会让 activate() 无视 policy，与 LocalHost 行为分叉，
  // 而且 { mode: 'handles' } 这种对象会因 truthy 被当成「开了」、实际却落回 global。
  const sandboxOverride = typeof sandbox === 'string'
    ? sandbox
    : (sandbox && typeof sandbox === 'object' ? sandbox.mode : null);
  const sandboxMode = sandboxOverride || policy.sandbox.mode || 'global';
  const resolvedMac = resolveLedgerMacKey({ ledgerMacKey, ledgerMacKeyFile, ledgerMacKeyEnv });
  const audit = ledger || new Ledger(ledgerPath, { macKey: resolvedMac.key });
  const seals = seal || new OneSealStore({ ttlMs: policy.oneSeal.ttlMs });
  const guard = createGuardChain({
    manifest,
    grants,
    ledger: audit,
    seal: seals,
    blacklist,
    policy,
    pluginRoot,
  });
  // Hook 挂在守卫入口：任何进入守卫链的调用都先经过原生模块 Hook 翻译，
  // 再由同一个 check() 做 Two-Key 判定并写 Ledger。
  const bridge = patchBuiltins ? guard.installNativeHooks() : null;
  const handles = sandboxMode === 'handles'
    ? createCapabilityHandles({ guard, limits: resolveLimits(policy) })
    : null;
  const redirect = handles
    ? createModuleRedirect({ handles, pluginRoot })
    : null;
  if (redirect) redirect.install();
  if (autoSweep) seals.startAutoSweep(policy.oneSeal.sweepIntervalMs);

  return {
    guard,
    bridge,
    handles,
    redirect,
    ledger: audit,
    seal: seals,
    quarantine: isQuarantined(manifest),
    dispose() {
      if (redirect) redirect.uninstall();
      if (bridge) bridge.uninstall();
      seals.stop();
    },
  };
}

/**
 * DeepSeek Harness 插件入口。
 * 宿主通过 registerPreExecute 获得判定函数；Hook 用于看护进程内 Node 调用。
 * 非侵入式：legacy 插件不拒绝激活，而是以 quarantine 档运行（没有声明就没有能力）。
 */
function activate(host = {}) {
  // 原生 Hook 会叠加：详见文件顶部 activeRuntimes 的注释。
  if (activeRuntimes > 0) {
    throw new Error(
      '同一进程只能有一个活动的 covenant 运行时：原生 Hook 会叠加，后装的会独吞判定。'
      + '请先 deactivate 上一个插件，或用 LocalHost 串行装载。',
    );
  }
  const runtime = createPluginRuntime({
    manifest: host.manifest,
    grants: host.grants || [],
    policy: host.policy || {},
    ledgerPath: host.ledgerPath,
    ledgerMacKey: host.ledgerMacKey || null,
    ledgerMacKeyFile: host.ledgerMacKeyFile || null,
    ledgerMacKeyEnv: host.ledgerMacKeyEnv || null,
    ledger: host.ledger,
    seal: host.seal,
    blacklist: host.blacklist,
    pluginRoot: host.pluginRoot,
    patchBuiltins: host.patchBuiltins !== false,
    autoSweep: host.autoSweep !== false,
    sandbox: host.sandbox || null,
  });

  // 先占位再注册回调：回调抛错时 Hook 已经装好了，若此时计数还是 0，
  // 下一次 activate 会顺利通过互斥检查并把 Hook 叠上去——正是这条互斥要防的事。
  activeRuntimes += 1;
  try {
    if (typeof host.registerPreExecute === 'function') {
      host.registerPreExecute(runtime.guard.check);
    } else if (host && typeof host.on === 'function') {
      host.on('pre-execute', runtime.guard.check);
    }
  } catch (error) {
    activeRuntimes -= 1;
    runtime.dispose();
    throw error;
  }
  let released = false;
  return {
    id: PLUGIN_ID,
    runtime,
    deactivate() {
      runtime.dispose();
      if (!released) {
        released = true;
        activeRuntimes -= 1;
      }
    },
  };
}

module.exports = {
  id: PLUGIN_ID,
  activate,
  createPluginRuntime,
  // 策略层
  ...require('./policy'),
  // 契约层
  ...require('./contract/capabilities'),
  ...require('./contract/manifest'),
  ...require('./contract/two-key'),
  ...require('./contract/charter'),
  // 运行时
  ...require('./runtime/derive'),
  ...require('./runtime/guards'),
  ...require('./runtime/ledger'),
  ...require('./runtime/one-seal'),
  ...require('./runtime/bridge'),
  ...require('./runtime/handles'),
  // 门禁
  ...require('./gates/index'),
  ...require('./gates/structure'),
  ...require('./gates/safety'),
  ...require('./gates/loadability'),
  // 签名
  ...require('./signing/trust'),
  ...require('./signing/bundle'),
  // 画像 / 诊断
  ...require('./portrait/portrait'),
  ...require('./autopsy/autopsy'),
  ...require('./autopsy/activation'),
  // 治理
  ...require('./governance/rollback'),
  ...require('./governance/blacklist'),
  ...require('./governance/metrics'),
  ...require('./governance/rollout'),
  // 宿主
  ...require('./host/local-host'),
  // 多进程运行时（原型）：只导出宿主入口，ipc/protocol、ipc/child 按路径直接 require。
  ChildHost: require('./host/child-host').ChildHost,
};
