// 1.14.0 面板宿主半侧测试：路由挂载、环回门禁、方法门禁、脱敏形状、
// 运行段聚合（纳管/未纳管/旁路口径）、会话聚类、records 游标与截断标记、
// dispose 清理，以及 apply() 在无 ctx.inject 宿主上的 optional-safe。
// 用法：node test/panel-host.mjs（或在包根目录 npm run smoke）
import { apply } from '../lib/index.js';
import { registerPanelRoutes, sanitizeRecord, computeStatus, clusterSessions } from '../lib/panel.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RESULTS = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dashcam-panel-smoke-'));
let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

function makeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
    find(method, pathname) {
      return routes.find((r) => r.method === method && r.path === pathname);
    },
  };
}

function makeReqRes(method, url, host = 'localhost:3000') {
  const req = { method, url, headers: { host } };
  const res = {
    code: 0,
    body: '',
    writeHead(code) { this.code = code; return this; },
    end(chunk) { if (chunk != null) this.body += chunk; },
  };
  return { req, res };
}

function jsonBody(res) {
  return JSON.parse(res.body);
}

function rec(seq, ts, capability, action, extra = {}) {
  return {
    v: 2,
    seq,
    ts,
    plugin: 'dsh-dashcam-host',
    pluginVersion: '1.13.0',
    ...(extra.session ? { session: extra.session } : {}),
    capability,
    action,
    decision: extra.decision || 'allow',
    intercepted: extra.intercepted || false,
    ruleId: extra.ruleId || 'test',
    reason: extra.reason || '',
    hash: 'deadbeef',
    prevHash: 'feedface',
    scope: extra.scope || {},
  };
}

// ---------- 1) sanitizeRecord：脱敏形状 ----------
{
  const read = sanitizeRecord(rec(1, '2026-11-09T01:00:00.000Z', 'fs.read', 'fs.read', {
    ruleId: 'r1', scope: { paths: ['C:/a.txt', 'C:/b.txt'] },
  }));
  check('sanitize: fs.read → type read + 结构化标题 key',
    read.type === 'read' && read.titleKey === 'ev.read' && read.titleVars && read.titleVars.target === 'C:/a.txt',
    JSON.stringify(read));
  check('sanitize: 多路径 detail 发模板 key（不拼死中文）',
    JSON.stringify(read.detailParts) === JSON.stringify([{ k: 'evd.morePaths', v: { n: 2 } }]),
    JSON.stringify(read.detailParts));

  const request = sanitizeRecord(rec(2, '2026-11-09T01:00:01.000Z', 'llm.ingress', 'llm.request', {
    ruleId: 'ingress-request',
    scope: {
      model: 'deepseek-chat', sessionId: 'session-x',
      messages: { count: 12, delta: { added: 3, removed: 1 } },
      sample: [{ role: 'system', head: 'SECRET HEAD' }],
    },
  }));
  const flat = JSON.stringify(request);
  check('sanitize: llm.request → think + 计数 detail 模板',
    request.type === 'think' && flat.includes('deepseek-chat')
    && JSON.stringify(request.detailParts).includes('"evd.messages"')
    && JSON.stringify(request.detailParts).includes('"n":12'),
    JSON.stringify(request.detailParts));
  check('sanitize: sample（消息 head 样本）不透出', !flat.includes('SECRET HEAD') && !flat.includes('sample'), flat);
  check('sanitize: 哈希链字段不透出', !flat.includes('deadbeef') && !flat.includes('feedface'), flat);

  const inbound = sanitizeRecord(rec(3, '2026-11-09T01:00:02.000Z', 'llm.ingress', 'llm.inbound', {
    ruleId: 'ingress-inbound', scope: { kind: 'user', len: 34, head: 'x'.repeat(200), sessionId: 'session-x' },
  }));
  check('sanitize: llm.inbound head 截断到 48 字',
    inbound.detailParts.includes('x'.repeat(48)) && !JSON.stringify(inbound).includes('x'.repeat(49)),
    JSON.stringify(inbound.detailParts));

  const deny = sanitizeRecord(rec(4, '2026-11-09T01:00:03.000Z', 'proc.spawn', 'proc.spawn', {
    decision: 'deny', intercepted: true, ruleId: 'r4', scope: { commands: ['rm -rf /'] },
  }));
  check('sanitize: deny → denied 标记 + intercepted', deny.denied === true && deny.intercepted === true && deny.type === 'bash', JSON.stringify(deny));

  const anomaly = sanitizeRecord(rec(5, '2026-11-09T01:00:04.000Z', 'llm.ingress', 'llm.anomaly', {
    ruleId: 'ingress-anomaly', scope: { kind: 'added_user_without_inbound', count: 2 },
  }));
  check('sanitize: llm.anomaly → error', anomaly.type === 'error', JSON.stringify(anomaly));

  const mount = sanitizeRecord(rec(6, '2026-11-09T01:00:05.000Z', 'telemetry', 'mount', {
    ruleId: 'mount', scope: { mode: 'advisory' },
  }));
  check('sanitize: mount → 模式 detail 模板',
    mount.type === 'tel' && mount.titleKey === 'ev.mount'
    && JSON.stringify(mount.detailParts) === JSON.stringify([{ k: 'evd.mountMode', v: { mode: 'advisory' } }]),
    JSON.stringify(mount));

  // 2.2.0 会话归属：v4 可选 session 字段优先，回退 scope.sessionId，两者皆无则缺省
  const attributed = sanitizeRecord(rec(7, '2026-11-09T01:00:06.000Z', 'fs.read', 'fs.read', {
    ruleId: 'r', session: 'win-uuid-1', scope: { paths: ['C:/a.txt'] },
  }));
  check('sanitize: session 字段透出（窗口归属）', attributed.session === 'win-uuid-1', JSON.stringify(attributed.session));
  const fallback = sanitizeRecord(rec(8, '2026-11-09T01:00:07.000Z', 'llm.ingress', 'llm.inbound', {
    ruleId: 'ingress-inbound', scope: { kind: 'user', sessionId: 'session-x' },
  }));
  check('sanitize: scope.sessionId 兜底（ingress 记录）', fallback.session === 'session-x', JSON.stringify(fallback.session));
  const orphan = sanitizeRecord(rec(9, '2026-11-09T01:00:08.000Z', 'fs.read', 'fs.read', {
    ruleId: 'r', scope: { paths: ['C:/a.txt'] },
  }));
  check('sanitize: 无归属 → session 缺省（面板归系统组）', !('session' in orphan), JSON.stringify(orphan.session));
}

// ---------- 2) computeStatus：运行段聚合（纳管/未纳管/旁路口径） ----------
{
  const records = [
    rec(10, '2026-11-09T01:00:00.000Z', 'telemetry', 'mount', { ruleId: 'mount', scope: { mode: 'advisory' } }),
    rec(11, '2026-11-09T01:00:01.000Z', 'fs.read', 'fs.read', { ruleId: 'r', scope: { paths: ['C:/a.txt'] } }),
    rec(12, '2026-11-09T01:00:02.000Z', 'fs.write', 'fs.write', { ruleId: 'r', scope: { paths: ['C:/a.txt'] } }),
    rec(13, '2026-11-09T01:00:03.000Z', 'fs.write', 'fs.write', { ruleId: 'r', scope: { paths: ['C:/b.txt'] } }),
    rec(14, '2026-11-09T01:00:04.000Z', 'proc.spawn', 'proc.spawn', { decision: 'deny', intercepted: true, ruleId: 'r', scope: { commands: ['curl'] } }),
    rec(15, '2026-11-09T01:00:05.000Z', 'llm.ingress', 'llm.request', { ruleId: 'ingress-request', scope: { model: 'deepseek-chat', sessionId: 'session-1', messages: { count: 5 } } }),
    // advisory 旁路 deny（intercepted=false）：不进 errors，进 bypass
    rec(16, '2026-11-09T01:00:06.000Z', 'proc.spawn', 'proc.spawn', { decision: 'deny', intercepted: false, ruleId: 'r', scope: { commands: ['pwsh'] } }),
    // 映射表外工具（MCP 等）→ telemetry/unmapped-tool：不进 judgments，进 unmapped
    rec(17, '2026-11-09T01:00:07.000Z', 'telemetry', 'unmapped-tool', { ruleId: 'telemetry', scope: { tool: 'mcp__demo__ping' } }),
  ];
  const status = computeStatus(records, { version: '1.14.0', ledgerPath: 'P' });
  check('status: startedAt=mount.ts / windowed=false', status.startedAt === '2026-11-09T01:00:00.000Z' && status.windowed === false, JSON.stringify(status.startedAt));
  check('status: 计数', status.counts.read === 1 && status.counts.write === 2 && status.counts.spawn === 2, JSON.stringify(status.counts));
  check('status: filesTouched 去重', status.filesTouched === 2, String(status.filesTouched));
  check('status: errors=intercepted+anomaly（旁路 deny 不算异常）', status.errors === 1 && status.counts.intercepted === 1 && status.counts.bypass === 1, JSON.stringify({ errors: status.errors, i: status.counts.intercepted, b: status.counts.bypass }));
  check('status: unmapped 计数（映射表外不丢账）', status.counts.unmapped === 1, String(status.counts.unmapped));
  check('status: judgments 口径（纳管五项，不含 unmapped）', status.judgments === 5, String(status.judgments));
  check('status: session 摘自最后一条 llm.request', status.session && status.session.id === 'session-1' && status.session.model === 'deepseek-chat', JSON.stringify(status.session));
  check('status: lastEvent 是最后一条', status.lastEvent && status.lastEvent.seq === 17, JSON.stringify(status.lastEvent && status.lastEvent.seq));

  const empty = computeStatus([], {});
  check('status: 空账本不炸', empty.ok === true && empty.startedAt === null && empty.ledgerSeq === 0, JSON.stringify(empty));

  const noMount = computeStatus([rec(1, '2026-11-09T01:00:00.000Z', 'fs.read', 'fs.read')], {});
  check('status: 无 mount → windowed=true 且统计全量', noMount.windowed === true && noMount.counts.read === 1, JSON.stringify(noMount));
}

// ---------- 3) clusterSessions：时间间隔切段 ----------
{
  const base = Date.parse('2026-11-09T01:00:00.000Z');
  const records = [
    rec(1, new Date(base).toISOString(), 'fs.read', 'fs.read'),
    rec(2, new Date(base + 60000).toISOString(), 'fs.write', 'fs.write'),
    // 20 分钟间隔 → 切段；intercepted=true 才算段内异常（advisory deny 是旁路）
    rec(3, new Date(base + 21 * 60000).toISOString(), 'fs.read', 'fs.read', { decision: 'deny', intercepted: true }),
    rec(4, new Date(base + 22 * 60000).toISOString(), 'llm.ingress', 'llm.request', { ruleId: 'ingress-request', scope: { sessionId: 's' } }),
  ];
  const now = base + 23 * 60000;
  const sessions = clusterSessions(records, now);
  check('cluster: 20 分钟间隔切成 2 段', sessions.length === 2, JSON.stringify(sessions));
  check('cluster: 新的在上（id S-0003）', sessions[0].id === 'S-0003', sessions[0] && sessions[0].id);
  check('cluster: 最新段 recording', sessions[0].status === 'recording' && sessions[1].status === 'completed', JSON.stringify(sessions.map((s) => s.status)));
  check('cluster: 段内计数', sessions[0].events === 2 && sessions[0].errors === 1, JSON.stringify(sessions[0]));
  check('cluster: from/to 序号范围', sessions[0].from === 3 && sessions[0].to === 4, JSON.stringify(sessions[0]));
  check('cluster: 空账本 → []', clusterSessions([], Date.now()).length === 0);
}

// ---------- 4) registerPanelRoutes：路由与门禁 ----------
{
  const ws = makeWebServer();
  const ledgerPath = path.join(RESULTS, 'panel.jsonl');
  const base = Date.now() - 60000;
  const lines = [
    rec(1, new Date(base - 40000).toISOString(), 'telemetry', 'mount', { ruleId: 'mount', scope: { mode: 'advisory' } }),
    rec(2, new Date(base - 30000).toISOString(), 'fs.read', 'fs.read', { ruleId: 'r', scope: { paths: ['C:/a.txt'] } }),
    rec(3, new Date(base - 20000).toISOString(), 'fs.write', 'fs.write', { ruleId: 'r', scope: { paths: ['C:/a.txt'] } }),
  ];
  fs.writeFileSync(ledgerPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const dispose = registerPanelRoutes(ws, { ledgerPath, version: '1.13.0' });
  check('routes: 五条路由注册', ws.routes.length === 5, String(ws.routes.length));
  check('routes: sessions/search 已挂载', Boolean(ws.find('GET', '/api/dsh-dashcam/sessions')) && Boolean(ws.find('GET', '/api/dsh-dashcam/search')));

  // 环回门禁
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/status', 'evil.example.com');
    await ws.find('GET', '/api/dsh-dashcam/status').handler(req, res);
    check('gate: 非环回 Host → 403', res.code === 403 && jsonBody(res).error === 'loopback only', res.body);
  }
  // 方法门禁
  {
    const { req, res } = makeReqRes('POST', '/api/dsh-dashcam/status');
    await ws.find('GET', '/api/dsh-dashcam/status').handler(req, res);
    check('gate: POST → 405', res.code === 405, String(res.code));
  }
  // status
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/status');
    await ws.find('GET', '/api/dsh-dashcam/status').handler(req, res);
    const body = jsonBody(res);
    check('status: 200 + mode/version', res.code === 200 && body.mode === 'advisory' && body.version === '1.13.0', res.body);
    check('status: ledgerSeq=3 / startedAt=mount', body.ledgerSeq === 3 && body.windowed === false, JSON.stringify({ seq: body.ledgerSeq, startedAt: body.startedAt }));
    check('status: 不透出哈希链字段', !res.body.includes('deadbeef'), res.body.slice(0, 200));
  }
  // records：since 过滤 + 脱敏 + limit
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/records?since=2&limit=1');
    await ws.find('GET', '/api/dsh-dashcam/records').handler(req, res);
    const body = jsonBody(res);
    check('records: since+limit 生效', body.records.length === 1 && body.records[0].seq === 3 && body.lastSeq === 3, res.body);
    check('records: 脱敏形状（type/titleKey，无 hash/scope.sample）', body.records[0].type === 'edit' && body.records[0].titleKey === 'ev.edit' && !res.body.includes('deadbeef'), res.body);
  }
  // 游标口径：lastSeq 只取实际返回的最后一条，截断时不再跳到文件尾部
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/records?since=0&limit=2');
    await ws.find('GET', '/api/dsh-dashcam/records').handler(req, res);
    const body = jsonBody(res);
    check('records: 首屏截断 → lastSeq=最后返回的 seq（非账本 max）', body.records.length === 2 && body.records[0].seq === 1 && body.lastSeq === 2 && body.truncated === true, res.body);
  }
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/records?since=2');
    await ws.find('GET', '/api/dsh-dashcam/records').handler(req, res);
    const body = jsonBody(res);
    // 旧实现此处 records 为空（游标已跳到 3，第 3 条实际还会返回；但 limit 截断
    // 场景下中间记录会被永久跳过）——修后按游标续拉，不丢记录。
    check('records: 游标续拉不丢记录', body.records.length === 1 && body.records[0].seq === 3 && body.lastSeq === 3 && body.truncated === false, res.body);
  }
  // tail（2.2.0 静默加载）：取窗口内最后 N 条，升序返回
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/records?tail=2');
    await ws.find('GET', '/api/dsh-dashcam/records').handler(req, res);
    const body = jsonBody(res);
    check('records: tail=2 → 最后 2 条升序 + lastSeq=最新',
      body.records.length === 2 && body.records[0].seq === 2 && body.records[1].seq === 3 && body.lastSeq === 3 && body.truncated === false,
      res.body);
    const { req: req2, res: res2 } = makeReqRes('GET', '/api/dsh-dashcam/records?tail=5&to=2');
    await ws.find('GET', '/api/dsh-dashcam/records').handler(req2, res2);
    const body2 = jsonBody(res2);
    check('records: tail 与 to 组合（回放向前补齐游标）',
      body2.records.length === 2 && body2.records[0].seq === 1 && body2.records[1].seq === 2,
      res2.body);
  }
  // sessions（2.2.0 会话索引）：账本聚合 + 活会话标题注入 + 无归属聚 null
  {
    const ws2 = makeWebServer();
    const ledger2 = path.join(RESULTS, 'panel-sessions.jsonl');
    const sBase = Date.parse('2026-11-13T02:00:00.000Z');
    const lines2 = [
      rec(1, new Date(sBase).toISOString(), 'fs.read', 'fs.read', { ruleId: 'r', session: 'win-a', scope: { paths: ['C:/a.txt'] } }),
      rec(2, new Date(sBase + 1000).toISOString(), 'fs.write', 'fs.write', { ruleId: 'r', session: 'win-a', scope: { paths: ['C:/a.txt'] } }),
      rec(3, new Date(sBase + 2000).toISOString(), 'proc.spawn', 'proc.spawn', { ruleId: 'r', session: 'win-b', scope: { commands: ['curl'] } }),
      rec(4, new Date(sBase + 3000).toISOString(), 'llm.ingress', 'llm.inbound', { ruleId: 'ingress-inbound', scope: { kind: 'user', sessionId: 'win-b', head: '部署到测试环境' } }),
      rec(5, new Date(sBase + 4000).toISOString(), 'telemetry', 'mount', { ruleId: 'mount', scope: { mode: 'advisory' } }),
    ];
    fs.writeFileSync(ledger2, lines2.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const dispose2 = registerPanelRoutes(ws2, {
      ledgerPath: ledger2,
      version: '2.2.0',
      sessionDirectory: () => [{ id: 'win-a', title: '调试会话窗口' }],
    });
    {
      const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/sessions');
      await ws2.find('GET', '/api/dsh-dashcam/sessions').handler(req, res);
      const body = jsonBody(res);
      const byId = new Map(body.sessions.map((s) => [s.id, s]));
      check('sessions: 聚合出 3 组（win-a / win-b / 系统null）',
        body.sessions.length === 3 && byId.has('win-a') && byId.has('win-b') && byId.has(null), res.body);
      check('sessions: win-a 计数与标题注入',
        byId.get('win-a').count === 2 && byId.get('win-a').title === '调试会话窗口' && byId.get('win-a').firstTs === new Date(sBase).toISOString(),
        JSON.stringify(byId.get('win-a')));
      check('sessions: scope.sessionId 兜底聚到 win-b',
        byId.get('win-b').count === 2 && byId.get('win-b').title === null, JSON.stringify(byId.get('win-b')));
      check('sessions: 无归属记录聚系统组', byId.get(null).count === 1, JSON.stringify(byId.get(null)));
    }
    // search（2.2.0 全账本搜索）：路径/命令/入站 head/插件名/规则 ID 命中
    {
      const hit = async (q) => {
        const { req, res } = makeReqRes('GET', `/api/dsh-dashcam/search?q=${encodeURIComponent(q)}`);
        await ws2.find('GET', '/api/dsh-dashcam/search').handler(req, res);
        return jsonBody(res);
      };
      const byPath = await hit('C:/a.txt');
      check('search: 路径命中 + 新→旧 + 脱敏形状',
        byPath.ok === true && byPath.records.length === 2 && byPath.records[0].seq === 2 && byPath.records[0].titleKey === 'ev.edit' && byPath.total === 2 && byPath.truncated === false,
        JSON.stringify(byPath));
      const byCmd = await hit('curl');
      check('search: 命令命中', byCmd.total === 1 && byCmd.records[0].seq === 3, JSON.stringify(byCmd));
      const byHead = await hit('测试环境');
      check('search: 入站消息 head 命中', byHead.total === 1 && byHead.records[0].seq === 4, JSON.stringify(byHead));
      const byPlugin = await hit('dsh-dashcam-host');
      check('search: 插件名命中全部 5 条', byPlugin.total === 5, String(byPlugin.total));
      const byMount = await hit('mount');
      check('search: 规则 ID 命中', byMount.total === 1 && byMount.records[0].seq === 5, JSON.stringify(byMount));
      const none = await hit('不存在的关键词xyz');
      check('search: 无命中 → 空结果不炸', none.total === 0 && none.records.length === 0, JSON.stringify(none));
      const { req: req3, res: res3 } = makeReqRes('GET', '/api/dsh-dashcam/search?q=');
      await ws2.find('GET', '/api/dsh-dashcam/search').handler(req3, res3);
      check('search: 空 q → 空结果', jsonBody(res3).total === 0, res3.body);
      // 大小写不敏感
      const ci = await hit('C:/A.TXT');
      check('search: 大小写不敏感', ci.total === 2, String(ci.total));
    }
    dispose2();
  }
  // history：3 秒间隔不切段，1 段
  {
    const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/history');
    await ws.find('GET', '/api/dsh-dashcam/history').handler(req, res);
    const body = jsonBody(res);
    check('history: 单段 recording', body.sessions.length === 1 && body.sessions[0].status === 'recording' && body.sessions[0].events === 3, res.body);
  }
  // dispose
  dispose();
  check('routes: dispose 后清空', ws.routes.length === 0, String(ws.routes.length));
}

// ---------- 5) 缺 ledger 文件 / webServer 缺席 ----------
{
  const ws = makeWebServer();
  const dispose = registerPanelRoutes(ws, { ledgerPath: path.join(RESULTS, 'missing.jsonl') });
  const { req, res } = makeReqRes('GET', '/api/dsh-dashcam/status');
  await ws.find('GET', '/api/dsh-dashcam/status').handler(req, res);
  const body = jsonBody(res);
  check('status: 账本缺失 → 空快照不炸', res.code === 200 && body.ledgerSeq === 0, res.body);
  dispose();

  let threw = false;
  try { registerPanelRoutes(null, {}); } catch { threw = true; }
  check('routes: webServer 缺席抛错（调用方吞）', threw);
}

// ---------- 6) apply() optional-safe：无 ctx.inject 的宿主上判定链照常挂载 ----------
{
  const log = [];
  const origInfo = console.info;
  console.info = (...a) => { log.push(a.join(' ')); };
  const handlers = {};
  const effects = [];
  const ctx = {
    on(event, fn) { handlers[event] = fn; },
    effect(fn) { effects.push(fn); },
  };
  const ledgerPath = path.join(RESULTS, 'apply-no-inject.jsonl');
  apply(ctx, { ledgerPath });
  console.info = origInfo;
  check('apply: 无 ctx.inject 也正常挂载判定链', typeof handlers['tools/pre-execute'] === 'function');
  check('apply: 留下「未提供 ctx.inject」日志', log.some((m) => /未提供 ctx\.inject/.test(m)), JSON.stringify(log));
  // 单运行时守护：同一进程只允许一个活动 dashcam，用例间必须 deactivate。
  for (const fn of effects) {
    try { const cleanup = fn(); if (typeof cleanup === 'function') cleanup(); } catch {}
  }
  handlers['tools/pre-execute'] = undefined;
}

// ---------- 7) apply() + ctx.inject：面板路由随宿主注入挂载 ----------
{
  const ws = makeWebServer();
  const handlers = {};
  const effects = [];
  const ctx = {
    on(event, fn) { handlers[event] = fn; },
    effect(fn) { effects.push(fn); },
    inject(deps, fn) {
      if (deps.includes('webServer')) {
        fn({
          webServer: ws,
          get(name) { return name === 'webServer' ? ws : undefined; },
          // cordis 语义：effect 立即执行回调，返回值注册为清理函数。
          effect(fn2) {
            const cleanup = fn2();
            effects.push(typeof cleanup === 'function' ? cleanup : () => {});
          },
        });
      }
    },
  };
  const ledgerPath = path.join(RESULTS, 'apply-inject.jsonl');
  apply(ctx, { ledgerPath });
  check('apply: ctx.inject 路径下路由挂载', ws.routes.length === 5, String(ws.routes.length));
  for (const fn of effects) {
    try { const cleanup = fn(); if (typeof cleanup === 'function') cleanup(); } catch {}
  }
  check('apply: 卸载后路由清空', ws.routes.length === 0, String(ws.routes.length));
}

// ---------- 8) 面板 i18n：词典一致性 + 语言切换（内联 mini-DOM stub，不引第三方依赖） ----------
{
  // 环境 stub：localStorage / navigator / document / ResizeObserver / rAF。
  // DOM stub 只覆盖面板用到的能力：template 解析、querySelector('.a .b' / [attr="v"])、
  // classList、dataset、事件接线与 click()。
  const langStore = new Map();
  const localStorageStub = {
    getItem: (k) => (langStore.has(k) ? langStore.get(k) : null),
    setItem: (k, v) => { langStore.set(k, String(v)); },
    removeItem: (k) => { langStore.delete(k); },
  };
  const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

  class StubText {
    constructor(text) { this.nodeType = 'text'; this.text = String(text); }
  }

  class StubElement {
    constructor(tag) {
      this.nodeType = 'element';
      this.tagName = String(tag).toLowerCase();
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = {};
      this.listeners = {};
      this.className = '';
      this.style = {};
      this.value = '';
      this.isConnected = false;
      const attrs = this.attributes;
      const toDash = (prop) => `data-${String(prop).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      this.dataset = new Proxy({}, {
        set(target, prop, value) { target[prop] = String(value); attrs[toDash(prop)] = String(value); return true; },
        deleteProperty(target, prop) { delete target[prop]; delete attrs[toDash(prop)]; return true; },
      });
    }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 'element' ? this.parentNode : null; }
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
    setAttribute(name, value) {
      const v = String(value);
      this.attributes[name] = v;
      if (name === 'class') this.className = v;
      if (String(name).startsWith('data-')) {
        const key = String(name).slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
        this.dataset[key] = v;
      }
    }
    get classList() {
      const el = this;
      const names = () => el.className.split(/\s+/).filter(Boolean);
      return {
        contains: (c) => names().includes(c),
        add: (c) => { const s = names(); if (!s.includes(c)) el.className = [...s, c].join(' '); },
        remove: (c) => { el.className = names().filter((x) => x !== c).join(' '); },
        toggle: (c, force) => {
          const s = names();
          const has = s.includes(c);
          const want = force === undefined ? !has : !!force;
          el.className = want ? [...s.filter((x) => x !== c), c].join(' ') : s.filter((x) => x !== c).join(' ');
          return want;
        },
      };
    }
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); markTree(node, true); return node; }
    insertBefore(node, ref) {
      node.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i < 0) this.childNodes.push(node); else this.childNodes.splice(i, 0, node);
      markTree(node, true);
      return node;
    }
    removeChild(node) {
      const i = this.childNodes.indexOf(node);
      if (i >= 0) this.childNodes.splice(i, 1);
      node.parentNode = null;
      markTree(node, false);
      return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceWith(node) {
      const p = this.parentNode;
      if (!p) return;
      p.childNodes[p.childNodes.indexOf(this)] = node;
      this.parentNode = null;
      markTree(this, false);
      node.parentNode = p;
      markTree(node, true);
    }
    set textContent(value) { this.childNodes = value === '' ? [] : [new StubText(value)]; }
    get textContent() {
      return this.childNodes.map((n) => (n.nodeType === 'text' ? n.text : n.textContent)).join('');
    }
    get children() { return this.childNodes.filter((n) => n.nodeType === 'element'); }
    set innerHTML(html) { this.childNodes = parseHtml(String(html), this); markTree(this, true); }
    get innerHTML() { return this.childNodes.map((n) => (n.nodeType === 'text' ? n.text : n.innerHTML)).join(''); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { const l = this.listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
    click() {
      const ev = { offsetX: 0, clientX: 0, clientY: 0, key: '', code: '', target: this, preventDefault() {} };
      for (const fn of [...(this.listeners.click || [])]) fn(ev);
    }
    getBoundingClientRect() { return { width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; }
    scrollIntoView() {}
    scrollTop = 0;
    replaceChildren(...nodes) {
      for (const c of [...this.childNodes]) { markTree(c, false); c.parentNode = null; }
      this.childNodes = [];
      for (const n of nodes) {
        if (!n) continue;
        if (n.nodeType === 'fragment') {
          const kids = [...n.childNodes];
          n.childNodes = [];
          for (const c of kids) this.appendChild(c);
        } else {
          this.appendChild(n);
        }
      }
    }
    querySelector(sel) { return queryAll(this, sel)[0] || null; }
    querySelectorAll(sel) { return queryAll(this, sel); }
  }

  function markTree(node, value) {
    if (!node || node.nodeType !== 'element') return;
    node.isConnected = value;
    for (const c of node.childNodes) if (c.nodeType === 'element') markTree(c, value);
  }

  function decodeEntities(s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  function parseHtml(html, owner) {
    const top = [];
    const stack = [{ arr: top, el: owner }];
    const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    let last = 0;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
      if (m.index > last) stack[stack.length - 1].arr.push(new StubText(decodeEntities(html.slice(last, m.index))));
      last = tagRe.lastIndex;
      if (html[m.index + 1] === '/') { stack.pop(); continue; }
      const frame = stack[stack.length - 1];
      const el = new StubElement(m[1]);
      // 分组：1=属性名，2=双引号值，3=单引号值（无值属性两组都为 undefined）
      const attrRe = /([a-zA-Z_:@][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
      let a;
      while ((a = attrRe.exec(m[2])) !== null) {
        el.setAttribute(a[1], a[2] === undefined && a[3] === undefined ? '' : decodeEntities(a[2] !== undefined ? a[2] : a[3]));
      }
      el.parentNode = frame.el;
      frame.arr.push(el);
      if (!m[3] && !VOID_TAGS.has(el.tagName)) stack.push({ arr: el.childNodes, el });
    }
    if (last < html.length) stack[stack.length - 1].arr.push(new StubText(decodeEntities(html.slice(last))));
    return top;
  }

  function parseSelector(sel) {
    return sel.trim().split(/\s+/).map((part) => {
      const m = part.match(/^\.([A-Za-z0-9_-]+)((?:\[[^\]]*\])*)$/);
      if (!m) throw new Error(`mini-DOM 不支持的选择器: ${sel}`);
      const attrs = [];
      const attrRe = /\[([-\w]+)(?:="([^"]*)")?\]/g;
      let a;
      while ((a = attrRe.exec(m[2])) !== null) attrs.push([a[1], a[2] === undefined ? null : a[2]]);
      return { cls: m[1], attrs };
    });
  }

  function matchPart(el, part) {
    if (!el.classList.contains(part.cls)) return false;
    for (const [k, v] of part.attrs) {
      const actual = el.getAttribute(k);
      if (actual === null) return false;
      if (v !== null && actual !== v) return false;
    }
    return true;
  }

  function chainMatch(el, parts, i) {
    if (!matchPart(el, parts[i])) return false;
    if (i === 0) return true;
    let p = el.parentElement;
    while (p) {
      if (chainMatch(p, parts, i - 1)) return true;
      p = p.parentElement;
    }
    return false;
  }

  function queryAll(rootEl, sel) {
    const parts = parseSelector(sel);
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (chainMatch(c, parts, parts.length - 1)) out.push(c);
        walk(c);
      }
    };
    walk(rootEl);
    return out;
  }

  const stubBody = new StubElement('body');
  const docListeners = {};
  const documentStub = {
    createElement: (tag) => new StubElement(tag),
    createDocumentFragment: () => { const f = new StubElement('#fragment'); f.nodeType = 'fragment'; return f; },
    body: stubBody,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { const l = docListeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
  };

  const prevDocument = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevNavigator = globalThis.navigator;
  const prevRO = globalThis.ResizeObserver;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  const prevGCS = globalThis.getComputedStyle;
  Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true });
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageStub, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: class { constructor() {} observe() {} disconnect() {} unobserve() {} },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { value: () => 0, configurable: true });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { value: () => {}, configurable: true });
  Object.defineProperty(globalThis, 'getComputedStyle', { value: () => ({ getPropertyValue: () => '' }), configurable: true });

  try {
    const { createDashcamPanel, DASHCAM_I18N, badgeTitle } = await import('../src/client/dashcam-panel.js');

    // (a) zh/en 两包 key 集合完全一致（防漏翻）
    const zhKeys = Object.keys(DASHCAM_I18N.zh).sort();
    const enKeys = Object.keys(DASHCAM_I18N.en).sort();
    check('i18n: zh/en 两包 key 集合完全一致（防漏翻）',
      JSON.stringify(zhKeys) === JSON.stringify(enKeys) && zhKeys.length >= 70,
      `zh=${zhKeys.length}, en=${enKeys.length}`);

    // (b) 语言切换：DOM 出现英文文案 + localStorage 持久化；state 数据保留
    let langChangeCalls = 0;
    const panel = createDashcamPanel({ onClose() {}, onLanguageChange: () => { langChangeCalls += 1; } });
    const rootEl = panel.el;
    const tabsNode = rootEl.querySelector('.ddc-tabs');
    check('i18n: 默认 zh（navigator.language 以 zh 开头）',
      rootEl.querySelector('.ddc-sub').textContent === '判定链账本 · 实时录制与回放'
      && [...rootEl.querySelectorAll('.ddc-tab')].map((b) => b.textContent).join('|') === '实时录制|回放|录像历史'
      && rootEl.querySelector('.ddc-lang').textContent === 'EN',
      JSON.stringify([...rootEl.querySelectorAll('.ddc-tab')].map((b) => b.textContent)));

    check('i18n: 徽章 tooltip 默认 zh',
      badgeTitle() === 'Agent Dashcam（Ctrl+Shift+D，拖动可换位置）', badgeTitle());

    // 喂一条实时记录（与 lib/panel.js 脱敏输出的记录同形）
    panel.updateLive(null, [{
      seq: 1, ts: '2026-11-09T01:00:00.000Z', type: 'read',
      titleKey: 'ev.read', titleVars: { target: 'C:/a.txt' }, titleText: 'fs.read',
      detailParts: [{ k: 'evd.morePaths', v: { n: 2 } }], denied: false, intercepted: false,
    }]);
    check('i18n: 实时流 zh 渲染（类型标签 / 计数量词 / 事件标题与详情）',
      rootEl.querySelector('.ddc-stream .ddc-ev .ddc-tag').textContent === '读取'
      && rootEl.querySelector('.ddc-stream-meta').textContent === '共 1 条'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-title').textContent === '读取 C:/a.txt'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-detail').textContent === '等 2 个路径',
      JSON.stringify({
        meta: rootEl.querySelector('.ddc-stream-meta').textContent,
        title: rootEl.querySelector('.ddc-stream .ddc-ev .ddc-title').textContent,
        detail: rootEl.querySelector('.ddc-stream .ddc-ev .ddc-detail').textContent,
      }));

    rootEl.querySelector('.ddc-lang').click();
    check('i18n: 切换后 DOM 出现英文且 localStorage 落盘',
      rootEl.querySelector('.ddc-sub').textContent === 'Judgment ledger · live recording & replay'
      && [...rootEl.querySelectorAll('.ddc-tab')].map((b) => b.textContent).join('|') === 'Live|Replay|History'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-tag').textContent === 'Reading'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-title').textContent === 'Reading C:/a.txt'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-detail').textContent === '2 paths total'
      && rootEl.querySelector('.ddc-stream-meta').textContent === '1 entries'
      && rootEl.querySelector('.ddc-play').textContent === 'Play'
      && rootEl.querySelector('.ddc-hsearch').getAttribute('placeholder') === 'Search ID / date…'
      && rootEl.querySelector('.ddc-lang').textContent === '中文'
      && langStore.get('ddc-lang') === 'en',
      JSON.stringify({ sub: rootEl.querySelector('.ddc-sub').textContent, lang: langStore.get('ddc-lang') }));
    check('i18n: 徽章 tooltip 跟随切换 + onLanguageChange 回调',
      badgeTitle() === 'Agent Dashcam (Ctrl+Shift+D, drag to move)' && langChangeCalls === 1,
      JSON.stringify({ title: badgeTitle(), langChangeCalls }));
    check('i18n: 重建保留根节点与 tabs 节点（engine 观察器不失效）',
      panel.el === rootEl && rootEl.querySelector('.ddc-tabs') === tabsNode);
    check('i18n: 切换不清空已收到的事件',
      rootEl.querySelectorAll('.ddc-stream .ddc-ev').length === 1,
      String(rootEl.querySelectorAll('.ddc-stream .ddc-ev').length));

    rootEl.querySelector('.ddc-lang').click();
    check('i18n: 切回 zh 文案逐字节一致',
      rootEl.querySelector('.ddc-sub').textContent === '判定链账本 · 实时录制与回放'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-tag').textContent === '读取'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-title').textContent === '读取 C:/a.txt'
      && rootEl.querySelector('.ddc-stream .ddc-ev .ddc-detail').textContent === '等 2 个路径'
      && rootEl.querySelector('.ddc-stream-meta').textContent === '共 1 条'
      && rootEl.querySelector('.ddc-lang').textContent === 'EN'
      && langStore.get('ddc-lang') === 'zh',
      JSON.stringify({ sub: rootEl.querySelector('.ddc-sub').textContent, lang: langStore.get('ddc-lang') }));

    // 持久化生效：localStorage 里存过 en，重新 import 模块（模拟页面刷新）直接落英文
    langStore.set('ddc-lang', 'en');
    const fresh = await import('../src/client/dashcam-panel.js?persistence-check');
    const panel2 = fresh.createDashcamPanel({ onClose() {} });
    check('i18n: localStorage 持久化生效（重挂载直接英文）',
      panel2.el.querySelector('.ddc-sub').textContent === 'Judgment ledger · live recording & replay'
      && [...panel2.el.querySelectorAll('.ddc-tab')].map((b) => b.textContent).join('|') === 'Live|Replay|History',
      JSON.stringify([...panel2.el.querySelectorAll('.ddc-tab')].map((b) => b.textContent)));

    // ---------- 2.2.0：实时流会话分组 + 日期分隔 + 分类 chip + 搜索渲染 ----------
    // 记录形状与 sanitizeRecord 输出一致（session 字段为 2.2.0 归属）。
    const mkEv = (seq, ts, session, type, titleKey, target) => ({
      seq, ts, session, type, titleKey, titleVars: { target }, titleText: type,
      detailParts: [], denied: false, intercepted: false,
    });
    const day2 = '2026-11-12T09:00:00.000Z';
    const day3 = '2026-11-13T10:00:00.000Z';
    panel2.updateLive(null, [
      mkEv(1, '2026-11-11T08:00:00.000Z', 'win-a', 'read', 'ev.read', 'C:/a.txt'),
      mkEv(2, '2026-11-11T08:01:00.000Z', 'win-a', 'edit', 'ev.edit', 'C:/a.txt'),
      mkEv(3, day2, 'win-a', 'bash', 'ev.command', 'git status'),
      mkEv(4, day2, null, 'think', 'ev.inbound'),
      mkEv(5, day3, 'win-b', 'net', 'ev.net', 'registry.npmjs.org'),
    ]);
    const groupHeads = [...panel2.el.querySelectorAll('.ddc-stream .ddc-ghead .ddc-gt')].map((n) => n.textContent);
    const dateSeps = [...panel2.el.querySelectorAll('.ddc-stream .ddc-dsep')].map((n) => n.textContent);
    check('group: 连续同会话聚一组，无归属归系统组（en pack）',
      groupHeads.length === 3 && groupHeads[0] === 'Session win-b' && groupHeads.includes('System') && groupHeads.includes('Session win-a'),
      JSON.stringify(groupHeads));
    check('group: 跨天插日期分隔条（组内 11-11 → 11-12）', dateSeps.some((d) => d.includes('11')) && dateSeps.length >= 2, JSON.stringify(dateSeps));
    check('group: 流仍按时间升序展示（新在上）',
      [...panel2.el.querySelectorAll('.ddc-stream .ddc-ev .ddc-title')].map((n) => n.textContent)[0].length > 0
      && panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 5,
      String(panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length));

    // 会话目录注入后，组头从「Session win-a」换成真实窗口标题
    panel2.updateSessionDirectory(new Map([['win-a', '调试窗口'], ['win-b', null]]));
    const heads2 = [...panel2.el.querySelectorAll('.ddc-stream .ddc-ghead .ddc-gt')].map((n) => n.textContent);
    check('group: 目录标题注入（win-a → 窗口标题；win-b 无标题降级 id8）',
      heads2.includes('调试窗口') && heads2.some((h) => h.includes('win-b')), JSON.stringify(heads2));

    // 分类 chip：选「Command」只留 bash；「Intercepted only」不影响无 deny 数据（空）
    const cmdChip = panel2.el.querySelector('.ddc-chip[data-ddc-lf="bash"]');
    cmdChip.click();
    const titlesAfterChip = [...panel2.el.querySelectorAll('.ddc-stream .ddc-ev .ddc-title')].map((n) => n.textContent);
    check('chip: 类型过滤（bash 1 条，组头保留）',
      panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 1 && titlesAfterChip[0] === 'Command git status',
      JSON.stringify(titlesAfterChip));
    panel2.el.querySelector('.ddc-chip[data-ddc-lf="all"]').click();
    check('chip: 全部复位', panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 5,
      String(panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length));

    // 会话/日期 chip 行：从 state.live 派生、新→旧、点击过滤（与事件分类同款交互）
    const sessChips0 = [...panel2.el.querySelectorAll('.ddc-dynchips[data-ddc-dyn="session"] .ddc-chip')];
    const dateChips = [...panel2.el.querySelectorAll('.ddc-dynchips[data-ddc-dyn="date"] .ddc-chip')];
    check('dyn chips: 会话行 3 个（目录标题已注入）+ 日期行 3 个',
      sessChips0.length === 3 && sessChips0.map((c) => c.textContent).join('|') === 'Session win-b|System|调试窗口'
      && dateChips.length === 3,
      JSON.stringify({ s: sessChips0.map((c) => c.textContent), d: dateChips.map((c) => c.textContent) }));
    sessChips0[2].click(); // 选中「调试窗口」
    const afterSess = panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length;
    const sessChipOn = [...panel2.el.querySelectorAll('.ddc-dynchips[data-ddc-dyn="session"] .ddc-chip')]
      .filter((c) => c.classList.contains('on')).length;
    check('dyn chips: 点会话 chip 只留该窗口 3 条且高亮',
      afterSess === 3 && sessChipOn === 1,
      JSON.stringify({ n: afterSess, on: sessChipOn }));
    // 过滤到只剩一个窗口时，其他 chip 仍在（chip 派生自未过滤集合）
    const still3 = panel2.el.querySelectorAll('.ddc-dynchips[data-ddc-dyn="session"] .ddc-chip').length;
    check('dyn chips: 过滤中其余会话 chip 仍可见', still3 === 3, String(still3));
    const sessChips = [...panel2.el.querySelectorAll('.ddc-dynchips[data-ddc-dyn="session"] .ddc-chip')];
    sessChips[2].click(); // 再点取消
    check('dyn chips: 再点取消恢复 5 条', panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 5,
      String(panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length));
    dateChips[0].click(); // 最新日期（Nov 13）只有 1 条
    const afterDate = panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length;
    check('dyn chips: 点日期 chip 过滤对应日期（1 条）', afterDate === 1, String(afterDate));
    panel2.el.querySelector('.ddc-chip[data-ddc-lf="all"]').click();
    check('dyn chips: 「全部」同时复位会话与日期',
      panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 5
      && [...panel2.el.querySelectorAll('.ddc-dynchips .ddc-chip')].filter((c) => c.classList.contains('on')).length === 0,
      String([...panel2.el.querySelectorAll('.ddc-dynchips .ddc-chip')].filter((c) => c.classList.contains('on')).length));

    // 搜索结果三层分组：窗口 → 日期 → 类型；接管流容器，新事件不冲掉结果
    panel2.showLiveSearch({
      ok: true, query: 'git', total: 2, truncated: false,
      records: [mkEv(3, day2, 'win-a', 'bash', 'ev.command', 'git status'), mkEv(6, day2, 'win-a', 'bash', 'ev.command', 'git push')],
    });
    check('search: 结果接管流容器（2 条 + 计数文案）',
      panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 2
      && panel2.el.querySelector('.ddc-stream-meta').textContent.includes('2'),
      panel2.el.querySelector('.ddc-stream-meta').textContent);
    panel2.updateLive(null, [mkEv(7, day3, 'win-b', 'net', 'ev.net', 'example.org')]);
    check('search: 搜索期间新事件只进 state 不动结果',
      panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 2, 'live update during search');
    // 清空搜索框 → 恢复事件流（含搜索期间收到的那条）
    const lsearch = panel2.el.querySelector('.ddc-lsearch');
    lsearch.value = '';
    lsearch.listeners.input.forEach((fn) => fn());
    check('search: 清空恢复事件流（6 条）',
      panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length === 6,
      String(panel2.el.querySelectorAll('.ddc-stream .ddc-ev').length));

    // 回放静默补齐：prepend 不重复、时间轴重排
    panel2.startReplay({ id: 'S-1', started: day2, from: 1, to: 3, events: 3, errors: 0, duration: 120, status: 'recording' }, [
      mkEv(2, day2, 'win-a', 'bash', 'ev.command', 'git status'),
      mkEv(3, day3, 'win-a', 'net', 'ev.net', 'registry.npmjs.org'),
    ]);
    const added = panel2.prependReplayEvents([mkEv(1, '2026-11-12T08:30:00.000Z', 'win-a', 'read', 'ev.read', 'C:/a.txt')]);
    check('replay: 补齐 1 条且去重', added === 1 && panel2.prependReplayEvents([mkEv(1, '2026-11-12T08:30:00.000Z', 'win-a', 'read', 'ev.read', 'C:/a.txt')]) === 0,
      String(added));
    check('replay: 事件升序 + 时间轴跨度更新',
      [...panel2.el.querySelectorAll('.ddc-evlist .ddc-ev')].length === 3, 'events merged');

    panel2.dispose();
    panel.dispose();
    langStore.delete('ddc-lang');
  } finally {
    // 还原全局 stub，避免影响同进程其他断言
    const restore = (name, prev) => {
      try {
        if (prev === undefined) delete globalThis[name];
        else Object.defineProperty(globalThis, name, { value: prev, configurable: true });
      } catch { /* Node 内建 getter 不可重定义时忽略 */ }
    };
    restore('document', prevDocument);
    restore('localStorage', prevLocalStorage);
    restore('ResizeObserver', prevRO);
    restore('requestAnimationFrame', prevRaf);
    restore('cancelAnimationFrame', prevCaf);
    restore('getComputedStyle', prevGCS);
    restore('navigator', prevNavigator);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
