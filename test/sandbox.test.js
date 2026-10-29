'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { createCapabilityHandles } = require('../src/runtime/handles');
const { createModuleRedirect } = require('../src/runtime/handles/inject');

function sandbox({ requests = [], grants = null } = {}) {
  const dir = tempDir('sandbox-');
  createPlugin({ dir, requests });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const grantList = (grants || requests).map((request, index) => normalizeGrant({
    capability: request.cap,
    scope: request.scope,
  }, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants: grantList, ledger, pluginRoot: dir });
  const handles = createCapabilityHandles({ guard });
  return { dir, guard, ledger, handles };
}

test('重定向：插件 require("fs") 拿到的是封闭句柄', () => {
  const runtime = sandbox({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const target = path.join(runtime.dir, 'own.txt');
  fs.writeFileSync(target, 'own');

  const redirect = createModuleRedirect({ handles: runtime.handles, pluginRoot: runtime.dir });
  // 模拟插件模块：parent 指向插件目录内的文件
  const fakeParent = { filename: path.join(runtime.dir, 'plugin.js') };
  const originalLoad = require('node:module')._load;
  redirect.install();
  try {
    const hijacked = require('node:module')._load('node:fs', fakeParent, false);
    assert.equal(typeof hijacked.readSync, 'undefined', 'readSync 不该出现在封闭句柄里');
    assert.equal(hijacked.readFileSync(target, 'utf8'), 'own');
    assert.equal(typeof hijacked.constants, 'object');

    // fs/promises 也要换成句柄的 promises 面
    const promisesFace = require('node:module')._load('node:fs/promises', fakeParent, false);
    assert.equal(promisesFace, hijacked.promises);
  } finally {
    redirect.uninstall();
    assert.equal(require('node:module')._load, originalLoad);
    cleanup(runtime.dir);
  }
});

test('重定向：宿主自身的 require 不受影响', () => {
  const runtime = sandbox({ requests: [] });
  const redirect = createModuleRedirect({ handles: runtime.handles, pluginRoot: runtime.dir });
  redirect.install();
  try {
    // parent 在执行时间之外（null）且不在装载窗口内 → 视为宿主
    const fromHost = require('node:module')._load('node:fs', null, false);
    assert.equal(fromHost, fs, '宿主拿到的必须是原生 fs');
    assert.equal(typeof fromHost.readSync, 'function');
  } finally {
    redirect.uninstall();
    cleanup(runtime.dir);
  }
});

test('重定向：装载窗口内 parent 为 null 的入口也算插件', () => {
  const runtime = sandbox({ requests: [] });
  const redirect = createModuleRedirect({ handles: runtime.handles, pluginRoot: runtime.dir });
  redirect.install();
  redirect.enter();
  try {
    const fromEntry = require('node:module')._load('fs', null, false);
    assert.equal(fromEntry, runtime.handles.fs);
  } finally {
    redirect.exit();
    redirect.uninstall();
    cleanup(runtime.dir);
  }
});

test('LocalHost：显式 sandbox=handles 时插件 require("fs") 拿到封闭面', async () => {
  const dir = tempDir('sandbox-host-');
  const pluginDir = path.join(dir, 'plugin');
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    id: 'com.example.sandbox',
    name: 'Sandbox',
    version: '1.0.0',
    entry: 'index.js',
    covenant: {
      spec: 'dsh-covenant/1',
      capabilities: { requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }] },
      content: null,
    },
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'probe.js'), 'module.exports = require("node:fs");');
  fs.writeFileSync(path.join(pluginDir, 'index.js'), [
    "'use strict';",
    'const fs = require("node:fs");',
    'module.exports = {',
    '  fs,',
    '  hasReadSync: typeof fs.readSync === "function",',
    '  nested: require("./probe.js"),',
    '  activate() {},',
    '  invoke() { return { ok: true }; },',
    '  deactivate() {},',
    '};',
  ].join('\n'));

  const { LocalHost } = require('../src/host/local-host');
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: {
      sandbox: { mode: 'handles' },
      grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }],
    },
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.sandbox');
    const module = host.modules.get('com.example.sandbox');
    assert.equal(module.hasReadSync, false, '插件不该拿到 readSync');
    assert.equal(module.nested.readSync, undefined, '插件内的二级 require 同样被重定向');
    assert.equal(host.coverage().sandbox.kind, 'module-redirect');
  } finally {
    try { await host.uninstall('com.example.sandbox'); } catch {}
    cleanup(dir);
  }
});

test('LocalHost：默认 global，插件拿到原生 fs（存量插件零改动）', async () => {
  const dir = tempDir('sandbox-global-');
  const pluginDir = path.join(dir, 'plugin');
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    id: 'com.example.global',
    name: 'Global',
    version: '1.0.0',
    entry: 'index.js',
    covenant: { spec: 'dsh-covenant/1', capabilities: { requests: [] }, content: null },
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'index.js'), [
    "'use strict';",
    'const fs = require("node:fs");',
    'module.exports = { hasReadSync: typeof fs.readSync === "function", activate() {}, invoke() { return {}; }, deactivate() {} };',
  ].join('\n'));

  const { LocalHost } = require('../src/host/local-host');
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: {}, // 不显式传 sandbox：本用例要验证的就是「默认 = global」
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.global');
    assert.equal(host.modules.get('com.example.global').hasReadSync, true);
  } finally {
    try { await host.uninstall('com.example.global'); } catch {}
    cleanup(dir);
  }
});

test('重定向：同一进程只允许一条，第二条直接报错', () => {
  const runtime = sandbox({ requests: [] });
  const first = createModuleRedirect({ handles: runtime.handles, pluginRoot: runtime.dir });
  const second = createModuleRedirect({ handles: runtime.handles, pluginRoot: runtime.dir });
  first.install();
  try {
    assert.throws(() => second.install(), /只能启用一条模块重定向/);
  } finally {
    first.uninstall();
    cleanup(runtime.dir);
  }
  // 卸载后可以再次安装
  assert.equal(second.install(), true);
  second.uninstall();
});

test('metrics：未声明拦截与 grant 拒绝分开统计', () => {
  const { computeMetrics } = require('../src/governance/metrics');
  const records = [
    { decision: 'allow', ruleId: 'two-key', intercepted: false },
    { decision: 'deny', ruleId: 'not_declared', intercepted: true },
    { decision: 'deny', ruleId: 'legacy', intercepted: true },
    { decision: 'deny', ruleId: 'not_granted', intercepted: false },
    { decision: 'deny', ruleId: 'scope_mismatch', intercepted: false },
  ];
  const metrics = computeMetrics({ ledgerRecords: records });
  assert.equal(metrics.denies, 4);
  assert.equal(metrics.undeclaredInterceptions, 2);
  assert.equal(metrics.undeclaredInterceptionRate, 2 / 5);
  assert.equal(metrics.grantDenials, 2);
  assert.equal(metrics.grantDenialRate, 0.5);
});
