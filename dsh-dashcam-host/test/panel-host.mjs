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
  check('sanitize: fs.read → type read + 路径标题', read.type === 'read' && /^读取 C:\/a\.txt/.test(read.title), JSON.stringify(read));
  check('sanitize: 多路径 detail', read.detail === '等 2 个路径', read.detail);

  const request = sanitizeRecord(rec(2, '2026-11-09T01:00:01.000Z', 'llm.ingress', 'llm.request', {
    ruleId: 'ingress-request',
    scope: {
      model: 'deepseek-chat', sessionId: 'session-x',
      messages: { count: 12, delta: { added: 3, removed: 1 } },
      sample: [{ role: 'system', head: 'SECRET HEAD' }],
    },
  }));
  const flat = JSON.stringify(request);
  check('sanitize: llm.request → think + 计数 detail', request.type === 'think' && request.detail.includes('deepseek-chat') && request.detail.includes('12 条消息'), request.detail);
  check('sanitize: sample（消息 head 样本）不透出', !flat.includes('SECRET HEAD') && !flat.includes('sample'), flat);
  check('sanitize: 哈希链字段不透出', !flat.includes('deadbeef') && !flat.includes('feedface'), flat);

  const inbound = sanitizeRecord(rec(3, '2026-11-09T01:00:02.000Z', 'llm.ingress', 'llm.inbound', {
    ruleId: 'ingress-inbound', scope: { kind: 'user', len: 34, head: 'x'.repeat(200), sessionId: 'session-x' },
  }));
  check('sanitize: llm.inbound head 截断到 48 字', inbound.detail.includes('x'.repeat(48)) && !inbound.detail.includes('x'.repeat(49)), inbound.detail);

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
  check('sanitize: mount → 模式 detail', mount.type === 'tel' && mount.detail === '模式 advisory', JSON.stringify(mount));
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
  check('routes: 三条路由注册', ws.routes.length === 3, String(ws.routes.length));

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
    check('records: 脱敏形状（type/title，无 hash/scope.sample）', body.records[0].type === 'edit' && /^编辑 /.test(body.records[0].title) && !res.body.includes('deadbeef'), res.body);
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
  check('apply: ctx.inject 路径下路由挂载', ws.routes.length === 3, String(ws.routes.length));
  for (const fn of effects) {
    try { const cleanup = fn(); if (typeof cleanup === 'function') cleanup(); } catch {}
  }
  check('apply: 卸载后路由清空', ws.routes.length === 0, String(ws.routes.length));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
