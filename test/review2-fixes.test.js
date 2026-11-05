'use strict';

/**
 * 第二轮三视角审查（H-1 / M-1 / M-3 / M-4 / L-1）的回归用例。
 * 这一轮的共同主题：**配置必须真的落到执行点，失败路径必须可区分**。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { loadPolicy, resolveLimits, DEFAULT_LIMITS } = require('../src/policy');
const { activate } = require('../src/index');
const { LocalHost } = require('../src/host/local-host');

const MANIFEST = {
  id: 'com.example.round2',
  name: 'Round2',
  version: '1.0.0',
  entry: 'index.js',
  kind: 'covenant',
  covenant: { spec: 'dsh-covenant/1', content: null, requests: [] },
};

function runtimeFor(policy = {}) {
  const dir = tempDir('round2-');
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const guard = createGuardChain({ manifest: MANIFEST, grants: [], ledger, pluginRoot: dir, policy });
  return { dir, ledger, guard };
}

test('H-1：policy.limits 真的能传到插件拿到的 net 句柄', async () => {
  const captured = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { captured.push(init); return Promise.resolve({ ok: true }); };

  const dir = tempDir('h1-');
  const pluginDir = path.join(dir, 'plugin');
  const requests = [{ cap: 'net.outbound', scope: { hosts: ['example.com:443'] }, reason: '出网' }];
  createPlugin({
    dir: pluginDir,
    requests,
    code: [
      "'use strict';",
      'let captured = null;',
      'module.exports = {',
      '  activate(ctx) { captured = ctx; },',
      "  invoke() { return captured.handles.net.fetch('https://example.com/x'); },",
      '  deactivate() {},',
      '};',
    ].join('\n'),
  });

  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: {
      // H-1 验证的是「limits → 句柄」这条链；句柄只在 handles 模式注入，故显式开启。
      sandbox: { mode: 'handles' },
      limits: { fetchTimeoutMs: 0 },
      grants: [{ capability: 'net.outbound', scope: { hosts: ['example.com:443'] } }],
    },
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.test');
    await host.invoke('com.example.test');
    assert.ok(captured.length >= 1);
    assert.equal(captured[0].signal, undefined, 'fetchTimeoutMs=0 必须传到插件手里的句柄');
  } finally {
    globalThis.fetch = originalFetch;
    try { await host.uninstall('com.example.test'); } catch {}
    cleanup(dir);
  }
});

test('M-1：注册回调抛错时计数回滚，下一次 activate 仍可用', () => {
  const dir = tempDir('m1-');
  const hostFor = (extra = {}) => ({
    manifest: MANIFEST,
    grants: [],
    patchBuiltins: false,
    autoSweep: false,
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    ...extra,
  });
  let runtime = null;
  try {
    assert.throws(
      () => activate(hostFor({ registerPreExecute() { throw new Error('boom'); } })),
      /boom/,
    );
    // 计数没回滚的话，这里会抛「同一进程只能有一个活动运行时」
    runtime = activate(hostFor());
    assert.ok(runtime);
  } finally {
    if (runtime) runtime.deactivate();
    cleanup(dir);
  }
});

test('M-3：非法的 limits 必须尽早失败，而不是静默失效', () => {
  assert.throws(() => resolveLimits({ limits: { batchTargets: 'abc' } }), /batchTargets 非法/);
  assert.throws(() => resolveLimits({ limits: { integrityEvery: -1 } }), /integrityEvery 非法/);
  assert.throws(() => resolveLimits({ limits: { fetchTimeoutMs: 1.5 } }), /fetchTimeoutMs 非法/);
  assert.throws(() => loadPolicy({ limits: { globBatchSize: 0 } }), /globBatchSize 非法/);

  const ok = resolveLimits({ limits: { batchTargets: 5 } });
  assert.equal(ok.batchTargets, 5);
  assert.equal(ok.fetchTimeoutMs, DEFAULT_LIMITS.fetchTimeoutMs);
  assert.equal(resolveLimits({ limits: { fetchTimeoutMs: 0 } }).fetchTimeoutMs, 0);
});

test('M-4：coverage().installed 能区分「没装」和「装了又卸了」', () => {
  const runtime = runtimeFor();
  try {
    assert.equal(runtime.guard.coverage().installed, false);
    runtime.guard.installNativeHooks();
    assert.equal(runtime.guard.coverage().installed, true);
    runtime.guard.uninstallNativeHooks();
    assert.equal(runtime.guard.coverage().installed, false, '卸载后不能继续指向已卸载的 Bridge');
    assert.equal(runtime.guard.coverage().entries, 0);
  } finally {
    cleanup(runtime.dir);
  }
});

test('L-1：并发检测仍然生效（重对齐的改动没有把它吞掉）', () => {
  const dir = tempDir('l1-');
  const file = path.join(dir, 'ledger.jsonl');
  const a = new Ledger(file);
  const b = new Ledger(file);
  const record = {
    plugin: 'p', capability: 'fs.read', action: 'fs.read', scope: {},
    decision: 'allow', ruleId: 'two-key', reason: 'r',
  };
  try {
    a.append(record);
    // H6 之后同进程多实例共享基准（误报消除），但 Ledger 之外的写入者
    // （外部进程直写）仍然要被抓：磁盘漂移后 append 持续报错，
    // 不能把别人写的字节当成自己的基准。
    fs.appendFileSync(file, '{"external":true}\n');
    assert.throws(() => b.append(record), /并发写入/);
    // 并发检测之后再写一次，仍然要报并发（不能把别人的字节当成自己的基准）
    assert.throws(() => b.append(record), /并发写入/);
  } finally {
    cleanup(dir);
  }
});

test('P1：createPluginRuntime 读 policy.sandbox.mode，且兼容对象/字符串写法', () => {
  const { createPluginRuntime } = require('../src/index');
  const dir = tempDir('p1-');
  const base = {
    manifest: MANIFEST,
    grants: [],
    patchBuiltins: false,
    autoSweep: false,
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    pluginRoot: dir,
  };

  // 对象写法（文档里写的 sandbox: { mode: 'handles' }）
  const viaObject = createPluginRuntime({ ...base, policy: { sandbox: { mode: 'handles' } } });
  try {
    assert.notEqual(viaObject.handles, null, '对象写法必须生效，不能因 truthy 被静默忽略');
    assert.notEqual(viaObject.redirect, null);
  } finally {
    viaObject.dispose();
  }

  // 字符串写法（旧接口兼容）
  const viaString = createPluginRuntime({ ...base, sandbox: 'handles' });
  try {
    assert.notEqual(viaString.handles, null, '字符串写法仍然有效');
  } finally {
    viaString.dispose();
  }

  // 默认 = global
  const defaultGlobal = createPluginRuntime({ ...base });
  try {
    assert.notEqual(defaultGlobal.handles, null, '句柄常驻：默认模式下也提供 ctx.handles');
    assert.equal(defaultGlobal.redirect, null, '默认 global 不重定向 require("fs")');
  } finally {
    defaultGlobal.dispose();
  }
  cleanup(dir);
});
