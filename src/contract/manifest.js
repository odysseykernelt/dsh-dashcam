'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gateError } = require('../errors');
const { normalizeRequest } = require('./capabilities');

const REQUIRED_FIELDS = ['id', 'name', 'version', 'entry'];
const MANIFEST_FILE = 'manifest.json';
const SUPPORTED_SPEC = 'dsh-covenant/1';

/** 无 covenant 字段时的默认配置：不拒绝安装，按隔离档运行。 */
const LEGACY_DEFAULT = Object.freeze({ level: 'legacy', quarantine: true });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 解析 manifest。存在 covenant 字段即视为契约插件；
 * 不存在则标记 legacy，保留可读性但禁入企业通道。
 */
function parseManifest(raw, { file = MANIFEST_FILE, pluginRoot = process.cwd(), home } = {}) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return {
      manifest: null,
      errors: [gateError('contract', 'manifest_invalid', 'manifest 必须是 JSON 对象', { file })],
    };
  }

  for (const field of REQUIRED_FIELDS) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) {
      errors.push(gateError('contract', 'manifest_field_missing', `缺少或非法字段 ${field}`, {
        field,
        file,
      }));
    }
  }

  const hasCovenant = Object.prototype.hasOwnProperty.call(raw, 'covenant');
  const kind = hasCovenant ? 'covenant' : 'legacy';
  const covenant = {
    spec: null,
    requests: [],
    content: null,
    // 没有 covenant 时不拒绝，只生成隔离档默认配置（非侵入式防护）。
    level: hasCovenant ? 'covenant' : LEGACY_DEFAULT.level,
    quarantine: hasCovenant
      ? Boolean(isPlainObject(raw.covenant) && raw.covenant.quarantine === true)
      : LEGACY_DEFAULT.quarantine,
  };

  if (hasCovenant) {
    if (!isPlainObject(raw.covenant)) {
      errors.push(gateError('contract', 'covenant_invalid', 'covenant 必须是对象', {
        field: 'covenant',
        file,
      }));
    } else {
      covenant.spec = raw.covenant.spec;
      if (raw.covenant.spec !== SUPPORTED_SPEC) {
        errors.push(gateError('contract', 'covenant_spec_unsupported', `covenant.spec 必须是 ${SUPPORTED_SPEC}`, {
          field: 'covenant.spec',
          file,
        }));
      }
      covenant.content = raw.covenant.content ?? null;
      const capabilities = raw.covenant.capabilities;
      if (!isPlainObject(capabilities) || !Array.isArray(capabilities.requests)) {
        errors.push(gateError('contract', 'capability_requests_missing', 'covenant.capabilities.requests 必须是数组', {
          field: 'covenant.capabilities.requests',
          file,
        }));
      } else {
        capabilities.requests.forEach((item, index) => {
          try {
            covenant.requests.push(normalizeRequest(item, { pluginRoot, home }));
          } catch (error) {
            errors.push(gateError('contract', 'capability_request_invalid', error.message, {
              field: error.field || `covenant.capabilities.requests[${index}]`,
              file,
            }));
          }
        });
      }
    }
  }

  const manifest = {
    id: typeof raw.id === 'string' ? raw.id.trim() : null,
    name: typeof raw.name === 'string' ? raw.name.trim() : null,
    version: typeof raw.version === 'string' ? raw.version.trim() : null,
    entry: typeof raw.entry === 'string' ? raw.entry.trim() : null,
    kind,
    level: covenant.level,
    quarantine: covenant.quarantine,
    covenant,
    contributes: isPlainObject(raw.contributes) ? raw.contributes : null,
    patches: Array.isArray(raw.patches) ? raw.patches : [],
    scripts: isPlainObject(raw.scripts) ? raw.scripts : {},
    uninstall: isPlainObject(raw.uninstall) ? raw.uninstall : null,
    raw,
    file,
  };

  if (manifest.entry) {
    const entryPath = path.resolve(pluginRoot, manifest.entry);
    if (entryPath !== path.resolve(pluginRoot) && !entryPath.startsWith(`${path.resolve(pluginRoot)}${path.sep}`)) {
      errors.push(gateError('contract', 'entry_outside_plugin', 'entry 不能指向插件目录之外', {
        field: 'entry',
        file,
      }));
    }
  }

  return { manifest, errors };
}

function loadManifest(pluginRoot, options = {}) {
  const file = path.join(pluginRoot, MANIFEST_FILE);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return {
      manifest: null,
      errors: [gateError('contract', 'manifest_unreadable', `无法读取 ${MANIFEST_FILE}: ${error.message}`, { file })],
    };
  }
  return parseManifest(raw, { file, pluginRoot, ...options });
}

function isLegacy(manifest) {
  return Boolean(manifest) && manifest.kind === 'legacy';
}

/** 隔离档：legacy 默认 true，契约插件也可显式声明 quarantine。 */
function isQuarantined(manifest) {
  return Boolean(manifest) && (manifest.quarantine === true || Boolean(manifest.covenant && manifest.covenant.quarantine));
}

/** 企业通道只接受完整契约与 Charter 的插件。 */
function isEnterpriseEligible(manifest) {
  if (!manifest || manifest.kind !== 'covenant') return false;
  const content = manifest.covenant && manifest.covenant.content;
  return Boolean(content)
    && content.enterpriseExcluded === false
    && content.rating !== 'restricted'
    && typeof content.sourceFingerprint === 'string';
}

module.exports = {
  MANIFEST_FILE,
  SUPPORTED_SPEC,
  LEGACY_DEFAULT,
  parseManifest,
  loadManifest,
  isLegacy,
  isQuarantined,
  isEnterpriseEligible,
};
