'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMetrics, monthlyMetrics } = require('../src/governance/metrics');

/**
 * 批量记录的口径回归护栏。
 *
 * 口径（与 src/governance/metrics.js 的注释一致）：
 * - 记录数 = Ledger 决策行数；requests / allows / denies / interceptionRate 全部沿用这个口径。
 * - 目标数 = 实际经过 Two-Key 判定的对象数；批量 allow 记 scope.count 个，
 *   批量 deny 记 scope.count 个（它是「检查到第几个就失败」，也就是实际触及的目标数）。
 * - 没有批量记录时两套计数必须完全重合（下面有独立用例证明这一点）。
 */

function decision(overrides = {}) {
  return {
    ts: '2026-09-01T00:00:00.000Z',
    plugin: 'com.example.metrics',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['C:/plugin/cache.txt'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '读取缓存',
    intercepted: false,
    ...overrides,
  };
}

const batchAllow100 = decision({
  ts: '2026-09-02T00:00:00.000Z',
  ruleId: 'two-key-batch',
  scope: { batch: true, count: 100 },
});

const batchDeny7 = decision({
  ts: '2026-09-05T00:00:00.000Z',
  decision: 'deny',
  ruleId: 'not_declared',
  reason: '未声明的范围',
  intercepted: true,
  scope: { batch: true, count: 7, sample: { paths: ['C:/outside/secret.txt'] } },
});

const plainRecords = [
  decision({ ts: '2026-09-03T00:00:00.000Z' }),
  decision({ ts: '2026-09-03T00:00:01.000Z' }),
  decision({ ts: '2026-09-03T00:00:02.000Z' }),
  decision({ ts: '2026-09-04T00:00:00.000Z', decision: 'deny', ruleId: 'not_declared', intercepted: true }),
];

// 旧字段清单：新增字段可以是加法，但一个都不能少、一个都不能改名。
const LEGACY_FIELDS = [
  'requests',
  'allows',
  'denies',
  'interceptionRate',
  'undeclaredInterceptions',
  'undeclaredInterceptionRate',
  'grantDenials',
  'grantDenialRate',
  'falseKillRate',
  'silentFailureRate',
  'installAttempts',
  'installAborts',
  'abandonmentRate',
  'metadataCoverage',
  'metadataCoverageCounts',
];

test('批量记录：记录数与目标数分开计，旧字段语义不变', () => {
  const records = [batchAllow100, ...plainRecords, batchDeny7];
  const metrics = computeMetrics({ ledgerRecords: records });

  // ---- 旧字段：仍然按记录数，数值与「一条记录算一次」完全一致 ----
  assert.equal(metrics.requests, 6);
  assert.equal(metrics.allows, 4);
  assert.equal(metrics.denies, 2);
  assert.equal(metrics.interceptionRate, 2 / 6);
  for (const field of LEGACY_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(metrics, field), `缺失旧字段 ${field}`);
  }

  // ---- 新字段：记录数 → 目标数的换算 ----
  assert.equal(metrics.batchRecords, 1);
  assert.equal(metrics.batchedTargets, 100);
  assert.equal(metrics.batchDeniedRecords, 1);
  assert.equal(metrics.batchDeniedTargets, 7);

  // effectiveRequests = 6 条 - 2 条批量 + (100 + 7) 个目标 = 111。
  // 也等价于「allows 的目标数 103 + denies 的目标数 8」。
  assert.equal(metrics.effectiveRequests, 111);
  assert.equal(
    metrics.effectiveRequests,
    (metrics.allows - metrics.batchRecords + metrics.batchedTargets)
      + (metrics.denies - metrics.batchDeniedRecords + metrics.batchDeniedTargets),
  );

  // 目标口径拦截率：8 / 111；与记录口径 2 / 6 并列，后者保持不变。
  assert.equal(metrics.targetInterceptionRate, 8 / 111);
  assert.notEqual(metrics.targetInterceptionRate, metrics.interceptionRate);
});

test('口径自洽：把批量记录摊成逐条记录后，目标口径读数不变、记录口径才变', () => {
  const batched = computeMetrics({ ledgerRecords: [batchAllow100, ...plainRecords, batchDeny7] });

  // 同样的事实，换一种写法：100 条 allow + 3 条普通 allow，7 条 deny + 1 条普通 deny。
  const expanded = [
    ...Array.from({ length: 100 }, (_, index) => decision({ ts: `2026-09-02T00:00:${String(index % 60).padStart(2, '0')}.000Z` })),
    ...plainRecords.slice(0, 3),
    ...Array.from({ length: 7 }, (_, index) => decision({
      ts: `2026-09-05T00:00:${String(index).padStart(2, '0')}.000Z`,
      decision: 'deny',
      ruleId: 'not_declared',
      intercepted: true,
    })),
    plainRecords[3],
  ];
  const plain = computeMetrics({ ledgerRecords: expanded });

  // 记录口径随记账方式漂移：107 条 vs 6 条，拦截率 8/111 vs 2/6。
  assert.equal(plain.requests, 111);
  assert.equal(plain.interceptionRate, 8 / 111);
  assert.notEqual(plain.interceptionRate, batched.interceptionRate);

  // 目标口径对记账方式不敏感：两条路径算出同一个数，这才是「策略有效性」的读数。
  assert.equal(plain.effectiveRequests, batched.effectiveRequests);
  assert.equal(plain.targetInterceptionRate, batched.targetInterceptionRate);
  assert.equal(plain.targetInterceptionRate, 8 / 111);

  // 没有批量记录时，两套口径必须完全重合，否则就是新字段在偷偷改历史。
  assert.equal(plain.batchRecords, 0);
  assert.equal(plain.batchedTargets, 0);
  assert.equal(plain.batchDeniedRecords, 0);
  assert.equal(plain.batchDeniedTargets, 0);
  assert.equal(plain.effectiveRequests, plain.requests);
  assert.equal(plain.targetInterceptionRate, plain.interceptionRate);
});

test('批量记录：count 缺失/非法时退回 1，不允许出现「0 个目标」的记录', () => {
  const metrics = computeMetrics({
    ledgerRecords: [
      decision({ ruleId: 'two-key-batch', scope: { batch: true } }),
      decision({ decision: 'deny', ruleId: 'not_declared', scope: { batch: true, count: 0 } }),
    ],
  });
  assert.equal(metrics.batchRecords, 1);
  assert.equal(metrics.batchedTargets, 1);
  assert.equal(metrics.batchDeniedRecords, 1);
  assert.equal(metrics.batchDeniedTargets, 1);
  assert.equal(metrics.effectiveRequests, 2);
});

test('批量 veto：interceptionRate 不被批量 allow 稀释的是 targetInterceptionRate', () => {
  // 1 条 10 万目标的 allow + 1 条 1 目标的 deny：
  // 记录口径拦截率 50%（看起来「很安全」），目标口径只有 1/100001。
  const metrics = computeMetrics({
    ledgerRecords: [
      decision({ ruleId: 'two-key-batch', scope: { batch: true, count: 100_000 } }),
      decision({ decision: 'deny', ruleId: 'not_declared', intercepted: true }),
    ],
  });
  assert.equal(metrics.interceptionRate, 0.5);
  assert.equal(metrics.targetInterceptionRate, 1 / 100_001);
  assert.equal(metrics.effectiveRequests, 100_001);
});

test('monthlyMetrics：跨月分桶后两套口径各自成立', () => {
  const ledgerRecords = [
    batchAllow100, // 2026-09
    decision({ ts: '2026-09-03T00:00:00.000Z' }),
    decision({ ts: '2026-09-04T00:00:00.000Z', decision: 'deny', ruleId: 'not_declared', intercepted: true }),
    decision({ ts: '2026-10-01T00:00:00.000Z' }),
    decision({ ts: '2026-10-02T00:00:00.000Z' }),
    decision({
      ts: '2026-10-03T00:00:00.000Z',
      decision: 'deny',
      ruleId: 'not_declared',
      intercepted: true,
      scope: { batch: true, count: 7, sample: { paths: ['C:/outside/secret.txt'] } },
    }),
  ];
  const installEvents = [{ type: 'attempt', at: '2026-11-01T00:00:00.000Z' }];

  const monthly = monthlyMetrics({ ledgerRecords, installEvents });
  assert.deepEqual(monthly.map((entry) => entry.month), ['2026-09', '2026-10', '2026-11']);

  const [september, october, november] = monthly;

  // 2026-09：1 条批量 allow(100) + 1 allow + 1 deny。
  assert.equal(september.requests, 3);
  assert.equal(september.allows, 2);
  assert.equal(september.denies, 1);
  assert.equal(september.interceptionRate, 1 / 3);
  assert.equal(september.batchRecords, 1);
  assert.equal(september.batchedTargets, 100);
  assert.equal(september.batchDeniedRecords, 0);
  assert.equal(september.batchDeniedTargets, 0);
  assert.equal(september.effectiveRequests, 102);
  assert.equal(september.targetInterceptionRate, 1 / 102);

  // 2026-10：2 allow + 1 条批量 deny(7)。
  assert.equal(october.requests, 3);
  assert.equal(october.allows, 2);
  assert.equal(october.denies, 1);
  assert.equal(october.interceptionRate, 1 / 3);
  assert.equal(october.batchRecords, 0);
  assert.equal(october.batchedTargets, 0);
  assert.equal(october.batchDeniedRecords, 1);
  assert.equal(october.batchDeniedTargets, 7);
  assert.equal(october.effectiveRequests, 9);
  assert.equal(october.targetInterceptionRate, 7 / 9);

  // 2026-11 只有安装事件：没有决策记录时不能算出 NaN。
  assert.equal(november.requests, 0);
  assert.equal(november.effectiveRequests, 0);
  assert.equal(november.targetInterceptionRate, 0);
  assert.equal(november.installAttempts, 1);

  // 月度口径与全量口径必须加得起来。
  const total = computeMetrics({ ledgerRecords, installEvents });
  assert.equal(total.requests, 6);
  assert.equal(total.effectiveRequests, 111);
  assert.equal(
    monthly.reduce((sum, entry) => sum + entry.effectiveRequests, 0),
    total.effectiveRequests,
  );
  assert.equal(
    monthly.reduce((sum, entry) => sum + entry.requests, 0),
    total.requests,
  );
});
