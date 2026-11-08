'use strict';

// 第六轮修复（2026-11-06，1.10.9）的回归测试。
// 依据 .review/dsh-dashcam-review-1.10.8-2026-11-06.md 的 P1 清单：
//  - M1：guardSocket 只看 host/port，句柄层拒 path、Bridge 层放行的双轨。
//  - M4：maxMessageBytes 无实现（ChildHost 双向消息无上限）。
//  - M5：ipcTimeoutMs 无实现（只有 invokeTimeoutMs 参数）。
//  - M8：strictPatch 只在 LocalHost 生效，createPluginRuntime/activate 不检查。
//  - M11：safetyStage.errors 被清空（证据丢失 + strict 看不到安全阻断项）。
//  - M15：realpathSafe 非 ENOENT 失败退回词法路径（fail-open）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { ChildHost } = require('../src/host/child-host');
const { messageSizeBytes, makeResponse } = require('../src/runtime/ipc/protocol');
const { realpathSafe, expandPath } = require('../src/util/paths');
const { runInstallPipeline } = require('../src/gates/index');
const { LocalHost } = require('../src/host/local-host');
const { activate, parseManifest } = require('../src/index');
const { parseManifest: parseManifestContract } = require('../src/contract/manifest');

function readLedger(file) {
  try { return new Ledger(file).records(); } catch { return []; }
}

// ── M1：socketPath 双轨统一 ──────────────────────────────────────

test('R6-M1：net.connect 走 options.path（Unix socket）时 Bridge 层拒绝并记账（不再落 Two-Key 判定）', async () => {
  const dir = tempDir('r6-m1-');
  const code = [
    "'use strict';",
    'const net = require("node:net");',
    'module.exports = {',
    '  invoke() {',
    '    const out = {};',
    '    try { net.connect({ path: "/tmp/evil.sock" }); out.objectPath = "NOT-DENIED"; }',
    '    catch (e) { out.objectPath = e.code; out.objectRule = e.ruleId; }',
    '    try { net.connect("/tmp/evil.sock"); out.stringPath = "NOT-DENIED"; }',
    '    catch (e) { out.stringPath = e.code; out.stringRule = e.ruleId; }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.r6.socketpath',
      requests: [],
      code,
    });
    const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl') });
    await host.install(path.join(dir, 'plugin'));
    await host.register('com.example.r6.socketpath');
    const out = await host.invoke('com.example.r6.socketpath');
    await host.uninstall('com.example.r6.socketpath');
    // 关键：ruleId 必须是 socket_path（专门拒绝），而不是 not_declared（Two-Key 判定）
    // ——后者说明它被误折算成了 { host:'localhost', port:0 } 走了正常判定轨道。
    assert.equal(out.objectPath, 'DASHCAM_DENIED', 'options.path 形态必须被拒');
    assert.equal(out.objectRule, 'socket_path');
    assert.equal(out.stringPath, 'DASHCAM_DENIED', '字符串路径形态必须被拒');
    assert.equal(out.stringRule, 'socket_path');
    const denies = readLedger(path.join(dir, 'ledger.jsonl'))
      .filter((r) => r.ruleId === 'socket_path' && r.decision === 'deny');
    assert.ok(denies.length >= 2, `socket_path 必须逐条记账，实际 ${denies.length} 条`);
    assert.ok(denies.every((r) => r.scope && typeof r.scope.path === 'string'), '账本要带 path scope');
  } finally {
    cleanup(dir);
  }
});

// ── M4：maxMessageBytes ─────────────────────────────────────────

function fakeChildSetup(options) {
  const dir = tempDir('r6-m4-');
  const scope = { paths: [dir.replace(/\\/g, '/') + '/**'] };
  const guard = createGuardChain({
    manifest: {
      id: 'com.example.r6', name: 'R6', version: '1.0.0', entry: 'x.js', kind: 'dashcam',
      dashcam: { spec: 'dsh-dashcam/1', content: null, requests: [{ capability: 'fs.read', scope, reason: '读' }] },
    },
    grants: [{ id: 'g', capability: 'fs.read', scope, enabled: true, expiresAt: null, oneSeal: false }],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
    pluginRoot: dir,
  });
  const host = new ChildHost({ guard, childEntry: path.join(dir, 'child.js'), ...options });
  const sent = [];
  host.child = { connected: true, send: (m) => sent.push(m) };
  host._ready = Promise.resolve();
  return { host, sent, dir };
}

test('R6-M4：入向超大消息丢弃、出向超大响应降级为小错误响应、invoke 载荷超限发送前拒绝', async () => {
  const { host, sent, dir } = fakeChildSetup({ maxMessageBytes: 200 });
  // 入向：超大响应不会 settle（丢弃），小响应正常 settle（用 makeResponse 保证形状合法）
  let settled = null;
  host.pending.set('p1', { resolve: (v) => { settled = v; }, reject: () => {}, timer: null });
  host._onMessage(makeResponse('p1', true, 'x'.repeat(500))); // 超限 → 丢弃
  assert.equal(settled, null, '超限响应必须被丢弃');
  host._onMessage(makeResponse('p1', true, 'ok')); // 未超限 → settle
  assert.equal(settled, 'ok', '未超限响应正常处理');
  // 出向：超大响应降级为 response_too_large 小响应
  host._reply('r9', true, 'y'.repeat(500));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].error.code, 'response_too_large');
  // 出向请求：invoke 载荷超限，发送前就抛
  await assert.rejects(
    () => host.invoke({ data: 'z'.repeat(500) }),
    (error) => error.code === 'message_too_large' && /maxMessageBytes/.test(error.message),
  );
  assert.ok(!sent.some((m) => m.op === 'invoke'), '超限请求不得发出');
  // 非法 maxMessageBytes 回落默认，不允许「配坏了就取消上限」
  const { host: host2, dir: dir2 } = fakeChildSetup({ maxMessageBytes: -1 });
  assert.equal(host2.maxMessageBytes, 1_048_576);
  cleanup(dir);
  cleanup(dir2);
});

test('R6-M4：messageSizeBytes 对循环引用返回 Infinity（fail-closed）', () => {
  const circular = { self: null };
  circular.self = circular;
  assert.equal(messageSizeBytes(circular), Number.POSITIVE_INFINITY);
  assert.ok(messageSizeBytes({ hello: 'world' }) > 0);
});

// ── M5：ipcTimeoutMs ────────────────────────────────────────────

test('R6-M5：ipcTimeoutMs 生效（超时拒绝）、0 = 不限时、旧参数名 invokeTimeoutMs 仍兼容', async () => {
  const { host: timed, dir: d1 } = fakeChildSetup({ ipcTimeoutMs: 50 });
  assert.equal(timed.ipcTimeoutMs, 50);
  // child 吞掉消息 → invoke 必然超时
  await assert.rejects(() => timed.invoke({ x: 1 }), /invoke 超时（50ms）/);
  cleanup(d1);

  const { host: untimed, dir: d2 } = fakeChildSetup({ ipcTimeoutMs: 0 });
  assert.equal(untimed.ipcTimeoutMs, 0, '0 = 不限时');
  cleanup(d2);

  const { host: legacy, dir: d3 } = fakeChildSetup({ invokeTimeoutMs: 1234 });
  assert.equal(legacy.ipcTimeoutMs, 1234, '旧参数名 invokeTimeoutMs 仍生效');
  cleanup(d3);

  const { host: fallback, dir: d4 } = fakeChildSetup({ ipcTimeoutMs: -5 });
  assert.equal(fallback.ipcTimeoutMs, 5_000, '负数回落默认（fail-closed：默认有限时）');
  cleanup(d4);
});

// ── M8：strictPatch 接入 createPluginRuntime/activate ───────────

test('R6-M8：activate({ strictPatch }) 在补丁不完整时拒绝装载（与 LocalHost 同语义）', () => {
  const dir = tempDir('r6-m8-');
  const manifest = parseManifestContract({
    id: 'com.example.r6.m8',
    name: 'M8',
    version: '1.0.0',
    entry: 'index.js',
    kind: 'dashcam',
    dashcam: {
      spec: 'dsh-dashcam/1',
      capabilities: { requests: [] },
      content: { rating: 'general', scenes: ['host'], commercialUse: 'allowed' },
    },
  }).manifest;
  const saved = fs.opendirSync;
  delete fs.opendirSync; // 复刻 options.test.js 的手法：制造补丁不完整
  try {
    assert.throws(
      () => activate({
        manifest,
        grants: [],
        ledgerPath: path.join(dir, 'ledger.jsonl'),
        patchBuiltins: true,
        autoSweep: false,
        policy: { enforcement: { strictPatch: true } },
      }),
      /沙箱补丁不完整/,
      'strictPatch 下补丁不完整必须拒绝',
    );
    // 非 strictPatch：同样情况只降级不拒绝（行为不变）
    const runtime = activate({
      manifest,
      grants: [],
      ledgerPath: path.join(dir, 'ledger2.jsonl'),
      patchBuiltins: true,
      autoSweep: false,
    });
    runtime.deactivate();
  } finally {
    fs.opendirSync = saved;
    cleanup(dir);
  }
});

// ── M11：safetyStage.errors 不再清空 ────────────────────────────

test('R6-M11：安全门禁错误保留在报告里；strict 模式下据此跳过 loadability', async () => {
  const dir = tempDir('r6-m11-');
  const plugin = createPlugin({
    dir,
    requests: [],
    code: [
      "'use strict';",
      'const { execSync } = require("node:child_process");',
      'module.exports = { invoke() { return execSync("echo hi").toString(); } };',
    ].join('\n'),
  });
  try {
    // advisory（consumer 默认）：不阻断安装流程，但错误必须保留在报告里（证据不丢）
    const advisory = await runInstallPipeline({ pluginDir: dir, channel: 'consumer' });
    const advisorySafety = advisory.stages.find((stage) => stage.name === 'safety');
    assert.ok(advisorySafety.errors.length > 0, 'advisory 下 safety 错误必须保留（M11 前被清空）');
    assert.ok(advisorySafety.errors.some((e) => e.code === 'undeclared_capability'));
    // strict（required）：blockedSoFar 现在能看到安全错误 → loadability 跳过
    const strict = await runInstallPipeline({
      pluginDir: dir,
      channel: 'consumer',
      policy: { enforcement: { mode: 'required' } },
      host: new LocalHost({ ledgerPath: path.join(dir, '.ledger.jsonl') }),
    });
    const strictSafety = strict.stages.find((stage) => stage.name === 'safety');
    assert.ok(strictSafety.errors.length > 0, 'strict 下 safety 错误同样保留');
    const loadStage = strict.stages.find((stage) => stage.name === 'loadability');
    assert.ok(
      loadStage.labels.some((label) => label.code === 'loadability_skipped'),
      'strict 模式必须跳过 loadability（不执行未过审插件代码）',
    );
  } finally {
    cleanup(dir);
  }
});

// ── M15：realpathSafe fail-closed ───────────────────────────────

test('R6-M15：非 ENOENT 失败返回 null（不再退回词法路径）；ENOENT 场景保留词法退化', () => {
  const dir = tempDir('r6-m15-');
  // ENOENT 场景（纯不存在）：保留词法退化（写/新建文件的合法场景）。
  // realpathSafe 内部走 normalizePath（正斜杠口径），断言用同口径期望值。
  const missing = path.join(dir, 'no-such-parent', 'file.txt');
  assert.equal(
    realpathSafe(missing),
    path.normalize(missing).replace(/\\/g, '/'),
    'ENOENT 仍按词法退化',
  );
  // 已存在目录：解析为真实路径
  assert.equal(realpathSafe(dir), fs.realpathSync.native(dir).replace(/\\/g, '/'));
  // 非 ENOENT 场景：超长路径触发 ENAMETOOLONG（Windows 常规路径上限 260）。
  // 平台若启用了长路径支持会解析成功——那种情况下跳过断言（平台差异，不是功能缺失）。
  const longPath = path.join(dir, 'a'.repeat(300) + '.txt');
  let threwNonEnoent = false;
  try { fs.realpathSync.native(longPath); } catch (error) {
    threwNonEnoent = error.code !== 'ENOENT';
  }
  if (threwNonEnoent) {
    assert.equal(realpathSafe(longPath), null, `非 ENOENT 失败必须返回 null（实测 ${longPath.length} 字符路径）`);
  }
  cleanup(dir);
});

/**
 * 找一个 realpath 会非 ENOENT 失败的路径（平台相关）：优先超长路径
 * （ENAMETOOLONG），退而求其次自指符号链接（ELOOP）；平台两种都不产生时
 * 返回 null，调用方跳过 fail-closed 断言（Windows/长路径开启的环境差异）。
 */
function findNonEnoentPath(dir) {
  const longPath = path.join(dir, 'b'.repeat(300) + '.txt');
  try { fs.realpathSync.native(longPath); } catch (error) {
    if (error.code !== 'ENOENT') return longPath;
  }
  const link = path.join(dir, 'loop-link');
  try { fs.symlinkSync(link, link, 'junction'); } catch { /* 建不出来就放弃这条路 */ }
  try { fs.realpathSync.native(link); } catch (error) {
    if (error.code !== 'ENOENT') return link;
  }
  return null;
}

test('R6-M15：derive 对无法解析真实路径的请求 fail-closed（derive_failed），配置解析直接抛', () => {
  const dir = tempDir('r6-m15b-');
  const scope = { paths: [dir.replace(/\\/g, '/') + '/**'] };
  const guard = createGuardChain({
    manifest: {
      id: 'com.example.r6.m15', name: 'M15', version: '1.0.0', entry: 'x.js', kind: 'dashcam',
      dashcam: { spec: 'dsh-dashcam/1', content: null, requests: [{ capability: 'fs.read', scope, reason: '读' }] },
    },
    grants: [{ id: 'g', capability: 'fs.read', scope, enabled: true, expiresAt: null, oneSeal: false }],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
    pluginRoot: dir,
  });
  // 判定层 fail-closed：拿不到真实路径 → derive_failed 拒绝（fail-open 即符号链接后门）
  const badPath = findNonEnoentPath(dir);
  if (badPath) {
    const decision = guard.check('fs.read', { path: badPath });
    assert.equal(decision.allowed, false, '拿不到真实路径必须拒绝');
    assert.equal(decision.code, 'derive_failed');
  }
  // expandPath：root 解析失败直接抛（配置期 fail-closed，不允许授权基准建立在猜测上）
  const badRoot = findNonEnoentPath(tempDir('r6-m15c-'));
  if (badRoot) {
    assert.throws(
      () => expandPath('$PLUGIN/x', { pluginRoot: badRoot, home: dir }),
      (error) => /无法解析真实路径/.test(error.message),
    );
  }
  cleanup(dir);
});
