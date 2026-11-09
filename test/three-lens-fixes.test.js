'use strict';
// 三视角审查（repo-audit-2026-11-09 §6.5）整改的回归用例。
// Fix1：R1 http options 通道拒绝 + R3 URL/options 合并判定。
// Fix3：R7 数字 fd 白名单 + readFile 写 flag 归一。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');
const { Ledger } = require('../src/runtime/ledger');
const { LocalHost } = require('../src/host/local-host');
const { createPluginRuntime } = require('../src/index');

// 记账型假账本：只收集记录，不落盘。
function fakeLedger() {
  return { records: [], append(rec) { this.records.push(rec); } };
}

// grants / requests 支持传函数（入参为 POSIX 分隔的插件根路径），供 fs 用例
// 在目录创建后动态拼 scope；传数组则按原样使用。
function setup({ grants, requests, files }) {
  const dir = tempDir('three-lens-');
  const root = dir.replace(/\\/g, '/');
  createPlugin({
    dir,
    requests: typeof requests === 'function' ? requests(root) : (requests || [
      { cap: 'net.outbound', scope: { hosts: ['a.example:80'] }, reason: '只授 a.example:80' },
    ]),
    files,
  });
  const { manifest } = loadManifest(dir);
  const ledger = fakeLedger();
  const seal = new OneSealStore();
  const resolvedGrants = typeof grants === 'function' ? grants(root) : grants;
  const chain = resolvedGrants.map((grant, index) => normalizeGrant({
    capability: grant.capability,
    scope: grant.scope,
  }, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants: chain, ledger, seal, pluginRoot: dir });
  const bridge = createBridge({ guard, ledger, plugin: manifest });
  bridge.install();
  return { dir, ledger, bridge };
}

const DENIED_RE = /未在 manifest 中声明|未声明的能力或范围|未授予|拒绝/;

// 拒绝记录的 scope 可能是对象（bridge 显式拒绝）也可能已序列化成字符串
// （guard.enforce 的常规路径）——统一转文本做断言。
function scopeText(record) {
  return typeof record.scope === 'string' ? record.scope : JSON.stringify(record.scope);
}

test('R3：http.request(url, options) 的 options.host 覆盖 URL——合并后判定真实建连对象', () => {
  const runtime = setup({ grants: [{ capability: 'net.outbound', scope: { hosts: ['a.example:80'] } }] });
  try {
    // URL 指向已授权的 a.example，options 偷偷换到 b.example：
    // 修复前只判 URL（连 B 记 A），修复后按合并结果 b.example 判定并拒绝。
    assert.throws(
      () => http.request('http://a.example/', { host: 'b.example' }),
      DENIED_RE,
    );
    const deny = runtime.ledger.records.find((r) => r.decision === 'deny');
    assert.ok(deny, '必须落 deny 账');
    assert.ok(scopeText(deny).includes('b.example'), '拒绝对象必须是 options 覆盖后的真实目标');
    assert.ok(scopeText(deny).includes('80'), '端口必须参与判定记录');

    // 反向：options.host 显式指回 a.example（与 URL 一致）→ 判定通过，真正建连在
    // ENETUNREACH/DNS 层失败（无网络依赖：localhost 无 80 服务），但不允许是判定拒绝。
    let verdict = 'no-error';
    try {
      const req = http.request('http://b.example/', { host: 'a.example' });
      req.on('error', () => {});
      req.destroy();
      verdict = 'dispatched';
    } catch (e) {
      verdict = e.code || String(e);
    }
    assert.notEqual(verdict, 'DASHCAM_DENIED', 'options 与授权一致时不得被判定层拒绝');
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R3：options.host 复合形态 host:port 与显式 port 都按真实端口判定', () => {
  const runtime = setup({ grants: [{ capability: 'net.outbound', scope: { hosts: ['a.example:80'] } }] });
  try {
    assert.throws(
      () => http.request({ host: 'a.example:8080' }),
      DENIED_RE,
    );
    const deny = runtime.ledger.records.at(-1);
    assert.ok(scopeText(deny).includes('8080'), '复合形态的端口必须被拆出并参与判定');
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R1：http options 通道（createConnection / 函数型 lookup / 自定义 agent / socketPath）一律拒绝', () => {
  const runtime = setup({ grants: [{ capability: 'net.outbound', scope: { hosts: ['a.example:80'] } }] });
  try {
    const cases = [
      ['createConnection', { createConnection: () => ({}) }, 'http_createConnection'],
      ['lookup 函数', { lookup: (h, o, cb) => cb(null, '1.2.3.4', 4) }, 'http_lookup'],
      ['自定义 agent', { agent: new http.Agent() }, 'http_agent'],
      ['socketPath', { socketPath: '/tmp/dashcam-test.sock' }, 'socket_path'],
    ];
    for (const [name, options, ruleId] of cases) {
      assert.throws(
        () => http.request('http://a.example/', options),
        (e) => e.code === 'DASHCAM_DENIED',
        `${name} 必须以 DASHCAM_DENIED 拒绝`,
      );
      const deny = runtime.ledger.records.at(-1);
      assert.equal(deny.ruleId, ruleId, `${name} 的拒绝必须按 ${ruleId} 记账`);
      assert.equal(deny.intercepted, true, `${name} 拒绝必须标记 intercepted`);
    }
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R1：agent 为 undefined / false（内部默认 Agent）不误伤', () => {
  const runtime = setup({
    grants: [{ capability: 'net.outbound', scope: { hosts: ['127.0.0.1:80'] } }],
    requests: [{ cap: 'net.outbound', scope: { hosts: ['127.0.0.1:80'] }, reason: '本机回环' }],
  });
  try {
    for (const agent of [undefined, false]) {
      let verdict = 'no-error';
      try {
        const req = http.request({ host: '127.0.0.1', port: 80, agent });
        req.on('error', () => {});
        req.destroy();
        verdict = 'dispatched';
      } catch (e) {
        verdict = e.code || String(e);
      }
      assert.notEqual(verdict, 'DASHCAM_DENIED', `agent=${agent} 走内部默认 Agent，不得拒绝`);
    }
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

// ── Fix3 / R7：数字 fd 白名单 + readFile 写 flag 归一 ────────────

const FS_READ = (root) => ({ capability: 'fs.read', scope: { paths: [root, `${root}/**`] } });
const FS_WRITE = (root) => ({ capability: 'fs.write', scope: { paths: [root, `${root}/**`] } });
const FS_REQUESTS = (root) => [
  { cap: 'fs.read', scope: { paths: [root, `${root}/**`] }, reason: '读' },
  { cap: 'fs.write', scope: { paths: [root, `${root}/**`] }, reason: '写' },
];

test('R7：数字 fd 未经守卫链 open 发放一律拒绝（raw_fd），0/1/2 也不例外', () => {
  const runtime = setup({
    grants: (root) => [FS_READ(root)],
    requests: (root) => [{ cap: 'fs.read', scope: { paths: [root, `${root}/**`] }, reason: '读' }],
    files: { 'data.txt': 'ok\n' },
  });
  try {
    for (const fd of [0, 1, 2, 999]) {
      assert.throws(
        () => fs.readFileSync(fd),
        (e) => e.code === 'DASHCAM_DENIED',
        `数字 fd ${fd} 必须以 DASHCAM_DENIED 拒绝`,
      );
      const deny = runtime.ledger.records.at(-1);
      assert.equal(deny.ruleId, 'raw_fd', `数字 fd ${fd} 必须按 raw_fd 记账`);
      assert.equal(deny.intercepted, true);
    }
    // 对照：授权路径上的普通读不受影响。
    assert.equal(fs.readFileSync(path.join(runtime.dir, 'data.txt'), 'utf8'), 'ok\n');
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R7：经守卫链 open 发放并复核过的 fd，数字形态放行', () => {
  const runtime = setup({
    grants: (root) => [FS_READ(root)],
    requests: (root) => [{ cap: 'fs.read', scope: { paths: [root, `${root}/**`] }, reason: '读' }],
    files: { 'data.txt': 'ok\n' },
  });
  try {
    const file = path.join(runtime.dir, 'data.txt');
    // openSync 走守卫链（fs.read 已授）→ 发放并加入白名单；随后数字形态读放行。
    const fd = fs.openSync(file, 'r');
    try {
      assert.equal(fs.readFileSync(fd, 'utf8'), 'ok\n', '白名单内的 fd 必须放行');
    } finally {
      fs.closeSync(fd);
    }
    // 白名单按设计不随 close 回收（沿用旧路径的授权口径，仍严于曾经的
    // 「数字全放行」）——close 后再读该 fd 号不再判定拒绝，由原生抛 EBADF。
    assert.throws(() => fs.readFileSync(fd, 'utf8'), (e) => e.code !== 'DASHCAM_DENIED');
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R7：readFile 写 flag 归一——flag r+ 需 fs.write 授权，未授则拒绝并记账', () => {
  const runtime = setup({
    grants: (root) => [FS_READ(root)],
    requests: (root) => [{ cap: 'fs.read', scope: { paths: [root, `${root}/**`] }, reason: '只读' }],
    files: { 'data.txt': 'ok\n' },
  });
  try {
    const file = path.join(runtime.dir, 'data.txt');
    assert.throws(
      () => fs.readFileSync(file, { flag: 'r+' }),
      (e) => e.code === 'DASHCAM_DENIED',
      "flag 'r+' 本质是写，只授 fs.read 时必须拒绝",
    );
    const deny = runtime.ledger.records.at(-1);
    assert.equal(deny.capability, 'fs.write', '写 flag 必须按 fs.write 判定并记账');
    // 对照：纯读 flag 正常放行。
    assert.equal(fs.readFileSync(file, { flag: 'r', encoding: 'utf8' }), 'ok\n');
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R7：fs.write 已授时 flag r+ 正常工作（归一不误伤）', () => {
  const runtime = setup({
    grants: (root) => [FS_READ(root), FS_WRITE(root)],
    requests: FS_REQUESTS,
    files: { 'data.txt': 'ok\n' },
  });
  try {
    const file = path.join(runtime.dir, 'data.txt');
    // 'r+' 读 + 不写内容：readFileSync 只读不落笔，但 flag 需要 fs.write 授权——
    // 已授时必须原样放行。
    assert.equal(fs.readFileSync(file, { flag: 'r+', encoding: 'utf8' }), 'ok\n');
    // createReadStream 的 flags 同口径：写 flag 在只授 fs.read 时拒绝。
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('R7：createReadStream 写 flags 归一——flags r+ 未授 fs.write 时拒绝', () => {
  const runtime = setup({
    grants: (root) => [FS_READ(root)],
    requests: (root) => [{ cap: 'fs.read', scope: { paths: [root, `${root}/**`] }, reason: '只读' }],
    files: { 'data.txt': 'ok\n' },
  });
  try {
    const file = path.join(runtime.dir, 'data.txt');
    assert.throws(
      () => fs.createReadStream(file, { flags: 'r+' }),
      (e) => e.code === 'DASHCAM_DENIED',
      "createReadStream 的 flags 'r+' 必须按 fs.write 判定",
    );
    const deny = runtime.ledger.records.at(-1);
    assert.equal(deny.capability, 'fs.write');
  } finally {
    runtime.bridge.uninstall();
    cleanup(runtime.dir);
  }
});

// ── Fix4 / B1·A3：账本完整性 fail-open 三处收口 ──────────────────

test('B1：verify() 账本文件不存在返回 ok:false（ledger_missing），不再默认通过', () => {
  const dir = tempDir('three-lens-ledger-missing-');
  try {
    const ledger = new Ledger(path.join(dir, 'absent.jsonl'));
    const report = ledger.verify();
    assert.equal(report.ok, false, '「从未记账」不得与「记账且完好」混同');
    assert.equal(report.count, 0);
    assert.ok(report.errors.some((e) => e.code === 'ledger_missing'));
  } finally {
    cleanup(dir);
  }
});

test('B1：账本只剩无换行半行时拒绝打开，不做整文件清零', () => {
  const dir = tempDir('three-lens-ledger-halfline-');
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const debris = '{"v":2,"seq":1,"plugin":"com.example.x","reason":"半行';
    fs.writeFileSync(file, debris, 'utf8');
    assert.throws(
      () => new Ledger(file),
      /拒绝打开/,
      '无任何完整记录时必须拒绝打开而不是 TRUNCATE 清零',
    );
    assert.equal(fs.readFileSync(file, 'utf8'), debris, '残骸必须原样保留，供人工取证');
  } finally {
    cleanup(dir);
  }
});

test('B1：磁盘账本比进程内基准小时构造告警 ledger_rollback', () => {
  const dir = tempDir('three-lens-ledger-rollback-');
  const warnings = [];
  const originalWarn = console.warn;
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const first = new Ledger(file);
    first.append({ plugin: 'com.example.rollback', decision: 'allow', capability: 'fs.read', action: 'fs.read' });
    first.append({ plugin: 'com.example.rollback', decision: 'deny', capability: 'fs.write', action: 'fs.write', ruleId: 'not_granted' });
    // 外部把账本截小：哈希链的前缀依然自洽，verify 发现不了回滚，
    // 构造时的 ledger_rollback 告警是唯一线索。截断点保留第一条完整行
    // （砍掉无换行半行会走「拒绝打开」路径，那是另一个用例的事）。
    const content = fs.readFileSync(file, 'utf8');
    fs.truncateSync(file, content.indexOf('\n') + 1);
    console.warn = (message) => warnings.push(String(message));
    new Ledger(file);
    const rollback = warnings.find((message) => message.includes('ledger_rollback'));
    assert.ok(rollback, '账本变小必须发出 ledger_rollback 告警');
    assert.ok(rollback.includes('回滚') || rollback.includes('截断'), '告警必须说明回滚/截断风险');
  } finally {
    console.warn = originalWarn;
    cleanup(dir);
  }
});

// ── Fix5 / A1·A2：dispose 走守卫卸载 + 回滚前校验归属 ────────────

test('A1：dispose() 走 guard.uninstallNativeHooks()，guard.hooks 置空', () => {
  const dir = tempDir('three-lens-dispose-');
  try {
    createPlugin({ dir, requests: [] });
    const { manifest } = loadManifest(dir);
    const runtime = createPluginRuntime({
      manifest,
      grants: [],
      ledgerPath: path.join(dir, 'ledger.jsonl'),
      patchBuiltins: true,
      autoSweep: false,
    });
    assert.ok(runtime.guard.hooks, '安装后 guard.hooks 必须存在');
    runtime.dispose();
    assert.equal(runtime.guard.hooks, null, 'dispose 后 guard.hooks 必须置空，coverage 不得再指向已卸载的 Bridge');
  } finally {
    cleanup(dir);
  }
});

test('A2：activate 等待窗口内的迟到回滚不得拆掉后注册插件的 Bridge', async () => {
  const dir = tempDir('three-lens-a2-');
  const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl') });
  const idA = 'com.example.a2.slow';
  const idB = 'com.example.a2.victim';
  // B 的探针：无任何授权读取全局路径——Bridge 在位时拒绝（DASHCAM_DENIED），
  // Bridge 被误拆后不拦截（NOT-DENIED）。
  const codeB = [
    "'use strict';",
    'const fs = require("node:fs");',
    'module.exports = {',
    '  async activate() {},',
    '  invoke() {',
    '    try { fs.readFileSync(process.execPath); return { probe: "NOT-DENIED" }; }',
    '    catch (e) { return { probe: e.code || String(e) }; }',
    '  },',
    '};',
  ].join('\n');
  const codeA = [
    "'use strict';",
    'module.exports = {',
    '  async activate() { await new Promise((resolve) => setTimeout(resolve, 120)); throw new Error("boom"); },',
    '};',
  ].join('\n');
  createPlugin({ dir: path.join(dir, 'a'), id: idA, requests: [], code: codeA });
  createPlugin({ dir: path.join(dir, 'b'), id: idB, requests: [], code: codeB });
  try {
    await host.install(path.join(dir, 'a'));
    await host.install(path.join(dir, 'b'));
    const registerA = host.register(idA);
    // 等 A 完成装载、active 已写入、activate 进入 await 等待窗口。
    await new Promise((resolve) => setTimeout(resolve, 30));
    await host.uninstall(idA);
    await host.register(idB);
    await assert.rejects(registerA, /activate 抛错/);
    assert.equal(host.active.pluginId, idB, 'B 的活动记录必须原样保留');
    const out = await host.invoke(idB);
    assert.equal(out.probe, 'DASHCAM_DENIED', 'A 的迟到回滚不得拆掉 B 的 Hook');
  } finally {
    await host.uninstall(idB).catch(() => {});
    cleanup(dir);
  }
});
