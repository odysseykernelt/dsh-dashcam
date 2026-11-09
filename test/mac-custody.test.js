'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { LocalHost, resolveLedgerMacKey, MIN_MAC_KEY_BYTES, DEFAULT_MAC_KEY_ENV } = require('../src/host/local-host');
const { Ledger } = require('../src/runtime/ledger');

const KEY = 'k'.repeat(MIN_MAC_KEY_BYTES);

test('密钥解析：优先级 值 > 文件 > 环境变量', () => {
  const dir = tempDir('mac-resolve-');
  const file = path.join(dir, 'mac.key');
  fs.writeFileSync(file, KEY + '\n');
  try {
    assert.equal(resolveLedgerMacKey({ ledgerMacKey: KEY, ledgerMacKeyFile: file }).source, 'value');
    assert.equal(resolveLedgerMacKey({ ledgerMacKeyFile: file }).source, 'file');
    assert.equal(
      resolveLedgerMacKey({ env: { [DEFAULT_MAC_KEY_ENV]: KEY } }).source,
      'env',
    );
    assert.equal(resolveLedgerMacKey({ env: {} }).source, 'none');
    assert.equal(resolveLedgerMacKey({ ledgerMacKeyFile: file }).key, KEY, '文件里的换行要被 trim');
  } finally {
    cleanup(dir);
  }
});

test('密钥解析：短密钥 / 缺文件 / 显式环境变量为空都要失败，且不回显密钥', () => {
  const dir = tempDir('mac-bad-');
  try {
    const short = 'too-short-key';
    assert.throws(() => resolveLedgerMacKey({ ledgerMacKey: short }), (error) => {
      assert.match(error.message, /太短/);
      assert.equal(error.message.includes(short), false, '错误消息不能回显密钥');
      return true;
    });
    assert.throws(() => resolveLedgerMacKey({ ledgerMacKeyFile: path.join(dir, 'nope.key') }), /读取 mac 密钥文件失败/);
    assert.throws(() => resolveLedgerMacKey({ ledgerMacKeyEnv: 'NO_SUCH_ENV', env: {} }), /NO_SUCH_ENV/);
  } finally {
    cleanup(dir);
  }
});

test('LocalHost：redact() 不含密钥，账本按 v3 写', async () => {
  const dir = tempDir('mac-host-');
  createPlugin({ dir, requests: [] });
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const host = new LocalHost({ ledgerPath, ledgerMacKey: KEY });
  try {
    const summary = host.redact();
    assert.equal(summary.macEnabled, true);
    assert.equal(summary.keyLength, MIN_MAC_KEY_BYTES);
    assert.equal(summary.source, 'value');
    assert.equal(JSON.stringify(summary).includes(KEY), false);

    await host.install(dir);
    const rows = new Ledger(ledgerPath, { macKey: KEY }).records();
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].v, 4);
    assert.equal(typeof rows[0].mac, 'string');
    assert.equal(new Ledger(ledgerPath, { macKey: KEY }).verify().ok, true);
  } finally {
    cleanup(dir);
  }
});

test('LocalHost：没给密钥时账本是 v2，给了但验证时不给会 mac_key_missing', async () => {
  const dir = tempDir('mac-host-2-');
  createPlugin({ dir, requests: [] });
  const plainPath = path.join(dir, 'plain.jsonl');
  const plainHost = new LocalHost({ ledgerPath: plainPath });
  await plainHost.install(dir);
  assert.equal(plainHost.redact().macEnabled, false);
  assert.equal(new Ledger(plainPath).verify().ok, true, 'v2 账本无密钥可验');

  const keyedPath = path.join(dir, 'keyed.jsonl');
  const keyedHost = new LocalHost({ ledgerPath: keyedPath, ledgerMacKey: KEY });
  await keyedHost.install(dir);
  const report = new Ledger(keyedPath).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'mac_key_missing'));
  cleanup(dir);
});
