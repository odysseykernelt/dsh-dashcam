'use strict';

const { normalizeGrant } = require('./contract/capabilities');

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
  }),
  // 能力注入：'handles' = require('fs') 返回封闭句柄；'global' = 原生 fs。
  // LocalHost 默认 handles；activate() 默认 global（宿主自己也用 fs，不能替它换掉）。
  sandbox: Object.freeze({
    mode: 'handles',
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
  policy.sandbox = mergeObject(DEFAULT_POLICY.sandbox, raw.sandbox);
  policy.credentialReview = mergeObject(DEFAULT_POLICY.credentialReview, raw.credentialReview);
  policy.oneSeal = mergeObject(DEFAULT_POLICY.oneSeal, raw.oneSeal);
  policy.circuitBreaker = mergeObject(DEFAULT_POLICY.circuitBreaker, raw.circuitBreaker);
  policy.scan = mergeObject(DEFAULT_POLICY.scan, raw.scan);
  policy.grants = (raw.grants || []).map((grant, index) => normalizeGrant(grant, context, index));
  return policy;
}

module.exports = { DEFAULT_POLICY, loadPolicy };
