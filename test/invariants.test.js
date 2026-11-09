'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');
const { DashcamDenied } = require('../src/errors');
const { stableStringify, sha256 } = require('../src/util/stable');

/**
 * 端到端不变量：v1→v3 的账本兼容性、尾部截断检测、以及 enforceBatch
 * 「判定逐个做、账本只写一条」的承诺。全部使用真实的 Ledger / guards / bridge，
 * 不 mock 任何判定路径——这些不变量一旦破了，审计就会在无声处失效。
 */

const MAC_KEY = 'invariants-mac-key-2026';

/** verify 的重算方式：去掉 hash / mac 后稳定序列化再 sha256。手工造行必须照同一口径。 */
function hashOf(record) {
  const copy = { ...record };
  delete copy.hash;
  delete copy.mac;
  return sha256(stableStringify(copy));
}

function writeLines(file, lines) {
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  fs.writeFileSync(file, `${text}\n`);
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

function baseRecord(overrides = {}) {
  return {
    plugin: 'com.example.mac',
    pluginVersion: '1.0.0',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['C:/mac/cache.txt'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '读取缓存',
    intercepted: false,
    ...overrides,
  };
}

/** 真实的 manifest / grant / Ledger / guard 链；只声明并授予 fs.read $PLUGIN/**。 */
function setupGuard({ dir }) {
  createPlugin({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '批量读取自身缓存' }],
  });
  const { manifest, errors } = loadManifest(dir);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(manifest, 'manifest 应能加载');

  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const grants = [normalizeGrant({
    capability: 'fs.read',
    scope: { paths: ['$PLUGIN/**'] },
  }, { pluginRoot: dir }, 0)];
  const guard = createGuardChain({ manifest, grants, ledger, pluginRoot: dir });
  return { dir, manifest, ledger, grants, guard };
}

test('不变量1：v1 历史账本仍可验证（手工构造哈希链，无 intercepted / 无 mac）', () => {
  const dir = tempDir('inv-v1-');
  const file = path.join(dir, 'ledger.jsonl');
  try {
    const lines = [];
    let prevHash = 'GENESIS';
    for (let seq = 1; seq <= 3; seq += 1) {
      const record = {
        v: 1,
        seq,
        ts: `2026-01-0${seq}T00:00:00.000Z`,
        plugin: 'com.example.legacy',
        pluginVersion: '0.9.0',
        capability: 'fs.read',
        action: 'fs.read',
        scope: { paths: ['C:/legacy/cache.txt'] },
        decision: seq === 3 ? 'deny' : 'allow',
        ruleId: seq === 3 ? 'not_declared' : 'two-key',
        reason: seq === 3 ? '未声明的范围' : '读取缓存',
        prevHash,
      };
      record.hash = hashOf(record);
      prevHash = record.hash;
      lines.push(record);
    }
    writeLines(file, lines);

    const report = new Ledger(file).verify();
    assert.equal(report.ok, true, JSON.stringify(report.errors));
    assert.equal(report.count, 3);
    assert.equal(report.errors.length, 0);
    // v1 没有 intercepted / mac：升级到 v2/v3 后不能反过来判它字段缺失。
    assert.equal(lines.every((line) => !('intercepted' in line) && !('mac' in line)), true);

    // 历史账本还能继续追加：升级不能把昨天的审计变成只读文件。
    const ledger = new Ledger(file);
    assert.equal(ledger.seq, 3);
    const appended = ledger.append(baseRecord({ reason: '继续追加' }));
    // 新追加的行按当前格式版本 v4 写（旧版本行不受影响，链可混版本续写）。
    assert.equal(appended.v, 4);

    const after = new Ledger(file).verify();
    assert.equal(after.ok, true, JSON.stringify(after.errors));
    assert.equal(after.count, 4);
  } finally {
    cleanup(dir);
  }
});

test('不变量2：v3 账本无密钥校验必须失败（mac_key_missing）', () => {
  const dir = tempDir('inv-v3-nokey-');
  const file = path.join(dir, 'ledger.jsonl');
  try {
    const ledger = new Ledger(file, { macKey: MAC_KEY });
    ledger.append(baseRecord());
    ledger.append(baseRecord({ decision: 'deny', ruleId: 'not_granted', intercepted: false }));

    assert.equal(
      new Ledger(file).records().every((record) => record.v === 4 && typeof record.mac === 'string'),
      true,
    );

    const noKey = new Ledger(file).verify();
    assert.equal(noKey.ok, false);
    // 只有一条错误：没有密钥就没校验 mac，不能装作「验过了」。
    assert.deepEqual(noKey.errors.map((error) => error.code), ['mac_key_missing']);
    assert.match(noKey.errors[0].detail, /macKey/);

    // 同一份账本带密钥必须通过：证明失败的原因确实只是缺密钥。
    const withKey = new Ledger(file, { macKey: MAC_KEY }).verify();
    assert.equal(withKey.ok, true, JSON.stringify(withKey.errors));
    assert.equal(withKey.count, 2);
  } finally {
    cleanup(dir);
  }
});

test('不变量3：v3 之后追加 v2 行 → version_downgrade', () => {
  const dir = tempDir('inv-downgrade-');
  const file = path.join(dir, 'ledger.jsonl');
  try {
    const ledger = new Ledger(file, { macKey: MAC_KEY });
    ledger.append(baseRecord());
    const second = ledger.append(baseRecord({ decision: 'deny', ruleId: 'not_granted' }));

    // 手工造一条 v2：prevHash / hash 全部自洽，唯一的破绽是「版本比历史低」。
    const forged = {
      v: 2,
      seq: second.seq + 1,
      ts: '2026-02-01T00:00:00.000Z',
      plugin: 'com.example.mac',
      pluginVersion: '1.0.0',
      capability: 'fs.read',
      action: 'fs.read',
      scope: { paths: ['C:/mac/forged.txt'] },
      decision: 'allow',
      ruleId: 'two-key',
      reason: '伪造的低版本行',
      intercepted: false,
      prevHash: second.hash,
    };
    forged.hash = hashOf(forged);
    fs.appendFileSync(file, `${JSON.stringify(forged)}\n`);

    const report = new Ledger(file, { macKey: MAC_KEY }).verify();
    assert.equal(report.ok, false);
    const codesOnLine3 = report.errors
      .filter((error) => error.line === 3)
      .map((error) => error.code)
      .sort();
    // 链本身自洽，所以抓住它的是版本检查；启用密钥后这行还缺 mac。
    assert.deepEqual(codesOnLine3, ['mac_missing', 'version_downgrade'].sort());
    // 两条 v3 历史行不受牵连：错误只落在那条伪造行上。
    assert.equal(report.errors.every((error) => error.line === 3), true);
  } finally {
    cleanup(dir);
  }
});

test('不变量4：anchor 能发现尾部截断（anchor_count_mismatch）', () => {
  const dir = tempDir('inv-anchor-');
  const file = path.join(dir, 'ledger.jsonl');
  try {
    const ledger = new Ledger(file, { macKey: MAC_KEY });
    ledger.append(baseRecord());
    ledger.append(baseRecord());
    ledger.append(baseRecord());
    const anchor = ledger.anchor();
    assert.equal(anchor.count, 3);
    assert.equal(typeof anchor.mac, 'string');

    const ok = new Ledger(file, { macKey: MAC_KEY }).verify({ anchor });
    assert.equal(ok.ok, true, JSON.stringify(ok.errors));

    // 砍掉最后一行：剩下的前缀依然是一条自洽的链，纯 hash 链发现不了。
    const lines = readLines(file);
    writeLines(file, lines.slice(0, -1));

    const truncated = new Ledger(file, { macKey: MAC_KEY }).verify({ anchor });
    assert.equal(truncated.ok, false);
    assert.ok(
      truncated.errors.some((error) => error.code === 'anchor_count_mismatch'),
      JSON.stringify(truncated.errors),
    );

    // 没有外部锚点时前缀自洽——这正是锚点必须外置的理由。
    const prefixOnly = new Ledger(file, { macKey: MAC_KEY }).verify();
    assert.equal(prefixOnly.ok, true, JSON.stringify(prefixOnly.errors));
  } finally {
    cleanup(dir);
  }
});

test('不变量5：enforceBatch 判定逐个做、账本只写一条（3 个目标 → 1 条 allow）', () => {
  const dir = tempDir('inv-batch-allow-');
  const runtime = setupGuard({ dir });
  let bridge = null;
  try {
    const payloads = ['a.txt', 'b.txt', 'c.txt'].map((name) => ({ path: path.join(dir, name) }));
    const result = runtime.guard.enforceBatch('fs.read', payloads);
    assert.equal(result.allowed, true);
    assert.equal(result.batch, true);
    assert.equal(result.count, 3);

    const records = runtime.ledger.records();
    assert.equal(records.length, 1);
    const [entry] = records;
    assert.equal(entry.decision, 'allow');
    assert.equal(entry.ruleId, 'two-key-batch');
    assert.equal(entry.scope.batch, true);
    assert.equal(entry.scope.count, 3);
    assert.equal(entry.intercepted, false);
    assert.equal(runtime.ledger.verify().ok, true);

    // 补充：批量标记只属于批量记录。真实 bridge 上的普通单次读取仍然逐条记账，
    // 否则 metrics 会把单次调用也当成批量目标。
    const plainFile = path.join(dir, 'plain.txt');
    fs.writeFileSync(plainFile, 'ok');
    bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: runtime.manifest });
    assert.equal(fs.readFileSync(plainFile, 'utf8'), 'ok');
    bridge.uninstall();
    bridge = null;

    const after = runtime.ledger.records();
    assert.equal(after.length, 2);
    assert.equal(after[1].decision, 'allow');
    assert.equal(after[1].ruleId, 'two-key');
    assert.equal(after[1].scope.batch, undefined);
    assert.equal(runtime.ledger.verify().ok, true);
  } finally {
    if (bridge) bridge.uninstall();
    cleanup(dir);
  }
});

test('不变量6：enforceBatch 有一条越界就整体失败，deny 的 count 停在失败位置', () => {
  const dir = tempDir('inv-batch-deny-');
  const outsideDir = tempDir('inv-batch-outside-');
  const runtime = setupGuard({ dir });
  try {
    const outsideFile = path.join(outsideDir, 'outside.txt');
    const payloads = [
      { path: path.join(dir, 'ok-1.txt') },
      { path: outsideFile }, // 越界：检查到第 2 个失败
      { path: path.join(dir, 'ok-3.txt') }, // 永远不会被判定
    ];

    let thrown = null;
    try {
      runtime.guard.enforceBatch('fs.read', payloads);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof DashcamDenied, '越界必须抛出 DashcamDenied');
    assert.equal(thrown.ruleId, 'not_declared');
    assert.deepEqual(thrown.batch, { count: 2, index: 1 });

    const records = runtime.ledger.records();
    assert.equal(records.length, 1);
    const [entry] = records;
    assert.equal(entry.decision, 'deny');
    assert.equal(entry.ruleId, 'not_declared');
    assert.equal(entry.scope.batch, true);
    // count = 2 而不是 payloads.length = 3：失败点之后的目标从未进入判定。
    assert.equal(entry.scope.count, 2);
    assert.equal(entry.intercepted, true);

    const samplePath = entry.scope.sample.paths[0];
    assert.equal(entry.scope.sample.paths.length, 1);
    assert.ok(samplePath.endsWith('outside.txt'));
    assert.equal(samplePath.toLowerCase().startsWith(dir.toLowerCase()), false);

    // 前两个目标没有被补写 allow：整批失败时账本里只留这一条 deny。
    assert.equal(records.some((record) => record.decision === 'allow'), false);
    assert.equal(runtime.ledger.verify().ok, true);
  } finally {
    cleanup(dir);
    cleanup(outsideDir);
  }
});
