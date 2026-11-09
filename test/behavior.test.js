'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildBehaviorReport } = require('../src/governance/behavior');
const { createTrust, spkiFingerprint } = require('../src/signing/trust');
const crypto = require('node:crypto');

test('行为画像：按插件聚合实际读/写/连/跑，零契约如实标注', () => {
  const records = [
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'fs', action: 'fs.read', scope: { path: 'C:/repo/a.ts' }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:00:00Z', intercepted: false },
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'fs', action: 'fs.write', scope: { paths: ['C:/repo/out.txt'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:01:00Z', intercepted: false },
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'proc', action: 'proc.spawn', scope: { command: 'git' }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:02:00Z', intercepted: false },
    { plugin: 'beta', pluginVersion: '2.0.0', capability: 'net', action: 'net.outbound', scope: { host: 'api.example.com' }, decision: 'deny', ruleId: 'not_declared', profiled: true, manifestHash: 'deadbeef', ts: '2026-11-09T10:03:00Z', intercepted: true },
    // 遥测记录不计入能力集合。
    { plugin: 'dsh-dashcam-host', pluginVersion: '1.0.0', capability: 'telemetry', action: 'mount', scope: {}, decision: 'allow', ruleId: 'mount', profiled: false, manifestHash: null, ts: '2026-11-09T09:59:00Z', intercepted: false },
  ];
  const report = buildBehaviorReport(records);
  assert.equal(report.plugins.length, 3);
  const alpha = report.plugins.find((section) => section.plugin === 'alpha');
  assert.equal(alpha.activity.total, 3);
  assert.equal(alpha.activity.allow, 3);
  assert.equal(alpha.contract.zeroContract, true);
  assert.deepEqual(alpha.observed.fsRead, ['C:/repo/a.ts']);
  assert.deepEqual(alpha.observed.fsWrite, ['C:/repo/out.txt']);
  assert.deepEqual(alpha.observed.commands, ['git']);
  assert.deepEqual(alpha.capabilities, ['fs', 'proc']);
  const beta = report.plugins.find((section) => section.plugin === 'beta');
  assert.equal(beta.activity.intercepted, 1);
  assert.equal(beta.contract.profiled, true);
  assert.equal(beta.contract.manifestHash, 'deadbeef');
  const host = report.plugins.find((section) => section.plugin === 'dsh-dashcam-host');
  assert.deepEqual(host.capabilities, []);
});

test('行为画像：传入 manifest 时输出能力级声明 diff', () => {
  const manifest = {
    id: 'alpha',
    dashcam: { requests: [{ capability: 'fs.read' }, { capability: 'fs.write' }] },
  };
  const records = [
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'fs', action: 'fs.read', scope: { path: 'x' }, decision: 'allow', ruleId: 'two-key', profiled: true, manifestHash: 'h', ts: '2026-11-09T10:00:00Z', intercepted: false },
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'proc', action: 'proc.spawn', scope: { command: 'rm' }, decision: 'deny', ruleId: 'not_declared', profiled: true, manifestHash: 'h', ts: '2026-11-09T10:01:00Z', intercepted: true },
  ];
  const report = buildBehaviorReport(records, { manifest });
  const diff = report.plugins[0].declarationDiff;
  // 家族级 diff：声明 fs.read/fs.write 归并为 fs。
  assert.deepEqual(diff.declared, ['fs']);
  assert.deepEqual(diff.undeclared, ['proc']);
  assert.deepEqual(diff.declaredNotObserved, []);
});

test('N2：SPKI 指纹前后 8 位，随信任表归一化产出', () => {
  // 生成一把真实 Ed25519 密钥取 SPKI PEM，指纹可复算。
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const expected = (() => {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const hex = crypto.createHash('sha256').update(der).digest('hex');
    return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
  })();
  assert.equal(spkiFingerprint(pem), expected);
  const trust = createTrust([{ keyId: 'k1', roles: ['publisher'], publicKey: pem }]);
  assert.equal(trust.keys[0].fingerprint, expected);
  assert.equal(spkiFingerprint(''), null);
});
