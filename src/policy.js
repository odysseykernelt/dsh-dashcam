'use strict';

const { normalizeGrant } = require('./contract/capabilities');

/**
 * 可调上限集中在这里。
 * 这些值以前散落在各模块里写死（bridge 的 256、guards 的 10000、net 的 30s…），
 * 宿主想调只能改源码。现在统一走 policy.limits，默认值保持不变。
 */
const DEFAULT_LIMITS = Object.freeze({
  /** 单次 enforceBatch 的目标数上限（同步判定，超了要调用方分块）。 */
  batchTargets: 10_000,
  /** 异步 glob 迭代器的分块大小（同步 glob 不受影响）。 */
  globBatchSize: 256,
  /** 出网 fetch 的默认超时；0 = 不注入（交给调用方自己管）。 */
  fetchTimeoutMs: 30_000,
  /** 每 N 次判定抽样做一次完整性校验；0 = 关闭。 */
  integrityEvery: 64,
  /** mac 密钥的最小字节数。下界与默认值一致，拒绝配小绕过。 */
  minMacKeyBytes: 32,
});

/** 每个 limit 的合法下界，用于拒绝"看起来配了、其实让保护失效"的值。 */
const LIMIT_MINIMUMS = Object.freeze({
  batchTargets: 1,
  globBatchSize: 1,
  fetchTimeoutMs: 0,
  integrityEvery: 0,
  // 32 是 HMAC-SHA256 的安全长度；允许配更小等于允许把保护关掉，不接受。
  minMacKeyBytes: 32,
});

const DEFAULT_POLICY = Object.freeze({
  // 默认不授予任何能力。
  grants: Object.freeze([]),
  channels: Object.freeze({
    consumer: Object.freeze({
      maxRating: 'mature',
      blockedScenes: Object.freeze([]),
      commercialUse: Object.freeze(['allowed', 'noncommercial']),
    }),
    enterprise: Object.freeze({
      maxRating: 'teen',
      blockedScenes: Object.freeze([]),
      commercialUse: Object.freeze(['allowed']),
      requireEgressAllowlist: true,
    }),
  }),
  // 默认非侵入式：先装、再标注、运行时按契约拦截。
  // enforcement.mode='required' 时才把门禁结论升级为拒装（企业通道始终 required）。
  enforcement: Object.freeze({
    mode: 'advisory',        // 'advisory' | 'required'
    allowLegacy: false,      // required 模式下放行 legacy 的显式逃生开关
    requireSignature: false, // 签名默认只输出 Untrusted 标签
    strictPatch: false,      // true = Hook 装不完整就拒绝装载（默认只记账 + 标 ReviewRequired）
  }),
  limits: DEFAULT_LIMITS,
  // 能力注入：'handles' = require('fs') 返回封闭句柄；'global' = 原生 fs + Bridge 守卫。
  // 默认 global：存量插件零改动即可运行，守卫由 Bridge 补丁承担。
  // 'handles' 是显式选项——它会让 require('fs') 拿到封闭面，需要插件使用 ctx.handles。
  sandbox: Object.freeze({
    mode: 'global',
  }),
  // null 表示未配置；安全门禁会标记出来，企业通道要求显式配置。
  egressAllowlist: null,
  installScriptAllowlist: Object.freeze([
    /^node\s+(\.\/)?scripts\/install\.js$/,
    /^npm\s+ci\s+--ignore-scripts$/,
  ]),
  patchExtensions: Object.freeze(['.js', '.cjs', '.mjs', '.json', '.patch', '.diff', '.txt']),
  patchTargetRoots: null,
  credentialReview: Object.freeze({
    approvedTargets: Object.freeze([]),
    approvedPlugins: Object.freeze([]),
  }),
  oneSeal: Object.freeze({
    ttlMs: 60_000,
    sweepIntervalMs: 30_000,
  }),
  circuitBreaker: Object.freeze({
    falseKillRate: 0.02,
    abandonmentRate: 0.05,
    silentFailureRate: 0.01,
  }),
  scan: Object.freeze({
    includeNodeModules: false,
  }),
});

function mergeObject(base, override) {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value;
  }
  return result;
}

function loadPolicy(raw = {}, context = {}) {
  const policy = mergeObject(DEFAULT_POLICY, raw);
  policy.channels = {
    consumer: mergeObject(DEFAULT_POLICY.channels.consumer, raw.channels && raw.channels.consumer),
    enterprise: mergeObject(DEFAULT_POLICY.channels.enterprise, raw.channels && raw.channels.enterprise),
  };
  policy.enforcement = mergeObject(DEFAULT_POLICY.enforcement, raw.enforcement);
  policy.limits = resolveLimits({ limits: raw.limits });
  policy.sandbox = mergeObject(DEFAULT_POLICY.sandbox, raw.sandbox);
  policy.credentialReview = mergeObject(DEFAULT_POLICY.credentialReview, raw.credentialReview);
  policy.oneSeal = mergeObject(DEFAULT_POLICY.oneSeal, raw.oneSeal);
  policy.circuitBreaker = mergeObject(DEFAULT_POLICY.circuitBreaker, raw.circuitBreaker);
  policy.scan = mergeObject(DEFAULT_POLICY.scan, raw.scan);
  policy.grants = (raw.grants || []).map((grant, index) => normalizeGrant(grant, context, index));
  return policy;
}

/**
 * 把 policy.limits 与默认值合并，并做类型/范围校验。
 *
 * 为什么必须校验：`batchTargets: 'abc'` 会让 `payloads.length > limits.batchTargets`
 * 恒为 false——上限静默失效，属 fail-open；`integrityEvery: -1` 会让完整性校验静默关闭。
 * 配置错误应当尽早失败，而不是变成一处没人知道的空缺。
 */
function resolveLimits(policy = {}) {
  const merged = { ...DEFAULT_LIMITS, ...((policy && policy.limits) || {}) };
  for (const key of Object.keys(LIMIT_MINIMUMS)) {
    const value = merged[key];
    const minimum = LIMIT_MINIMUMS[key];
    if (!Number.isInteger(value) || value < minimum) {
      throw new Error(
        `policy.limits.${key} 非法：${JSON.stringify(value)}（要求 >= ${minimum} 的整数，默认 ${DEFAULT_LIMITS[key]}）`,
      );
    }
  }
  return merged;
}

module.exports = { DEFAULT_POLICY, DEFAULT_LIMITS, loadPolicy, resolveLimits };
