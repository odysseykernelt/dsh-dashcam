'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');

function guardFor(dir, requests, grants) {
  const manifest = {
    id: 'com.example.batch',
    name: 'Batch',
    version: '1.0.0',
    entry: 'index.js',
    kind: 'dashcam',
    dashcam: { spec: 'dsh-dashcam/1', content: null, requests },
  };
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  return {
    ledger,
    guard: createGuardChain({ manifest, grants, ledger, pluginRoot: dir }),
  };
}

test('批量判定：observe 窗口内越界必须留下 deny，不能记成 allow', () => {
  const dir = tempDir('batch-observe-');
  const inside = path.join(dir, 'inside.txt');
  const outside = path.join(dir, '..', 'outside.txt');
  const scope = { paths: [dir.replace(/\\/g, '/') + '/**'] };
  const { guard, ledger } = guardFor(
    dir,
    [{ capability: 'fs.read', scope, reason: '读取自身文件' }],
    [{ id: 'g', capability: 'fs.read', scope, enabled: true, expiresAt: null, oneSeal: false }],
  );
  try {
    guard.beginObserve();
    let result;
    try {
      result = guard.enforceBatch('fs.read', [{ path: inside }, { path: outside }]);
    } finally {
      guard.endObserve();
    }
    assert.equal(result.observed, true, '窗口内不该抛错');
    assert.equal(result.count, 2);

    const records = ledger.records();
    assert.equal(records.length, 1, '批量只写一条');
    assert.equal(records[0].decision, 'deny', '窗口内的越界不能被记成 allow');
    assert.equal(records[0].scope.count, 2);
    assert.equal(records[0].intercepted, true);
  } finally {
    cleanup(dir);
  }
});

test('批量判定：混合能力不能记成单一能力（cred 不能被藏进 fs）', () => {
  const dir = tempDir('batch-mixed-');
  const plain = path.join(dir, 'notes.txt');
  const secret = path.join(dir, 'id_rsa');
  const scope = { paths: [dir.replace(/\\/g, '/') + '/**'] };
  const { guard, ledger } = guardFor(
    dir,
    [
      { capability: 'fs.read', scope, reason: '读取普通文件' },
      { capability: 'cred.read', scope: { targets: [scope.paths[0]] }, reason: '读取凭证' },
    ],
    [
      { id: 'g1', capability: 'fs.read', scope, enabled: true, expiresAt: null, oneSeal: false },
      { id: 'g2', capability: 'cred.read', scope: { targets: [scope.paths[0]] }, enabled: true, expiresAt: null, oneSeal: false },
    ],
  );
  try {
    guard.enforceBatch('fs.read', [{ path: plain }, { path: secret }]);
    const record = ledger.records().at(-1);
    assert.equal(record.capability, 'mixed', '混合批次必须标 mixed，而不是最后一个能力');
    assert.deepEqual(record.scope.capabilities.sort(), ['cred.read', 'fs.read']);
  } finally {
    cleanup(dir);
  }
});
