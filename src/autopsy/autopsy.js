'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadManifest } = require('../contract/manifest');
const { validateCharter } = require('../contract/charter');
const { scanPlugin } = require('../gates/safety');
const { loadPolicy } = require('../policy');
const { SIGNATURE_FILE } = require('../signing/bundle');
const { composeActivation } = require('./activation');

const SEGMENTS = ['existence', 'declaration', 'activation', 'registration', 'capability', 'uninstall'];

function newSegment(name) {
  return { name, status: 'pass', checks: [], missing: [] };
}

function missing(segment, item, detail, extra = {}) {
  segment.status = 'fail';
  segment.missing.push({ segment: segment.name, item, detail, ...extra });
}

function warnMissing(segment, item, detail, extra = {}) {
  if (segment.status === 'pass') segment.status = 'warn';
  segment.missing.push({ segment: segment.name, item, detail, ...extra });
}

/**
 * Autopsy：离线从包本身推导安装结果，不启动宿主。
 * 分段：存在 → 声明 → 激活 → 注册 → 能力 → 卸载。
 */
function runAutopsy({
  pluginDir,
  profile = undefined,
  bundlePatch = [],
  policy: policyInput = {},
  requireSignature = true,
} = {}) {
  const root = path.resolve(pluginDir);
  const policy = loadPolicy(policyInput);
  const segments = [];
  const generatedAt = new Date().toISOString();

  const existence = newSegment('existence');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    missing(existence, 'pluginDir', '插件目录不存在', { file: root });
  }
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) missing(existence, 'manifest.json', '缺少 manifest.json', { file: 'manifest.json' });
  let rawManifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      existence.checks.push({ item: 'manifest.json', ok: true });
    } catch (error) {
      missing(existence, 'manifest.json', `manifest.json 解析失败：${error.message}`, { file: 'manifest.json', line: 1 });
    }
  }
  if (rawManifest && typeof rawManifest.entry === 'string') {
    const entryPath = path.resolve(root, rawManifest.entry);
    if (!fs.existsSync(entryPath)) {
      missing(existence, rawManifest.entry, '入口文件不存在', { file: rawManifest.entry, line: 1 });
    } else {
      existence.checks.push({ item: rawManifest.entry, ok: true });
    }
  }
  if (requireSignature && !fs.existsSync(path.join(root, SIGNATURE_FILE))) {
    missing(existence, SIGNATURE_FILE, '缺少签名文件', { file: SIGNATURE_FILE });
  }
  segments.push(existence);

  const declaration = newSegment('declaration');
  const loaded = loadManifest(root);
  for (const error of loaded.errors) {
    missing(declaration, error.field || error.code, error.message, { file: error.file, line: error.line });
  }
  const manifest = loaded.manifest;
  if (manifest && manifest.kind === 'legacy') {
    warnMissing(declaration, 'dashcam', 'legacy 插件缺少 dashcam 声明，只能进入消费通道', {
      file: 'manifest.json',
    });
  }
  if (manifest && manifest.kind === 'dashcam') {
    const charterErrors = validateCharter(manifest.dashcam.content, { file: 'manifest.json' });
    for (const error of charterErrors) {
      missing(declaration, error.field, error.message, { file: error.file, line: error.line });
    }
  }
  segments.push(declaration);

  const activation = newSegment('activation');
  let composed = null;
  if (profile === undefined) {
    activation.status = 'skip';
    activation.missing.push({
      segment: 'activation',
      item: 'profile',
      detail: '未提供宿主 profile，无法离线组合激活状态',
    });
  } else if (manifest) {
    try {
      composed = composeActivation(profile, bundlePatch, manifest.id);
      activation.checks.push({
        item: 'bundlePatch',
        ok: true,
        applied: composed.applied,
        reasons: composed.reasons,
      });
      if (!composed.enabled) {
        missing(activation, 'activation', `profile + bundle patch 未启用 ${manifest.id}`, {
          detail: composed.reasons.join('；'),
        });
      }
    } catch (error) {
      missing(activation, 'bundlePatch', `bundle patch 无法离线应用：${error.message}`);
    }
  }
  segments.push(activation);

  const registration = newSegment('registration');
  if (!manifest) {
    registration.status = 'skip';
    registration.missing.push({ segment: 'registration', item: 'manifest', detail: '缺少 manifest，无法推导注册项' });
  } else {
    const registrations = manifest.contributes && Array.isArray(manifest.contributes.registrations)
      ? manifest.contributes.registrations
      : null;
    if (!registrations) {
      missing(registration, 'contributes.registrations', '缺少注册项声明', { file: 'manifest.json' });
    } else if (registrations.length === 0) {
      missing(registration, 'contributes.registrations', '注册项声明为空', { file: 'manifest.json' });
    } else {
      const seen = new Set();
      for (const [index, entry] of registrations.entries()) {
        if (!entry || typeof entry !== 'object' || !entry.type || !entry.id) {
          missing(registration, `contributes.registrations[${index}]`, '注册项必须包含 type 与 id', { file: 'manifest.json' });
          continue;
        }
        const key = `${entry.type}:${entry.id}`;
        if (seen.has(key)) {
          missing(registration, key, '注册项重复', { file: 'manifest.json' });
        }
        seen.add(key);
        const existing = composed && Array.isArray(composed.profile.registry)
          ? composed.profile.registry.find((item) => (typeof item === 'string' ? item === key : `${item.type}:${item.id}` === key))
          : null;
        if (existing) {
          missing(registration, key, 'profile 中已存在同名注册项', { file: 'manifest.json' });
        }
      }
      if (registration.status === 'pass') registration.checks.push({ item: 'registrations', ok: true, count: registrations.length });
    }
  }
  segments.push(registration);

  const capability = newSegment('capability');
  if (manifest) {
    const scanResult = scanPlugin(root, { policy, manifest });
    for (const error of scanResult.errors) {
      missing(capability, error.code, error.message, { file: error.file, line: error.line, field: error.field });
    }
    const requests = (manifest.dashcam && manifest.dashcam.requests) || [];
    const grantedCapabilities = new Set((policy.grants || []).filter((grant) => grant.enabled !== false).map((grant) => grant.capability));
    for (const request of requests) {
      if (!grantedCapabilities.has(request.capability)) {
        warnMissing(capability, `grant:${request.capability}`, '策略中缺少对应授予，运行时会被拒绝', { file: 'manifest.json' });
      }
    }
    capability.checks.push({
      item: 'scan',
      ok: true,
      filesScanned: scanResult.scan.filesScanned,
      capabilities: scanResult.scan.capabilities,
      declared: requests.map((request) => request.capability),
      granted: [...grantedCapabilities],
    });
  } else {
    capability.status = 'skip';
    capability.missing.push({ segment: 'capability', item: 'manifest', detail: '缺少 manifest，无法扫描能力面' });
  }
  segments.push(capability);

  const uninstall = newSegment('uninstall');
  if (manifest) {
    if (manifest.patches.length > 0) {
      const reverse = manifest.uninstall && Array.isArray(manifest.uninstall.reversePatches)
        ? manifest.uninstall.reversePatches
        : null;
      if (!reverse) {
        missing(uninstall, 'uninstall.reversePatches', '存在 patch 但缺少逆向 patch 声明', { file: 'manifest.json' });
      } else if (reverse.length !== manifest.patches.length) {
        missing(uninstall, 'uninstall.reversePatches', `逆向 patch 数量 ${reverse.length} 与 patch 数量 ${manifest.patches.length} 不一致`, {
          file: 'manifest.json',
        });
      }
    }
    if (manifest.uninstall && Array.isArray(manifest.uninstall.remove)) {
      for (const target of manifest.uninstall.remove) {
        const resolved = path.resolve(root, String(target));
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          missing(uninstall, `uninstall.remove:${target}`, '卸载删除路径越出插件目录', { file: 'manifest.json' });
        }
      }
    }
    if (uninstall.status === 'pass') uninstall.checks.push({ item: 'uninstall', ok: true });
  } else {
    uninstall.status = 'skip';
  }
  segments.push(uninstall);

  const allMissing = segments.flatMap((segment) => segment.missing);
  return {
    plugin: manifest ? manifest.id : (rawManifest && rawManifest.id) || null,
    generatedAt,
    offline: true,
    ok: segments.every((segment) => segment.status !== 'fail'),
    segments,
    missing: allMissing,
  };
}

module.exports = { runAutopsy, SEGMENTS };
