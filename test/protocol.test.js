'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const protocol = require('../src/runtime/ipc/protocol.js');

test('导出契约精确（OPS / CONTROL_OPS / 函数）', () => {
  assert.deepEqual(protocol.OPS, ['fs.read', 'fs.write', 'net.outbound', 'ping']);
  assert.deepEqual(protocol.CONTROL_OPS, ['invoke']);
  assert.ok(Object.isFrozen(protocol.OPS));
  assert.ok(Object.isFrozen(protocol.CONTROL_OPS));
  for (const fn of ['makeRequest', 'makeResponse', 'isValidRequest', 'isValidResponse']) {
    assert.equal(typeof protocol[fn], 'function', fn);
  }
});

test('makeRequest：payload 缺省为空对象', () => {
  assert.deepEqual(protocol.makeRequest(1, 'ping', { x: 1 }), {
    id: 1, kind: 'request', op: 'ping', payload: { x: 1 },
  });
  assert.deepEqual(protocol.makeRequest('s', 'fs.read'), {
    id: 's', kind: 'request', op: 'fs.read', payload: {},
  });
});

test('makeResponse：ok 强转布尔、value/error 归一化', () => {
  assert.deepEqual(protocol.makeResponse('a', true, 42, null), {
    id: 'a', kind: 'response', ok: true, value: 42, error: null,
  });
  assert.deepEqual(protocol.makeResponse('a', false, undefined, { code: 'E1', message: 'x' }), {
    id: 'a', kind: 'response', ok: false, value: null, error: { code: 'E1', message: 'x' },
  });
  assert.equal(protocol.makeResponse('a', 0, 1, null).ok, false);
});

test('isValidRequest：合法请求通过', () => {
  assert.equal(protocol.isValidRequest({ id: 1, kind: 'request', op: 'ping', payload: {} }), true);
  assert.equal(protocol.isValidRequest({ id: 's', kind: 'request', op: 'fs.read' }), true); // payload 省略
  assert.equal(protocol.isValidRequest({ id: 0, kind: 'request', op: 'ping', payload: undefined }), true);
});

test('isValidRequest：畸形/恶意输入全部 false 且不抛', () => {
  const bad = [
    null,
    undefined,
    42,
    'str',
    true,
    [],
    {},
    { id: 1, kind: 'request', op: {}, payload: {} },        // op 是对象
    { id: 1, kind: 'request', op: '', payload: {} },         // op 空串
    { id: 1, kind: 'request', op: 7, payload: {} },          // op 非字符串
    { id: 1, kind: 'request', op: 'ping', payload: [] },     // payload 数组
    { id: 1, kind: 'request', op: 'ping', payload: 'x' },    // payload 非对象
    { id: 1, kind: 'request', op: 'ping', payload: 42 },
    { id: 1, kind: 'request', op: 'ping', payload: new Date() }, // 非纯对象
    { id: {}, kind: 'request', op: 'ping', payload: {} },    // id 是对象
    { id: null, kind: 'request', op: 'ping', payload: {} },
    { id: true, kind: 'request', op: 'ping', payload: {} },
    { kind: 'request', op: 'ping', payload: {} },            // 缺 id
    { id: 1, op: 'ping', payload: {} },                      // 缺 kind
    { id: 1, kind: 'req', op: 'ping', payload: {} },         // kind 错
    { id: 1, kind: 'request', payload: {} },                 // 缺 op
  ];
  for (const m of bad) {
    assert.equal(protocol.isValidRequest(m), false, JSON.stringify(m));
  }
});

test('isValidResponse：合法响应通过', () => {
  assert.equal(protocol.isValidResponse({ id: 1, kind: 'response', ok: true, value: 1, error: null }), true);
  assert.equal(protocol.isValidResponse({ id: 'x', kind: 'response', ok: false, value: null, error: { code: 'E' } }), true);
  assert.equal(protocol.isValidResponse({ id: 1, kind: 'response', ok: false, value: null, error: undefined }), true);
});

test('isValidResponse：畸形/恶意输入全部 false 且不抛', () => {
  const bad = [
    null,
    undefined,
    [],
    {},
    { id: 1, kind: 'response', ok: 'yes', value: 1, error: null }, // ok 非布尔
    { id: 1, kind: 'response', ok: 1, value: 1, error: null },
    { id: 1, kind: 'response', ok: true, value: 1, error: { code: 1 } }, // code 非字符串
    { id: 1, kind: 'response', ok: true, value: 1, error: {} },          // 缺 code
    { id: 1, kind: 'response', ok: true, value: 1, error: [] },          // error 数组
    { id: 1, kind: 'response', ok: true, value: 1, error: 'x' },
    { id: {}, kind: 'response', ok: true, value: 1, error: null },       // id 对象
    { kind: 'response', ok: true, value: 1, error: null },               // 缺 id
    { id: 1, ok: true, value: 1, error: null },                          // 缺 kind
    { id: 1, kind: 'resp', ok: true, value: 1, error: null },            // kind 错
  ];
  for (const m of bad) {
    assert.equal(protocol.isValidResponse(m), false, JSON.stringify(m));
  }
});

test('恶意 getter 抛异常也不让校验函数抛错', () => {
  const evil = {};
  Object.defineProperty(evil, 'kind', { get() { throw new Error('boom'); } });
  assert.equal(protocol.isValidRequest(evil), false);
  assert.equal(protocol.isValidResponse(evil), false);
});
