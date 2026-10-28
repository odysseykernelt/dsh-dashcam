'use strict';

const METADATA_FIELDS = [
  'id',
  'name',
  'version',
  'entry',
  'covenant',
  'covenant.content.rating',
  'covenant.content.scenes',
  'covenant.content.commercialUse',
  'covenant.content.sourceFingerprint',
  'covenant.content.enterpriseExcluded',
];

function getField(object, fieldPath) {
  let current = object;
  for (const part of fieldPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function monthOf(timestamp) {
  return String(timestamp || '').slice(0, 7) || 'unknown';
}

/**
 * 月度度量：拦截率、误杀率、静默失效率、放弃率、元数据覆盖率。
 * 输入全部来自 Ledger 与安装事件，可离线重算。
 */
function computeMetrics({
  ledgerRecords = [],
  installEvents = [],
  guardErrors = 0,
  overrides = 0,
  manifests = [],
} = {}) {
  const decisions = ledgerRecords.filter((record) => record && (record.decision === 'allow' || record.decision === 'deny'));
  const denies = decisions.filter((record) => record.decision === 'deny').length;
  const allows = decisions.filter((record) => record.decision === 'allow').length;
  const attempts = installEvents.filter((event) => event.type === 'attempt').length;
  const aborts = installEvents.filter((event) => event.type === 'abort').length;
  // attempt 事件只记录未被中止的安装；中止发生在记录 attempt 之前，
  // 因此分母必须把 abort 一并计入，否则放弃率永远为 0。
  const installTotal = attempts + aborts;

  let present = 0;
  let required = 0;
  for (const manifest of manifests) {
    for (const field of METADATA_FIELDS) {
      required += 1;
      const value = getField(manifest, field);
      if (value !== undefined && value !== null && value !== '') present += 1;
    }
  }

  // 「未声明越权」与「声明了但没授予」是两回事：前者是插件越界，
  // 后者是宿主还没发钥匙。混在一个拦截率里会让复盘看不出该改哪边。
  const undeclaredInterceptions = decisions.filter((record) => record.intercepted === true).length;
  const grantDenials = decisions.filter((record) => record.decision === 'deny'
    && (record.ruleId === 'not_granted' || record.ruleId === 'scope_mismatch')).length;

  return {
    requests: decisions.length,
    allows,
    denies,
    interceptionRate: ratio(denies, decisions.length),
    undeclaredInterceptions,
    undeclaredInterceptionRate: ratio(undeclaredInterceptions, decisions.length),
    grantDenials,
    grantDenialRate: ratio(grantDenials, denies),
    falseKillRate: ratio(overrides, denies),
    silentFailureRate: ratio(guardErrors, decisions.length || guardErrors),
    installAttempts: installTotal,
    installAborts: aborts,
    abandonmentRate: ratio(aborts, installTotal),
    metadataCoverage: required ? present / required : 0,
    metadataCoverageCounts: { present, required },
  };
}

function monthlyMetrics(input = {}) {
  const groups = new Map();
  for (const record of input.ledgerRecords || []) {
    const month = monthOf(record.ts);
    if (!groups.has(month)) groups.set(month, { ledgerRecords: [], installEvents: [] });
    groups.get(month).ledgerRecords.push(record);
  }
  for (const event of input.installEvents || []) {
    const month = monthOf(event.at || event.ts);
    if (!groups.has(month)) groups.set(month, { ledgerRecords: [], installEvents: [] });
    groups.get(month).installEvents.push(event);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, group]) => ({
      month,
      ...computeMetrics({
        ...input,
        ledgerRecords: group.ledgerRecords,
        installEvents: group.installEvents,
      }),
    }));
}

function formatPercent(value) {
  return `${(Number(value) * 100).toFixed(2)}%`;
}

module.exports = { computeMetrics, monthlyMetrics, formatPercent, METADATA_FIELDS };
