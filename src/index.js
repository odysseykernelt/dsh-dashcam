'use strict';

const path = require('node:path');
const { loadPolicy } = require('./policy');
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
  // activate 默认不重定向：宿主自己也用 fs，替它把 require('fs') 换掉是失礼的。
  // 真正需要封闭面的宿主要么用 LocalHost，要么显式传 sandbox: 'handles'。
  const sandboxMode = sandbox || 'global';
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
  const handles = sandboxMode === 'handles' ? createCapabilityHandles({ guard }) : null;
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

  if (typeof host.registerPreExecute === 'function') {
    host.registerPreExecute(runtime.guard.check);
  } else if (host && typeof host.on === 'function') {
    host.on('pre-execute', runtime.guard.check);
  }

  activeRuntimes += 1;
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
};
