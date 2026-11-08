'use strict';

/**
 * policy.limits / policy.enforcement.strictPatch 的可配置性回归。
 * 这些值以前是各模块里写死的常量，现在必须真的能通过 policy 改。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { loadPolicy, resolveLimits, DEFAULT_LIMITS } = require('../src/policy');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');
const { createNetHandle } = require('../src/runtime/handles/net');
const { LocalHost, resolveLedgerMacKey } = require('../src/host/local-host');

const MANIFEST = {
  id: 'com.example.options',
  name: 'Options',
  version: '1.0.0',
  entry: 'index.js',
  kind: 'dashcam',
  dashcam: { spec: 'dsh-dashcam/1', content: null, requests: [] },
};

function runtimeFor(policy = {}) {
  const dir = tempDir('options-');
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const guard = createGuardChain({
    manifest: MANIFEST, grants: [], ledger, pluginRoot: dir, policy,
  });
  return { dir, ledger, guard };
}

test('limits：默认值集中在一处，未覆盖的键保持默认', () => {
  const merged = resolveLimits({ limits: { batchTargets: 5 } });
  assert.equal(merged.batchTargets, 5);
  assert.equal(merged.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs);
  assert.equal(merged.integrityEvery, DEFAULT_LIMITS.integrityEvery);

  const loaded = loadPolicy({ limits: { globBatchSize: 7 } });
  assert.equal(loaded.limits.globBatchSize, 7);
  assert.equal(loaded.limits.batchTargets, DEFAULT_LIMITS.batchTargets);
});

test('limits.batchTargets：上限可调，超了仍然拒绝', () => {
  const runtime = runtimeFor({ limits: { batchTargets: 2 } });
  try {
    const payloads = [{ path: '/tmp/a' }, { path: '/tmp/b' }, { path: '/tmp/c' }];
    assert.throws(() => runtime.guard.enforceBatch('fs.read', payloads), /超过上限 2/);
  } finally {
    cleanup(runtime.dir);
  }
});

test('limits.integrityEvery = 0 时关闭抽样校验', () => {
  const runtime = runtimeFor({ limits: { integrityEvery: 0 } });
  const bridge = runtime.guard.installNativeHooks();
  const original = fs.readFileSync;
  try {
    fs.readFileSync = function tampered() { return 'tampered'; };
    for (let index = 0; index < 200; index += 1) {
      runtime.guard.check('fs.read', { path: path.join(runtime.dir, 'a.txt') });
    }
    assert.equal(runtime.guard.isCompromised(), false, '关掉抽样后不应该自己发现');
  } finally {
    fs.readFileSync = original;
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('limits.fetchTimeoutMs：0 不注入超时，正值注入', async () => {
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = (input, init) => { captured.push(init); return Promise.resolve({}); };
  try {
    const noTimeout = createNetHandle({ guard: { enforce() {} }, limits: { fetchTimeoutMs: 0 } });
    await noTimeout.fetch('https://example.com/a');
    assert.equal(captured[0].signal, undefined, 'fetchTimeoutMs=0 时不注入 signal');

    const withTimeout = createNetHandle({ guard: { enforce() {} }, limits: { fetchTimeoutMs: 1500 } });
    await withTimeout.fetch('https://example.com/a');
    assert.ok(captured[1].signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('limits.minMacKeyBytes：下限只能抬高，不能降到 32 以下', () => {
  const dir = tempDir('options-mac-');
  try {
    const shortKey = 'k'.repeat(8);
    assert.throws(() => resolveLedgerMacKey({ ledgerMacKey: shortKey }), /太短/);
    // 函数级参数也不能放宽：否则「可调」就是绕过 policy 的后门。
    assert.throws(() => resolveLedgerMacKey({ ledgerMacKey: shortKey, minBytes: 8 }), /太短/);
    // policy 侧不允许把下限配到 32 以下：那等于允许把 HMAC 强度关掉。
    assert.throws(
      () => resolveLimits({ limits: { minMacKeyBytes: 8 } }),
      /minMacKeyBytes/,
    );
  } finally {
    cleanup(dir);
  }
});

test('limits.globBatchSize：异步 glob 按配置分块', async (t) => {
  if (!fs.promises || typeof fs.promises.glob !== 'function') {
    t.skip('当前 Node 没有 fs.promises.glob');
    return;
  }
  const dir = tempDir('options-glob-');
  const scope = { paths: [dir.replace(/\\/g, '/') + '/**'] };
  createPlugin({ dir, requests: [{ cap: 'fs.read', scope, reason: '读取自身文件' }] });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const grants = [normalizeGrant({ capability: 'fs.read', scope }, { pluginRoot: dir }, 0)];
  const guard = createGuardChain({
    manifest, grants, ledger, pluginRoot: dir, policy: { limits: { globBatchSize: 2 } },
  });

  for (let index = 0; index < 5; index += 1) {
    fs.writeFileSync(path.join(dir, 'f' + index + '.txt'), 'x');
  }

  const bridge = createBridge({
    guard, ledger, plugin: { id: manifest.id }, globBatchSize: 2,
  });
  try {
    let seen = 0;
    for await (const matched of fs.promises.glob('**/*.txt', { cwd: dir })) {
      assert.ok(matched);
      seen += 1;
    }
    assert.equal(seen, 5);
    const records = ledger.records().filter((record) => record.ruleId === 'two-key-batch');
    assert.equal(records.length, 3, '5 条结果按 2 条一块 → 3 条账本');
  } finally {
    bridge.uninstall();
    cleanup(dir);
  }
});

test('enforcement.strictPatch：补丁不完整时拒绝装载', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'opendirSync');
  if (!descriptor || descriptor.configurable === false) {
    t.skip('fs.opendirSync 不可配置，无法构造补丁失败');
    return;
  }
  const saved = fs.opendirSync;
  delete fs.opendirSync;

  const dir = tempDir('options-strict-');
  const plugin = createPlugin({ dir, requests: [] });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { enforcement: { strictPatch: true } },
  });
  try {
    await host.install(dir);
    await assert.rejects(() => host.register(plugin.manifest.id), /补丁不完整/);
  } finally {
    try { await host.uninstall(plugin.manifest.id); } catch {}
    Object.defineProperty(fs, 'opendirSync', {
      value: saved, writable: true, configurable: true, enumerable: descriptor.enumerable,
    });
    cleanup(dir);
  }
});
