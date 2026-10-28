'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { Ledger } = require('../src/runtime/ledger');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');

function setup({ requests = [], files = {} } = {}) {
  const dir = tempDir('bypass-');
  createPlugin({
    dir,
    requests,
    files,
  });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const seal = new OneSealStore();
  const grants = requests.map((request, index) => normalizeGrant({
    capability: request.cap,
    scope: request.scope,
  }, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants, ledger, seal, pluginRoot: dir });
  return { dir, manifest, ledger, seal, guard };
}

test('绕过测试：直调 Node API 仍被守卫链拦截', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  // 外部文件必须在 Bridge 安装前创建：安装后 write 同样受 Two-Key 约束。
  const outsideDir = tempDir('bypass-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const own = path.join(runtime.dir, 'own.txt');
  fs.writeFileSync(own, 'own');
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    assert.throws(() => fs.readFileSync(outside, 'utf8'), /未声明|未授予/);
    assert.equal(fs.readFileSync(own, 'utf8'), 'own');
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('绕过测试：第三方库通过 require 访问 fs 同样被拦截', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
    files: {
      'lib.js': [
        "'use strict';",
        "const fs = require('node:fs');",
        'module.exports = (target) => fs.readFileSync(target, "utf8");',
      ].join('\n'),
    },
  });
  const outsideDir = tempDir('bypass-lib-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    const lib = require(path.join(runtime.dir, 'lib.js'));
    assert.throws(() => lib(outside), /未声明|未授予/);
  } finally {
    bridge.uninstall();
    delete require.cache[require.resolve(path.join(runtime.dir, 'lib.js'))];
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('绕过测试：patch 注入被完整性校验发现并触发失败关闭', () => {
  const realReadFileSync = fs.readFileSync;
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    // 模拟恶意插件在安装前保存原始函数，再把它写回覆盖 Bridge。
    fs.readFileSync = realReadFileSync;
    const injected = bridge.verifyIntegrity();
    assert.equal(injected.ok, false);
    assert.ok(injected.violations.some((violation) => violation.target === 'readFileSync'));
    assert.equal(runtime.guard.isCompromised(), true);
    const tamper = runtime.ledger.records().find((record) => record.ruleId === 'tamper_detected');
    assert.ok(tamper);
    assert.throws(
      () => runtime.guard.enforce('fs.read', { path: path.join(runtime.dir, 'any.txt') }),
      /完整性/,
    );
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('绕过测试：直接网络与环境变量访问也被拦截', () => {
  const key = 'DSH_BYPASS_API_KEY';
  process.env[key] = 'secret';
  const runtime = setup({
    requests: [{ cap: 'cred.read', scope: { targets: [`env:${key}`] }, reason: '读取密钥' }],
  });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    assert.equal(process.env[key], 'secret');
    assert.throws(() => process.env.DSH_UNKNOWN_API_KEY, /未声明|未授予/);
    assert.throws(() => http.get('http://attacker.example:80/'), /未声明|未授予/);
  } finally {
    bridge.uninstall();
    delete process.env[key];
    cleanup(runtime.dir);
  }
});

test('绕过测试：fs.openSync 不能绕开句柄关口', async () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const outsideDir = tempDir('bypass-open-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const own = path.join(runtime.dir, 'own.txt');
  fs.writeFileSync(own, 'own');
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    assert.throws(() => fs.openSync(outside, 'r'), /未声明|未授予/);
    // fsp.open 是异步 API：判定失败表现为 rejected promise，不是同步抛错。
    await assert.rejects(() => fs.promises.open(outside, 'r'), /未声明|未授予/);
    const fd = fs.openSync(own, 'r');
    fs.closeSync(fd);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('绕过测试：Socket 实例直连不能绕开出站管控', () => {
  const runtime = setup({ requests: [] });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    const socket = new net.Socket();
    assert.throws(() => socket.connect(9, '127.0.0.1'), /未声明|未授予|manifest 中声明/);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('绕过测试：dns.promises 同样受出站管控', () => {
  const runtime = setup({ requests: [] });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    assert.throws(() => dns.promises.lookup('example.com'), /未声明|未授予|manifest 中声明/);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('绕过测试：覆写敏感环境变量需要 cred.write，而不是 env.write', () => {
  const sensitive = 'DSH_BYPASS_WRITE_KEY';
  const plain = 'DSH_BYPASS_WRITE_FLAG';
  const runtime = setup({
    requests: [{ cap: 'env.write', scope: { keys: ['DSH_BYPASS_WRITE_*'] }, reason: '写入运行期标志' }],
  });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    assert.throws(() => { process.env[sensitive] = 'x'; }, /未声明|未授予|manifest 中声明/);
    // 非敏感键有 env.write 授予即可写；读回验证放到卸载之后（读是另一项能力）。
    process.env[plain] = '1';
  } finally {
    bridge.uninstall();
  }
  try {
    assert.equal(process.env[plain], '1');
  } finally {
    delete process.env[plain];
    delete process.env[sensitive];
    cleanup(runtime.dir);
  }
});

test('绕过测试：fs.promises.link 需要读权限（硬链接二次命名）', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.write', scope: { paths: ['$PLUGIN/**'] }, reason: '写入自身目录' }],
  });
  const outsideDir = tempDir('bypass-hardlink-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    // 只给写权限：把范围外文件 link 进插件目录，等于给它起了第二个名字。
    // realpath 帮不上忙（两个名字都是真的），所以 link 必须同时要读权限。
    assert.throws(
      () => fs.promises.link(outside, path.join(runtime.dir, 'stolen.txt')),
      /未声明|未授予|manifest/,
    );
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('覆盖自检：句柄与实例入口登记在 guarded 里，knownGaps 不为空', () => {
  const runtime = setup({ requests: [] });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
  try {
    const report = bridge.coverage();
    for (const entry of ['fs.open', 'fs.openSync', 'fsp.open', 'net.Socket#connect', 'dns.promises.lookup']) {
      assert.ok(report.guarded.includes(entry), `coverage 缺少 ${entry}`);
    }
    assert.ok(report.knownGaps.length >= 4);
    assert.ok(report.entries > 80);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});
