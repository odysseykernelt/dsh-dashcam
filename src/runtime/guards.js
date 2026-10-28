'use strict';

const { CovenantDenied } = require('../errors');
const { authorizeAccess } = require('../contract/two-key');
const { deriveOperation } = require('./derive');

function recordLedger(ledger, record) {
  if (!ledger) return null;
  try {
    return ledger.append(record);
  } catch (error) {
    // 已经是 Ledger 自身的失败就原样抛出，避免错误信息被反复嵌套。
    if (error instanceof CovenantDenied && error.ruleId === 'ledger') throw error;
    // 审计写不进去时失败关闭，宁可拒绝执行。
    throw new CovenantDenied(`Ledger 写入失败：${String((error && error.message) || error).slice(0, 300)}`, {
      capability: record.capability,
      scope: record.scope,
      ruleId: 'ledger',
    });
  }
}

/**
 * 守卫链：推导能力 → 查授予 → 判定 → 写 Ledger。
 * bridge 只负责把原始调用翻译成 operation，所有判定集中在这里。
 */
function createGuardChain({
  manifest,
  grants = [],
  ledger = null,
  seal = null,
  blacklist = null,
  policy = {},
  pluginRoot = process.cwd(),
  home,
  onEvent = null,
  nativeHooks = false,
} = {}) {
  let compromised = null;
  let hooks = null;
  // 装载窗口：Hook 已经装好，但宿主还在 require 插件入口。
  // 窗口内照常判定、照常记账，只是不把拒绝抛出去——否则任何 legacy 插件的
  // 第一次 fs 调用都会让「安装」失败，非侵入式就名存实亡了。
  let observeDepth = 0;
  const stats = { requests: 0, allowed: 0, denied: 0, intercepted: 0, observed: 0, errors: 0, oneSealConsumed: 0 };

  function emit(event) {
    if (typeof onEvent === 'function') {
      try {
        onEvent(event);
      } catch {
        // 事件回调不能影响判定。
      }
    }
  }

  function check(operation, payload = {}) {
    stats.requests += 1;
    const ctx = { pluginRoot, home };
    let derived;
    try {
      derived = deriveOperation(operation, payload, ctx);
    } catch (error) {
      stats.denied += 1;
      const denial = {
        allowed: false,
        code: 'derive_failed',
        reason: error.message,
        capability: 'unknown',
        scope: null,
        action: operation,
      };
      denial.ledgerSeq = recordLedger(ledger, {
        plugin: manifest && manifest.id,
        pluginVersion: manifest && manifest.version,
        capability: denial.capability,
        action: denial.action,
        scope: denial.scope,
        decision: 'deny',
        ruleId: 'derive',
        reason: denial.reason,
        intercepted: true,
      })?.seq || null;
      emit({ type: 'deny', ...denial });
      return denial;
    }

    const base = {
      capability: derived.capability,
      scope: derived.scope,
      action: derived.action,
    };

    let denial = null;
    let authorization = null;
    let reservedSealId = null;
    if (compromised) {
      denial = {
        allowed: false,
        code: 'integrity_compromised',
        reason: `运行时完整性已被破坏：${compromised}`,
        ...base,
      };
    } else if (blacklist && manifest && blacklist.isBlocked(manifest.id)) {
      denial = {
        allowed: false,
        code: 'blacklisted',
        reason: '插件在应急黑名单中，禁止一切能力',
        ...base,
      };
    } else {
      const now = seal && typeof seal.now === 'function' ? seal.now() : Date.now();
      authorization = authorizeAccess({
        manifest,
        grants,
        capability: derived.capability,
        scope: derived.scope,
        seal,
        now,
      });
      if (!authorization.allowed) {
        denial = {
          allowed: false,
          code: authorization.code,
          reason: authorization.reason,
          ...base,
        };
      } else if (authorization.grant.oneSeal) {
        // 两阶段：先 reserve，Ledger 写成功后再 commit。
        // 直接 consume 会让「审计写失败」这种瞬时故障永久烧掉一次性授权。
        try {
          seal.reserve(authorization.grant.id);
          reservedSealId = authorization.grant.id;
        } catch (error) {
          denial = {
            allowed: false,
            code: 'one_seal_exhausted',
            reason: error.message,
            ...base,
          };
        }
      }
    }

    if (denial) {
      statisticsIncrement(stats, 'denied');
      const intercepted = isInterceptionCode(denial.code);
      if (intercepted) stats.intercepted += 1;
      const entry = recordLedger(ledger, {
        plugin: manifest && manifest.id,
        pluginVersion: manifest && manifest.version,
        capability: denial.capability,
        action: denial.action,
        scope: denial.scope,
        decision: 'deny',
        ruleId: denial.code,
        reason: denial.reason,
        intercepted,
      });
      denial.ledgerSeq = entry ? entry.seq : null;
      denial.intercepted = intercepted;
      if (observeDepth > 0) {
        stats.observed += 1;
        const observed = {
          allowed: true,
          ...base,
          observed: true,
          observedReason: denial.reason,
          observedCode: denial.code,
          ledgerSeq: denial.ledgerSeq,
        };
        emit({ type: 'observe', reason: denial.reason, ...observed });
        return observed;
      }
      emit({ type: 'deny', ...denial });
      return denial;
    }

    statisticsIncrement(stats, 'allowed');
    let entry;
    try {
      entry = recordLedger(ledger, {
        plugin: manifest && manifest.id,
        pluginVersion: manifest && manifest.version,
        capability: base.capability,
        action: base.action,
        scope: base.scope,
        decision: 'allow',
        ruleId: 'two-key',
        reason: declaredReasonOf(authorization),
        intercepted: false,
      });
    } catch (error) {
      // 审计没写进去就不算放行，也不能把一次性授权留在已消费状态。
      if (reservedSealId) releaseSeal(seal, reservedSealId);
      throw error;
    }
    if (reservedSealId) {
      commitSeal(seal, reservedSealId);
      stats.oneSealConsumed += 1;
    }
    const result = {
      allowed: true,
      ...base,
      ledgerSeq: entry ? entry.seq : null,
    };
    emit({ type: 'allow', ...result });
    return result;
  }

  function enforce(operation, payload = {}) {
    const decision = check(operation, payload);
    if (!decision.allowed) {
      throw new CovenantDenied(decision.reason, {
        capability: decision.capability,
        scope: decision.scope,
        ruleId: decision.code,
        ledgerSeq: decision.ledgerSeq,
      });
    }
    return decision;
  }

  /**
   * 在守卫入口安装 Node 原生模块 Hook。Hook 只负责把真实调用翻译成 operation，
   * 判定仍然全部回到 check()，因此 Two-Key 与 Ledger 语义不变。
   */
  function installNativeHooks(options = {}) {
    if (hooks) return hooks;
    // 延迟 require：bridge 依赖 derive，guards 依赖 bridge 会形成循环引用。
    const { createBridge } = require('./bridge');
    hooks = createBridge({
      guard: api,
      ledger,
      plugin: manifest,
      ...options,
    });
    return hooks;
  }

  function uninstallNativeHooks() {
    if (!hooks) return;
    hooks.uninstall();
    hooks = null;
  }

  function beginObserve() {
    observeDepth += 1;
    return observeDepth;
  }

  function endObserve() {
    if (observeDepth > 0) observeDepth -= 1;
    return observeDepth;
  }

  const api = {
    check,
    enforce,
    stats,
    manifest,
    beginObserve,
    endObserve,
    isObserving() {
      return observeDepth > 0;
    },
    coverage() {
      if (hooks && typeof hooks.coverage === 'function') return hooks.coverage();
      return {
        entries: 0,
        guarded: [],
        knownGaps: ['原生 Hook 尚未安装：此时没有任何入口受控'],
        caveat: '未安装 Hook 时守卫链只能靠宿主显式调用。',
      };
    },
    installNativeHooks,
    uninstallNativeHooks,
    get hooks() {
      return hooks;
    },
    setCompromised(reason) {
      compromised = reason || 'unknown';
    },
    isCompromised() {
      return Boolean(compromised);
    },
    setGrants(nextGrants) {
      grants = nextGrants || [];
    },
  };

  if (nativeHooks) installNativeHooks();
  return api;
}

function isInterceptionCode(code) {
  return code === 'not_declared' || code === 'legacy' || code === 'derive_failed';
}

function statisticsIncrement(stats, key) {
  stats[key] += 1;
}

/**
 * 审计里的 reason 必须来自「真正覆盖本次请求」的那条声明，
 * 而不是同能力的第一条：一个插件声明两次 net.outbound（一次上报指标、
 * 一次下载依赖）时，账本里不能永远只有第一条的理由。
 * two-key 已经把命中项算好了（declaredReason），这里不再重算。
 */
function declaredReasonOf(authorization) {
  if (authorization && typeof authorization.declaredReason === 'string') return authorization.declaredReason;
  return '';
}

function releaseSeal(seal, grantId) {
  if (!seal || typeof seal.release !== 'function') return;
  try {
    seal.release(grantId);
  } catch {
    // 释放失败交由 TTL 清扫兜底，不覆盖原始错误。
  }
}

function commitSeal(seal, grantId) {
  if (!seal || typeof seal.commit !== 'function') return;
  try {
    seal.commit(grantId);
  } catch {
    // commit 失败时条目仍是 reserved，会被 sweep 清理；
    // 本次 allow 审计已写入，所以不在此处回滚。
  }
}

module.exports = { createGuardChain };
