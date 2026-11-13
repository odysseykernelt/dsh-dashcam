'use strict';

// 2.2.0 会话归属回归：guard.check 接受 options.session，落账时写入记录的可选
// session 字段（宿主适配层从 tools/pre-execute 的 exec.agent.session.id 取）。
// 兼容口径：老账本不带该字段；verify 只查必填清单，哈希按整行重算——带与不带
// session 的行混在一个账本里都必须能过验。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');

function makeGuard(ledgerPath, dir) {
  const scope = { paths: [path.join(dir, '**')] };
  return createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读取' }],
      },
    },
    grants: [{ id: 'g1', capability: 'fs.read', scope, enabled: true, oneSeal: false, expiresAt: null }],
    ledger: new Ledger(ledgerPath),
  });
}

test('session-attribution：options.session 落账为可选 session 字段，verify 通过', () => {
  const dir = tempDir('session-attr-');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const guard = makeGuard(ledgerPath, dir);
  try {
    const allowed = guard.check('fs.read', { path: path.join(dir, 'a.txt') }, { session: 'session-uuid-1' });
    assert.equal(allowed.allowed, true);
    const denied = guard.check('fs.read', { path: path.join(dir, '..', 'elsewhere.txt') }, { session: 'session-uuid-2' });
    assert.equal(denied.allowed, false);
    const records = new Ledger(ledgerPath).records();
    const bySeq = new Map(records.map((r) => [r.seq, r]));
    assert.equal(bySeq.get(1).session, 'session-uuid-1', 'allow 记录带 session');
    assert.equal(bySeq.get(2).session, 'session-uuid-2', 'deny 记录带 session');
    assert.equal(new Ledger(ledgerPath).verify().ok, true, '链上含 session 字段仍过验');
  } finally {
    cleanup(dir);
  }
});

test('session-attribution：不带 options 时无 session 字段；新旧行混合账本过验（向后兼容）', () => {
  const dir = tempDir('session-attr-mixed-');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const guard = makeGuard(ledgerPath, dir);
  try {
    guard.check('fs.read', { path: path.join(dir, 'b.txt') }, { session: 'old-window' });
    // 直接用 Ledger 追加一条无 session 的记录（模拟 2.2.0 之前的老宿主写法）
    const ledger = new Ledger(ledgerPath);
    ledger.append({
      plugin: 'legacy-host', pluginVersion: '0.9.0', profiled: false, manifestHash: null,
      capability: 'fs.read', action: 'fs.read', scope: { paths: [path.join(dir, 'c.txt')] },
      decision: 'allow', ruleId: 'legacy', reason: '老账本行', intercepted: false,
    });
    guard.check('fs.read', { path: path.join(dir, 'd.txt') }, { session: 'new-window' });
    const records = new Ledger(ledgerPath).records();
    const sessions = records.map((r) => r.session);
    assert.deepEqual(sessions, ['old-window', undefined, 'new-window'], '老行无 session 字段，新行带');
    assert.equal(new Ledger(ledgerPath).verify().ok, true, '新旧行混合账本过验');
  } finally {
    cleanup(dir);
  }
});
