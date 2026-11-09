'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { loadManifest } = require('../contract/manifest');

/** 默认的环境变量名：宿主不传任何参数时也会看它。 */
const DEFAULT_MAC_KEY_ENV = 'DSH_DASHCAM_MAC_KEY';
/** HMAC 密钥下限。短于此长度的密钥不值得拿来防篡改。 */
const MIN_MAC_KEY_BYTES = 32;

/** 带 code 的密钥错误：CLI 可以据此只打消息、不打整段 stack。 */
function macKeyError(message) {
  const error = new Error(message);
  error.code = 'mac_key_invalid';
  return error;
}

function normalizeMacKey(value, minBytes = MIN_MAC_KEY_BYTES) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  const bytes = Buffer.byteLength(text, 'utf8');
  // 调用方传的 minBytes 只能抬高、不能低于安全下限：否则「可调」就成了绕过口。
  const floor = Math.max(Number(minBytes) || 0, MIN_MAC_KEY_BYTES);
  if (bytes < floor) {
    // 只报长度，不回显密钥：错误消息也会进日志。
    throw macKeyError(`mac 密钥太短：至少 ${floor} 字节（当前 ${bytes} 字节）`);
  }
  return text;
}

/**
 * 解析 Ledger 的 HMAC 密钥。优先级：直接传值 > 文件 > 环境变量。
 *
 * 三种来源任一显式给出却失败，都**抛错**，绝不静默退化成「无密钥的 v2」：
 * 那正是账本「看着有 mac、其实没人验」的来源。默认环境变量缺失不算错（返回 none）。
 *
 * @returns {{key: string|null, source: 'value'|'file'|'env'|'none'}}
 */
function resolveLedgerMacKey({
  ledgerMacKey = null,
  ledgerMacKeyFile = null,
  ledgerMacKeyEnv = null,
  env = process.env,
  minBytes = MIN_MAC_KEY_BYTES,
} = {}) {
  const fromValue = normalizeMacKey(ledgerMacKey, minBytes);
  if (fromValue) return { key: fromValue, source: 'value' };

  if (ledgerMacKeyFile) {
    let raw;
    try {
      raw = fs.readFileSync(path.resolve(ledgerMacKeyFile), 'utf8');
    } catch (error) {
      throw macKeyError(`读取 mac 密钥文件失败：${ledgerMacKeyFile}（${error.code || error.message}）`);
    }
    const fromFile = normalizeMacKey(raw, minBytes);
    if (!fromFile) throw macKeyError(`mac 密钥文件为空：${ledgerMacKeyFile}`);
    return { key: fromFile, source: 'file' };
  }

  const explicitEnv = typeof ledgerMacKeyEnv === 'string' && ledgerMacKeyEnv.trim()
    ? ledgerMacKeyEnv.trim()
    : null;
  const envName = explicitEnv || DEFAULT_MAC_KEY_ENV;
  const fromEnv = normalizeMacKey((env || {})[envName], minBytes);
  if (fromEnv) return { key: fromEnv, source: 'env' };
  if (explicitEnv) {
    throw macKeyError(`环境变量 ${envName} 为空或不存在：显式指定了密钥来源就必须给得出密钥`);
  }
  return { key: null, source: 'none' };
}
const { runInstallPipeline, readRawPluginId } = require('../gates/index');
const { loadPolicy, resolveLimits } = require('../policy');
const { Ledger } = require('../runtime/ledger');
const { OneSealStore } = require('../runtime/one-seal');
const { createGuardChain } = require('../runtime/guards');
const { createCapabilityHandles, createModuleRedirect } = require('../runtime/handles');
const { buildPluginFacade } = require('../runtime/facade');

/**
 * LocalHost：可装载性门禁使用的真实宿主适配器。
 * 装 → 注册（加载入口并安装 Bridge）→ 调用 → 卸载，四段都真正执行。
 */
class LocalHost {
  constructor({
    // N1：默认账本路径按实例区分（profile 未传时为 default）——账本是单写者
    // 契约，两个实例共用同一文件会互相判「并发写入」而卡死。
    profile = null,
    ledgerPath = path.join(process.cwd(), `.dsh-ledger-${profile || 'default'}.jsonl`),
    ledgerMacKey = null,
    ledgerMacKeyFile = null,
    ledgerMacKeyEnv = null,
    policy = {},
    blacklist = null,
    trust = null,
    channel = 'consumer',
  } = {}) {
    this.rawPolicy = policy;
    this.policy = loadPolicy(policy);
    this.baseLedgerPath = ledgerPath;
    const resolvedMac = resolveLedgerMacKey({
      ledgerMacKey,
      ledgerMacKeyFile,
      ledgerMacKeyEnv,
      minBytes: resolveLimits(this.policy).minMacKeyBytes,
    });
    this.ledgerMacKey = resolvedMac.key;
    this.macKeySource = resolvedMac.source;
    this.blacklist = blacklist;
    this.trust = trust;
    this.channel = channel;
    this.enforcement = this.policy.enforcement;
    this.installed = new Map();
    this.modules = new Map();
    this.reports = new Map();
    this.active = null;
    this.lastLedger = null;
  }

  // 私有：准入重入标志。之前是公开属性，任何调用方写一行 host.admitting = true
  // 就能跳过全部门禁，等于把后门焊在门框上。
  #admitting = false;

  /** required 模式下宿主自己就是执行点；advisory 下只收集画像标签。 */
  get enforcing() {
    return this.enforcement.mode === 'required';
  }

  async install(pluginDir) {
    // 非侵入式：先跑一遍门禁收集标签；只有恶意脚本/黑名单才真正阻断。
    // admitting 只用于打断 runInstallPipeline → checkLoadability → install 的重入。
    if (!this.#admitting) {
      this.#admitting = true;
      try {
        await this.admit(pluginDir);
      } finally {
        this.#admitting = false;
      }
    }
    const { manifest, errors } = loadManifest(pluginDir);
    if (!manifest || errors.length > 0) {
      throw new Error(`安装失败：${errors.map((error) => error.message).join('；')}`);
    }
    const entry = path.join(pluginDir, manifest.entry);
    this.installed.set(manifest.id, { pluginDir, manifest, entry });
    return { id: manifest.id, version: manifest.version, labels: this.labels(manifest.id) };
  }

  /**
   * 准入 = 完整门禁流水线。只有 report.blocked（恶意脚本 / 黑名单）才抛错；
   * 其余问题记录为安全画像标签，挂在该插件上供 UI 展示。
   */
  async admit(pluginDir) {
    const report = await runInstallPipeline({
      pluginDir,
      channel: this.channel,
      policy: this.rawPolicy,
      trust: this.trust,
      blacklist: this.blacklist,
      skipSignature: this.enforcement.requireSignature === false,
      host: null,
    });
    const id = (report && report.plugin) || readRawPluginId(pluginDir);
    if (id) this.reports.set(id, report);
    this.recordAdmission(pluginDir, report);
    if (!report.ok) {
      const detail = report.errors.map((error) => `[${error.gate}] ${error.code} ${error.message}`).join('；');
      const failure = new Error(`准入拒绝：${detail}`);
      failure.codes = report.errors.map((error) => error.code);
      failure.report = report;
      throw failure;
    }
    return report;
  }

  /** 该插件的安全画像标签；未安装时返回空数组。 */
  labels(pluginId) {
    const report = this.reports.get(pluginId);
    return report ? report.labels : [];
  }

  /** 完整门禁报告（含扫描结果与阶段状态），供安装流程展示。 */
  report(pluginId) {
    return this.reports.get(pluginId) || null;
  }

  /** 准入决定本身也要留痕：谁放行的、依据哪条规则。审计失败按拒绝处理。 */
  recordAdmission(pluginDir, report) {
    const ledger = new Ledger(this.baseLedgerPath, { macKey: this.ledgerMacKey });
    const ok = Boolean(report && report.ok);
    ledger.append({
      plugin: (report && report.plugin) || readRawPluginId(pluginDir) || 'unknown',
      pluginVersion: null,
      capability: 'install',
      action: ok ? 'admit' : 'reject',
      scope: { channel: this.channel },
      decision: ok ? 'allow' : 'deny',
      ruleId: 'admission',
      reason: ok
        ? '宿主准入通过'
        : (report ? report.errors.map((error) => error.code).join(',') : 'report_missing'),
    });
    return ledger;
  }

  async register(pluginId) {
    const record = this.installed.get(pluginId);
    if (!record) throw new Error(`插件未安装：${pluginId}`);
    if (this.active) throw new Error(`已有活动 Bridge：${this.active}，LocalHost 一次只装载一个插件`);

    const ledger = new Ledger(this.baseLedgerPath, { macKey: this.ledgerMacKey });
    const seal = new OneSealStore({ ttlMs: this.policy.oneSeal.ttlMs });
    const pluginPolicy = loadPolicy(this.rawPolicy, { pluginRoot: record.pluginDir });
    const guard = createGuardChain({
      manifest: record.manifest,
      grants: pluginPolicy.grants,
      ledger,
      seal,
      blacklist: this.blacklist,
      policy: pluginPolicy,
      pluginRoot: record.pluginDir,
    });
    // 能力句柄始终可用：插件走 ctx.handles 就是封闭面，不看 sandbox 模式。
    // 只有 sandbox.mode='handles' 才额外把插件目录内的 require('fs') 重定向过来；
    // 默认 'global' 保持原生 fs，存量插件零改动。
    const sandboxed = pluginPolicy.sandbox.mode === 'handles';
    const handles = createCapabilityHandles({ guard, limits: resolveLimits(pluginPolicy) });
    // 入口源码由宿主先读出来：这次 fs 调用发生在 Hook 之前，属于宿主行为，
    // 不该被记成插件的一次未声明读取（否则 interceptions() 会变成噪音）。
    const resolvedEntry = path.resolve(record.entry);
    const entrySource = fs.readFileSync(resolvedEntry, 'utf8');

    // Hook 必须在装载之前装好：插件顶层代码同样是攻击面，不能是法外之地。
    const bridge = guard.installNativeHooks();
    // 默认只记账（H1）；strictPatch 打开时升级为拒绝装载。
    if (pluginPolicy.enforcement.strictPatch === true) {
      const coverage = guard.coverage();
      if (coverage.complete === false) {
        // 用 guard.uninstallNativeHooks() 而不是 bridge.uninstall()：
        // 前者会把 guard.hooks 置空，coverage() 才不会继续指向一个已卸载的 Bridge。
        guard.uninstallNativeHooks();
        const detail = (coverage.unpatched || []).map((item) => `${item.prop}(${item.reason})`).join(', ');
        throw new Error(`沙箱补丁不完整，按 strictPatch 拒绝装载：${detail || '未知入口'}`);
      }
    }
    // 重定向必须在 Hook 之后装：createBridge 自己也要 require 原生 fs。
    const redirect = sandboxed
      ? createModuleRedirect({ handles, pluginRoot: record.pluginDir })
      : null;
    let module;
    try {
      if (redirect) {
        redirect.install();
        redirect.enter();
      }
      // 装载 observe 窗口受 policy 控制（H2）：默认保持现状（改写为放行 +
      // 记账 deny+observed），存量 legacy 插件不至于装载即死；宿主置
      // enforcement.observeLoadWindow=false 后不再开窗——装载期越界照常
      // 抛出。strictPatch=true 是 fail-closed 模式（Hook 不完整即拒装），
      // 保留装载放行窗口与其精神矛盾，此时强制关窗且不可用配置重开。
      const observeLoadWindow = pluginPolicy.enforcement.observeLoadWindow !== false
        && pluginPolicy.enforcement.strictPatch !== true;
      if (observeLoadWindow) guard.beginObserve();
      try {
        module = compileEntry(resolvedEntry, entrySource);
      } finally {
        if (observeLoadWindow) guard.endObserve();
        if (redirect) redirect.exit();
        if (guard.stats.observed > 0) {
          // 装载窗口把拒绝改写为放行是一次明确的信任让步：它必须可见。
          console.warn(
            `[dsh-dashcam] 装载窗口：插件 ${pluginId} 顶层代码有 ${guard.stats.observed}` +
            ' 次越界调用被放行（已按 deny 记账）。该窗口可用 policy.enforcement.observeLoadWindow=false 关闭（越界将直接拒绝装载）。',
          );
        }
      }
    } catch (error) {
      if (redirect) redirect.uninstall();
      bridge.uninstall();
      throw new Error(`注册失败（加载入口）：${error.message}`);
    }
    this.lastLedger = ledger;
    this.active = { pluginId, ledger, seal, guard, bridge, handles, redirect };
    this.modules.set(pluginId, module);
    if (typeof module.activate === 'function') {
      // 交付面与 activate() 共用同一份定义（runtime/facade.js）：此前这里把裸
      // guard/ledger/seal 直接交给插件——ctx.guard.setGrants 自我授权、
      // uninstallNativeHooks 拆进程级 Hook、ctx.ledger.append/macKey 泄露审计
      // 材料，全部从这一处断掉。registerPreExecute 与 fs 是宿主集成真正需要
      // 的，保留；guard/ledger/seal 实例只留在 host 闭包（this.active）里。
      const facade = buildPluginFacade({ manifest: record.manifest, guard, handles });
      try {
        await module.activate({
          plugin: record.manifest,
          ...facade,
          fs: sandboxed ? handles.fs : fs,
          registerPreExecute: (handler) => {
            this.active.preExecute = handler;
          },
        });
      } catch (error) {
        // activate 抛错时必须回滚，否则宿主卡在「已有活动 Bridge」的半装载状态：
        // active / modules 已写入，Hook 与重定向已安装，后续注册会直接失败，
        // 而插件其实从未成功激活。
        // A2（三视角审查）：activate 是 await——等待期间宿主可能已经 uninstall 本插件
        // 并 register 了下一个插件。回滚只允许作用于「仍是自己的」活动记录：
        // 无条件 bridge.uninstall() + active=null 会把后注册插件的 Hook 拆掉、
        // 把它的注册记录抹掉。
        const ownsActive = this.active
          && this.active.pluginId === pluginId
          && this.active.bridge === bridge;
        try {
          if (typeof module.deactivate === 'function') await module.deactivate();
        } catch {
          // 回滚失败不掩盖原始错误。
        }
        if (ownsActive) {
          try {
            if (redirect) redirect.uninstall();
          } catch {
            // 同上。
          }
          try {
            bridge.uninstall();
          } catch {
            // 同上。
          }
          seal.stop();
          this.modules.delete(pluginId);
          this.active = null;
        }
        throw new Error(`注册失败（activate 抛错）：${error.message}`);
      }
    }
    return { id: pluginId, registered: true };
  }

  async invoke(pluginId, action = 'ping') {
    const module = this.modules.get(pluginId);
    if (!module) throw new Error(`插件未注册：${pluginId}`);
    if (typeof module.invoke === 'function') return module.invoke(action);
    if (typeof module.ping === 'function') return module.ping();
    return { ok: true, action };
  }

  async uninstall(pluginId) {
    const module = this.modules.get(pluginId);
    if (module && typeof module.deactivate === 'function') {
      try {
        await module.deactivate();
      } catch {
        // 卸载回调失败不阻断资源回收。
      }
    }
    if (this.active && this.active.pluginId === pluginId) {
      const { redirect, bridge, seal } = this.active;
      // active 先清零，再逐段回收（M6）：此前三行连续调用无 try，redirect.uninstall()
      // 一抛错就会跳过 bridge.uninstall() / seal.stop() / active 清理——旧 Hook
      // 继续判下一个插件。现在任何一步失败都不允许跳过其余清理；首个错误照常
      // 向调用方抛出（回收失败必须可见），但回收链一定走完。
      this.active = null;
      try {
        try {
          if (redirect) redirect.uninstall();
        } finally {
          bridge.uninstall();
        }
      } finally {
        seal.stop();
      }
    }
    this.modules.delete(pluginId);
    const record = this.installed.get(pluginId);
    if (record) {
      try {
        delete require.cache[require.resolve(record.entry)];
      } catch {
        // 入口可能已被清理。
      }
    }
    this.installed.delete(pluginId);
    return { id: pluginId, uninstalled: true };
  }

  ledger() {
    return this.lastLedger;
  }

  /**
   * 可安全打印的密钥配置摘要：**不含密钥本身**。
   * 日志、报告、coverage 都可以放心带上这个对象。
   */
  redact() {
    return {
      macEnabled: Boolean(this.ledgerMacKey),
      keyLength: this.ledgerMacKey ? Buffer.byteLength(this.ledgerMacKey, 'utf8') : 0,
      source: this.macKeySource || 'none',
    };
  }

  /** 当前活动 Hook 的覆盖自检；sandbox 模式另外给出模块重定向信息。 */
  coverage() {
    if (!this.active) return null;
    const hooks = this.active.guard.coverage();
    if (!this.active.redirect) return { ...hooks, sandbox: { kind: 'none', mode: 'global' } };
    return { ...hooks, sandbox: this.active.redirect.coverage() };
  }
}

/**
 * 编译执行入口模块（源码由调用方在安装 Hook 之前读好）。
 * 不用裸 require 的原因：require 内部会自己读文件，那次读取会被 Hook 记成
 * 插件的一次未声明 fs.read——记录是错的，会让 interceptions() 变成噪音。
 */
function compileEntry(entry, source) {
  const resolved = path.resolve(entry);
  // Bridge/Hook 建立在 CJS 模块图上；.mjs 走到 _compile 会按 CJS 解析，
  // 报一个和真实原因无关的 SyntaxError。
  if (path.extname(resolved) === '.mjs') {
    throw new Error('暂不支持 ESM 入口（.mjs）：运行时 Hook 基于 CommonJS 模块图');
  }
  const mod = new Module(resolved, null);
  mod.filename = resolved;
  mod.paths = Module._nodeModulePaths(path.dirname(resolved));
  if (typeof mod._compile !== 'function') return require(resolved);
  mod._compile(source, resolved);
  mod.loaded = true;
  require.cache[resolved] = mod;
  return mod.exports;
}

module.exports = {
  LocalHost,
  resolveLedgerMacKey,
  normalizeMacKey,
  DEFAULT_MAC_KEY_ENV,
  MIN_MAC_KEY_BYTES,
};
