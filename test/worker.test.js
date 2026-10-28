'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { createBridge } = require('../src/runtime/bridge');

function setup({ requests = [], grants = [] } = {}) {
  const dir = tempDir('worker-');
  createPlugin({ dir, requests });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const grantList = grants.map((grant, index) => normalizeGrant(grant, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants: grantList, ledger, pluginRoot: dir });
  return { dir, ledger, guard };
}

test('worker：eval 模式的命令名不含源码，且被守卫拒绝', () => {
  const workerThreads = require('node:worker_threads');
  const runtime = setup();
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: { id: 'p', version: '1' } });
  const source = 'const secret = "TOP-SECRET-STRING"; require("node:fs").writeFileSync("/tmp/x", secret);';
  try {
    assert.throws(() => new workerThreads.Worker(source, { eval: true }), /未声明|未授予|manifest/);

    const records = runtime.ledger.records();
    assert.equal(records.length, 1);
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes('TOP-SECRET-STRING'), false, '源码不能进账本');
    const command = records[0].scope && recordCommand(records[0]);
    assert.match(String(command), /^worker:eval:[0-9a-f]{12}$/);
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});

function recordCommand(record) {
  const paths = record.scope && record.scope.paths;
  return Array.isArray(paths) ? paths[0] : (record.scope && record.scope.commands && record.scope.commands[0]);
}

test('worker：普通文件 worker 仍用入口路径作命令名', () => {
  const workerThreads = require('node:worker_threads');
  const runtime = setup({
    requests: [{ cap: 'proc.spawn', scope: { commands: ['worker.js'] }, reason: '起工作线程' }],
    grants: [{ capability: 'proc.spawn', scope: { commands: ['worker.js'] } }],
  });
  const bridge = createBridge({ guard: runtime.guard, ledger: runtime.ledger, plugin: { id: 'p', version: '1' } });
  try {
    const entry = path.join(runtime.dir, 'worker.js');
    // 授权用基名匹配，所以这里只验证「命令名是入口路径」与「不抛错」。
    let worker = null;
    try {
      worker = new workerThreads.Worker(entry);
      worker.unref();
      assert.equal(String(recordCommand(runtime.ledger.records()[0])), entry);
    } catch (error) {
      // 沙箱禁子线程时跳过，不把环境限制算成用例失败。
      assert.match(String(error.code || error.message), /EPERM|ERR_WORKER|ENOENT/);
    } finally {
      if (worker) Promise.resolve(worker.terminate()).catch(() => {});
    }
  } finally {
    bridge.uninstall();
    cleanup(runtime.dir);
  }
});
