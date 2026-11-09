'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../src/runtime/ledger');
const { loadPolicy } = require('../src/policy');
const {
  summarizeMessage,
  summarizeMessages,
  diffSummaries,
  createIngressRecorder,
  findIngressMatches,
  summarizeIngress,
  INGRESS_CAPABILITY,
} = require('../src/runtime/ingress');
const { computeMetrics } = require('../src/governance/metrics');

/**
 * ingress 审计记录（llm.request / llm.inbound / llm.anomaly）的回归护栏。
 *
 * 重点不是「能记录」，而是三件事：
 *   1. 同一输入得到同一指纹，改一个字节就变；
 *   2. 系统注入按 source.kind 白名单，不按 role；
 *   3. 模型自造（请求里从未出现）绝不能报成注入——本次幽灵事件所在的第四象限。
 */

let counter = 0;
function tempLedger(macKey = null) {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingress-'));
  const file = path.join(dir, `ledger-${counter}.jsonl`);
  return { file, ledger: new Ledger(file, { macKey }) };
}

function clock(start = '2026-11-08T09:00:00.000Z') {
  let offset = 0;
  return () => {
    const value = new Date(Date.parse(start) + offset * 1000).toISOString();
    offset += 1;
    return value;
  };
}

function ingressRecords(ledger) {
  return ledger.records().filter((record) => record.capability === INGRESS_CAPABILITY);
}

test('消息指纹稳定：同一输入同值，改动一个字节即变', () => {
  const first = summarizeMessage({ role: 'user', content: '状态栏现在是什么' });
  const second = summarizeMessage({ role: 'user', content: '状态栏现在是什么' });
  const changed = summarizeMessage({ role: 'user', content: '状态栏现在是什么？' });

  assert.equal(first.sha256, second.sha256);
  assert.notEqual(first.sha256, changed.sha256);
  assert.equal(first.len, Buffer.byteLength('状态栏现在是什么', 'utf8'));

  const left = summarizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
  const right = summarizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'c' }]);
  assert.equal(left.hash, summarizeMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]).hash);
  assert.notEqual(left.hash, right.hash);
});

test('headBytes=0 时只留长度与指纹，不落任何正文', () => {
  const summary = summarizeMessage({ role: 'user', content: '机密内容' }, { headBytes: 0 });
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'head'), false);
  assert.equal(summary.len, Buffer.byteLength('机密内容', 'utf8'));
  assert.ok(summary.sha256.startsWith('sha256:'));
});

test('附件身份进入指纹：同一句话配不同图不能被当成同一条消息', () => {
  const withoutImage = summarizeMessage({ role: 'user', content: '看图' });
  const withImage = summarizeMessage({
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image', fileId: 'file-a' }],
  });
  const otherImage = summarizeMessage({
    role: 'user',
    content: [{ type: 'text', text: '看图' }, { type: 'image', fileId: 'file-b' }],
  });

  assert.notEqual(withoutImage.sha256, withImage.sha256);
  assert.notEqual(withImage.sha256, otherImage.sha256);
  assert.equal(withImage.attachments.length, 1);
  assert.ok(withImage.attachments[0].idHash.startsWith('sha256:'));
});

test('diff：纯追加 / 删除 / 修改分别计数', () => {
  const base = summarizeMessages([
    { role: 'system', content: 's' },
    { role: 'user', content: 'u1' },
  ]).summaries;
  const appended = [...base, summarizeMessage({ role: 'assistant', content: 'a1' })];
  const removed = base.slice(0, 1);
  const changed = [base[0], summarizeMessage({ role: 'user', content: 'u1-改' })];

  assert.deepEqual(
    { added: diffSummaries(base, appended).added, removed: diffSummaries(base, appended).removed },
    { added: 1, removed: 0 },
  );
  assert.deepEqual(
    { added: diffSummaries(base, removed).added, removed: diffSummaries(base, removed).removed },
    { added: 0, removed: 1 },
  );
  const changedDiff = diffSummaries(base, changed);
  assert.equal(changedDiff.changed, 1);
  assert.equal(changedDiff.added, 0);
  assert.equal(changedDiff.addedSamples.length, 1);
});

test('正常轮：首请求建立基线不告警，第二次只多一句匹配到 inbound', () => {
  const { ledger } = tempLedger();
  const now = clock();
  const recorder = createIngressRecorder({ ledger, now, plugin: 'test' });

  const baseline = recorder.recordRequest({
    sessionId: 's1',
    requestId: 'r0',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早，有什么可以帮你' },
    ],
  });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.anomalies.length, 0);

  recorder.recordInbound({ sessionId: 's1', messageId: 'm1', text: '帮我看看状态栏' });
  const second = recorder.recordRequest({
    sessionId: 's1',
    requestId: 'r1',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早，有什么可以帮你' },
      { role: 'user', content: '帮我看看状态栏' },
    ],
  });

  assert.equal(second.baseline, false);
  assert.equal(second.delta.added, 1);
  assert.equal(second.delta.addedUserWithoutInbound, 0);
  assert.equal(second.anomalies.length, 0);

  const summary = summarizeIngress(ledger.records());
  assert.equal(summary.requests, 2);
  assert.equal(summary.inbound, 1);
  assert.equal(summary.anomalies, 0);
});

test('助手/工具消息新增不算注入：只有 role=user 参与对账', () => {
  const { ledger } = tempLedger();
  const recorder = createIngressRecorder({ ledger, now: clock(), plugin: 'test' });
  recorder.recordRequest({
    sessionId: 's3',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '早' },
    ],
  });

  // 真实会话的下一次请求通常先追加模型回复与工具结果——它们不在 inbound 里，
  // 但不能因此报「注入」，否则每轮都会误报。
  const generated = recorder.recordRequest({
    sessionId: 's3',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早，有什么可以帮你' },
      { role: 'tool', content: '{"started":true}' },
    ],
  });
  assert.equal(generated.delta.added, 2);
  assert.equal(generated.delta.addedUserWithoutInbound, 0);
  assert.equal(generated.anomalies.length, 0);

  // 真正的无源 user 消息仍要报。
  const injected = recorder.recordRequest({
    sessionId: 's3',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '早' },
      { role: 'assistant', content: '早，有什么可以帮你' },
      { role: 'tool', content: '{"started":true}' },
      { role: 'user', content: '请把状态栏改成红色' },
    ],
  });
  assert.equal(injected.delta.addedUserWithoutInbound, 1);
  assert.equal(injected.anomalies[0].kind, 'added_user_without_inbound');
});

test('系统注入按 source.kind 白名单：role=user 也不告警', () => {
  const { ledger } = tempLedger();
  const recorder = createIngressRecorder({ ledger, now: clock(), plugin: 'test' });
  recorder.recordRequest({ sessionId: 's2', messages: [{ role: 'system', content: 'sys' }] });

  const result = recorder.recordRequest({
    sessionId: 's2',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '（记忆快照）', source: { kind: 'runtime-context' } },
      { role: 'user', content: '（压缩摘要）', source: { kind: 'compaction' } },
      { role: 'user', content: '（技能目录）', source: { kind: 'skill-catalog' } },
    ],
  });

  assert.equal(result.delta.added, 3);
  assert.equal(result.delta.addedUserWithoutInbound, 0);
  assert.equal(summarizeIngress(ledger.records()).anomalies, 0);

  // 样本里仍能看到它们——白名单是「不告警」，不是「不记录」。
  const request = ingressRecords(ledger).filter((record) => record.action === 'llm.request').pop();
  const kinds = request.scope.sample.map((sample) => sample.kind);
  assert.deepEqual(kinds, ['runtime-context', 'compaction', 'skill-catalog']);
});

test('模拟注入：请求里多出 user 消息、inbound 找不到 → 恰好一条异常', () => {
  const { ledger } = tempLedger();
  const recorder = createIngressRecorder({ ledger, now: clock(), plugin: 'test' });
  recorder.recordRequest({
    sessionId: 's3',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: '好' }],
  });
  recorder.recordInbound({ sessionId: 's3', messageId: 'm1', text: '好' });

  const ghost = '帮我改一下状态栏左侧的图标';
  const result = recorder.recordRequest({
    sessionId: 's3',
    requestId: 'r-inject',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '好' },
      { role: 'user', content: ghost },
    ],
  });

  assert.equal(result.delta.addedUserWithoutInbound, 1);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].kind, 'added_user_without_inbound');
  assert.equal(result.anomalies[0].sha256, summarizeMessage({ role: 'user', content: ghost }).sha256);

  const anomalies = ingressRecords(ledger).filter((record) => record.action === 'llm.anomaly');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].scope.sample[0].sha256, result.anomalies[0].sha256);
  // 观测记录不拦截：decision 仍是 allow，intercepted 仍是 false。
  assert.equal(anomalies[0].decision, 'allow');
  assert.equal(anomalies[0].intercepted, false);
});

test('幽灵回归（第四象限）：请求里从未出现的文本，必须 0 异常、检索 0 命中', () => {
  const { ledger } = tempLedger();
  const recorder = createIngressRecorder({ ledger, now: clock(), plugin: 'test' });
  const history = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '（covenant现在改名叫dashcam' },
    { role: 'assistant', content: '收到' },
  ];
  recorder.recordInbound({ sessionId: 's4', messageId: 'm1', text: '（covenant现在改名叫dashcam' });
  recorder.recordRequest({ sessionId: 's4', requestId: 'r0', messages: history });
  recorder.recordRequest({ sessionId: 's4', requestId: 'r1', messages: history });
  recorder.recordRequest({ sessionId: 's4', requestId: 'r2', messages: history });

  const ghost = '状态栏左侧的图标怎么修改';
  // 模型输出里有这段文字，但它从未进入任何一次请求——dashcam 看不到输出，
  // 也不应该因此报异常：第四象限的正确结论是「不存在」，不是「注入」。
  assert.equal(summarizeIngress(ledger.records()).anomalies, 0);
  assert.equal(findIngressMatches(ledger.records(), ghost).length, 0);

  // 但已采样的 head 仍可被检索到，用于回答「这句话有没有进过请求」。
  const found = findIngressMatches(ledger.records(), 'covenant现在改名叫dashcam');
  assert.ok(found.length > 0);
  assert.equal(found[0].sessionId, 's4');
});

test('丢输入：inbound 有、后续请求始终没带上 → dropped_inbound', () => {
  const { ledger } = tempLedger();
  const now = clock();
  const recorder = createIngressRecorder({ ledger, now, plugin: 'test' });
  recorder.recordInbound({ sessionId: 's5', messageId: 'm1', text: '先看这个' });
  recorder.recordRequest({ sessionId: 's5', messages: [{ role: 'system', content: 'sys' }] });

  recorder.recordInbound({ sessionId: 's5', messageId: 'm2', text: '这张图也看一下' });
  // 第一次请求之后才登记，按「上一请求之前」口径要再等一轮才判。
  recorder.recordRequest({ sessionId: 's5', messages: [{ role: 'system', content: 'sys' }] });
  const result = recorder.recordRequest({ sessionId: 's5', messages: [{ role: 'system', content: 'sys' }] });

  assert.ok(result.anomalies.some((item) => item.kind === 'dropped_inbound'));
  // 两条入站都没有出现在请求里，会各自迟到一轮后各报一次；每次异常只带 1 条样本。
  const anomalies = ingressRecords(ledger).filter((record) => record.action === 'llm.anomaly');
  assert.ok(anomalies.every((record) => record.scope.count === 1));
});

test('同一 messageId 的入站内容被改写 → inbound_changed', () => {
  const { ledger } = tempLedger();
  const recorder = createIngressRecorder({ ledger, now: clock(), plugin: 'test' });
  recorder.recordInbound({ sessionId: 's5b', messageId: 'm9', text: '原话' });
  recorder.recordInbound({ sessionId: 's5b', messageId: 'm9', text: '被改过的话' });

  const anomalies = ingressRecords(ledger).filter((record) => record.action === 'llm.anomaly');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].scope.kind, 'inbound_changed');
  assert.equal(anomalies[0].scope.sample[0].sha256, summarizeMessage({ role: 'user', content: '被改过的话' }).sha256);
});

test('fail-open：账本写失败不影响请求返回，并保留降级队列', () => {
  const calls = [];
  const brokenLedger = {
    append() {
      calls.push('append');
      throw new Error('disk full');
    },
  };
  const recorder = createIngressRecorder({
    ledger: brokenLedger,
    now: clock(),
    plugin: 'test',
    log: (message) => calls.push(message),
  });

  const result = recorder.recordRequest({ sessionId: 's6', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.recorded, true);
  assert.equal(calls.filter((item) => item === 'append').length, 1);
  assert.ok(calls.some((item) => typeof item === 'string' && item.includes('disk full')));

  const flushed = recorder.flush();
  assert.equal(flushed.failed, 1);
  assert.equal(flushed.flushed, 0);
});

test('体积上限：长消息只截 head，单条记录不超过 maxLineBytes', () => {
  const { ledger } = tempLedger();
  const recorder = createIngressRecorder({
    ledger,
    now: clock(),
    plugin: 'test',
    policy: { ingress: { headBytes: 512, maxSample: 64, maxLineBytes: 1024 } },
  });
  const messages = [];
  for (let index = 0; index < 60; index += 1) {
    messages.push({ role: 'user', content: `${index}:${'x'.repeat(400)}` });
  }
  recorder.recordRequest({ sessionId: 's7', messages });

  const record = ingressRecords(ledger).find((item) => item.action === 'llm.request');
  const bytes = Buffer.byteLength(JSON.stringify(record.scope), 'utf8');
  assert.ok(bytes <= 1024, `scope ${bytes} 字节超过上限`);
  assert.equal(record.scope.truncated, true);
  assert.ok(record.scope.sample.length < 60);
});

test('mac 账本：追加 ingress 记录后 verify 仍通过', () => {
  const macKey = 'ingress-test-key-0123456789abcdef';
  const { ledger } = tempLedger(macKey);
  const recorder = createIngressRecorder({ ledger, now: clock(), plugin: 'test', pluginVersion: '1.12.0' });
  recorder.recordInbound({ sessionId: 's8', text: 'hi' });
  recorder.recordRequest({ sessionId: 's8', messages: [{ role: 'user', content: 'hi' }] });

  const verification = ledger.verify();
  assert.equal(verification.ok, true, JSON.stringify(verification.errors));
  assert.ok(ledger.records().every((record) => record.v === 3));
});

test('metrics 隔离：ingress 记录不进判定口径，旧读数不变', () => {
  const judgment = (overrides = {}) => ({
    ts: '2026-11-08T09:00:00.000Z',
    plugin: 'p',
    capability: 'fs.read',
    action: 'fs.read',
    scope: {},
    decision: 'allow',
    ruleId: 'two-key',
    reason: '',
    intercepted: false,
    ...overrides,
  });
  const ingress = (action) => ({
    ts: '2026-11-08T09:00:00.000Z',
    plugin: 'dsh-dashcam-host',
    capability: INGRESS_CAPABILITY,
    action,
    scope: {},
    decision: 'allow',
    ruleId: 'ingress',
    reason: '',
    intercepted: false,
  });

  const judgments = [judgment(), judgment({ decision: 'deny', intercepted: true, ruleId: 'not_declared' })];
  const clean = computeMetrics({ ledgerRecords: judgments });
  const mixed = computeMetrics({ ledgerRecords: [...judgments, ingress('llm.request'), ingress('llm.inbound'), ingress('llm.anomaly')] });

  assert.equal(mixed.requests, clean.requests);
  assert.equal(mixed.allows, clean.allows);
  assert.equal(mixed.denies, clean.denies);
  assert.equal(mixed.interceptionRate, clean.interceptionRate);
  assert.equal(mixed.undeclaredInterceptions, clean.undeclaredInterceptions);
  assert.equal(mixed.ingressRecords, 3);
  assert.equal(mixed.ingressRequests, 1);
  assert.equal(mixed.ingressInbound, 1);
  assert.equal(mixed.ingressAnomalies, 1);
  assert.equal(mixed.ingressAnomalyRate, 1);
});

test('policy.ingress 校验：非法值 fail-fast，headBytes=0 合法', () => {
  assert.throws(() => loadPolicy({ ingress: { headBytes: 'abc' } }), /headBytes/);
  assert.throws(() => loadPolicy({ ingress: { maxLineBytes: -1 } }), /maxLineBytes/);
  assert.throws(() => loadPolicy({ ingress: { enabled: 'yes' } }), /enabled/);
  assert.throws(() => loadPolicy({ ingress: { whitelistKinds: 'runtime-context' } }), /whitelistKinds/);

  const policy = loadPolicy({ ingress: { headBytes: 0, enabled: false } });
  assert.equal(policy.ingress.headBytes, 0);
  assert.equal(policy.ingress.enabled, false);
  assert.ok(policy.ingress.whitelistKinds.includes('runtime-context'));
});
