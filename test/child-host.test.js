'use strict';

/**
 * 多进程运行时垂直切片的集成测试。
 * 验证：授权内读取成功、越界读取被宿主拒绝且账本留痕、子进程崩溃时 invoke 能感知。
 *
 * 注意：createGuardChain 期望 manifest.dashcam.requests 里的 scope 是**已展开的绝对路径**
 * （真实流程由 parseManifest 完成）。这里直接内联 manifest，所以 scope 要自己展开成
 * `<dir>/...`，不能用 `$PLUGIN` 占位符——否则会被判成「未声明」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { ChildHost } = require('../src/host/child-host');

const CHILD_ENTRY = path.join(__dirname, '..', 'examples', 'child-plugin.js');

function setup(subpath = '/**') {
  const dir = tempDir('childhost-');
  const scope = { paths: [dir.replace(/\\/g, '/') + subpath] };
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const guard = createGuardChain({
    manifest: {
      id: 'com.example.child',
      name: 'Child',
      version: '1.0.0',
      entry: 'x.js',
      kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读自身文件' }],
      },
    },
    grants: [{ id: 'g', capability: 'fs.read', scope, enabled: true, expiresAt: null, oneSeal: false }],
    ledger,
    pluginRoot: dir,
  });
  return { dir, ledger, guard };
}

test('多进程切片：授权内读取成功（IO 发生在宿主）', async () => {
  const runtime = setup('/**');
  fs.writeFileSync(path.join(runtime.dir, 'a.txt'), 'HELLO');

  const host = new ChildHost({ guard: runtime.guard, childEntry: CHILD_ENTRY });
  host.start();
  try {
    const result = await host.invoke({ path: path.join(runtime.dir, 'a.txt') });
    assert.deepEqual(result, { ok: true, text: 'HELLO' });
  } finally {
    host.stop();
    cleanup(runtime.dir);
  }
});

test('多进程切片：越界读取被宿主拒绝，且账本留痕', async () => {
  const runtime = setup('/inside/**');
  fs.mkdirSync(path.join(runtime.dir, 'inside'), { recursive: true });
  const outside = path.join(runtime.dir, 'outside.txt');
  fs.writeFileSync(outside, 'SECRET');

  const host = new ChildHost({ guard: runtime.guard, childEntry: CHILD_ENTRY });
  host.start();
  try {
    await assert.rejects(
      () => host.invoke({ path: outside }),
      /未声明|未授予|manifest/,
    );
    const denies = runtime.ledger.records().filter((record) => record.decision === 'deny');
    assert.ok(denies.length >= 1, '宿主侧必须记账');
    assert.ok(denies.some((record) => record.ruleId === 'not_declared' || record.ruleId === 'not_granted'));
  } finally {
    host.stop();
    cleanup(runtime.dir);
  }
});

test('多进程切片：子进程崩溃时 invoke 以错误收场而不是悬挂', async () => {
  const runtime = setup('/**');
  fs.writeFileSync(path.join(runtime.dir, 'a.txt'), 'X');

  const host = new ChildHost({ guard: runtime.guard, childEntry: CHILD_ENTRY, invokeTimeoutMs: 2000 });
  host.start();
  try {
    const result = await host.invoke({ path: path.join(runtime.dir, 'a.txt') });
    assert.equal(result.text, 'X');

    host.stop();
    await assert.rejects(() => host.invoke({ path: 'x' }));
  } finally {
    host.stop();
    cleanup(runtime.dir);
  }
});

test('多进程切片：批量读一次 RPC 读多个文件，且账本只写一条', async () => {
  const runtime = setup('/**');
  fs.writeFileSync(path.join(runtime.dir, 'a.txt'), 'A');
  fs.writeFileSync(path.join(runtime.dir, 'b.txt'), 'B');

  const host = new ChildHost({ guard: runtime.guard, childEntry: CHILD_ENTRY });
  host.start();
  try {
    const result = await host.invoke({
      paths: [path.join(runtime.dir, 'a.txt'), path.join(runtime.dir, 'b.txt')],
    });
    assert.deepEqual(result, { ok: true, texts: ['A', 'B'] });

    const batchRecords = runtime.ledger.records().filter((record) => record.ruleId === 'two-key-batch');
    assert.equal(batchRecords.length, 1, '批量读只该写一条 batch 账本');
    assert.equal(batchRecords[0].scope.count, 2);
  } finally {
    host.stop();
    cleanup(runtime.dir);
  }
});

test('ChildHost 已接进公开导出', () => {
  const api = require('../src/index');
  assert.equal(typeof api.ChildHost, 'function');
});
