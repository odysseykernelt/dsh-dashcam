'use strict';
// 三视角审查（repo-audit-2026-11-09 §6.5）整改的回归用例。
// Fix1：R1 http options 通道拒绝 + R3 URL/options 合并判定。

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');

// 记账型假账本：只收集记录，不落盘。
function fakeLedger() {
  return { records: [], append(rec) { this.records.push(rec); } };
}

function setup({ grants, requests }) {
  const dir = tempDir('three-lens-');
  createPlugin({
    dir,
    requests: requests || [
      { cap: 'net.outbound', scope: { hosts: ['a.example:80'] }, reason: '只授 a.example:80' },
    ],
  });
  const { manifest } = loadManifest(dir);
  const ledger = fakeLedger();
  const seal = new OneSealStore();
  const chain = grants.map((scope, index) => normalizeGrant({
    capability: 'net.outbound',
    scope,
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
  const runtime = setup({ grants: [{ hosts: ['a.example:80'] }] });
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
  const runtime = setup({ grants: [{ hosts: ['a.example:80'] }] });
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
  const runtime = setup({ grants: [{ hosts: ['a.example:80'] }] });
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
    grants: [{ hosts: ['127.0.0.1:80'] }],
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
