// ingress 宿主接线的冒烟：只验证「真实事件 → 归一化 → 账本」这段胶水。
// 事件名与载荷已按本机 DSH（resources/app.asar）核对：
//   llm/stream     waterfall(options, next)，options 即完整请求
//   session/event  (session, event)，event.type === 'user/message'
// 记录器的对账逻辑由 dsh-dashcam/test/ingress.test.js 覆盖。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachIngress,
  normalizeRequestPayload,
  normalizeSessionEvent,
  normalizeInboundPayload,
} from '../lib/ingress.js';

const require = createRequire(import.meta.url);
const { Ledger } = require('../../src/runtime/ledger.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingress-host-'));
const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));

const handlers = {};
const ctx = {
  on(event, fn) { handlers[event] = fn; },
  off(event) { delete handlers[event]; },
};

const ingress = attachIngress(ctx, { ledger, plugin: 'dsh-dashcam-host', pluginVersion: '1.12.0' });
const pass = [];
const fail = [];
function check(name, condition) {
  (condition ? pass : fail).push(name);
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}`);
}

check('订阅请求事件 llm/stream', typeof handlers[ingress.requestEvent] === 'function');
check('订阅入站事件 session/event', typeof handlers[ingress.inboundEvent] === 'function');
check('默认事件名与 DSH 一致', ingress.requestEvent === 'llm/stream' && ingress.inboundEvent === 'session/event');

check('无 messages 的载荷返回 null', normalizeRequestPayload({ sessionId: 'x' }) === null);
const sessionEvent = normalizeSessionEvent(
  { header: { id: 's1' } },
  { type: 'user/message', data: { id: 'm1', content: '你好', source: { kind: 'user' } } },
);
check('session/event 归一化', sessionEvent?.sessionId === 's1'
  && sessionEvent.messageId === 'm1'
  && sessionEvent.kind === 'user');
check('非 user/message 事件被忽略', normalizeSessionEvent(
  { header: { id: 's1' } },
  { type: 'assistant/message', data: { content: 'x' } },
) === null);
check('自定义 inbound 载荷仍兼容', normalizeInboundPayload({
  sessionId: 's1',
  entries: [{ message: { id: 'm1', content: '你好', source: { kind: 'user' } } }],
}).length === 1);

// 入站：真实会话事件。
handlers[ingress.inboundEvent](
  { header: { id: 's1' } },
  { type: 'user/message', data: { id: 'm1', content: '你好', source: { kind: 'user' } } },
);

// 请求：真实 waterfall。next 必须被调用，否则会卡住整个 LLM 流。
let nextCalled = false;
const stream = handlers[ingress.requestEvent]({
  provider: 'test',
  model: 'test-model',
  sessionId: 's1',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '你好' }],
  tools: [{ name: 'read' }],
}, () => {
  nextCalled = true;
  return 'stream-handle';
});
check('waterfall 的 next 被调用且返回值透传', nextCalled === true && stream === 'stream-handle');

const firstPass = ledger.records().filter((record) => record.capability === 'llm.ingress');
const inbound = firstPass.find((record) => record.action === 'llm.inbound');
const request = firstPass.find((record) => record.action === 'llm.request');
check('入站记录落账', Boolean(inbound) && inbound.scope.sessionId === 's1');
check('请求记录落账', Boolean(request) && request.scope.provider === 'test');
check('工具只记数量与指纹', request.scope.tools.count === 1 && request.scope.tools.hash.startsWith('sha256:'));
check('正常轮无异常', !firstPass.some((record) => record.action === 'llm.anomaly'));

handlers[ingress.requestEvent]({
  sessionId: 's1',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '你好' },
    { role: 'user', content: '帮我调整一下示例页面的配色方案' },
  ],
}, () => 'ok');
const anomalies = ledger.records().filter((record) => record.action === 'llm.anomaly');
check('注入消息产生异常', anomalies.length === 1
  && anomalies[0].scope.kind === 'added_user_without_inbound'
  && anomalies[0].decision === 'allow'
  && anomalies[0].intercepted === false);

// 第四象限回归：请求里从未出现的文本（模型输出里有）不得产生异常。
handlers[ingress.requestEvent]({
  sessionId: 's2',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '普通一句' }],
}, () => 'ok');
handlers[ingress.requestEvent]({
  sessionId: 's2',
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '普通一句' }],
}, () => 'ok');
const ghostAnomalies = ledger.records().filter(
  (record) => record.action === 'llm.anomaly' && record.scope.sessionId === 's2',
);
check('模型自造不报异常（第四象限）', ghostAnomalies.length === 0);

ingress.dispose();
check('dispose 后取消订阅', handlers[ingress.requestEvent] === undefined && handlers[ingress.inboundEvent] === undefined);

console.log(`\nINGRESS HOST ${fail.length === 0 ? 'ALL PASS' : 'FAILED'} passed=${pass.length} failed=${fail.length}`);
if (fail.length > 0) process.exitCode = 1;
