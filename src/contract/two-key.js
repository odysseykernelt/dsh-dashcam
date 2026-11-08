'use strict';

const { findDeclaredRequest, describeScope, scopeCovers } = require('./capabilities');

/** 默认授予集：空数组，即 deny-all。 */
const DENY_ALL = Object.freeze([]);

function denial(code, reason, detail = {}) {
  return { allowed: false, code, reason, ...detail };
}

/**
 * Two-Key：声明 ∩ 授予。
 * 只有 manifest 声明（第一把钥匙）与宿主授予（第二把钥匙）同时覆盖，
 * 且 scope 被授权范围包含时，才返回 allowed=true。
 */
function authorizeAccess({
  manifest,
  grants = DENY_ALL,
  capability,
  scope,
  now = Date.now(),
  seal = null,
} = {}) {
  if (!manifest) return denial('manifest_missing', '缺少插件 manifest');
  if (manifest.kind === 'legacy') {
    return denial('legacy', 'legacy 插件没有 dashcam 声明，运行时拒绝一切能力');
  }

  const declared = (manifest.dashcam && manifest.dashcam.requests) || [];
  if (declared.length === 0) {
    return denial('not_declared', `${capability} 未在 manifest 中声明`, { capability, scope });
  }
  const declaration = findDeclaredRequest(declared, capability, scope);
  if (!declaration) {
    return denial('not_declared', `未声明的能力或范围：${capability} (${describeScope(capability, scope)})`, {
      capability,
      scope,
    });
  }

  const candidates = grants.filter((grant) => (
    grant.enabled !== false
    && grant.capability === capability
    && (grant.expiresAt === null || grant.expiresAt === undefined || grant.expiresAt > now)
  ));

  const scopeCandidates = candidates.filter((grant) => scopeCovers(capability, grant.scope, scope));
  const matching = scopeCandidates.filter((grant) => {
    if (!grant.oneSeal) return true;
    if (!seal) return false;
    return seal.isAvailable(grant.id, now);
  });

  if (matching.length === 0) {
    if (scopeCandidates.length > 0) {
      return denial('one_seal_exhausted', '一次性授予已使用或已过期', { capability, scope });
    }
    if (candidates.length > 0) {
      return denial('scope_mismatch', `授予存在但不覆盖请求范围：${capability} (${describeScope(capability, scope)})`, {
        capability,
        scope,
      });
    }
    return denial('not_granted', `宿主未授予能力：${capability} (${describeScope(capability, scope)})`, {
      capability,
      scope,
    });
  }

  // 一次性 grant 优先，避免长期 grant 被误用为无限授权。
  matching.sort((left, right) => Number(right.oneSeal) - Number(left.oneSeal));
  return {
    allowed: true,
    grant: matching[0],
    declaration: declaration,
    declaredReason: declaration.reason,
  };
}

function hasAnyGrant(grants, capability) {
  return gifts(capability, grants);
}

function gifts(capability, grants) {
  return (grants || []).some((grant) => grant.enabled !== false && grant.capability === capability);
}

module.exports = { DENY_ALL, authorizeAccess, hasAnyGrant };
