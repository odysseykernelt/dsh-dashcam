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

/** 批量放行记录的规则号：由 guards.enforceBatch 写入（判定逐个做、账本只写一条）。 */
const BATCH_RULE_ID = 'two-key-batch';

/**
 * 一条批量记录代表多少个目标。
 *
 * allow 批：scope.count 就是这批的目标总数（guards 用 payloads.length 写入）。
 * deny 批：scope.count 是「检查到第几个目标时失败」，即这批实际触及的目标数。
 *   失败点之后的目标从未进入 Two-Key 判定，不能算成「已处理」——分母里多算它们
 *   会把拦截率洗成虚假的安全感。
 *
 * count 缺失或不是正整数时退回 1：宁可把批量低估成单条，也不能让审计口径
 * 出现「0 个目标」这种比记录本身还小的数（一条记录至少代表一次判定）。
 */
function batchTargetsOf(record) {
  const scope = record && record.scope;
  const count = scope && typeof scope === 'object' ? Number(scope.count) : Number.NaN;
  return Number.isInteger(count) && count > 0 ? count : 1;
}

/**
 * 拒绝侧的批量识别：deny 记录的 ruleId 是具体拒绝码（not_declared / scope_mismatch …），
 * 不是 'two-key-batch'，因此只能靠 guards 写下的 scope.batch === true 来认。
 */
function isBatchScope(record) {
  const scope = record && record.scope;
  return Boolean(scope) && typeof scope === 'object' && scope.batch === true;
}

/**
 * 宿主附加记录（aux telemetry）识别。
 *
 * 宿主适配层（如 dsh-covenant-host）会把**非判定**的附加审计记录直接
 * `ledger.append` 进账本：mount 挂载事件、unmapped-tool / unjudgeable-tool
 * 遥测、proc.commandline 命令行存档，capability 固定为 'telemetry'。
 * 它们不是 Two-Key 判定——一条 mount 记录不代表任何目标经过判定，一条
 * commandline 存档 allow 也不代表放行过什么。混进 allow/deny 口径会同时
 * 污染三个读数：
 *   - requests / interceptionRate：一次 shell 调用产生 1 条 proc.spawn 判定
 *     + 1 条 commandline 存档，拦截率被凭空稀释一半；
 *   - undeclaredInterceptions：enforceUnmapped 下 unmapped-tool 遥测记
 *     deny + intercepted=true，会被误算成「未声明越权拦截」；
 *   - grantDenialRate 的分母（denies 被遥测 deny 抬高）。
 *
 * 口径因此定为：**判定读数只收能力判定记录**；telemetry 另列并列读数
 * `telemetryRecords` / `telemetryDenies`（与批量双口径同哲学：可见性不丢，
 * 取舍留给宿主），records() / verify() 等离线审计仍看全量行，不受影响。
 */
const TELEMETRY_CAPABILITY = 'telemetry';

function isTelemetryRecord(record) {
  return Boolean(record) && record.capability === TELEMETRY_CAPABILITY;
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
  const allDecisions = ledgerRecords.filter((record) => record && (record.decision === 'allow' || record.decision === 'deny'));
  const telemetry = allDecisions.filter(isTelemetryRecord);
  const telemetryDenies = telemetry.filter((record) => record.decision === 'deny').length;
  const decisions = allDecisions.filter((record) => !isTelemetryRecord(record));
  const denies = decisions.filter((record) => record.decision === 'deny').length;
  const allows = decisions.filter((record) => record.decision === 'allow').length;

  // ---- 记录数 vs 目标数 ----
  // 记录数 = Ledger 行数：一次判定批次的审计成本（open/write 一次）。
  // 目标数 = 真正经过 Two-Key 判定的对象数：真实的暴露面。
  // 普通记录两者恒等；只有 enforceBatch 的批量记录一条顶 N 个目标。
  // 不分开的后果：1 条 10 万目标的 allow 记录只给分母 +1，而 1 条 7 目标的 deny
  // 记录也只 +1——「批量」于是成了压低拦截率的开关，月度曲线随宿主的批大小漂移。
  const batchAllowRecords = decisions.filter((record) => (
    record.decision === 'allow' && record.ruleId === BATCH_RULE_ID
  ));
  const batchDenyDecisions = decisions.filter((record) => (
    record.decision === 'deny' && isBatchScope(record)
  ));
  const batchRecords = batchAllowRecords.length;
  const batchedTargets = batchAllowRecords.reduce((sum, record) => sum + batchTargetsOf(record), 0);
  const batchDeniedRecords = batchDenyDecisions.length;
  const batchDeniedTargets = batchDenyDecisions.reduce((sum, record) => sum + batchTargetsOf(record), 0);
  // 目标口径的请求数：先把每条记录退回「1 条 = 1 目标」，再把批量记录替换成它
  // 实际代表的目标数。等价于 (allows 的目标数) + (denies 的目标数)。
  // 这里刻意叫 effectiveRequests 而不是改 requests：requests 的历史语义是记录数，
  // 熔断阈值、历史曲线、既有报表都按它取值，改语义等于悄悄改写过去的数据。
  const effectiveRequests = decisions.length - batchRecords - batchDeniedRecords
    + batchedTargets + batchDeniedTargets;
  // 目标口径的被拒数：普通 deny 记 1，批量 deny 记它实际检查过的目标数。
  const targetDenies = denies - batchDeniedRecords + batchDeniedTargets;

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
    // 记录口径（保持原语义，一个字段都没少）：requests = 能力判定行数
    // （1.10.12 起 capability='telemetry' 的宿主附加记录不再计入，见 isTelemetryRecord）。
    requests: decisions.length,
    allows,
    denies,
    // 记录口径拦截率：多少条「判定记录」被拒。批量 allow 只算 1 条，这是刻意的，
    // 既有熔断阈值与历史曲线都按这个口径校准过，不能在这里偷偷换成目标数。
    interceptionRate: ratio(denies, decisions.length),

    // telemetry 并列读数（加法字段）：宿主附加审计记录不进判定口径，但数量
    // 与其中 deny 的条数仍可观测——「未映射工具被拒了多少次」在 telemetryDenies，
    // 不在 denies。没有 telemetry 记录时两者恒为 0，旧账本读数不变。
    telemetryRecords: telemetry.length,
    telemetryDenies,

    // 批量口径（新增）：记录数 ↔ 目标数的换算依据，以及按目标加权的并列读数。
    batchRecords,
    batchedTargets,
    batchDeniedRecords,
    batchDeniedTargets,
    effectiveRequests,
    // 目标口径拦截率：多少个「实际经过判定的目标」被拒。
    // 与 interceptionRate 并列而不是替换，取舍留给宿主：
    //   - 记录口径回答「审计里多少次判定被拒 / 宿主触发了几次拒绝」，
    //     适合看噪声与人工介入成本；
    //   - 目标口径回答「真实世界里多少个目标被拒」，批量 allow 稀释不了它，
    //     适合看风险暴露与策略有效性。
    // 没有批量记录时两者恒等（effectiveRequests === requests，targetDenies === denies），
    // 因此把旧曲线换成新字段的差异只会在批量流量上显现。
    targetInterceptionRate: ratio(targetDenies, effectiveRequests),
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
