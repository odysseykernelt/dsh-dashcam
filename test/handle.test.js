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
const { createFsHandle } = require('../src/runtime/handles/fs');
const { createCapabilityHandles } = require('../src/runtime/handles');

function setup({ requests = [] } = {}) {
  const dir = tempDir('handle-');
  createPlugin({ dir, requests });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const grants = requests.map((request, index) => normalizeGrant({
    capability: request.cap,
    scope: request.scope,
  }, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants, ledger, pluginRoot: dir });
  return { dir, guard, ledger };
}

test('能力句柄：不经 Bridge，越界读取直接被守卫链拒绝', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const handle = createFsHandle({ guard: runtime.guard });
  const own = path.join(runtime.dir, 'own.txt');
  fs.writeFileSync(own, 'own');

  const outsideDir = tempDir('handle-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');

  try {
    assert.equal(handle.readFileSync(own, 'utf8'), 'own');
    assert.throws(() => handle.readFileSync(outside, 'utf8'), /未声明|未授予/);
    assert.throws(() => handle.readFile(outside), /未声明|未授予/);
    assert.equal(runtime.ledger.verify().ok, true);
  } finally {
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('能力句柄：封闭集合，没有 fd 级入口，也不能被改写', () => {
  const runtime = setup({ requests: [] });
  try {
    const handles = createCapabilityHandles({ guard: runtime.guard });
    assert.equal(Object.isFrozen(handles), true);
    assert.equal(Object.isFrozen(handles.fs), true);
    assert.equal(handles.fs.readSync, undefined);
    assert.equal(handles.fs.writeSync, undefined);
    assert.equal(handles.fs.readv, undefined);
    assert.throws(() => handles.fs.readFileSync(1), /只接受路径/);
  } finally {
    cleanup(runtime.dir);
  }
});

test('能力句柄：open 返回受限 FileHandle，不暴露 fd', async () => {
  const runtime = setup({
    requests: [
      { cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' },
      { cap: 'fs.write', scope: { paths: ['$PLUGIN/**'] }, reason: '写入自身文件' },
    ],
  });
  const handle = createFsHandle({ guard: runtime.guard });
  const target = path.join(runtime.dir, 'data.txt');
  fs.writeFileSync(target, 'hello');
  try {
    const fileHandle = await handle.open(target, 'r');
    assert.equal(fileHandle.fd, undefined);
    const buffer = Buffer.alloc(5);
    await fileHandle.read(buffer, 0, 5, 0);
    assert.equal(buffer.toString(), 'hello');
    await fileHandle.close();
  } finally {
    cleanup(runtime.dir);
  }
});

test('能力句柄：open 的 flags 决定需要读还是写', async () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '只读' }],
  });
  const handle = createFsHandle({ guard: runtime.guard });
  const target = path.join(runtime.dir, 'x.txt');
  fs.writeFileSync(target, 'x');
  try {
    const fileHandle = await handle.open(target, 'r');
    await fileHandle.close();
    await assert.rejects(() => handle.open(target, 'r+'), /未声明|未授予/);
  } finally {
    cleanup(runtime.dir);
  }
});

test('能力句柄：复制/重命名需要同时覆盖读与写', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '只读' }],
  });
  const handle = createFsHandle({ guard: runtime.guard });
  const source = path.join(runtime.dir, 'a.txt');
  fs.writeFileSync(source, 'a');
  try {
    assert.throws(() => handle.copyFileSync(source, path.join(runtime.dir, 'b.txt')), /未声明|未授予/);
    assert.throws(() => handle.renameSync(source, path.join(runtime.dir, 'c.txt')), /未声明|未授予/);
  } finally {
    cleanup(runtime.dir);
  }
});

test('能力句柄：coverage 报告封闭方法集合，与 Bridge 的差集形成对照', () => {
  const runtime = setup({ requests: [] });
  try {
    const handle = createFsHandle({ guard: runtime.guard });
    const report = handle.coverage();
    assert.equal(report.closed, true);
    assert.ok(report.methods.includes('readFileSync'));
    assert.ok(report.methods.includes('open'));
    assert.equal(report.methods.includes('readSync'), false);
    assert.ok(report.methods.length > 30);
  } finally {
    cleanup(runtime.dir);
  }
});
