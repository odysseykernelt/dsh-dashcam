'use strict';

/**
 * 三视角审查（bba49f5）修复的回归用例。
 * 每条用例对应报告里的一个编号：H1 / H2 / H3 / M1 / M2 / M3 / M4 / M5 / M6 / L1 / L2。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');
const { createCapabilityHandles } = require('../src/runtime/handles');
const { createModuleRedirect } = require('../src/runtime/handles/inject');
const { createNetHandle } = require('../src/runtime/handles/net');

const MANIFEST = {
  id: 'com.example.review',
  name: 'Review',
  version: '1.0.0',
  entry: 'index.js',
  kind: 'covenant',
  covenant: { spec: 'dsh-covenant/1', content: null, requests: [] },
};

function runtimeFor(options = {}) {
  const dir = tempDir('review-');
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const guard = createGuardChain({
    manifest: MANIFEST,
    grants: [],
    ledger,
    pluginRoot: dir,
    ...options,
  });
  return { dir, ledger, guard };
}

/** 只记账的假守卫：net 句柄只需要 enforce 存在。 */
function stubGuard() {
  return { enforce() { return { allowed: true }; } };
}

test('H1：补丁装不上必须暴露，不能假装完整', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(fs, 'opendirSync');
  if (!descriptor || descriptor.configurable === false) {
    t.skip('当前运行时的 fs.opendirSync 不可配置，无法构造 patch 失败');
    return;
  }
  const saved = fs.opendirSync;
  delete fs.opendirSync;

  const runtime = runtimeFor();
  let bridge = null;
  try {
    // 必须走这条路径：coverage() 是委托给 hooks 的，直接 new Bridge 不会接上。
    bridge = runtime.guard.installNativeHooks();
    const coverage = runtime.guard.coverage();
    assert.ok(
      coverage.unpatched.some((item) => item.prop === 'opendirSync' && item.reason === 'not_function'),
      '装不上的入口要出现在 unpatched 里',
    );
    assert.equal(coverage.complete, false);
    const record = runtime.ledger.records().find((item) => item.ruleId === 'bridge_incomplete');
    assert.ok(record, '装不上要留下账本记录');
    assert.match(record.reason, /opendirSync/);
  } finally {
    if (bridge) bridge.uninstall();
    Object.defineProperty(fs, 'opendirSync', {
      value: saved, writable: true, configurable: true, enumerable: descriptor.enumerable,
    });
    cleanup(runtime.dir);
  }
});

test('H2：完整性校验接进了判定循环（抽样）', () => {
  const runtime = runtimeFor({ integrityEvery: 2 });
  const bridge = runtime.guard.installNativeHooks();
  const original = fs.readFileSync;
  try {
    // 模拟插件把包装函数换掉
    fs.readFileSync = function tampered() { return 'tampered'; };
    assert.equal(runtime.guard.isCompromised(), false);
    runtime.guard.check('fs.read', { path: path.join(runtime.dir, 'a.txt') });
    assert.equal(runtime.guard.isCompromised(), false, '还没到抽样点');
    runtime.guard.check('fs.read', { path: path.join(runtime.dir, 'a.txt') });
    assert.equal(runtime.guard.isCompromised(), true, '到达抽样点应当发现被替换');
  } finally {
    fs.readFileSync = original;
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('H3：Windows 上 pluginRoot 大小写不同仍算插件模块', { skip: process.platform !== 'win32' }, () => {
  const dir = tempDir('case-');
  const handles = createCapabilityHandles({ guard: stubGuard() });
  // 故意把根传成大写：真实模块路径是小写（或反之）
  const redirect = createModuleRedirect({ handles, pluginRoot: dir.toUpperCase() });
  try {
    redirect.install();
    redirect.enter();
    const loaded = require('node:module')._load('node:fs', { filename: path.join(dir, 'plugin.js') }, false);
    assert.equal(loaded, handles.fs, '大小写不该让重定向失效');
  } finally {
    redirect.exit();
    redirect.uninstall();
    cleanup(dir);
  }
});

test('M1：fetch 默认注入超时信号，调用方给 signal 时以它为准', async () => {
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = (input, init) => {
    captured.push(init);
    return Promise.resolve({ ok: true });
  };
  try {
    const handle = createNetHandle({ guard: stubGuard() });
    await handle.fetch('https://example.com/x');
    assert.ok(captured[0] && captured[0].signal instanceof AbortSignal, '没有 signal 时要注入默认超时');

    const mine = new AbortController().signal;
    await handle.fetch('https://example.com/x', { signal: mine });
    assert.equal(captured[1].signal, mine, '调用方显式给的 signal 优先');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('M2：glob 的 cwd 非法类型直接拒绝，而不是静默退回 process.cwd()', () => {
  const dir = tempDir('glob-cwd-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const runtime = runtimeFor({
    grants: [{
      id: 'g', capability: 'fs.read', enabled: true, expiresAt: null, oneSeal: false,
      scope: { paths: [dir.replace(/\\/g, '/') + '/**'] },
    }],
    manifest: {
      ...MANIFEST,
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [{ capability: 'fs.read', scope: { paths: [dir.replace(/\\/g, '/') + '/**'] }, reason: '读自身' }],
      },
    },
  });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: { id: MANIFEST.id } });
  try {
    // 注：Node 自己的 fs.glob 目前只接受 string cwd（传 URL 会在内部 path.resolve 抛错），
    // 所以这里只锁「认不出的类型不静默忽略」这一半——那是我们真正能控制的。
    assert.throws(() => fs.globSync('**/*', { cwd: 123 }), /cwd 类型不受支持/);
    assert.equal(fs.globSync('**/*.txt', { cwd: dir }).length, 1, '正常的 string cwd 不受影响');
  } finally {
    bridge.uninstall();
    cleanup(dir);
    cleanup(runtime.dir);
  }
});

test('M3：未知协议拒绝降级成 http', () => {
  const handle = createNetHandle({ guard: stubGuard() });
  // 用非默认端口：ftp 的 :21 会被 URL 规范化掉，反而先触发「无法确定端口」。
  assert.throws(() => handle.get('ftp://example.com:2121/x'), /不支持协议/);
});

test('M4：activate 拒绝第二个运行时，释放后可再激活', () => {
  const { activate } = require('../src/index');
  const dir = tempDir('activate-');
  const hostFor = () => ({
    manifest: MANIFEST,
    grants: [],
    patchBuiltins: false,
    autoSweep: false,
    ledgerPath: path.join(dir, 'ledger.jsonl'),
  });
  let first = null;
  let second = null;
  try {
    first = activate(hostFor());
    assert.throws(() => activate(hostFor()), /只能有一个活动的 covenant 运行时/);
    first.deactivate();
    first = null;
    second = activate(hostFor());
  } finally {
    if (first) first.deactivate();
    if (second) second.deactivate();
    cleanup(dir);
  }
});

test('M5：并发追加被检测出来，而不是写出重复 seq', () => {
  const dir = tempDir('ledger-concurrent-');
  const file = path.join(dir, 'ledger.jsonl');
  const a = new Ledger(file);
  const b = new Ledger(file);
  const record = {
    plugin: 'p', capability: 'fs.read', action: 'fs.read', scope: {},
    decision: 'allow', ruleId: 'two-key', reason: 'r',
  };
  try {
    a.append(record);
    // H6 之后同进程多实例共享 size 基准（那是修复目标，不是漏洞）：
    // b 与 a 对同一磁盘的认知一致，交替写入不再误报。
    b.append(record);
    assert.equal(b.append(record).seq, 3);
    // 真正的并发写入者要用 Ledger 之外的写入模拟（外部进程直写）：
    // 共享基准发现磁盘漂移后，append 必须报错，而不是把别人的字节当基准续写。
    fs.appendFileSync(file, '{"external":true}\n');
    assert.throws(() => a.append(record), /并发写入/);
    assert.throws(() => b.append(record), /并发写入/);
  } finally {
    cleanup(dir);
  }
});

test('M6：失陷状态能从 coverage() 看到', () => {
  const runtime = runtimeFor();
  try {
    runtime.guard.setCompromised('test 注入');
    assert.equal(runtime.guard.coverage().compromised, 'test 注入');
  } finally {
    cleanup(runtime.dir);
  }
});

test('L1：批量判定的目标数有上限', () => {
  const runtime = runtimeFor();
  try {
    const payloads = new Array(10001).fill({ path: '/tmp/x' });
    assert.throws(() => runtime.guard.enforceBatch('fs.read', payloads), /批量判定目标过多/);
  } finally {
    cleanup(runtime.dir);
  }
});

test('L2：ESM 入口给出明确错误而不是 SyntaxError', async () => {
  const { LocalHost } = require('../src/host/local-host');
  const dir = tempDir('esm-');
  const pluginDir = path.join(dir, 'plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({
    id: 'com.example.esm', name: 'ESM', version: '1.0.0', entry: 'index.mjs',
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'index.mjs'), 'export default {};\n');

  const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl') });
  try {
    await host.install(pluginDir);
    await assert.rejects(() => host.register('com.example.esm'), /ESM 入口/);
  } finally {
    try { await host.uninstall('com.example.esm'); } catch {}
    cleanup(dir);
  }
});
