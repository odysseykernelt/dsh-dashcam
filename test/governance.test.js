'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RollbackManager, LEVELS } = require('../src/governance/rollback');
const { Blacklist } = require('../src/governance/blacklist');
const { computeMetrics, monthlyMetrics } = require('../src/governance/metrics');
const { checkCircuitBreaker, RolloutController, STAGES } = require('../src/governance/rollout');

test('回滚：规则级 / 模块级 / 契约级都能回到上一版', () => {
  assert.deepEqual(LEVELS, ['rule', 'module', 'contract']);
  const manager = new RollbackManager();
  manager.snapshot({ level: 'rule', key: 'safety.egress', value: { allow: ['a'] } });
  manager.snapshot({ level: 'rule', key: 'safety.egress', value: { allow: [] } });
  assert.deepEqual(manager.current('rule', 'safety.egress'), { allow: [] });
  assert.deepEqual(manager.rollback({ level: 'rule', key: 'safety.egress' }), { allow: ['a'] });
  assert.equal(manager.history('rule', 'safety.egress').length, 1);

  manager.snapshot({ level: 'module', key: 'net-guard', value: 'v1' });
  manager.snapshot({ level: 'module', key: 'net-guard', value: 'v2' });
  assert.equal(manager.rollback({ level: 'module', key: 'net-guard' }), 'v1');

  manager.snapshot({ level: 'contract', key: 'plugin-x', value: { version: '1.0.0' } });
  manager.snapshot({ level: 'contract', key: 'plugin-x', value: { version: '1.0.1' } });
  assert.deepEqual(manager.rollback({ level: 'contract', key: 'plugin-x' }), { version: '1.0.0' });
  assert.throws(() => manager.snapshot({ level: 'bad', key: 'x', value: 1 }), /未知回滚层级/);
});

test('黑名单：独立通道可增删查，过期后放行', () => {
  const store = new Blacklist();
  store.add('com.example.evil', { reason: '紧急下架' });
  assert.equal(store.isBlocked('com.example.evil'), true);
  assert.equal(store.isBlocked('com.example.good'), false);
  store.add('com.example.temporary', { reason: '临时', until: '2020-01-01T00:00:00.000Z' });
  assert.equal(store.isBlocked('com.example.temporary'), false);
  assert.equal(store.remove('com.example.evil'), true);
  assert.equal(store.isBlocked('com.example.evil'), false);
});

test('月度度量：拦截率、误杀率、静默失效率、放弃率、元数据覆盖率', () => {
  const ledgerRecords = [
    ...Array.from({ length: 8 }, () => ({ ts: '2026-10-01T00:00:00.000Z', decision: 'allow' })),
    ...Array.from({ length: 2 }, () => ({ ts: '2026-10-02T00:00:00.000Z', decision: 'deny' })),
  ];
  const installEvents = [
    ...Array.from({ length: 9 }, () => ({ type: 'attempt', at: '2026-10-01T00:00:00.000Z' })),
    { type: 'abort', at: '2026-10-02T00:00:00.000Z' },
  ];
  const manifests = [
    {
      id: 'a',
      name: 'A',
      version: '1.0.0',
      entry: 'index.js',
      dashcam: {
        content: {
          rating: 'general',
          scenes: [],
          commercialUse: 'allowed',
          sourceFingerprint: 'sha256:x',
          enterpriseExcluded: false,
        },
      },
    },
    {},
  ];
  const metrics = computeMetrics({ ledgerRecords, installEvents, guardErrors: 1, overrides: 1, manifests });
  assert.equal(metrics.allows, 8);
  assert.equal(metrics.denies, 2);
  assert.equal(metrics.interceptionRate, 0.2);
  assert.equal(metrics.falseKillRate, 0.5);
  assert.equal(metrics.silentFailureRate, 0.1);
  assert.equal(metrics.abandonmentRate, 0.1);
  assert.equal(metrics.metadataCoverageCounts.required, 20);
  assert.equal(metrics.metadataCoverageCounts.present, 10);

  const monthly = monthlyMetrics({ ledgerRecords, installEvents, manifests });
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].month, '2026-10');
});

test('熔断：误杀率或放弃率超阈值即回退上一档', () => {
  const bad = checkCircuitBreaker({ falseKillRate: 0.05, abandonmentRate: 0.01, silentFailureRate: 0 }, undefined);
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((violation) => violation.metric === 'falseKillRate'));

  const good = checkCircuitBreaker({ falseKillRate: 0.01, abandonmentRate: 0.01, silentFailureRate: 0 }, undefined);
  assert.equal(good.ok, true);

  assert.equal(STAGES.length, 6);
  const controller = new RolloutController({ stageIndex: 2, thresholds: { falseKillRate: 0.02, abandonmentRate: 0.05, silentFailureRate: 0.01 } });
  const rolled = controller.evaluate({ falseKillRate: 0.03, abandonmentRate: 0.01, silentFailureRate: 0 });
  assert.equal(rolled.action, 'rollback');
  assert.equal(controller.stageIndex, 1);

  const held = controller.evaluate({ falseKillRate: 0.01, abandonmentRate: 0.01, silentFailureRate: 0 });
  assert.equal(held.action, 'hold');

  const advancing = new RolloutController({ stageIndex: 0, autoAdvance: true });
  assert.equal(advancing.evaluate({ falseKillRate: 0, abandonmentRate: 0, silentFailureRate: 0 }).action, 'advance');
  assert.equal(advancing.stageIndex, 1);
});
