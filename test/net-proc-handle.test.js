'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CovenantDenied } = require('../src/errors');
const { createGuardChain } = require('../src/runtime/guards');
const { firstCommand } = require('../src/runtime/bridge');
const { createNetHandle } = require('../src/runtime/handles/net');
const { createProcHandle } = require('../src/runtime/handles/proc');

/**
 * deny-all：真实的守卫链 + 空授予集。
 * 拒绝在真正调用原生 fetch / child_process 之前抛出，所以测试不会联网、不会起进程。
 */
function denyAllGuard() {
  const manifest = {
    id: 'com.example.handle-net-proc',
    version: '0.0.0',
    covenant: { requests: [] },
  };
  return createGuardChain({ manifest, grants: [] });
}

/** 记账后立刻中断：既能断言 payload，又保证原生调用绝不会发生。 */
class StopAfterGuard extends Error {}

function recordingGuard() {
  const calls = [];
  return {
    calls,
    enforce(operation, payload) {
      calls.push({ operation, payload });
      throw new StopAfterGuard('假守卫已记录调用，测试在此中断原生调用');
    },
  };
}

test('net 句柄：deny-all 时 fetch 被守卫链拒绝（CovenantDenied），不会联网', async () => {
  const handle = createNetHandle({ guard: denyAllGuard() });
  await assert.rejects(() => handle.fetch('https://example.com/x'), (error) => {
    assert.equal(error instanceof CovenantDenied, true);
    assert.equal(error.capability, 'net.outbound');
    return true;
  });
  await assert.rejects(() => handle.fetch(new URL('http://example.com:8080/x')), CovenantDenied);
});

test('net 句柄：request / get / connect 传给守卫的 host / port 正确（https 默认 443，http 默认 80）', async () => {
  const guard = recordingGuard();
  const handle = createNetHandle({ guard });

  assert.throws(() => handle.request('https://example.com/x'), StopAfterGuard);
  assert.throws(() => handle.get('http://example.com/'), StopAfterGuard);
  assert.throws(() => handle.connect({ host: 'Example.COM', port: '8443' }), StopAfterGuard);
  assert.throws(() => handle.createConnection(8080, 'api.example.com'), StopAfterGuard);
  await assert.rejects(() => handle.fetch('https://example.com:9443/x'), StopAfterGuard);

  assert.deepEqual(guard.calls, [
    { operation: 'net.outbound', payload: { host: 'example.com', port: 443 } },
    { operation: 'net.outbound', payload: { host: 'example.com', port: 80 } },
    { operation: 'net.outbound', payload: { host: 'example.com', port: 8443 } },
    { operation: 'net.outbound', payload: { host: 'api.example.com', port: 8080 } },
    { operation: 'net.outbound', payload: { host: 'example.com', port: 9443 } },
  ]);
});

test('net 句柄：Request 对象按 .url 解析出 host / port', { skip: typeof Request !== 'function' }, async () => {
  const guard = recordingGuard();
  const handle = createNetHandle({ guard });
  const request = new Request('https://example.com:8443/path?x=1');
  await assert.rejects(() => handle.fetch(request), StopAfterGuard);
  assert.deepEqual(guard.calls, [
    { operation: 'net.outbound', payload: { host: 'example.com', port: 8443 } },
  ]);
});

test('net 句柄：端口缺省与非法入参在判定前就被挡住', async () => {
  const guard = recordingGuard();
  const handle = createNetHandle({ guard });

  // connect / createConnection 端口必填；Unix socket 路径无法用 host:port 定性，直接拒绝。
  assert.throws(() => handle.connect({ host: 'example.com' }), /端口/);
  assert.throws(() => handle.createConnection('\\\\.\\pipe\\covenant'), /Unix socket|端口/);
  // fetch 是 async：入参非法时以 rejected promise 的形式失败。
  await assert.rejects(() => handle.fetch(12345), /只接受/);
  assert.equal(guard.calls.length, 0);
});

test('net 句柄：方法集合封闭、coverage 报告、对象冻结、创建时不判定', () => {
  const guard = recordingGuard();
  const handle = createNetHandle({ guard });

  assert.equal(guard.calls.length, 0);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(handle.listen, undefined);
  assert.equal(handle.http, undefined);
  assert.equal(handle.https, undefined);

  const report = handle.coverage();
  assert.equal(report.kind, 'net-handle');
  assert.equal(report.closed, true);
  assert.deepEqual(report.methods, ['connect', 'createConnection', 'fetch', 'get', 'request']);
  assert.equal(typeof report.note, 'string');

  assert.throws(() => {
    handle.fetch = () => {};
  }, TypeError);
});

test('proc 句柄：deny-all 时 spawn / exec 在真正起进程前被拒绝（CovenantDenied）', () => {
  const handle = createProcHandle({ guard: denyAllGuard() });
  assert.throws(() => handle.spawn(process.execPath, ['-v']), (error) => {
    assert.equal(error instanceof CovenantDenied, true);
    assert.equal(error.capability, 'proc.spawn');
    return true;
  });
  assert.throws(() => handle.exec('git status'), CovenantDenied);
  assert.throws(() => handle.execFileSync('node'), CovenantDenied);
});

test('proc 句柄：命令名口径与 Bridge 的 firstCommand 完全一致', () => {
  const guard = recordingGuard();
  const handle = createProcHandle({ guard });

  assert.throws(() => handle.spawn(process.execPath, ['-v']), StopAfterGuard);
  assert.throws(() => handle.exec('  "git" status '), StopAfterGuard);
  assert.throws(() => handle.execFile('node'), StopAfterGuard);
  assert.throws(() => handle.fork('worker.js'), StopAfterGuard);

  assert.deepEqual(guard.calls.map((call) => call.operation), [
    'proc.spawn', 'proc.spawn', 'proc.spawn', 'proc.spawn',
  ]);
  assert.deepEqual(guard.calls.map((call) => call.payload.command), [
    firstCommand([process.execPath, ['-v']]),
    firstCommand(['  "git" status ']),
    firstCommand(['node']),
    firstCommand(['worker.js']),
  ]);
  assert.equal(guard.calls[1].payload.command, 'git');
});

test('proc 句柄：kill 的 self / children / pid:<n> 三种映射正确', () => {
  const guard = recordingGuard();
  const handle = createProcHandle({ guard });

  assert.throws(() => handle.kill(process.pid), StopAfterGuard);
  assert.throws(() => handle.kill(0), StopAfterGuard);
  assert.throws(() => handle.kill(43210), StopAfterGuard);

  assert.deepEqual(guard.calls, [
    { operation: 'proc.signal', payload: { target: 'self' } },
    { operation: 'proc.signal', payload: { target: 'children' } },
    { operation: 'proc.signal', payload: { target: 'pid:43210' } },
  ]);
});

test('proc 句柄：deny-all 时 kill 也不会真的发出信号', () => {
  const handle = createProcHandle({ guard: denyAllGuard() });
  assert.throws(() => handle.kill(process.pid), CovenantDenied);
  assert.throws(() => handle.kill(43210, 'SIGTERM'), CovenantDenied);
});

test('proc 句柄：方法集合封闭、coverage 报告、对象冻结、创建时不判定', () => {
  const guard = recordingGuard();
  const handle = createProcHandle({ guard });

  assert.equal(guard.calls.length, 0);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(handle.childProcess, undefined);
  assert.equal(handle.killall, undefined);

  const report = handle.coverage();
  assert.equal(report.kind, 'proc-handle');
  assert.equal(report.closed, true);
  assert.deepEqual(report.methods, [
    'exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'kill', 'spawn', 'spawnSync',
  ]);
  assert.equal(typeof report.note, 'string');

  assert.throws(() => {
    handle.spawn = () => {};
  }, TypeError);
});
