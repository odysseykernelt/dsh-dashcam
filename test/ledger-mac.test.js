'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');

const KEY = 'test-mac-key-2026';

function record(overrides = {}) {
  return {
    plugin: 'com.example.mac',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '读取缓存',
    ...overrides,
  };
}

test('mac：带密钥写入可验证，篡改会被 mac 抓住', () => {
  const dir = tempDir('mac-ok-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file, { macKey: KEY });
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_granted' }));

  const report = new Ledger(file, { macKey: KEY }).verify();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.count, 2);

  // 无密钥者改中间行并重算整条链：hash 能对上，mac 对不上。
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.decision = 'deny';
  first.__forged = true;
  // 按无密钥者的能力重算 hash（不含 mac）
  const { stableStringify, sha256 } = require('../src/util/stable');
  const copy = { ...first };
  delete copy.hash;
  delete copy.mac;
  first.hash = sha256(stableStringify(copy));
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const forged = new Ledger(file, { macKey: KEY }).verify();
  assert.equal(forged.ok, false);
  assert.ok(forged.errors.some((error) => error.code === 'mac_mismatch' || error.code === 'hash_mismatch'));
  cleanup(dir);
});

test('mac：v3 账本在无密钥校验时必须失败，而不是静默放行', () => {
  const dir = tempDir('mac-nokey-');
  const file = path.join(dir, 'ledger.jsonl');
  new Ledger(file, { macKey: KEY }).append(record());

  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'mac_key_missing'));
  cleanup(dir);
});

test('mac：v3 之后追加低版本行会被判为降版本绕过', () => {
  const dir = tempDir('mac-downgrade-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file, { macKey: KEY });
  const first = ledger.append(record());
  // 手工追加一条 v2 行，链上自洽但不带 mac
  const { stableStringify, sha256 } = require('../src/util/stable');
  const base = {
    v: 2,
    seq: first.seq + 1,
    ts: new Date().toISOString(),
    plugin: 'com.example.mac',
    pluginVersion: null,
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/y'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '伪造',
    intercepted: false,
    prevHash: first.hash,
  };
  base.hash = sha256(stableStringify(base));
  fs.appendFileSync(file, `${JSON.stringify(base)}\n`);

  const report = new Ledger(file, { macKey: KEY }).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'version_downgrade'));
  cleanup(dir);
});

test('锚点：正常通过，尾部被截断时暴露', () => {
  const dir = tempDir('mac-anchor-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file, { macKey: KEY });
  ledger.append(record());
  ledger.append(record());
  ledger.append(record());

  const anchor = ledger.anchor();
  assert.equal(anchor.count, 3);
  assert.equal(typeof anchor.mac, 'string');

  const ok = new Ledger(file, { macKey: KEY }).verify({ anchor });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));

  // 砍掉最后一行：剩下的前缀依然是一条自洽的链，只有锚点能发现。
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(file, `${lines.slice(0, -1).join('\n')}\n`);

  const truncated = new Ledger(file, { macKey: KEY }).verify({ anchor });
  assert.equal(truncated.ok, false);
  assert.ok(truncated.errors.some((error) => error.code === 'anchor_count_mismatch'));
  cleanup(dir);
});

test('锚点：没有 macKey 时 anchor() 返回 null，且带锚点校验会拒绝', () => {
  const dir = tempDir('mac-anchor-nokey-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  assert.equal(ledger.anchor(), null);

  const report = ledger.verify({ anchor: { count: 1, head: 'x', mac: 'y' } });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'mac_key_missing'));
  cleanup(dir);
});
