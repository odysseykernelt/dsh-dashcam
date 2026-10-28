'use strict';

const { gateError } = require('../errors');

const RATINGS = Object.freeze(['general', 'teen', 'mature', 'restricted']);
const RATING_RANK = Object.freeze({ general: 0, teen: 1, mature: 2, restricted: 3 });
const COMMERCIAL_USE = Object.freeze(['allowed', 'noncommercial', 'prohibited']);

/** 最保守默认值：未填写即按 restricted / prohibited / 企业排除处理。 */
const CONSERVATIVE_CHARTER = Object.freeze({
  rating: 'restricted',
  scenes: Object.freeze([]),
  commercialUse: 'prohibited',
  sourceFingerprint: null,
  enterpriseExcluded: true,
});

const CHARTER_FIELDS = Object.freeze([
  'rating',
  'scenes',
  'commercialUse',
  'sourceFingerprint',
  'enterpriseExcluded',
]);

function resolveCharter(content) {
  const source = content && typeof content === 'object' ? content : {};
  const missingFields = CHARTER_FIELDS.filter((field) => source[field] === undefined || source[field] === null);
  const charter = {
    rating: RATINGS.includes(source.rating) ? source.rating : CONSERVATIVE_CHARTER.rating,
    scenes: Array.isArray(source.scenes)
      ? source.scenes.filter((scene) => typeof scene === 'string' && scene.trim()).map((scene) => scene.trim())
      : [],
    commercialUse: COMMERCIAL_USE.includes(source.commercialUse)
      ? source.commercialUse
      : CONSERVATIVE_CHARTER.commercialUse,
    sourceFingerprint: typeof source.sourceFingerprint === 'string' && source.sourceFingerprint.trim()
      ? source.sourceFingerprint.trim()
      : CONSERVATIVE_CHARTER.sourceFingerprint,
    enterpriseExcluded: typeof source.enterpriseExcluded === 'boolean'
      ? source.enterpriseExcluded
      : CONSERVATIVE_CHARTER.enterpriseExcluded,
  };
  return { charter, missingFields, defaultsUsed: missingFields.length > 0 };
}

function validateCharter(content, { file = 'manifest.json' } = {}) {
  const errors = [];
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return [gateError('charter', 'charter_missing', 'covenant.content 缺失或不是对象', {
      field: 'covenant.content',
      file,
    })];
  }
  for (const field of CHARTER_FIELDS) {
    if (content[field] === undefined || content[field] === null) {
      errors.push(gateError('charter', 'charter_field_missing', `缺少 Charter 字段 ${field}`, {
        field: `covenant.content.${field}`,
        file,
      }));
    }
  }
  if (content.rating !== undefined && !RATINGS.includes(content.rating)) {
    errors.push(gateError('charter', 'charter_rating_invalid', `rating 必须是 ${RATINGS.join(' / ')}`, {
      field: 'covenant.content.rating',
      file,
    }));
  }
  if (content.scenes !== undefined && !Array.isArray(content.scenes)) {
    errors.push(gateError('charter', 'charter_scenes_invalid', 'scenes 必须是字符串数组', {
      field: 'covenant.content.scenes',
      file,
    }));
  }
  if (content.commercialUse !== undefined && !COMMERCIAL_USE.includes(content.commercialUse)) {
    errors.push(gateError('charter', 'charter_commercial_invalid', `commercialUse 必须是 ${COMMERCIAL_USE.join(' / ')}`, {
      field: 'covenant.content.commercialUse',
      file,
    }));
  }
  if (content.sourceFingerprint !== undefined
    && (typeof content.sourceFingerprint !== 'string' || !/^sha256:[a-f0-9]{32,64}$/i.test(content.sourceFingerprint.trim()))) {
    errors.push(gateError('charter', 'charter_fingerprint_invalid', 'sourceFingerprint 必须是 sha256:<hex>', {
      field: 'covenant.content.sourceFingerprint',
      file,
    }));
  }
  if (content.enterpriseExcluded !== undefined && typeof content.enterpriseExcluded !== 'boolean') {
    errors.push(gateError('charter', 'charter_enterprise_invalid', 'enterpriseExcluded 必须是布尔值', {
      field: 'covenant.content.enterpriseExcluded',
      file,
    }));
  }
  return errors;
}

/**
 * Sieve 准入：按分级、场景、商用边界、企业排除逐项判断。
 * 返回的 reason 直接来自策略或字段值，不做二次包装。
 */
function evaluateAdmission(manifest, { channel = 'consumer', policy = {} } = {}) {
  const reasons = [];
  const warnings = [];
  const channelPolicy = (policy.channels && policy.channels[channel]) || {};
  const isEnterprise = channel === 'enterprise';

  const enforcement = (policy && policy.enforcement) || {};
  const strict = enforcement.mode === 'required';
  const legacyAllowlisted = enforcement.allowLegacy === true;

  if (manifest.kind === 'legacy') {
    if (isEnterprise) {
      return {
        admitted: false,
        charter: { ...CONSERVATIVE_CHARTER },
        reasons: [{ code: 'legacy_enterprise_excluded', field: 'covenant', reason: 'legacy 插件禁入企业通道' }],
        warnings,
      };
    }
    // 非侵入式：legacy 不再“不可装载”，而是以 quarantine 档运行，
    // 没有声明就没有任何能力可用（运行时 Two-Key 交集为空）。
    if (strict && !legacyAllowlisted) {
      return {
        admitted: false,
        charter: { ...CONSERVATIVE_CHARTER },
        reasons: [{
          code: 'legacy_not_admitted',
          field: 'covenant',
          reason: 'no covenant：legacy 插件在 required 模式下不可装载',
        }],
        warnings,
      };
    }
    warnings.push({
      code: legacyAllowlisted ? 'legacy_allowlisted_by_host' : 'legacy_conservative_defaults',
      reason: legacyAllowlisted
        ? '宿主 enforcement.allowLegacy=true，放行无契约插件并进入隔离档（审计已记录）'
        : 'legacy 插件按最保守 Charter 运行',
    });
    return {
      admitted: true,
      charter: { ...CONSERVATIVE_CHARTER },
      quarantine: true,
      reasons,
      warnings,
    };
  }

  const content = manifest.covenant && manifest.covenant.content;
  if (!content || typeof content !== 'object') {
    return {
      admitted: false,
      charter: { ...CONSERVATIVE_CHARTER },
      reasons: [{ code: 'charter_missing', field: 'covenant.content', reason: 'covenant.content 缺失' }],
      warnings,
    };
  }

  const { charter, missingFields } = resolveCharter(content);
  if (missingFields.length > 0) {
    for (const field of missingFields) {
      reasons.push({
        code: 'charter_field_missing',
        field: `covenant.content.${field}`,
        reason: `缺少 Charter 字段 ${field}`,
      });
    }
    // 缺字段在门禁阶段即失败；此处仍返回保守画像，便于前端展示。
    return { admitted: false, charter, reasons, warnings };
  }

  const maxRating = channelPolicy.maxRating || (isEnterprise ? 'teen' : 'mature');
  if (RATING_RANK[charter.rating] > RATING_RANK[maxRating]) {
    reasons.push({
      code: 'rating_blocked',
      field: 'covenant.content.rating',
      reason: `${charter.rating} 超过通道上限 ${maxRating}`,
    });
  }

  const blockedScenes = Array.isArray(channelPolicy.blockedScenes) ? channelPolicy.blockedScenes : [];
  for (const scene of charter.scenes) {
    if (blockedScenes.includes(scene)) {
      reasons.push({
        code: 'scene_blocked',
        field: 'covenant.content.scenes',
        reason: scene,
      });
    }
  }

  const commercialAllowed = Array.isArray(channelPolicy.commercialUse)
    ? channelPolicy.commercialUse
    : (isEnterprise ? ['allowed'] : ['allowed', 'noncommercial']);
  if (!commercialAllowed.includes(charter.commercialUse)) {
    reasons.push({
      code: 'commercial_blocked',
      field: 'covenant.content.commercialUse',
      reason: `${charter.commercialUse} 不被 ${channel} 通道接受`,
    });
  }

  if (isEnterprise && charter.enterpriseExcluded) {
    reasons.push({
      code: 'enterprise_excluded',
      field: 'covenant.content.enterpriseExcluded',
      reason: '发布者声明 enterpriseExcluded=true',
    });
  }
  if (isEnterprise && channelPolicy.requireEgressAllowlist && !policy.egressAllowlist) {
    reasons.push({
      code: 'egress_allowlist_not_configured',
      field: 'policy.egressAllowlist',
      reason: '企业通道要求显式出站 allowlist',
    });
  }

  return { admitted: reasons.length === 0, charter, reasons, warnings };
}

module.exports = {
  RATINGS,
  RATING_RANK,
  COMMERCIAL_USE,
  CONSERVATIVE_CHARTER,
  CHARTER_FIELDS,
  resolveCharter,
  validateCharter,
  evaluateAdmission,
};
