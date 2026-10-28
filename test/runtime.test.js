'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { Ledger } = require('../src/runtime/ledger');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');

function setupRuntime({ requests, dir = tempDir('runtime-') }) {
  createPlugin({ dir, requests });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const seal = new OneSealStore({ ttlMs: 60_000 });
  const grants = requests.map((request, index) => normalizeGrant({
    capability: request.cap,
    scope: request.scope,
  }, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants, ledger, seal, pluginRoot: dir });
  const bridge = createBridge({ guard, ledger, plugin: manifest });
  return { dir, manifest, ledger, seal, guard, bridge };
}

test('运行时：fs 访问经过守卫链并按声明放行/拒绝', () => {
  const dir = tempDir('runtime-fs-');
  // 临时目录必须在 Bridge 安装前建好：安装后 mkdtemp 同样受 fs.write 约束。
  const outsideDir = tempDir('outside-');
  const outside = path.join(outsideDir, 'secret.txt');
  const runtime = setupRuntime({
    dir,
    requests: [
      { cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身缓存' },
      { cap: 'fs.write', scope: { paths: ['$PLUGIN/**'] }, reason: '写入自身缓存' },
    ],
  });
  try {
    const allowedPath = path.join(dir, 'cache.txt');
    fs.writeFileSync(allowedPath, 'ok');
    const content = fs.readFileSync(allowedPath, 'utf8');
    assert.equal(content, 'ok');

    assert.throws(() => fs.readFileSync(outside, 'utf8'), /未声明|未授予/);

    const decisions = runtime.ledger.records().map((record) => record.decision);
    assert.ok(decisions.includes('allow'));
    assert.ok(decisions.includes('deny'));
    assert.equal(runtime.ledger.verify().ok, true);
  } finally {
    runtime.bridge.uninstall();
    cleanup(dir);
    cleanup(outsideDir);
  }
});

test('运行时：出站网络按 host:port 授权，未声明目标在执行前拒绝', async () => {
  const server = http.createServer((request, response) => response.end('ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = tempDir('runtime-net-');
  const runtime = setupRuntime({
    dir,
    requests: [
      { cap: 'net.outbound', scope: { hosts: [`127.0.0.1:${port}`] }, reason: '访问本地服务' },
    ],
  });
  try {
    const body = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/`, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve(data));
      }).on('error', reject);
    });
    assert.equal(body, 'ok');
    assert.throws(() => http.get('http://example.com:80/'), /未声明|未授予/);
  } finally {
    runtime.bridge.uninstall();
    await new Promise((resolve) => server.close(resolve));
    cleanup(dir);
  }
});

test('运行时：进程与环境变量访问收敛到守卫链', () => {
  const key = 'DSH_TEST_API_KEY';
  process.env[key] = 'secret-before-bridge';
  const dir = tempDir('runtime-proc-');
  const runtime = setupRuntime({
    dir,
    requests: [
      { cap: 'proc.spawn', scope: { commands: ['node'] }, reason: '运行 Node 子进程' },
      { cap: 'cred.read', scope: { targets: [`env:${key}`] }, reason: '读取测试密钥' },
    ],
  });
  try {
    // 插件在宿主安装 Bridge 之后才 require 子进程模块，否则拿到的是安装前的原始引用。
    const { execSync } = require('node:child_process');
    assert.equal(execSync('node --version', { encoding: 'utf8' }).trim().startsWith('v'), true);
    assert.throws(() => execSync('whoami'), /未声明|未授予/);
    assert.equal(process.env[key], 'secret-before-bridge');
    assert.throws(() => process.env.DSH_OTHER_API_KEY, /未声明|未授予/);
  } finally {
    runtime.bridge.uninstall();
    delete process.env[key];
    cleanup(dir);
  }
});

test('One-Seal：一次性 grant 用完即删，过期自动清扫', () => {
  const dir = tempDir('runtime-seal-');
  createPlugin({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '一次性读取' }],
  });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  let fakeNow = 1000;
  const seal = new OneSealStore({ ttlMs: 100, now: () => fakeNow });
  const grant = normalizeGrant({
    capability: 'fs.read',
    scope: { paths: ['$PLUGIN/**'] },
    oneSeal: true,
  }, { pluginRoot: dir }, 0);
  seal.issue(grant);
  const guard = createGuardChain({ manifest, grants: [grant], ledger, seal, pluginRoot: dir });
  const payload = { path: path.join(dir, 'a.txt') };

  guard.enforce('fs.read', payload);
  assert.equal(seal.size(), 0);
  assert.throws(() => guard.enforce('fs.read', payload), /一次性|未授予|已使用/);

  const expiring = normalizeGrant({
    capability: 'fs.read',
    scope: { paths: ['$PLUGIN/**'] },
    oneSeal: true,
    id: 'expiring',
  }, { pluginRoot: dir }, 1);
  seal.issue(expiring);
  fakeNow += 101;
  assert.equal(seal.isAvailable('expiring', fakeNow), false);
  assert.equal(seal.sweep(fakeNow), 1);
  cleanup(dir);
});

test('Ledger：JSONL 字段固定，哈希链可校验且能发现篡改', () => {
  const dir = tempDir('ledger-');
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  ledger.append({
    plugin: 'p',
    pluginVersion: '1.0.0',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: 'r',
  });
  ledger.append({
    plugin: 'p',
    pluginVersion: '1.0.0',
    capability: 'fs.write',
    action: 'fs.write',
    scope: { paths: ['y'] },
    decision: 'deny',
    ruleId: 'not_declared',
    reason: 'no',
  });
  assert.equal(ledger.verify().ok, true);

  const file = path.join(dir, 'ledger.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = JSON.parse(lines[0]);
  first.reason = 'tampered';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const verified = new Ledger(file).verify();
  assert.equal(verified.ok, false);
  assert.ok(verified.errors.some((error) => error.code === 'hash_mismatch'));
  cleanup(dir);
});
