'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeMetrics, monthlyMetrics } = require('../src/governance/metrics');

/**
 * telemetry 附加记录的口径回归护栏（1.10.12，复核 F5 后半）。
 *
 * 背景：宿主适配层（dsh-covenant-host）把非判定的附加审计记录直接 append 进账本
 * （mount / unmapped-tool / unjudgeable-tool / proc.commandline 存档），capability
 * 固定为 'telemetry'。它们不是 Two-Key 判定，混进 allow/deny 口径会：
 *   - 用 commandline 存档稀释拦截率（一次 shell 调用 = 1 条判定 + 1 条存档）；
 *   - 把 enforceUnmapped 的 unmapped-tool deny(intercepted=true) 误算成
 *     「未声明越权拦截」（undeclaredInterceptions）；
 *   - 抬高 grantDenialRate 的分母。
 *
 * 口径（与 src/governance/metrics.js 注释一致）：
 *   - 判定读数（requests / allows / denies / interceptionRate /
 *     undeclaredInterceptions / grantDenials / silentFailureRate 分母）只收
 *     capability !== 'telemetry' 的记录；
 *   - telemetry 数量与其中 deny 条数另列 telemetryRecords / telemetryDenies
 *     并列读数，可见性不丢；
 *   - 没有 telemetry 记录时所有读数与旧版完全一致（旧账本不可被改写）。
 */

function judgment(overrides = {}) {
  return {
    ts: '2026-11-01T00:00:00.000Z',
    plugin: 'com.example.host',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['C:/repo/a.txt'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '读域内文件',
    intercepted: false,
    ...overrides,
  };
}

/** 宿主附加记录的真实形状（dsh-covenant-host appendAuxRecord 写入）。 */
function telemetry(overrides = {}) {
  return {
    ts: '2026-11-01T00:00:00.000Z',
    plugin: 'dsh-covenant-host',
    capability: 'telemetry',
    action: 'unmapped-tool',
    scope: { tool: 'send_meme' },
    decision: 'allow',
    ruleId: 'unmapped-tool',
    reason: '未映射工具遥测',
    intercepted: false,
    ...overrides,
  };
}

const judgmentRecords = [
  judgment(),
  judgment({ ts: '2026-11-01T00:00:01.000Z', decision: 'deny', ruleId: 'not_declared', intercepted: true }),
];

// 1 条 mount(allow) + 1 条 commandline 存档(allow，enforce 拒绝时会被改写) +
// 1 条 unmapped-tool deny(intercepted=true, enforceUnmapped) —— 全部是宿主附加。
const telemetryRecords = [
  telemetry({ action: 'mount', ruleId: 'mount', decision: 'allow', scope: { mode: 'advisory' } }),
  telemetry({
    action: 'proc.commandline',
    ruleId: 'commandline-audit',
    decision: 'allow',
    scope: { commandLineHash: 'ab'.repeat(32), commandLineLength: 12 },
  }),
  telemetry({
    action: 'unmapped-tool',
    decision: 'deny',
    intercepted: true,
    reason: 'enforceUnmapped：未映射工具 fail-closed',
  }),
];

test('telemetry 附加记录不进判定口径：requests/allows/denies/拦截率只数判定行', () => {
  const withTelemetry = computeMetrics({ ledgerRecords: [...judgmentRecords, ...telemetryRecords] });
  const withoutTelemetry = computeMetrics({ ledgerRecords: judgmentRecords });

  // 2 条判定记录不因 3 条 telemetry 附加记录而漂移。
  assert.equal(withTelemetry.requests, 2);
  assert.equal(withTelemetry.allows, 1);
  assert.equal(withTelemetry.denies, 1);
  assert.equal(withTelemetry.interceptionRate, withoutTelemetry.interceptionRate);
  assert.equal(withTelemetry.interceptionRate, 0.5);

  // 没有 telemetry 附加的账本读数与混入前完全一致（旧账本不可被改写）。
  assert.equal(withTelemetry.requests, withoutTelemetry.requests);
  assert.equal(withTelemetry.allows, withoutTelemetry.allows);
  assert.equal(withTelemetry.denies, withoutTelemetry.denies);
});

test('telemetry 的 deny(intercepted=true) 不冒充「未声明越权拦截」', () => {
  const metrics = computeMetrics({ ledgerRecords: [...judgmentRecords, ...telemetryRecords] });

  // 唯一的 intercepted=true 判定来自 judgmentRecords[1]；unmapped-tool 的
  // intercepted=true 是遥测对处置的记录，不是越权拦截。
  assert.equal(metrics.undeclaredInterceptions, 1);
  assert.equal(metrics.undeclaredInterceptionRate, 1 / 2);

  // grantDenials 分母也不被遥测 deny 抬高。
  assert.equal(metrics.grantDenials, 0);
  assert.equal(metrics.grantDenialRate, 0);
});

test('并列读数：telemetryRecords / telemetryDenies 保留可见性', () => {
  const metrics = computeMetrics({ ledgerRecords: [...judgmentRecords, ...telemetryRecords] });

  assert.equal(metrics.telemetryRecords, 3);
  assert.equal(metrics.telemetryDenies, 1);

  // 没有 telemetry 记录时恒为 0。
  const clean = computeMetrics({ ledgerRecords: judgmentRecords });
  assert.equal(clean.telemetryRecords, 0);
  assert.equal(clean.telemetryDenies, 0);
});

test('telemetry 不与批量口径互相污染', () => {
  const metrics = computeMetrics({
    ledgerRecords: [
      judgment({
        ts: '2026-11-02T00:00:00.000Z',
        ruleId: 'two-key-batch',
        scope: { batch: true, count: 100 },
      }),
      telemetry(),
      judgment({
        ts: '2026-11-03T00:00:00.000Z',
        decision: 'deny',
        ruleId: 'not_declared',
        intercepted: true,
        scope: { batch: true, count: 7 },
      }),
    ],
  });

  // effectiveRequests = 判定口径 2 条 - 2 条批量 + (100 + 7) 目标 = 107；
  // telemetry 1 条不进任何一边。
  assert.equal(metrics.effectiveRequests, 107);
  assert.equal(metrics.targetInterceptionRate, 7 / 107);
  assert.equal(metrics.telemetryRecords, 1);
  assert.equal(metrics.telemetryDenies, 0);
});

test('silentFailureRate 分母只数判定记录', () => {
  const metrics = computeMetrics({
    ledgerRecords: [...judgmentRecords, ...telemetryRecords],
    guardErrors: 1,
  });

  // 分母是 2 条判定记录，不是 5 条全量行：守卫异常归因到判定暴露面。
  assert.equal(metrics.silentFailureRate, 1 / 2);
});

test('monthlyMetrics：telemetry 不创造判定读数，但月度并列读数可加总', () => {
  const ledgerRecords = [
    ...judgmentRecords, // 2026-11
    telemetry({ ts: '2026-11-04T00:00:00.000Z' }),
    telemetry({ ts: '2026-12-01T00:00:00.000Z', decision: 'deny', intercepted: true }),
  ];
  const monthly = monthlyMetrics({ ledgerRecords });

  assert.deepEqual(monthly.map((entry) => entry.month), ['2026-11', '2026-12']);

  const [november, december] = monthly;
  assert.equal(november.requests, 2);
  assert.equal(november.telemetryRecords, 1);
  assert.equal(november.telemetryDenies, 0);

  // 12 月只有 telemetry 记录：判定读数为 0（不能算 NaN），遥测读数仍在。
  assert.equal(december.requests, 0);
  assert.equal(december.interceptionRate, 0);
  assert.equal(december.telemetryRecords, 1);
  assert.equal(december.telemetryDenies, 1);

  // 月度并列读数与全量口径加得起来。
  const total = computeMetrics({ ledgerRecords });
  assert.equal(monthly.reduce((sum, entry) => sum + entry.telemetryRecords, 0), total.telemetryRecords);
  assert.equal(monthly.reduce((sum, entry) => sum + entry.telemetryDenies, 0), total.telemetryDenies);
});

test('字段清单：telemetry 并列读数是加法，旧字段一个不少、一个不改名', () => {
  const metrics = computeMetrics({ ledgerRecords: judgmentRecords });
  const legacyFields = [
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
    'batchRecords',
    'batchedTargets',
    'batchDeniedRecords',
    'batchDeniedTargets',
    'effectiveRequests',
    'targetInterceptionRate',
  ];
  for (const field of legacyFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(metrics, field), `缺失旧字段 ${field}`);
  }
  assert.ok(Object.prototype.hasOwnProperty.call(metrics, 'telemetryRecords'));
  assert.ok(Object.prototype.hasOwnProperty.call(metrics, 'telemetryDenies'));
});
