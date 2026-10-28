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
  // 每 N 次判定抽样做一次完整性校验（0 = 关闭）。防线不接线等于不存在。
  integrityEvery = 64,
} = {}) {
  let compromised = null;
  let hooks = null;
  // 装载窗口：Hook 已经装好，但宿主还在 require 插件入口。
  // 窗口内照常判定、照常记账，只是不把拒绝抛出去——否则任何 legacy 插件的
  // 第一次 fs 调用都会让「安装」失败，非侵入式就名存实亡了。
  let observeDepth = 0;
  let integrityTicks = 0;
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

  /**
   * @param {{record?: boolean}} options record=false 时只判定、不写账本，
   *   供 enforceBatch 把成百上千个目标压成一条记录（判定仍然逐个做）。
   */
  function check(operation, payload = {}, options = {}) {
    const record = options.record !== false;
    stats.requests += 1;
    if (integrityEvery > 0 && hooks && ++integrityTicks >= integrityEvery) {
      integrityTicks = 0;
      try {
        hooks.verifyIntegrity();
      } catch {
        // 检测本身失败不改变本次判定；真被篡改时下一次判定会带 compromised。
      }
    }
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
      denial.ledgerSeq = record ? (recordLedger(ledger, {
        plugin: manifest && manifest.id,
        pluginVersion: manifest && manifest.version,
        capability: denial.capability,
        action: denial.action,
        scope: denial.scope,
        decision: 'deny',
        ruleId: 'derive',
        reason: denial.reason,
        intercepted: true,
      })?.seq || null) : null;
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
      const entry = record ? recordLedger(ledger, {
        plugin: manifest && manifest.id,
        pluginVersion: manifest && manifest.version,
        capability: denial.capability,
        action: denial.action,
        scope: denial.scope,
        decision: 'deny',
        ruleId: denial.code,
        reason: denial.reason,
        intercepted,
      }) : null;
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
    let entry = null;
    try {
      if (record) entry = recordLedger(ledger, {
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

  /**
   * 批量判定：每个目标都单独过 Two-Key，但**只写一条账本**。
   *
   * 存在理由：一次 glob / 目录遍历可以产生上万个目标，一条一个记录会把审计文件撑爆
   * （1 万条 = 1 万次 open/write/close）。所以判定不合并、只合并记账：
   * 拒绝时写一条 deny 并抛错（reason 原文照搬），全部通过时写一条 allow，
   * ruleId 为 'two-key-batch'，scope 里带 count。
   *
   * 注意：一次性授权（oneSeal）仍会按目标逐个消费——批量调用不要和 One-Seal 混用。
   */
  function enforceBatch(operation, payloads = []) {
    if (!Array.isArray(payloads) || payloads.length === 0) return enforce(operation, {});
    if (payloads.length > MAX_BATCH_TARGETS) {
      throw new CovenantDenied(
        `批量判定目标过多：${payloads.length} 超过上限 ${MAX_BATCH_TARGETS}，请调用方分块`,
        { ruleId: 'batch_too_large' },
      );
    }

    // 混合能力的批次不能只写「最后一个」（或第一个）能力名：那会把 cred.read
    // 藏进 fs.read 里，事后审计就看不到凭证访问了。收集去重集合，>1 就记 mixed。
    const capabilities = new Set();
    const actions = new Set();
    const noteCapability = (decision) => {
      if (decision.capability && decision.capability !== 'unknown') capabilities.add(decision.capability);
      if (decision.action) actions.add(decision.action);
    };
    for (let index = 0; index < payloads.length; index += 1) {
      const decision = check(operation, payloads[index], { record: false });
      noteCapability(decision);
      // observe 窗口里 check 会把拒绝「放行」并返回 observed:true（不抛错），
      // 但批量绝不能因此记成 allow：账本必须如实留一条 deny，否则账上说全过、
      // 实际有越界，统计计数器与账本互相矛盾。
      const denied = !decision.allowed || decision.observed === true;
      if (denied) {
        const code = decision.observed ? decision.observedCode : decision.code;
        const reason = decision.observed ? decision.observedReason : decision.reason;
        const intercepted = decision.observed
          ? (decision.intercepted === true || isInterceptionCode(decision.observedCode))
          : Boolean(decision.intercepted);
        // stats 已由 check 计过（denied / intercepted / observed），这里不重复计数。
        const entry = recordLedger(ledger, {
          plugin: manifest && manifest.id,
          pluginVersion: manifest && manifest.version,
          capability: decision.capability,
          action: decision.action,
          scope: { batch: true, count: index + 1, sample: decision.scope },
          decision: 'deny',
          ruleId: code,
          reason,
          intercepted,
        });
        const ledgerSeq = entry ? entry.seq : null;
        if (observeDepth > 0) {
          return {
            allowed: true,
            batch: true,
            observed: true,
            count: index + 1,
            observedCode: code,
            ledgerSeq,
          };
        }
        const denial = new CovenantDenied(reason, {
          capability: decision.capability,
          scope: decision.scope,
          ruleId: code,
          ledgerSeq,
        });
        denial.batch = { count: index + 1, index };
        throw denial;
      }
    }

    const capabilityList = [...capabilities];
    const actionList = [...actions];
    const capability = capabilityList.length === 0
      ? 'unknown'
      : (capabilityList.length === 1 ? capabilityList[0] : 'mixed');
    const action = actionList.length === 1 ? actionList[0] : operation;
    const entry = recordLedger(ledger, {
      plugin: manifest && manifest.id,
      pluginVersion: manifest && manifest.version,
      capability,
      action,
      scope: {
        batch: true,
        count: payloads.length,
        ...(capabilityList.length > 1 ? { capabilities: capabilityList } : {}),
      },
      decision: 'allow',
      ruleId: 'two-key-batch',
      reason: declaredReasonOf(authorizationForBatch(operation, payloads[0])),
      intercepted: false,
    });
    const result = {
      allowed: true,
      batch: true,
      capability,
      action,
      count: payloads.length,
      ledgerSeq: entry ? entry.seq : null,
    };
    emit({ type: 'allow', ...result });
    return result;
  }

  /** 只为拿到「真正覆盖第一项」的声明理由，不复用 check（它会计数、记账）。 */
  function authorizationForBatch(operation, payload) {
    try {
      const ctx = { pluginRoot, home };
      const derived = deriveOperation(operation, payload, ctx);
      return authorizeAccess({
        manifest,
        grants,
        capability: derived.capability,
        scope: derived.scope,
        seal,
        now: seal && typeof seal.now === 'function' ? seal.now() : Date.now(),
      });
    } catch {
      return null;
    }
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
    enforceBatch,
    stats,
    manifest,
    beginObserve,
    endObserve,
    isObserving() {
      return observeDepth > 0;
    },
    coverage() {
      const base = hooks && typeof hooks.coverage === 'function'
        ? hooks.coverage()
        : {
          entries: 0,
          guarded: [],
          unpatched: [],
          complete: false,
          knownGaps: ['原生 Hook 尚未安装：此时没有任何入口受控'],
          caveat: '未安装 Hook 时守卫链只能靠宿主显式调用。',
        };
      // 失陷状态必须能从外部看到，否则「已失陷」只活在 guard 的内存里。
      return { ...base, compromised: compromised ? String(compromised) : null };
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

/** 单次批量判定的目标数上限：同步逐条判定会阻塞事件循环，必须由调用方分块。 */
const MAX_BATCH_TARGETS = 10_000;

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
