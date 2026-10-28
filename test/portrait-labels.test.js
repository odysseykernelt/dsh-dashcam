'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { buildPortrait, renderPortrait } = require('../src/portrait/portrait');
const { computeMetrics } = require('../src/governance/metrics');

test('画像卡：安全标签按 label 去重，首屏只报去重后的数量', () => {
  const portrait = buildPortrait({
    manifest: { id: 'com.example.labels', covenant: { requests: [] } },
    labels: [
      { gate: 'signature', code: 'trust_missing', label: 'Untrusted', reason: '未提供信任表，无法验签' },
      { gate: 'safety', code: 'network_egress', label: 'ReviewRequired', reason: '出网范围需要人工复核' },
      { gate: 'sieve', code: 'quarantined', label: 'Untrusted', reason: '重复分档不应重复计数' },
    ],
  });
  assert.deepEqual(portrait.securityLabels, ['Untrusted', 'ReviewRequired']);
  assert.equal(portrait.firstScreen.labelCount, 2);
  // labels 原文保留，去重只作用于首屏展示用的 securityLabels。
  assert.equal(portrait.labels.length, 3);
});

test('画像卡：首屏直出安全标签与隔离档两行', () => {
  const dir = tempDir('portrait-labels-');
  createPlugin({ dir, legacy: true });
  const { manifest } = loadManifest(dir);
  cleanup(dir);

  const portrait = buildPortrait({
    manifest,
    labels: [
      { gate: 'signature', code: 'signature_skipped', label: 'Untrusted', reason: '调用方跳过验签' },
      { gate: 'sieve', code: 'quarantined', label: 'Quarantined', reason: 'legacy 插件按 deny-all 隔离' },
    ],
  });
  assert.equal(portrait.quarantine, true);

  const rendered = renderPortrait(portrait);
  assert.ok(rendered.includes('安全标签：Untrusted / Quarantined'));
  assert.ok(rendered.includes('隔离档：无 covenant 声明，运行时 deny-all'));
});

test('画像卡：隔离档判定统一走 isQuarantined', () => {
  // covenant.quarantine 为真、顶层字段缺失时也应判定为隔离档。
  const fromCovenant = buildPortrait({
    manifest: { id: 'com.example.quarantined', covenant: { requests: [], quarantine: true } },
  });
  assert.equal(fromCovenant.quarantine, true);

  const plain = buildPortrait({ manifest: { covenant: { requests: [] } } });
  assert.equal(plain.quarantine, false);
  assert.equal(buildPortrait({}).quarantine, false);
});

test('治理度量：未声明越权与 grant 拒绝分开计数', () => {
  const ledgerRecords = [
    { ts: '2026-10-01T10:00:00.000Z', decision: 'allow', ruleId: 'two-key', intercepted: false },
    { ts: '2026-10-01T10:01:00.000Z', decision: 'deny', ruleId: 'not_declared', intercepted: true },
    { ts: '2026-10-01T10:02:00.000Z', decision: 'deny', ruleId: 'not_granted', intercepted: false },
  ];
  const metrics = computeMetrics({ ledgerRecords });

  assert.equal(metrics.requests, 3);
  assert.equal(metrics.allows, 1);
  assert.equal(metrics.denies, 2);
  assert.equal(metrics.undeclaredInterceptions, 1);
  assert.equal(metrics.undeclaredInterceptionRate, 1 / 3);
  assert.equal(metrics.grantDenials, 1);
  assert.equal(metrics.grantDenialRate, 0.5);
});
