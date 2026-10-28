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

function setup({ requests, grants, dir = tempDir('glob-') }) {
  createPlugin({ dir, requests });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const grantList = grants.map((grant, index) => normalizeGrant(grant, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants: grantList, ledger, pluginRoot: dir });
  return { dir, ledger, guard };
}

test('glob：一次遍历只写一条账本，而不是每个文件一条', () => {
  const dir = tempDir('glob-tree-');
  for (let folder = 0; folder < 4; folder += 1) {
    const sub = path.join(dir, 'd' + folder);
    fs.mkdirSync(sub, { recursive: true });
    for (let file = 0; file < 25; file += 1) {
      fs.writeFileSync(path.join(sub, 'f' + file + '.txt'), 'x');
    }
  }
  // 目录树必须就是插件目录本身：scope 按 $PLUGIN 展开，树建在别处一定越界。
  const runtime = setup({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
    grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }],
  });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: { id: 'p', version: '1' } });
  try {
    const matches = fs.globSync('**/*.txt', { cwd: dir });
    assert.equal(matches.length, 100, '目录树本身仍要完整返回');
    const records = runtime.ledger.records();
    assert.equal(records.length, 1, '100 个结果只该产生一条账本');
    assert.equal(records[0].ruleId, 'two-key-batch');
    assert.equal(records[0].scope.count, 100);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

test('glob：混进范围外目标时整体失败，且账本只有一条 deny', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/inside/**'] }, reason: '只读子目录' }],
    grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/inside/**'] } }],
  });
  const inside = path.join(runtime.dir, 'inside');
  const outside = path.join(runtime.dir, 'outside');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(inside, 'ok.txt'), 'ok');
  fs.writeFileSync(path.join(outside, 'no.txt'), 'no');

  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: { id: 'p', version: '1' } });
  try {
    assert.throws(
      () => fs.globSync('**/*.txt', { cwd: runtime.dir }),
      /未声明|未授予|manifest/,
    );
    const denies = runtime.ledger.records().filter((record) => record.decision === 'deny');
    assert.equal(denies.length, 1, '整次遍历只记一条 deny');
    assert.equal(denies[0].scope.batch, true);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});
