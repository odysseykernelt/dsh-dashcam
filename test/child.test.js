'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { startChildBridge } = require('../src/runtime/ipc/child');
const { makeRequest, makeResponse } = require('../src/runtime/ipc/protocol');

const originalSend = process.send;

function removeAllMessageListeners() {
  for (const handler of process.listeners('message')) {
    process.removeListener('message', handler);
  }
}

function installSendStub() {
  const sent = [];
  process.send = (msg) => {
    sent.push(msg);
  };
  return sent;
}

function restoreSend() {
  process.send = originalSend;
}

// 每个测试开始时清空 message 监听器，保证 process.listeners('message')[0]
// 恰好是本次 startChildBridge 注册的那个 handler。
function setup(onInvoke) {
  removeAllMessageListeners();
  const sent = installSendStub();
  const client = startChildBridge({ onInvoke });
  const handler = process.listeners('message')[0];
  return { client, handler, sent };
}

function teardown() {
  restoreSend();
  removeAllMessageListeners();
}

test('client.fs.readFile 发出 {kind:"request", op:"fs.read", payload:{path}}', async () => {
  const { client, handler, sent } = setup(() => {});
  try {
    const p = '/tmp/notes.txt';
    const promise = client.fs.readFile(p);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], { id: 0, kind: 'request', op: 'fs.read', payload: { path: p } });

    // 结算掉这个请求，避免留下未决 promise
    handler(makeResponse(sent[0].id, true, 'file-content', null));
    assert.equal(await promise, 'file-content');
  } finally {
    teardown();
  }
});

test('收到合法响应后 promise resolve 到正确 value', async () => {
  const { client, handler, sent } = setup(() => {});
  try {
    const promise = client.fs.writeFile('/tmp/out.txt', 'hello');
    const id = sent[0].id;
    assert.deepEqual(sent[0], makeRequest(id, 'fs.write', { path: '/tmp/out.txt', data: 'hello' }));

    handler(makeResponse(id, true, { bytesWritten: 5 }, null));
    assert.deepEqual(await promise, { bytesWritten: 5 });
  } finally {
    teardown();
  }
});

test('收到 error 非空的响应后 reject，且 error 带 code', async () => {
  const { client, handler, sent } = setup(() => {});
  try {
    const promise = client.net.fetch('https://example.com');
    const id = sent[0].id;
    assert.deepEqual(sent[0], makeRequest(id, 'net.outbound', { url: 'https://example.com' }));

    handler(makeResponse(id, false, null, { code: 'ENETDOWN', message: 'no route to host' }));
    await assert.rejects(promise, (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'ENETDOWN');
      assert.equal(err.message, 'no route to host');
      return true;
    });
  } finally {
    teardown();
  }
});

test('收到畸形响应（isValidResponse false）时忽略、不 settle、不抛', async () => {
  const { client, handler, sent } = setup(() => {});
  try {
    const promise = client.fs.readFile('/x');
    const id = sent[0].id;
    assert.equal(sent.length, 1);

    let settled = false;
    promise.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    // 畸形响应：kind 正确但 ok 不是布尔，isValidResponse 应返回 false
    handler({ kind: 'response', id, ok: 'not-a-boolean', value: 'bad', error: null });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, '畸形响应不得 settle promise');
    assert.equal(sent.length, 1, '畸形响应不得触发任何 process.send');

    // 之后收到合法响应仍能正常结算，证明畸形消息没有破坏 pending 表
    handler(makeResponse(id, true, 'still-ok', null));
    assert.equal(await promise, 'still-ok');
  } finally {
    teardown();
  }
});

test('invoke 控制消息触发 onInvoke，返回值被包装成 response 发出', async () => {
  let receivedPayload;
  let receivedClient;
  const { client, handler, sent } = setup(async (payload, c) => {
    receivedPayload = payload;
    receivedClient = c;
    return 'computed';
  });
  try {
    handler({ kind: 'request', op: 'invoke', id: 42, payload: { a: 1 } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(receivedPayload, { a: 1 });
    assert.equal(receivedClient, client, 'onInvoke 收到的 client 应与返回的 client 相同');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], makeResponse(42, true, 'computed', null));
  } finally {
    teardown();
  }
});

test('onInvoke 抛错时发出 ok:false 的 response', async () => {
  const { handler, sent } = setup(async () => {
    const e = new Error('boom');
    e.code = 'EBOOM';
    throw e;
  });
  try {
    handler({ kind: 'request', op: 'invoke', id: 7, payload: null });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], makeResponse(7, false, null, { code: 'EBOOM', message: 'boom' }));
  } finally {
    teardown();
  }
});

test('onInvoke 抛无 code 的错误时回退到 child_error', async () => {
  const { handler, sent } = setup(async () => {
    throw new Error('plain');
  });
  try {
    handler({ kind: 'request', op: 'invoke', id: 9, payload: null });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0], makeResponse(9, false, null, { code: 'child_error', message: 'plain' }));
  } finally {
    teardown();
  }
});

test('client 是只读冻结的能力面', async () => {
  const { client } = setup(() => {});
  try {
    assert.ok(Object.isFrozen(client));
    assert.ok(Object.isFrozen(client.fs));
    assert.ok(Object.isFrozen(client.net));
    assert.throws(() => { 'use strict'; client.fs.readFile = () => {}; }, TypeError);
  } finally {
    teardown();
  }
});
