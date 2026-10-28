'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { stableStringify, sha256 } = require('../src/util/stable');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');

function record(overrides = {}) {
  return {
    plugin: 'com.example.audit',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '读取缓存',
    ...overrides,
  };
}

test('Ledger：正常账本可逐行重算', () => {
  const dir = tempDir('audit-ok-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_granted', reason: '宿主未授予' }));
  const report = new Ledger(file).verify();
  assert.equal(report.ok, true);
  assert.equal(report.count, 2);
  assert.equal(report.errors.length, 0);
  assert.match(report.head, /^[a-f0-9]{64}$/);
  cleanup(dir);
});

test('Ledger：尾行损坏时报告 json_invalid，而不是让 verify 抛异常', () => {
  const dir = tempDir('audit-tail-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record());
  fs.appendFileSync(file, '{"v":1,"seq":3,"broken\n');
  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.equal(report.head, null);
  assert.ok(report.errors.some((error) => error.code === 'json_invalid' && error.line === 3));
  cleanup(dir);
});

test('Ledger：v1 历史账本仍可验证（版本感知字段集）', () => {
  const dir = tempDir('audit-v1-');
  const file = path.join(dir, 'ledger.jsonl');
  const base = {
    v: 1,
    seq: 1,
    ts: '2026-10-01T00:00:00.000Z',
    plugin: 'com.example.old',
    pluginVersion: '1.0.0',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '旧版记录',
    prevHash: 'GENESIS',
  };
  base.hash = sha256(stableStringify(base));
  fs.writeFileSync(file, JSON.stringify(base) + '\n');
  const report = new Ledger(file).verify();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.count, 1);
  cleanup(dir);
});

test('Ledger：v1 记录里塞入 intercepted 会被 hash 校验抓住', () => {
  const dir = tempDir('audit-v1-tamper-');
  const file = path.join(dir, 'ledger.jsonl');
  const base = {
    v: 1,
    seq: 1,
    ts: '2026-10-01T00:00:00.000Z',
    plugin: 'com.example.old',
    pluginVersion: null,
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '旧版记录',
    prevHash: 'GENESIS',
  };
  base.hash = sha256(stableStringify(base));
  base.intercepted = true;
  fs.writeFileSync(file, JSON.stringify(base) + '\n');
  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'hash_mismatch'));
  cleanup(dir);
});

test('Ledger：中间行被篡改时定位到具体行号', () => {
  const dir = tempDir('audit-tamper-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record());
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.decision = 'deny';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'hash_mismatch' && error.line === 1));
  cleanup(dir);
});

test('One-Seal：审计写失败时释放占位，不白烧一次性授权', () => {
  const dir = tempDir('audit-seal-');
  const scope = { paths: [path.join(dir, '**')] };
  const seal = new OneSealStore({ ttlMs: 60_000 });
  seal.issue({ id: 'seal-1', oneSeal: true, sealTtlMs: 60_000 });
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读取缓存' }],
      },
    },
    grants: [{
      id: 'seal-1',
      capability: 'fs.read',
      scope,
      enabled: true,
      oneSeal: true,
      expiresAt: null,
      sealTtlMs: 60_000,
    }],
    ledger: { append() { throw new Error('disk full'); } },
    seal,
  });

  assert.throws(() => guard.enforce('fs.read', { path: path.join(dir, 'a.txt') }), /Ledger 写入失败/);
  assert.equal(seal.isAvailable('seal-1'), true, '一次性授权不应被审计故障消耗');
  cleanup(dir);
});

test('One-Seal：成功放行后 commit，第二次必然失败', () => {
  const dir = tempDir('audit-seal-ok-');
  const scope = { paths: [path.join(dir, '**')] };
  const file = path.join(dir, 'ledger.jsonl');
  const seal = new OneSealStore({ ttlMs: 60_000 });
  seal.issue({ id: 'seal-1', oneSeal: true, sealTtlMs: 60_000 });
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读取缓存' }],
      },
    },
    grants: [{
      id: 'seal-1',
      capability: 'fs.read',
      scope,
      enabled: true,
      oneSeal: true,
      expiresAt: null,
      sealTtlMs: 60_000,
    }],
    ledger: new Ledger(file),
    seal,
  });
  guard.enforce('fs.read', { path: path.join(dir, 'a.txt') });
  assert.equal(seal.isAvailable('seal-1'), false);
  assert.throws(() => guard.enforce('fs.read', { path: path.join(dir, 'b.txt') }), /一次性授予/);
  cleanup(dir);
});

test('审计归因：reason 来自真正覆盖请求的那条声明', () => {
  const dir = tempDir('audit-reason-');
  const file = path.join(dir, 'ledger.jsonl');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [
          { capability: 'net.outbound', scope: { hosts: ['metrics.example:443'] }, reason: '上报指标' },
          { capability: 'net.outbound', scope: { hosts: ['cdn.example:443'] }, reason: '下载依赖' },
        ],
      },
    },
    grants: [
      { id: 'g1', capability: 'net.outbound', scope: { hosts: ['metrics.example:443'] }, enabled: true },
      { id: 'g2', capability: 'net.outbound', scope: { hosts: ['cdn.example:443'] }, enabled: true },
    ],
    ledger: new Ledger(file),
  });
  guard.enforce('net.outbound', { host: 'cdn.example', port: 443 });
  const last = new Ledger(file).records().at(-1);
  assert.equal(last.decision, 'allow');
  assert.equal(last.reason, '下载依赖');
  cleanup(dir);
});

test('Ledger：intercepted 标记未声明调用，interceptions() 按该口径统计', () => {
  const dir = tempDir('audit-intercept-');
  const file = path.join(dir, 'ledger.jsonl');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
      },
    },
    grants: [{ id: 'g1', capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, enabled: true }],
    ledger: new Ledger(file),
  });

  const denied = guard.check('net.outbound', { host: 'evil.example', port: 443 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'not_declared');
  assert.equal(denied.intercepted, true);

  const ledger = new Ledger(file);
  assert.equal(ledger.verify().ok, true);
  const record = ledger.records().at(-1);
  assert.equal(record.intercepted, true);
  assert.equal(record.ruleId, 'not_declared');
  assert.equal(ledger.interceptions().length, 1);
  assert.equal(guard.stats.intercepted, 1);
  cleanup(dir);
});

test('守卫入口：installNativeHooks 把 fs 直调接入同一条守卫链', () => {
  const dir = tempDir('audit-hook-');
  const file = path.join(dir, 'ledger.jsonl');
  const outsideDir = tempDir('audit-hook-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [],
      },
    },
    grants: [],
    ledger: new Ledger(file),
  });
  const hooks = guard.installNativeHooks();
  assert.ok(hooks);
  assert.equal(guard.hooks, hooks);
  try {
    assert.throws(() => fs.readFileSync(outside, 'utf8'), /未在 manifest 中声明|未授予/);
  } finally {
    guard.uninstallNativeHooks();
  }
  assert.equal(guard.hooks, null);
  assert.equal(new Ledger(file).interceptions().length, 1);
  cleanup(dir);
  cleanup(outsideDir);
});

test('Ledger MAC：有密钥的账本无法被无密钥者重算', () => {
  const dir = tempDir('audit-mac-');
  const file = path.join(dir, 'ledger.jsonl');
  const key = 'test-mac-key-32bytes-padded-000000';
  const ledger = new Ledger(file, { macKey: key });
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_declared', intercepted: true }));
  assert.equal(new Ledger(file, { macKey: key }).verify().ok, true);
  assert.equal(new Ledger(file).records()[0].v, 3);

  // 篡改者重算了哈希链但没有密钥：mac 校验必须抓出来。
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const forged = JSON.parse(lines[1]);
  forged.reason = '伪造原因';
  delete forged.hash;
  forged.hash = sha256(stableStringify({ ...forged, mac: undefined }));
  forged.mac = '0'.repeat(64); // 没有密钥，只能瞎编
  lines[1] = stableStringify(forged);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const result = new Ledger(file, { macKey: key }).verify();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'mac_mismatch'));

  // 错误的密钥同样全部失败。
  fs.writeFileSync(file, '');
  const other = new Ledger(file, { macKey: 'wrong-key' });
  other.append(record());
  assert.equal(new Ledger(file, { macKey: key }).verify().ok, false);
  cleanup(dir);
});

test('TOCTOU：open 后按 fd 复核，符号链接替换落点被二次判定拦截', (t) => {
  const dir = tempDir('audit-toctou-');
  const outsideDir = tempDir('audit-toctou-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const linkInside = path.join(dir, 'alias.txt');
  try {
    fs.symlinkSync(outside, linkInside);
  } catch (error) {
    t.skip(`当前环境不允许创建符号链接：${error.code}`);
    cleanup(dir);
    cleanup(outsideDir);
    return;
  }
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: {
        spec: 'dsh-covenant/1',
        content: null,
        requests: [{ capability: 'fs.read', scope: { paths: [`${dir.replace(/\\/g, '/')}/**`] }, reason: '读取插件目录' }],
      },
    },
    grants: [{ id: 'g1', capability: 'fs.read', scope: { paths: [`${dir.replace(/\\/g, '/')}/**`] }, enabled: true }],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  const hooks = guard.installNativeHooks();
  try {
    // 链接本体在插件目录内（判定通过），落点在目录外（fd 复核必须拦下）。
    assert.throws(() => fs.readFileSync(linkInside, 'utf8'), /未在 manifest 中声明|未授予|拒绝/);
  } finally {
    guard.uninstallNativeHooks();
    cleanup(dir);
    cleanup(outsideDir);
  }
});

test('globSync：路径在返回值里，逐个结果都要过守卫', (t) => {
  if (typeof fs.globSync !== 'function') {
    t.skip('当前 Node 版本没有 fs.globSync');
    return;
  }
  const dir = tempDir('audit-glob-');
  const outsideDir = tempDir('audit-glob-out-');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: { spec: 'dsh-covenant/1', content: null, requests: [] },
    },
    grants: [],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  guard.installNativeHooks();
  try {
    assert.throws(
      () => fs.globSync('*.txt', { cwd: outsideDir }),
      /未在 manifest 中声明|未授予/,
    );
  } finally {
    guard.uninstallNativeHooks();
    cleanup(dir);
    cleanup(outsideDir);
  }
});

test('worker_threads：Worker 创建收敛到 proc.spawn 判定', (t) => {
  const dir = tempDir('audit-worker-');
  const workerFile = path.join(dir, 'worker.js');
  fs.writeFileSync(workerFile, '/* worker */');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'covenant',
      covenant: { spec: 'dsh-covenant/1', content: null, requests: [] },
    },
    grants: [],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  guard.installNativeHooks();
  try {
    const { Worker } = require('node:worker_threads');
    assert.throws(() => new Worker(workerFile), /未在 manifest 中声明|未授予/);
  } finally {
    guard.uninstallNativeHooks();
    cleanup(dir);
  }
});
