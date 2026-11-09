'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildBehaviorReport, buildDeclarationDraft } = require('../src/governance/behavior');
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

test('draft：从账本观测反推声明草案（fs 折目录、proc 取首词、凭证单独分组）', () => {
  const records = [
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'fs', action: 'fs.read', scope: { paths: ['C:/repo/src/a.ts', 'C:/repo/src/b.ts', 'C:/Users/x/.ssh/id_rsa'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:00:00Z', intercepted: false },
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'fs', action: 'fs.write', scope: { paths: ['C:/repo/dist/out.js'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:01:00Z', intercepted: false },
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'proc', action: 'proc.spawn', scope: { commands: ['git status', 'git push'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:02:00Z', intercepted: false },
    { plugin: 'alpha', pluginVersion: '1.0.0', capability: 'net', action: 'net.outbound', scope: { hosts: ['api.example.com:443'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:03:00Z', intercepted: false },
  ];
  const draft = buildDeclarationDraft(records);
  assert.equal(draft.generatedFrom, 'ledger');
  assert.ok(draft.note.includes('人工收敛'));
  const alpha = draft.plugins.find((section) => section.plugin === 'alpha');
  assert.equal(alpha.zeroContract, true);
  const byCapability = new Map(alpha.requests.map((request) => [request.capability, request]));
  // 普通读折叠到目录；同目录两个文件只建议一个目录。
  const fsRead = byCapability.get('fs.read');
  assert.deepEqual(fsRead.scope.paths, ['C:/repo/src']);
  // 凭证路径（id_rsa）升级为 cred.read 且保留精确目标，不并入 fs.read。
  const credRead = byCapability.get('cred.read');
  assert.deepEqual(credRead.scope.targets, ['C:/Users/x/.ssh/id_rsa']);
  // 写折叠到目录。
  assert.deepEqual(byCapability.get('fs.write').scope.paths, ['C:/repo/dist']);
  // proc 取首词去重。
  assert.deepEqual(byCapability.get('proc.spawn').scope.commands, ['git']);
  // net 原样。
  assert.deepEqual(byCapability.get('net.outbound').scope.hosts, ['api.example.com:443']);
  // 每条 reason 都写明来源与「需人工收敛」。
  for (const request of alpha.requests) {
    assert.ok(request.reason.includes('由账本观测反推'));
    assert.ok(request.reason.includes('需人工收敛'));
  }
});

test('draft：fs.delete 保留精确路径不放大；已有 manifest 的家族不再重复建议', () => {
  const records = [
    { plugin: 'alpha', capability: 'fs', action: 'fs.read', scope: { paths: ['C:/repo/src/a.ts'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:00:00Z', intercepted: false },
    { plugin: 'alpha', capability: 'fs', action: 'fs.delete', scope: { paths: ['C:/repo/cache.tmp', 'C:/repo/old.log'] }, decision: 'allow', ruleId: 'unprofiled', profiled: false, manifestHash: null, ts: '2026-11-09T10:01:00Z', intercepted: false },
  ];
  // 不传 manifest：fs.read 与 fs.delete 都建议，delete 保留精确路径。
  const bare = buildDeclarationDraft(records);
  const bareAlpha = bare.plugins.find((section) => section.plugin === 'alpha');
  const bareByCapability = new Map(bareAlpha.requests.map((request) => [request.capability, request]));
  assert.deepEqual(bareByCapability.get('fs.delete').scope.paths, ['C:/repo/cache.tmp', 'C:/repo/old.log']);
  assert.ok(bareByCapability.get('fs.read'));

  // 传入 manifest：fs.read 已声明，不再建议；fs.delete 是另一个精确能力，
  // 精确路径仍在（删除能力按目录授权等于把整个目录交给人家删）。
  const manifest = {
    id: 'alpha',
    dashcam: { requests: [{ capability: 'fs.read', scope: { paths: ['C:/repo'] }, reason: 'already declared' }] },
  };
  const withManifest = buildDeclarationDraft(records, { manifest });
  const alpha = withManifest.plugins.find((section) => section.plugin === 'alpha');
  assert.deepEqual(alpha.coveredByManifest, ['fs.read']);
  const capabilities = alpha.requests.map((request) => request.capability);
  assert.ok(!capabilities.includes('fs.read'));
  assert.deepEqual(capabilities, ['fs.delete']);
  // 别的插件不吃这份 manifest 的覆盖。
  const other = withManifest.plugins.find((section) => section.plugin !== 'alpha');
  if (other) assert.deepEqual(other.coveredByManifest, []);
});

test('draft：零记录给出空草案，不编造', () => {
  const draft = buildDeclarationDraft([]);
  assert.deepEqual(draft.plugins, []);
});
