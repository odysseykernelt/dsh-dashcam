'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir, defaultCharter } = require('./helpers/fixtures');
const { normalizeRequest, normalizeGrant, scopeCovers } = require('../src/contract/capabilities');
const { parseManifest, isEnterpriseEligible } = require('../src/contract/manifest');
const { authorizeAccess } = require('../src/contract/two-key');
const { resolveCharter, evaluateAdmission } = require('../src/contract/charter');

const root = path.resolve(tempDir('contract-'));
const ctx = { pluginRoot: root };

function manifestWith(requests) {
  return {
    id: 'com.example.demo',
    version: '1.0.0',
    kind: 'dashcam',
    dashcam: { requests },
  };
}

test('Two-Key：声明与授予同时覆盖才放行，默认授予集为空', () => {
  const request = normalizeRequest({ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取缓存' }, ctx);
  const manifest = manifestWith([request]);
  const scope = normalizeRequest({ cap: 'fs.read', scope: { paths: ['$PLUGIN/cache/a.json'] }, reason: 'x' }, ctx).scope;

  const denied = authorizeAccess({ manifest, grants: [], capability: 'fs.read', scope });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'not_granted');

  const grant = normalizeGrant({ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }, ctx, 0);
  const allowed = authorizeAccess({ manifest, grants: [grant], capability: 'fs.read', scope });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.grant.id, 'grant-0-fs.read');
});

test('Two-Key：未声明能力即使有授予也拒绝', () => {
  const manifest = manifestWith([]);
  const scope = normalizeGrant({ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }, ctx, 0).scope;
  const result = authorizeAccess({
    manifest,
    grants: [normalizeGrant({ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }, ctx, 0)],
    capability: 'fs.read',
    scope,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'not_declared');
});

test('Two-Key：授予范围不足时返回 scope_mismatch', () => {
  const request = normalizeRequest({ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: 'r' }, ctx);
  const manifest = manifestWith([request]);
  const scope = normalizeRequest({ cap: 'fs.read', scope: { paths: ['$PLUGIN/secrets/x'] }, reason: 'r' }, ctx).scope;
  const grant = normalizeGrant({ capability: 'fs.read', scope: { paths: ['$PLUGIN/cache/**'] } }, ctx, 0);
  const result = authorizeAccess({ manifest, grants: [grant], capability: 'fs.read', scope });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'scope_mismatch');
});

test('scope 语义：主机通配、环境变量前缀、命令与端口子集', () => {
  const hosts = normalizeGrant({ capability: 'net.outbound', scope: { hosts: ['*.example.com:443'] } }, ctx, 0).scope;
  assert.equal(scopeCovers('net.outbound', hosts, { hosts: ['api.example.com:443'] }), true);
  assert.equal(scopeCovers('net.outbound', hosts, { hosts: ['example.com:443'] }), false);
  assert.equal(scopeCovers('net.outbound', hosts, { hosts: ['api.example.com:80'] }), false);

  const env = normalizeGrant({ capability: 'env.read', scope: { keys: ['DEEPSEEK_*'] } }, ctx, 0).scope;
  assert.equal(scopeCovers('env.read', env, { keys: ['DEEPSEEK_KEY'] }), true);
  assert.equal(scopeCovers('env.read', env, { keys: ['OTHER_KEY'] }), false);

  const proc = normalizeGrant({ capability: 'proc.spawn', scope: { commands: ['node'] } }, ctx, 0).scope;
  assert.equal(scopeCovers('proc.spawn', proc, { commands: ['node'] }), true);
  assert.equal(scopeCovers('proc.spawn', proc, { commands: ['curl'] }), false);

  const listen = normalizeGrant({ capability: 'net.listen', scope: { address: '0.0.0.0', ports: [3000, 3001] } }, ctx, 0).scope;
  assert.equal(scopeCovers('net.listen', listen, { address: '127.0.0.1', ports: [3001] }), true);
  assert.equal(scopeCovers('net.listen', listen, { address: '127.0.0.1', ports: [3002] }), false);
});

test('凭证能力不能由 fs 声明替代', () => {
  const fsRequest = normalizeRequest({ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: 'r' }, ctx);
  const manifest = manifestWith([fsRequest]);
  const scope = normalizeRequest({ cap: 'cred.read', scope: { targets: ['$PLUGIN/.env'] }, reason: 'r' }, ctx).scope;
  const result = authorizeAccess({ manifest, grants: [], capability: 'cred.read', scope });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'not_declared');
});

test('legacy：无 dashcam 标记，运行时拒绝能力，企业通道拒绝', () => {
  const { manifest, errors } = parseManifest({
    id: 'com.example.legacy',
    name: 'Legacy',
    version: '1.0.0',
    entry: 'index.js',
  });
  assert.equal(errors.length, 0);
  assert.equal(manifest.kind, 'legacy');
  assert.equal(isEnterpriseEligible(manifest), false);
  const result = authorizeAccess({
    manifest,
    grants: [],
    capability: 'fs.read',
    scope: { paths: [path.join(root, 'x')] },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'legacy');
  const admission = evaluateAdmission(manifest, { channel: 'enterprise', policy: {} });
  assert.equal(admission.admitted, false);
});

test('Charter 默认最保守，缺字段在准入阶段失败', () => {
  const resolved = resolveCharter({});
  assert.equal(resolved.charter.rating, 'restricted');
  assert.equal(resolved.charter.commercialUse, 'prohibited');
  assert.equal(resolved.charter.enterpriseExcluded, true);
  assert.equal(resolved.missingFields.length, 5);

  const manifest = parseManifest({
    id: 'com.example.charter',
    name: 'Charter',
    version: '1.0.0',
    entry: 'index.js',
    dashcam: { spec: 'dsh-dashcam/1', capabilities: { requests: [] }, content: {} },
  }).manifest;
  const admission = evaluateAdmission(manifest, { channel: 'consumer', policy: {} });
  assert.equal(admission.admitted, false);
  assert.equal(admission.reasons.length, 5);
});

test('Sieve：分级、场景、商用边界与企业排除', () => {
  const manifest = parseManifest({
    id: 'com.example.sieve',
    name: 'Sieve',
    version: '1.0.0',
    entry: 'index.js',
    dashcam: {
      spec: 'dsh-dashcam/1',
      capabilities: { requests: [] },
      content: defaultCharter({ rating: 'mature', scenes: ['violence'], commercialUse: 'noncommercial', enterpriseExcluded: true }),
    },
  }).manifest;

  const consumer = evaluateAdmission(manifest, {
    channel: 'consumer',
    policy: { channels: { consumer: { maxRating: 'mature', blockedScenes: ['violence'], commercialUse: ['allowed', 'noncommercial'] } } },
  });
  assert.equal(consumer.admitted, false);
  assert.ok(consumer.reasons.some((reason) => reason.code === 'scene_blocked'));
  assert.equal(consumer.reasons.find((reason) => reason.code === 'scene_blocked').reason, 'violence');

  const enterprise = evaluateAdmission(manifest, { channel: 'enterprise', policy: { egressAllowlist: ['api.example.com:443'] } });
  assert.equal(enterprise.admitted, false);
  assert.ok(enterprise.reasons.some((reason) => reason.code === 'rating_blocked'));
  assert.ok(enterprise.reasons.some((reason) => reason.code === 'commercial_blocked'));
  assert.ok(enterprise.reasons.some((reason) => reason.code === 'enterprise_excluded'));
});
