// dsh-dashcam 面板宿主半侧：把账本摘要成只读 HTTP API，供注入 DSH Web 的浏览器面板消费。
//
// 路由（全部 GET、no-store、环回 Host 校验——与 DSH web server 的 loopback-only
// bind 对齐，防 DNS rebinding 页面订阅）：
//   GET /api/dsh-dashcam/status                     聚合快照（模式/计数/最近事件/会话）
//   GET /api/dsh-dashcam/records?since=&to=&limit=  增量记录（已脱敏成展示形状）
//                                                   ?tail=N 取窗口内最后 N 条（2.2.0 首屏）
//   GET /api/dsh-dashcam/history                    会话聚类（时间间隔 > 15 分钟切段，短缓存）
//   GET /api/dsh-dashcam/sessions                   会话索引（2.2.0：按对话窗口聚合 + 活会话标题）
//   GET /api/dsh-dashcam/search?q=&limit=           全账本关键词搜索（2.2.0，实测卡顿降级最近 8MB）
//
// 安全姿势（与 dsh-deepseek-tan-pet 面板同款）：
//   - 只读；只暴露粗粒度事实（路径/命令/主机名、计数、决策、reason）；
//   - llm.request 的 scope.sample（消息 head 样本）不透出；llm.inbound 只透出
//     截断到 48 字的 head（用户自己的话，本地展示与账本同源）；
//   - 哈希链字段（hash/prevHash/mac）不透出——展示用不到，不给篡改者对照面；
//   - 历史聚类全量读文件，带 size+mtime 键的 10s 缓存，避免每次打开都全量扫描。

import { open, stat, readFile } from 'node:fs/promises';

export const STATUS_PATH = '/api/dsh-dashcam/status';
export const RECORDS_PATH = '/api/dsh-dashcam/records';
export const HISTORY_PATH = '/api/dsh-dashcam/history';
export const SESSIONS_PATH = '/api/dsh-dashcam/sessions';
export const SEARCH_PATH = '/api/dsh-dashcam/search';

const TAIL_MAX_BYTES = 4 * 1024 * 1024;
const HISTORY_CACHE_TTL_MS = 10_000;
const SESSION_GAP_MS = 15 * 60 * 1000;
const RECORDS_LIMIT_DEFAULT = 100;
const RECORDS_LIMIT_MAX = 2000;
const HEAD_LIMIT = 48;
const HISTORY_MAX_SESSIONS = 60;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLoopbackRequest(req) {
  const host = String((req && req.headers && req.headers.host) || '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '').trim();
  if (hostname.startsWith('[')) return LOOPBACK_HOSTS.has(hostname) || LOOPBACK_HOSTS.has(hostname.slice(1, -1));
  return LOOPBACK_HOSTS.has(hostname);
}

function capStrings(value, cap) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.length > 0).slice(0, cap);
}

// 从文件尾部读至多 maxBytes，返回升序解析的记录数组；损坏行跳过，文件缺失返回 []。
export async function readLedgerTail(ledgerPath, maxBytes = TAIL_MAX_BYTES) {
  let handle;
  try {
    handle = await open(ledgerPath, 'r');
  } catch {
    return [];
  }
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    let text = buffer.toString('utf8');
    if (length < info.size) text = text.slice(text.indexOf('\n') + 1); // 丢掉头部半行
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // 账本写入中途的半行，忽略
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

export async function readLedgerAll(ledgerPath) {
  let text;
  try {
    text = await readFile(ledgerPath, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // 同上
    }
  }
  return records;
}

// 尾部解析缓存：status 3s + records 2s 的轮询下，不缓存意味着每 2–3 秒重读并
// 逐行 JSON.parse 至多 4MB（约每分钟 50 次）。键同 history 的做法（size+mtime），
// 文件没变就复用解析结果；追加/轮转会换键，不会吃到旧账。
const TAIL_CACHE_TTL_MS = 10_000;
const tailCache = new Map();

async function readLedgerTailCached(ledgerPath) {
  let info;
  try {
    info = await stat(ledgerPath);
  } catch {
    return [];
  }
  const key = `${info.size}:${info.mtimeMs}`;
  const cached = tailCache.get(ledgerPath);
  if (cached && cached.key === key && Date.now() - cached.at < TAIL_CACHE_TTL_MS) return cached.records;
  const records = await readLedgerTail(ledgerPath);
  tailCache.set(ledgerPath, { key, at: Date.now(), records });
  return records;
}

// 记录 → 展示形状。字段刻意收窄：不含 hash/prevHash/mac、不含 llm.request 的
// sample 数组、不含 baseline/coverage 全量结构。
export function sanitizeRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const capability = typeof record.capability === 'string' ? record.capability : '';
  const action = typeof record.action === 'string' ? record.action : capability;
  const ruleId = typeof record.ruleId === 'string' ? record.ruleId : '';
  const ts = typeof record.ts === 'string' ? record.ts : null;
  if (!ts) return null;
  const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
  const reason = typeof record.reason === 'string' ? record.reason : '';
  // 展示文案不在宿主侧拼死：标题发 titleKey(+titleVars)，详情发 detailParts
  // （字符串=原样数据，{k,v}=词典模板），由面板按当前语言渲染。titleText 只用于
  // 未知 capability 的原样回退（action 本身是标识符，不翻译）。
  const out = {
    seq: Number(record.seq) || 0,
    ts,
    type: 'tel',
    titleKey: '',
    titleVars: null,
    titleText: action || 'record',
    detailParts: reason ? [reason] : [],
    denied: record.decision === 'deny',
    intercepted: record.intercepted === true,
    ruleId,
    extra: {},
  };
  // 会话归属（2.2.0）：优先取 v4 可选 session 字段（tools/pre-execute 判定链落账），
  // 回退 scope.sessionId（ingress 记录自带）。两者皆无 → null，面板归「系统」组。
  const sessionId = typeof record.session === 'string' && record.session
    ? record.session
    : (typeof scope.sessionId === 'string' && scope.sessionId ? scope.sessionId : null);
  if (sessionId) out.session = sessionId;

  const paths = capStrings(scope.paths, 8);
  const commands = capStrings(scope.commands, 4);
  let hosts = capStrings(scope.hosts, 4);
  if (!hosts.length && typeof scope.host === 'string' && scope.host) hosts = [scope.host];

  if (capability === 'fs.read' || capability === 'cred.read') {
    out.type = 'read';
    out.titleKey = paths[0] ? 'ev.read' : 'ev.readBare';
    if (paths[0]) out.titleVars = { target: paths[0] };
    out.detailParts = paths.length > 1
      ? [{ k: 'evd.morePaths', v: { n: paths.length } }]
      : paths[0] ? [paths[0]] : out.detailParts;
    if (paths.length) out.extra.paths = paths;
  } else if (capability === 'fs.write') {
    out.type = 'edit';
    out.titleKey = paths[0] ? 'ev.edit' : 'ev.editBare';
    if (paths[0]) out.titleVars = { target: paths[0] };
    out.detailParts = paths.length > 1
      ? [{ k: 'evd.morePaths', v: { n: paths.length } }]
      : paths[0] ? [paths[0]] : out.detailParts;
    if (paths.length) out.extra.paths = paths;
  } else if (capability === 'fs.delete') {
    out.type = 'edit';
    out.titleKey = paths[0] ? 'ev.delete' : 'ev.deleteBare';
    if (paths[0]) out.titleVars = { target: paths[0] };
    out.detailParts = paths.length > 1
      ? [{ k: 'evd.morePaths', v: { n: paths.length } }]
      : paths[0] ? [paths[0]] : out.detailParts;
    if (paths.length) out.extra.paths = paths;
  } else if (capability === 'proc.spawn') {
    out.type = 'bash';
    out.titleKey = commands[0] ? 'ev.command' : 'ev.commandBare';
    if (commands[0]) out.titleVars = { target: commands[0] };
    out.detailParts = commands.length > 1
      ? [{ k: 'evd.moreCommands', v: { n: commands.length } }]
      : commands[0] ? [commands[0]] : out.detailParts;
    if (commands.length) out.extra.commands = commands;
  } else if (capability === 'net.outbound') {
    out.type = 'net';
    out.titleKey = hosts[0] ? 'ev.net' : 'ev.netBare';
    if (hosts[0]) out.titleVars = { target: hosts[0] };
    if (hosts.length) out.extra.hosts = hosts;
  } else if (capability === 'llm.ingress') {
    if (action === 'llm.request') {
      out.type = 'think';
      out.titleKey = 'ev.llmRequest';
      const messages = scope.messages && typeof scope.messages === 'object' ? scope.messages : null;
      const delta = messages && messages.delta && typeof messages.delta === 'object' ? messages.delta : null;
      const model = typeof scope.model === 'string' && scope.model
        ? scope.model
        : typeof scope.provider === 'string' && scope.provider
          ? scope.provider
          : null;
      const count = messages && Number.isFinite(messages.count) ? messages.count : null;
      out.detailParts = [
        model,
        count !== null ? { k: 'evd.messages', v: { n: count } } : null,
        delta ? `+${delta.added ?? 0}/−${delta.removed ?? 0}` : null,
      ].filter(Boolean);
      if (model) out.extra.model = model;
      if (typeof scope.sessionId === 'string' && scope.sessionId) out.extra.sessionId = scope.sessionId;
    } else if (action === 'llm.inbound') {
      out.type = 'think';
      out.titleKey = 'ev.inbound';
      const kind = typeof scope.kind === 'string' ? scope.kind : 'user';
      const len = Number.isFinite(scope.len) ? scope.len : null;
      const head = typeof scope.head === 'string' && scope.head ? scope.head.slice(0, HEAD_LIMIT) : '';
      out.detailParts = [
        kind,
        len !== null ? { k: 'evd.chars', v: { n: len } } : null,
        head,
      ].filter(Boolean);
      if (typeof scope.sessionId === 'string' && scope.sessionId) out.extra.sessionId = scope.sessionId;
    } else if (action === 'llm.anomaly') {
      out.type = 'error';
      out.titleKey = 'ev.anomaly';
      // 旧版用单空格连接（不是 ' · '）；'× N' 与语言无关，先拼好再作为原样部分发出。
      const parts = [
        typeof scope.kind === 'string' ? scope.kind : null,
        Number.isFinite(scope.count) ? `× ${scope.count}` : null,
      ].filter(Boolean);
      out.detailParts = parts.length ? [parts.join(' ')] : [];
    }
  } else if (capability === 'telemetry') {
    out.type = 'tel';
    if (ruleId === 'commandline-audit' || action === 'proc.commandline') {
      out.titleKey = 'ev.commandLine';
      const commandLine = typeof scope.commandLine === 'string' && scope.commandLine
        ? scope.commandLine
        : '';
      out.detailParts = commandLine
        ? [commandLine.slice(0, 160)]
        : typeof scope.commandLineHash === 'string' && scope.commandLineHash
          ? [scope.commandLineHash.slice(7, 19)]
          : [];
      if (commandLine) out.extra.commandLine = commandLine.slice(0, 300);
    } else if (action === 'unmapped-tool') {
      out.titleKey = scope.tool ? 'ev.unmapped' : 'ev.unmappedBare';
      if (scope.tool) out.titleVars = { tool: scope.tool };
    } else if (action === 'unjudgeable-tool') {
      out.titleKey = scope.tool ? 'ev.unjudgeable' : 'ev.unjudgeableBare';
      if (scope.tool) out.titleVars = { tool: scope.tool };
      if (typeof scope.detail === 'string') out.detailParts = [scope.detail];
    } else if (ruleId === 'mount' || action === 'mount') {
      out.titleKey = 'ev.mount';
      out.detailParts = scope.mode ? [{ k: 'evd.mountMode', v: { mode: scope.mode } }] : [];
    } else if (ruleId === 'ingress-mount' || action === 'ingress-mount') {
      out.titleKey = 'ev.ingressMount';
      out.detailParts = scope.enabled === false ? [{ k: 'evd.disabled' }] : [];
    } else if (ruleId === 'ingress-disabled' || action === 'ingress-disabled') {
      out.titleKey = 'ev.ingressDisabled';
    }
  }
  return out;
}

// 聚合快照：以最后一条 mount 记录为当前运行段起点；找不到（尾部窗口太短）就
// 退化为整个尾部窗口并标记 windowed=true，前端如实显示。
export function computeStatus(records, meta = {}) {
  let mount = null;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.action === 'mount' && record.ruleId === 'mount') {
      mount = record;
      break;
    }
  }
  const runSeq = mount ? mount.seq : 0;
  // unmapped：映射表外工具的 telemetry/unmapped-tool 账（MCP、workflow 等都在表外），
  // 与纳管五项分开计数——否则「工具调用」卡片对 MCP 重的会话恒为 0。
  // bypass：advisory 下 decision=deny 但 intercepted=false 的旁路命中（guards.js
  // 口径：旁路模式照样落 deny 账）——不算异常，否则旁路模式下红色卡片常亮失去警示。
  const counts = {
    read: 0, write: 0, del: 0, spawn: 0, net: 0, llm: 0,
    telemetry: 0, unmapped: 0, deny: 0, bypass: 0, intercepted: 0, anomaly: 0,
  };
  const files = new Set();
  let lastRequest = null;
  for (const record of records) {
    if (record.seq <= runSeq) continue;
    const capability = record.capability;
    const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
    if (capability === 'fs.read' || capability === 'cred.read') counts.read += 1;
    else if (capability === 'fs.write') {
      counts.write += 1;
      for (const path of capStrings(scope.paths, 64)) files.add(path);
    } else if (capability === 'fs.delete') counts.del += 1;
    else if (capability === 'proc.spawn') counts.spawn += 1;
    else if (capability === 'net.outbound') counts.net += 1;
    else if (capability === 'llm.ingress') counts.llm += 1;
    else if (capability === 'telemetry') {
      counts.telemetry += 1;
      if (record.action === 'unmapped-tool') counts.unmapped += 1;
    }
    if (record.decision === 'deny' && capability !== 'telemetry') {
      counts.deny += 1;
      if (record.intercepted === true) counts.intercepted += 1;
      else counts.bypass += 1;
    }
    if (record.action === 'llm.anomaly') counts.anomaly += 1;
    if (record.action === 'llm.request') lastRequest = record;
  }
  const judgments = counts.read + counts.write + counts.del + counts.spawn + counts.net;
  const last = records.length ? records[records.length - 1] : null;
  const lastScope = lastRequest && lastRequest.scope && typeof lastRequest.scope === 'object' ? lastRequest.scope : null;
  return {
    ok: true,
    now: new Date().toISOString(),
    version: meta.version || (mount && mount.pluginVersion) || null,
    mode: (mount && mount.scope && mount.scope.mode) || null,
    startedAt: mount ? mount.ts : records.length ? records[0].ts : null,
    windowed: !mount,
    ledgerSeq: last ? last.seq : 0,
    ledgerPath: meta.ledgerPath || null,
    counts,
    judgments,
    // errors 只算真异常：已拦截（intercepted=true）或 ingress anomaly。
    // advisory 的 deny 是旁路命中，走 counts.bypass 单独展示。
    errors: counts.intercepted + counts.anomaly,
    filesTouched: files.size,
    session: lastScope
      ? {
          id: typeof lastScope.sessionId === 'string' ? lastScope.sessionId : null,
          model:
            (typeof lastScope.model === 'string' && lastScope.model) ||
            (typeof lastScope.provider === 'string' && lastScope.provider) ||
            null,
        }
      : null,
    lastEvent: last ? sanitizeRecord(last) : null,
  };
}

// 会话聚类：相邻记录间隔 > 15 分钟切段；含最后一条记录且距现在 < 15 分钟的段
// 标记 recording。返回新的在上，至多 60 段。
export function clusterSessions(records, now = Date.now()) {
  const sessions = [];
  let current = null;
  let prevMs = 0;
  for (const record of records) {
    const ms = Date.parse(record.ts || '');
    if (!Number.isFinite(ms)) continue;
    if (!current || ms - prevMs > SESSION_GAP_MS) {
      current = { from: record.seq, start: record.ts, end: record.ts, startMs: ms, endMs: ms, events: 0, errors: 0, to: record.seq };
      sessions.push(current);
    }
    current.end = record.ts;
    current.endMs = ms;
    current.to = record.seq;
    current.events += 1;
    // 口径与 computeStatus.errors 一致：只算已拦截或 anomaly（advisory 的 deny
    // 是旁路命中，不算录像段异常）。
    if (record.intercepted === true || record.action === 'llm.anomaly') {
      current.errors += 1;
    }
    prevMs = ms;
  }
  const list = sessions.map((session, index) => ({
    id: `S-${String(session.from).padStart(4, '0')}`,
    started: session.start,
    ended: session.end,
    duration: Math.max(0, Math.round((session.endMs - session.startMs) / 1000)),
    events: session.events,
    errors: session.errors,
    from: session.from,
    to: session.to,
    status: index === sessions.length - 1 && now - session.endMs < SESSION_GAP_MS ? 'recording' : 'completed',
  }));
  list.reverse();
  return list.slice(0, HISTORY_MAX_SESSIONS);
}

function parseQuery(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const since = Number(url.searchParams.get('since'));
  const toRaw = Number(url.searchParams.get('to'));
  const limit = Number(url.searchParams.get('limit'));
  const tail = Number(url.searchParams.get('tail'));
  return {
    since: Number.isFinite(since) && since > 0 ? Math.floor(since) : 0,
    to: Number.isFinite(toRaw) && toRaw > 0 ? Math.floor(toRaw) : null,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), RECORDS_LIMIT_MAX) : RECORDS_LIMIT_DEFAULT,
    // tail（2.2.0）：只要窗口内**最后** N 条——首屏静默加载用，避免「从账本
    // 头开始慢慢追」。tail 与 since 互斥：给了 tail 就忽略 since。
    tail: Number.isFinite(tail) && tail > 0 ? Math.min(Math.floor(tail), RECORDS_LIMIT_MAX) : 0,
  };
}

async function serveStatus(req, res, deps) {
  const records = await readLedgerTail(deps.ledgerPath);
  const body = JSON.stringify(computeStatus(records, deps));
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveRecords(req, res, deps) {
  const { since, to, limit, tail } = parseQuery(req);
  const records = await readLedgerTailCached(deps.ledgerPath);
  if (tail) {
    // tail 口径：先按 to 过滤，再取窗口内最后 N 条（升序返回，面板拿
    // records[0].seq - 1 当向前补齐的游标）。
    const filtered = to ? records.filter((r) => (Number(r.seq) || 0) <= to) : records;
    const out = filtered.slice(-tail).map(sanitizeRecord).filter(Boolean);
    const body = JSON.stringify({ ok: true, lastSeq: out.length ? out[out.length - 1].seq : 0, truncated: false, records: out });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
  // 游标口径：lastSeq 只取**实际返回**的最后一条 seq（此前是对整个文件取 max，
  // 首屏 limit 截断时游标直接跳到文件尾部，中间的记录就永久丢了）。
  // 空结果回退 since——前端有 >lastSeq 守护，不会倒退。truncated 标记后面还有
  // 匹配记录被 limit 截掉，前端回放据此显示「已截断」。
  let lastSeq = since;
  let truncated = false;
  const out = [];
  for (const record of records) {
    const seq = Number(record.seq) || 0;
    if (seq <= since) continue;
    if (to && seq > to) continue;
    if (out.length >= limit) {
      truncated = true;
      break;
    }
    const sanitized = sanitizeRecord(record);
    if (sanitized) {
      out.push(sanitized);
      lastSeq = sanitized.seq;
    }
  }
  const body = JSON.stringify({ ok: true, lastSeq, truncated, records: out });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const historyCache = new Map();

async function serveHistory(req, res, deps) {
  let info;
  try {
    info = await stat(deps.ledgerPath);
  } catch {
    const body = JSON.stringify({ ok: true, sessions: [] });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  const key = `${info.size}:${info.mtimeMs}`;
  const cached = historyCache.get(deps.ledgerPath);
  const fresh = cached && cached.key === key && Date.now() - cached.at < HISTORY_CACHE_TTL_MS;
  let sessions;
  if (fresh) {
    sessions = cached.sessions;
  } else {
    const records = await readLedgerAll(deps.ledgerPath);
    sessions = clusterSessions(records);
    historyCache.set(deps.ledgerPath, { key, at: Date.now(), sessions });
  }
  const body = JSON.stringify({ ok: true, sessions });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── 会话索引（2.2.0）────────────────────────────────────────────
// 账本聚合：按记录的 session 字段（回退 scope.sessionId）聚出每个对话窗口的
// 事件数/时间范围/拒绝数，再叠加 sessionDirectory() 提供的活会话标题。
// 无归属的记录聚到 id=null（面板显示「系统」组）。响应不缓存——聚合在
// tailCache 的解析结果上做，开销可忽略；活会话标题由调用方（deps）现取。
async function serveSessions(req, res, deps) {
  const records = await readLedgerTailCached(deps.ledgerPath);
  const map = new Map();
  for (const record of records) {
    const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
    const sid = typeof record.session === 'string' && record.session
      ? record.session
      : (typeof scope.sessionId === 'string' && scope.sessionId ? scope.sessionId : null);
    let entry = map.get(sid);
    if (!entry) {
      entry = { id: sid, title: null, count: 0, denied: 0, intercepted: 0, firstTs: record.ts, lastTs: record.ts, firstSeq: Number(record.seq) || 0, lastSeq: Number(record.seq) || 0 };
      map.set(sid, entry);
    }
    entry.count += 1;
    if (record.decision === 'deny') entry.denied += 1;
    if (record.intercepted === true) entry.intercepted += 1;
    const seq = Number(record.seq) || 0;
    if (seq < entry.firstSeq) { entry.firstSeq = seq; entry.firstTs = record.ts; }
    if (seq >= entry.lastSeq) { entry.lastSeq = seq; entry.lastTs = record.ts; }
  }
  // 活会话标题：id 匹配就补上；查不到的保持 null（面板降级为「会话 + id 前 8 位」）。
  if (typeof deps.sessionDirectory === 'function') {
    try {
      for (const item of deps.sessionDirectory()) {
        const entry = item && item.id ? map.get(item.id) : null;
        if (entry && typeof item.title === 'string' && item.title) entry.title = item.title;
      }
    } catch { /* 目录提供方异常：标题保持 null */ }
  }
  const sessions = [...map.values()].sort((a, b) => (b.lastSeq || 0) - (a.lastSeq || 0));
  const body = JSON.stringify({ ok: true, sessions });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ── 全账本搜索（2.2.0）────────────────────────────────────────────
// 关键词大小写不敏感的子串匹配，命中面：插件名、规则 ID、路径、命令、主机、
// 命令行、工具名、入站消息 head、模型名、llm.request 的 sessionId。
// 账本大小策略：全量扫（readLedgerAll）；只有上一次全量扫实测超过
// SEARCH_DEGRADE_MS 才降级到最近 SEARCH_TAIL_BYTES（8MB）并回 truncated=true
// 提示——「卡了才退」，不预先牺牲覆盖面。账本尺寸变化超过 1MB 后重试全量。
const SEARCH_DEGRADE_MS = 800;
const SEARCH_TAIL_BYTES = 8 * 1024 * 1024;
const SEARCH_LIMIT_DEFAULT = 200;
const SEARCH_LIMIT_MAX = 500;
const searchState = new Map(); // ledgerPath -> { degraded: bool, sizeAtDegrade }

function recordHaystacks(record) {
  const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value) out.push(value);
  };
  push(record.plugin);
  push(record.ruleId);
  push(record.session);
  push(scope.sessionId);
  push(scope.host);
  push(scope.commandLine);
  push(scope.tool);
  push(scope.head);
  push(scope.model);
  push(scope.provider);
  for (const key of ['paths', 'commands', 'hosts']) {
    if (Array.isArray(scope[key])) for (const item of scope[key]) push(item);
  }
  return out;
}

function parseSearchQuery(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Number(url.searchParams.get('limit'));
  return {
    q: q.toLowerCase(),
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT,
  };
}

async function serveSearch(req, res, deps) {
  const { q, limit } = parseSearchQuery(req);
  if (!q) {
    reply(res, 200, { ok: true, query: '', records: [], total: 0, truncated: false });
    return;
  }
  let info;
  try {
    info = await stat(deps.ledgerPath);
  } catch {
    reply(res, 200, { ok: true, query: q, records: [], total: 0, truncated: false });
    return;
  }
  const state = searchState.get(deps.ledgerPath) || { degraded: false, sizeAtDegrade: 0 };
  searchState.set(deps.ledgerPath, state);
  // 降级后账本明显增长（>1MB）说明又追加了新内容，重试一次全量看是否还卡。
  let degraded = state.degraded && info.size - state.sizeAtDegrade < 1024 * 1024;
  const startedAt = Date.now();
  let records;
  if (degraded) {
    records = await readLedgerTail(deps.ledgerPath, SEARCH_TAIL_BYTES);
  } else {
    records = await readLedgerAll(deps.ledgerPath);
    if (Date.now() - startedAt > SEARCH_DEGRADE_MS) {
      state.degraded = true;
      state.sizeAtDegrade = info.size;
      degraded = true;
    }
  }
  // 匹配从新往旧走：limit 截断保住的是最近的事件（回放/排查最常用）。
  const out = [];
  let total = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    const haystacks = recordHaystacks(record);
    if (!haystacks.some((text) => text.toLowerCase().includes(q))) continue;
    total += 1;
    if (out.length < limit) {
      const sanitized = sanitizeRecord(record);
      if (sanitized) out.push(sanitized);
    }
  }
  const body = JSON.stringify({ ok: true, query: q, records: out, total, truncated: degraded });
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function reply(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 与 tan-pet registerPetRoutes 同款契约：webServer.register(route) 返回 disposer。
// 返回总 disposer；webServer 缺席时抛错，由调用方决定是否吞掉。
export function registerPanelRoutes(webServer, deps) {
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('webServer 服务不可用');
  }
  const disposers = [];
  const guard = (handler) => async (req, res) => {
    try {
      if (req.method !== 'GET') {
        reply(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      if (!isLoopbackRequest(req)) {
        reply(res, 403, { ok: false, error: 'loopback only' });
        return;
      }
      await handler(req, res, deps);
    } catch (error) {
      try {
        reply(res, 500, { ok: false, error: String((error && error.message) || error) });
      } catch {
        // 连 reply 都失败（连接已断），无需处理
      }
    }
  };

  disposers.push(webServer.register({ method: 'GET', path: STATUS_PATH, handler: guard(serveStatus) }));
  disposers.push(webServer.register({ method: 'GET', path: RECORDS_PATH, handler: guard(serveRecords) }));
  disposers.push(webServer.register({ method: 'GET', path: HISTORY_PATH, handler: guard(serveHistory) }));
  disposers.push(webServer.register({ method: 'GET', path: SESSIONS_PATH, handler: guard(serveSessions) }));
  disposers.push(webServer.register({ method: 'GET', path: SEARCH_PATH, handler: guard(serveSearch) }));
  if (deps.log) {
    deps.log(`[dsh-dashcam] 面板 API 挂载完成：${STATUS_PATH} ${RECORDS_PATH} ${HISTORY_PATH} ${SESSIONS_PATH} ${SEARCH_PATH}`);
  }

  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        // 卸载失败不致命
      }
    }
  };
}
