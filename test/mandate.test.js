'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir, createPlugin, signPlugin, makeKeys, trustFor, cleanup } = require('./helpers/fixtures');
const { parseManifest } = require('../src/contract/manifest');
const { evaluateAdmission } = require('../src/contract/charter');
const { runInstallPipeline } = require('../src/gates/index');
const { LocalHost } = require('../src/host/local-host');
const { Ledger } = require('../src/runtime/ledger');
const { activate } = require('../src/index');

function legacyManifest() {
  return parseManifest({
    id: 'com.example.legacy',
    name: 'Legacy',
    version: '1.0.0',
    entry: 'index.js',
  }).manifest;
}

test('准入：legacy 在 required 模式下消费通道也拒绝', () => {
  const manifest = legacyManifest();
  const required = evaluateAdmission(manifest, {
    channel: 'consumer',
    policy: { enforcement: { mode: 'required' } },
  });
  assert.equal(required.admitted, false);
  assert.equal(required.reasons[0].code, 'legacy_not_admitted');
});

test('准入：默认 advisory 下 legacy 以 quarantine 档放行', () => {
  const manifest = legacyManifest();
  const advisory = evaluateAdmission(manifest, { channel: 'consumer', policy: {} });
  assert.equal(advisory.admitted, true);
  assert.equal(advisory.quarantine, true);
  assert.ok(advisory.warnings.some((warning) => warning.code === 'legacy_conservative_defaults'));

  const allowlisted = evaluateAdmission(manifest, {
    channel: 'consumer',
    policy: { enforcement: { allowLegacy: true } },
  });
  assert.equal(allowlisted.admitted, true);
  assert.ok(allowlisted.warnings.some((warning) => warning.code === 'legacy_allowlisted_by_host'));
});

test('安装流水线：legacy 默认带 Quarantined 标签放行，required 才拒', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('mandate-legacy-');
  const plugin = createPlugin({ dir, requests: [], legacy: true });
  signPlugin(plugin, keys);

  const allowed = await runInstallPipeline({ pluginDir: dir, trust, channel: 'consumer' });
  assert.equal(allowed.ok, true, allowed.formatted.join('\n'));
  assert.ok(allowed.securityLabels.includes('Quarantined'));

  const blocked = await runInstallPipeline({
    pluginDir: dir,
    trust,
    channel: 'consumer',
    policy: { enforcement: { mode: 'required' } },
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some((error) => error.code === 'legacy_not_admitted'));
  cleanup(dir);
});

test('LocalHost：没有信任表仍可安装，但画像是 Untrusted', async () => {
  const dir = tempDir('mandate-host-');
  const plugin = createPlugin({ dir, requests: [] });
  const host = new LocalHost({ ledgerPath: path.join(dir, '.ledger.jsonl') });
  const result = await host.install(dir);
  assert.equal(result.id, plugin.manifest.id);
  assert.ok(result.labels.some((label) => label.label === 'Untrusted'));
  assert.equal(host.installed.has(plugin.manifest.id), true);
  cleanup(dir);
});

test('LocalHost：签名通过则准入，并留下准入审计', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('mandate-host-ok-');
  const plugin = createPlugin({ dir, requests: [] });
  signPlugin(plugin, keys);
  const ledgerPath = path.join(dir, '.ledger.jsonl');
  const host = new LocalHost({ ledgerPath, trust });

  const result = await host.install(dir);
  assert.equal(result.id, plugin.manifest.id);
  const records = new Ledger(ledgerPath).records();
  assert.ok(records.some((item) => item.ruleId === 'admission' && item.decision === 'allow'));
  await host.uninstall(plugin.manifest.id);
  cleanup(dir);
});

test('运行时：activate 不拒绝 legacy，改以 quarantine 档运行', () => {
  // ledgerPath 必须落在临时目录：默认值取 process.cwd()，
  // 不传的话跑一次测试就会在项目根目录留下 .dsh-ledger.jsonl。
  const dir = tempDir('mandate-activate-');
  const manifest = legacyManifest();
  const runtime = activate({
    manifest,
    grants: [],
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    patchBuiltins: false,
    autoSweep: false,
  });
  try {
    assert.equal(runtime.runtime.quarantine, true);
    assert.equal(runtime.runtime.guard.check('fs.read', { path: 'x' }).code, 'legacy');
  } finally {
    runtime.deactivate();
    cleanup(dir);
  }
});
