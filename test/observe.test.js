'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { LocalHost } = require('../src/host/local-host');
const { createGuardChain } = require('../src/runtime/guards');
const { runInstallPipeline } = require('../src/gates/index');

function writePlugin(dir, { id = 'com.example.observe', source }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    id,
    name: 'Observe',
    version: '1.0.0',
    entry: 'index.js',
    covenant: {
      spec: 'dsh-covenant/1',
      capabilities: { requests: [] },
      content: null,
    },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.js'), source);
  return dir;
}

test('守卫链：observe 窗口内记 deny 但不抛出，窗口结束后恢复 fail-closed', () => {
  const ledger = { append() { return { seq: 1 }; } };
  const guard = createGuardChain({
    manifest: { id: 'p', name: 'P', version: '1.0.0', entry: 'i.js', kind: 'covenant', covenant: { spec: 'dsh-covenant/1', requests: [], content: null } },
    grants: [],
    ledger,
  });

  guard.beginObserve();
  try {
    const decision = guard.enforce('fs.read', { path: '/tmp/secret' });
    assert.equal(decision.allowed, true);
    assert.equal(decision.observed, true);
    assert.equal(decision.observedCode, 'not_declared');
  } finally {
    guard.endObserve();
  }

  assert.equal(guard.isObserving(), false);
  assert.throws(() => guard.enforce('fs.read', { path: '/tmp/secret' }), /未声明|manifest/);
  assert.equal(guard.stats.observed, 1);
});

test('装载窗口：顶层代码的越界读取被记账，但不阻断安装', async () => {
  const dir = tempDir('observe-host-');
  const outsideDir = tempDir('observe-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');

  const pluginDir = writePlugin(path.join(dir, 'plugin'), {
    source: [
      "'use strict';",
      "const fs = require('node:fs');",
      'let stolen = null;',
      'try { stolen = fs.readFileSync(' + JSON.stringify(outside) + ", 'utf8'); } catch (error) { stolen = 'DENIED'; }",
      'module.exports = { stolen, activate() {}, invoke() { return { stolen }; }, deactivate() {} };',
    ].join('\n'),
  });

  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const host = new LocalHost({ ledgerPath });
  try {
    await host.install(pluginDir);
    await host.register('com.example.observe');

    const module = host.modules.get('com.example.observe');
    assert.equal(module.stolen, 'TOP-SECRET', '装载窗口内不阻断（否则 legacy 插件根本装不上）');

    const records = new Ledger(ledgerPath).records();
    const intercepted = records.filter((record) => record.intercepted === true);
    assert.ok(intercepted.length >= 1, '窗口内的越界读取必须留下记录');
    assert.ok(intercepted.some((record) => record.ruleId === 'not_declared'));

    // 窗口已经关闭：同样的调用现在必须被拒绝
    assert.throws(
      () => host.active.guard.enforce('fs.read', { path: outside }),
      /未声明|manifest/,
    );
  } finally {
    try { await host.uninstall('com.example.observe'); } catch {}
    cleanup(dir);
    cleanup(outsideDir);
  }
});

test('装载窗口：不把加载器自己的读文件记成插件行为', async () => {
  const dir = tempDir('observe-entry-');
  const pluginDir = writePlugin(path.join(dir, 'plugin'), {
    source: "'use strict';\nmodule.exports = { activate() {}, invoke() { return { ok: true }; }, deactivate() {} };\n",
  });
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const host = new LocalHost({ ledgerPath });
  try {
    await host.install(pluginDir);
    await host.register('com.example.observe');
    const records = new Ledger(ledgerPath).records();
    const entryRead = records.some((record) => JSON.stringify(record.scope || '').includes('index.js'));
    assert.equal(entryRead, false, '入口文件的读取是宿主行为，不该记在插件账上');
  } finally {
    try { await host.uninstall('com.example.observe'); } catch {}
    cleanup(dir);
  }
});

test('LocalHost：admitting 是私有字段，外部写不进去也绕不过去', () => {
  const dir = tempDir('observe-private-');
  const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl') });
  assert.equal('admitting' in host, false);
  assert.equal(Object.getOwnPropertyNames(host).includes('admitting'), false);
  host.admitting = true;
  assert.equal('admitting' in host, true);
  assert.equal(host.admitting, true);
  cleanup(dir);
});

test('strict 模式：前置门禁未通过时不执行插件代码', async () => {
  const dir = tempDir('observe-strict-');
  const marker = path.join(dir, 'executed.txt');
  const pluginDir = writePlugin(path.join(dir, 'plugin'), {
    source: [
      "'use strict';",
      "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'executed');",
      'module.exports = { activate() {}, invoke() { return { ok: true }; }, deactivate() {} };',
    ].join('\n'),
  });

  const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl'), channel: 'enterprise' });
  const report = await runInstallPipeline({
    pluginDir,
    trust: null,
    channel: 'enterprise',
    host,
  });

  assert.equal(report.ok, false);
  assert.equal(fs.existsSync(marker), false, '验签没过就不该执行插件代码');
  const loadStage = report.stages.find((stage) => stage.name === 'loadability');
  assert.equal(loadStage.status, 'warn');
  assert.ok(loadStage.labels.some((item) => item.code === 'loadability_skipped'));
  cleanup(dir);
});

test('coverage：Hook 装好之后 guard.coverage() 能给出受控入口清单', () => {
  const guard = createGuardChain({
    manifest: { id: 'p', name: 'P', version: '1.0.0', entry: 'i.js', kind: 'covenant', covenant: { spec: 'dsh-covenant/1', requests: [], content: null } },
    grants: [],
  });
  const before = guard.coverage();
  assert.equal(before.entries, 0);
  assert.ok(before.knownGaps.length >= 1);

  const hooks = guard.installNativeHooks();
  try {
    const after = guard.coverage();
    assert.ok(after.entries > 50);
    assert.ok(after.guarded.includes('fs.openSync'));
  } finally {
    hooks.uninstall();
  }
});
