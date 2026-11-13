#!/usr/bin/env node
// 生成 README / 插件页的演示动图。
//
// 做法：先合成一份**假账本**（docs/screenshots/demo-ledger.jsonl），再用仓库里
// **真实的**面板代码（dashcam-css.js + dashcam-panel.js，拼装规则与 build.mjs
// 一致）在 Edge headless 里渲染，逐帧截图，最后用 ffmpeg 编成 GIF。
//
// 假数据是这套图的前提：截图里的事件、路径、命令都不是任何人的真实会话。
// 每张图左下角都标了「DEMO · 模拟账本」，README 里也有一行说明。
//
// 用法：
//   node tools/screenshots/make-demo-shots.mjs     # 全流程（要 Edge + ffmpeg）
//   node tools/screenshots/make-demo-shots.mjs --html-only
//   node tools/screenshots/make-demo-shots.mjs --encode-only
//
// 注意：截图必须在**不受 DSH 文件沙箱限制**的终端里跑——Chromium 多进程要开
// 命名管道，沙箱里起不来（mojo platform_channel 会 0x5 拒绝访问）。

import { spawn } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const BUILD = join(ROOT, '.build', 'shots');
const OUT = join(ROOT, 'docs', 'screenshots');
const HTML_PATH = join(BUILD, 'demo.html');
const LEDGER_PATH = join(OUT, 'demo-ledger.jsonl');

// 1028×816 让面板正好是 980×720（CSS 里是 min(980px, 100vw-48px) 这类写法）。
const VIEWPORT = { width: 1028, height: 816 };
const DEMO_NOW = Date.parse('2026-11-13T11:24:00+08:00');

const { clusterSessions, computeStatus, sanitizeRecord } = await import(
  pathToFileURL(join(ROOT, 'dsh-dashcam-host', 'lib', 'panel.js')).href
);

// ---------------------------------------------------------------- 假账本

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const READ_PATHS = [
  'src/runtime/guards.js',
  'src/contract/two-key.js',
  'src/runtime/ingress.js',
  'dsh-dashcam-host/src/client/dashcam-panel.js',
  'dsh-dashcam-host/src/client/dashcam-css.js',
  'test/attack-surface.test.js',
  'test/ledger-chain.test.js',
  'docs/SPEC.md',
  'README.md',
];
const WRITE_PATHS = [
  'dsh-dashcam-host/src/client/dashcam-panel.js',
  'dsh-dashcam-host/src/client/dashcam-css.js',
  'README.md',
  'README.zh-CN.md',
  'docs/SPEC.md',
  'test/panel.test.js',
  'examples/quick-start.js',
];
const COMMANDS = [
  'pnpm test',
  'node --test test/attack-surface.test.js',
  'node --test test/ledger-chain.test.js',
  'git status --short',
  'git diff --stat',
  'pnpm run build',
  'node examples/quick-start.js',
];
const HOSTS = ['api.deepseek.com', 'registry.npmjs.org', 'api.github.com'];
const TOOLS = ['mcp__github__get_file_contents', 'mcp__browser__open', 'subagent_scan'];
const HEADS = [
  '把面板里的拒绝事件标红',
  'README 首屏能不能压短一点',
  '这个规则命中之后会不会漏记账',
  '帮我看下 test 为什么挂在 CI 上',
  '把账本路径写进面板状态里',
];

const iso = (baseMs, offsetSec) => new Date(baseMs + offsetSec * 1000).toISOString();

let SEQ = 104;

function record(ts, capability, action, scope, extra = {}) {
  return {
    v: 4,
    seq: SEQ++,
    ts,
    plugin: 'dsh-demo-tools',
    pluginVersion: '0.4.2',
    capability,
    action,
    scope,
    decision: extra.decision || 'allow',
    ruleId: extra.ruleId || '',
    reason: extra.reason || null,
    profiled: true,
    manifestHash: 'sha256:9f2c41d0b7a8' + String(SEQ).padStart(4, '0'),
    intercepted: extra.intercepted === true,
  };
}

const mount = (t) => record(t, 'telemetry', 'mount', { mode: 'advisory' }, { ruleId: 'mount' });
const read = (t, path, extra) => record(t, extra && extra.cred ? 'cred.read' : 'fs.read', 'fs.read', { paths: [path] }, extra);
const write = (t, path) => record(t, 'fs.write', 'fs.write', { paths: [path] });
const bash = (t, command) => record(t, 'proc.spawn', 'proc.spawn', { commands: [command] });
const commandLine = (t, command) => record(t, 'telemetry', 'proc.commandline', { commandLine: command }, { ruleId: 'commandline-audit' });
const net = (t, host) => record(t, 'net.outbound', 'net.outbound', { hosts: [host] });
const request = (t, count, added, removed, sessionId) => record(t, 'llm.ingress', 'llm.request', {
  sessionId,
  model: 'deepseek-chat',
  messages: { count, delta: { added, removed } },
});
const inbound = (t, head, sessionId) => record(t, 'llm.ingress', 'llm.inbound', {
  sessionId,
  kind: 'user',
  len: head.length,
  head,
});
const anomaly = (t, kind, sessionId) => record(t, 'llm.ingress', 'llm.anomaly', { sessionId, kind, count: 1 }, { ruleId: 'ingress-anomaly' });
const unmapped = (t, tool) => record(t, 'telemetry', 'unmapped-tool', { tool });

// 特色会话：11-13 上午，手工编排成「改面板 → 跑测试 → 顺手改 README」的一条线，
// 末尾带一次凭证路径的旁路拒绝和一条入站异常。截图的主场。
function featuredSession() {
  // 会话贴着 DEMO_NOW 收尾，面板里的「刚刚 / 秒前」才说得通
  const base = DEMO_NOW - (8 * 60 + 50) * 1000;
  const sid = '01JCE7F3X2';
  const rows = [
    mount(iso(base, 0)),
    inbound(iso(base, 12), '把面板里的拒绝事件标红', sid),
    request(iso(base, 18), 12, 2, 0, sid),
    read(iso(base, 26), 'dsh-dashcam-host/src/client/dashcam-panel.js'),
    read(iso(base, 41), 'dsh-dashcam-host/src/client/dashcam-css.js'),
    request(iso(base, 63), 15, 1, 0, sid),
    write(iso(base, 80), 'dsh-dashcam-host/src/client/dashcam-panel.js'),
    bash(iso(base, 112), 'pnpm test'),
    read(iso(base, 130), 'test/panel.test.js'),
    write(iso(base, 154), 'test/panel.test.js'),
    bash(iso(base, 182), 'node --test test/panel.test.js'),
    request(iso(base, 211), 19, 3, 1, sid),
    net(iso(base, 213), 'api.deepseek.com'),
    read(iso(base, 242), 'README.md'),
    write(iso(base, 280), 'README.md'),
    bash(iso(base, 311), 'git diff --stat'),
    commandLine(iso(base, 312), 'git diff --stat'),
    inbound(iso(base, 340), '顺手把首屏也压短一点', sid),
    read(iso(base, 365), 'C:/Users/dev/.aws/credentials', {
      cred: true,
      decision: 'deny',
      ruleId: 'scope_mismatch',
      reason: '授予存在但不覆盖请求范围：cred.read (paths: C:/Users/dev/.aws/credentials)',
    }),
    read(iso(base, 380), 'docs/SPEC.md'),
    request(iso(base, 404), 24, 5, 2, sid),
    write(iso(base, 422), 'docs/SPEC.md'),
    unmapped(iso(base, 441), 'mcp__github__get_file_contents'),
    anomaly(iso(base, 458), 'inbound_changed', sid),
    bash(iso(base, 478), 'pnpm test'),
    request(iso(base, 500), 27, 1, 0, sid),
  ];
  return { records: rows, startedAt: base };
}

// 其余会话：同一种「读 → 改 → 跑测试」的节奏，随机但可复现。
function randomSession({ start, minutes, count, seed }) {
  const rand = mulberry32(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const base = Date.parse(start);
  const total = minutes * 60;
  const sid = '01JC' + String(seed).padStart(6, '0');
  const rows = [mount(iso(base, 0))];
  let at = 4 + Math.floor(rand() * 10);
  for (let i = 1; i < count - 1; i += 1) {
    at += 4 + Math.floor(rand() * 26);
    if (at > total) break;
    const roll = rand();
    let rec;
    if (roll < 0.3) rec = read(iso(base, at), pick(READ_PATHS));
    else if (roll < 0.52) rec = write(iso(base, at), pick(WRITE_PATHS));
    else if (roll < 0.68) rec = bash(iso(base, at), pick(COMMANDS));
    else if (roll < 0.82) rec = request(iso(base, at), 8 + Math.floor(rand() * 30), Math.floor(rand() * 6), Math.floor(rand() * 3), sid);
    else if (roll < 0.9) rec = net(iso(base, at), pick(HOSTS));
    else if (roll < 0.95) rec = unmapped(iso(base, at), pick(TOOLS));
    else rec = inbound(iso(base, at), pick(HEADS), sid);
    rows.push(rec);
    // 真实账本里 proc.spawn 后面常跟一条命令行存档，这里照抄这个节奏
    if (rec.action === 'proc.spawn' && rand() < 0.5) {
      rows.push(commandLine(iso(base, at + 1), rec.scope.commands[0]));
    }
  }
  rows.push(request(iso(base, Math.min(total, at + 12)), 12 + rows.length, 1, 0, sid));
  return { records: rows, startedAt: base };
}

function buildLedger() {
  const featured = featuredSession();
  const others = [
    randomSession({ start: '2026-11-13T08:12:00+08:00', minutes: 7, count: 34, seed: 1013 }),
    randomSession({ start: '2026-11-12T21:36:00+08:00', minutes: 17, count: 58, seed: 1012 }),
    randomSession({ start: '2026-11-12T15:02:00+08:00', minutes: 3, count: 12, seed: 1011 }),
    randomSession({ start: '2026-11-11T23:18:00+08:00', minutes: 12, count: 44, seed: 1010 }),
    randomSession({ start: '2026-11-11T19:40:00+08:00', minutes: 6, count: 21, seed: 1009 }),
    randomSession({ start: '2026-11-10T22:05:00+08:00', minutes: 21, count: 73, seed: 1008 }),
    randomSession({ start: '2026-11-09T20:31:00+08:00', minutes: 8, count: 30, seed: 1007 }),
    randomSession({ start: '2026-11-08T21:12:00+08:00', minutes: 7, count: 26, seed: 1006 }),
    randomSession({ start: '2026-11-07T22:48:00+08:00', minutes: 5, count: 18, seed: 1005 }),
    randomSession({ start: '2026-11-06T19:55:00+08:00', minutes: 2, count: 9, seed: 1004 }),
    randomSession({ start: '2026-11-06T14:20:00+08:00', minutes: 4, count: 15, seed: 1003 }),
  ];
  const all = [];
  for (const session of others) all.push(...session.records);
  all.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts));
  all.push(...featured.records);
  all.forEach((rec, index) => { rec.seq = 104 + index; });
  return { all, featured };
}

// ---------------------------------------------------------------- 组装数据

function buildFixture() {
  const { all, featured } = buildLedger();
  const sessions = clusterSessions(all, DEMO_NOW);
  const bySession = new Map();
  for (const session of sessions) {
    const rows = all.filter((rec) => rec.seq >= session.from && rec.seq <= session.to);
    bySession.set(session.id, rows.map(sanitizeRecord).filter(Boolean));
  }
  const featuredRows = featured.records.map(sanitizeRecord).filter(Boolean);
  // 每条状态都按「前 N 条」重算，这样直播视图的计数器随事件流一起长。
  const statuses = featuredRows.map((_, index) => computeStatus(featured.records.slice(0, index + 1), {
    version: '2.0.3',
    ledgerPath: 'C:\\Users\\dev\\.dsh\\dsh-dashcam\\ledger.jsonl',
  }));
  const featuredRow = sessions.find((session) => session.from === featured.records[0].seq);
  return {
    ledgerText: all.map((rec) => JSON.stringify(rec)).join('\n') + '\n',
    fixture: {
      live: { records: featuredRows, statuses, preload: 12, stepMs: 380, elapsedSec: 8 * 60 + 41 },
      replay: { session: sessions[1], records: bySession.get(sessions[1].id) || [] },
      history: { sessions },
      featured: featuredRow,
      records: Object.fromEntries(bySession),
    },
  };
}

// ---------------------------------------------------------------- 页面

function toBody(file) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  return source
    .split('\n')
    .filter((line) => !/^import\s/.test(line))
    .join('\n')
    .replace(/^export\s+(?=(const|function|class))/gm, '');
}

function buildHtml(fixture) {
  const inline = JSON.stringify(fixture).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-dashcam demo</title>
<style>
  html, body { margin: 0; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; overflow: hidden; }
  body {
    background:
      radial-gradient(1200px 700px at 78% 12%, rgba(217,83,79,.10), transparent 60%),
      radial-gradient(900px 600px at 12% 88%, rgba(64,120,255,.10), transparent 65%),
      #05060a;
  }
  .ddc-demo-flag {
    position: fixed; left: 26px; top: 20px;
    font: 500 11px/1.6 ui-monospace, "Cascadia Mono", monospace;
    letter-spacing: .14em; text-transform: uppercase;
    color: rgba(242,242,245,.30);
  }
  .ddc-demo-flag b { color: rgba(242,242,245,.52); font-weight: 600; }
</style>
</head>
<body>
<div class="ddc-demo-flag">DEMO · <b>模拟账本</b><br>not a real session</div>
<script>
(function () {
  var t0 = ${DEMO_NOW};
  var p0 = performance.now();
  var R = Date;
  function F() {
    if (arguments.length) return new R(...arguments);
    return new R(t0 + (performance.now() - p0));
  }
  F.now = function () { return t0 + (performance.now() - p0); };
  F.parse = R.parse;
  F.UTC = R.UTC;
  F.prototype = R.prototype;
  window.Date = F;
})();
</script>
<script>window.__DEMO__ = ${inline};</script>
<script>
${toBody('dsh-dashcam-host/src/client/dashcam-css.js')}
</script>
<script>
${toBody('dsh-dashcam-host/src/client/dashcam-panel.js')}
</script>
<script>
(function () {
  var fx = window.__DEMO__;
  var view = new URLSearchParams(location.search).get('view') || 'live';
  var style = document.createElement('style');
  style.textContent = DASHCAM_CSS;
  document.head.appendChild(style);

  var panel = createDashcamPanel({
    api: {
      loadSession: function (session) {
        panel.startReplay(session, fx.records[session.id] || [], false);
        setTimeout(function () {
          var speed = panel.el.querySelector('.ddc-spd[data-ddc-spd="60"]');
          if (speed) speed.click();
          var play = panel.el.querySelector('.ddc-play');
          if (play) play.click();
        }, 500);
      },
    },
    onClose: function () {},
  });
  document.body.appendChild(panel.el);
  panel.el.style.display = 'flex'; // 真机是 flex：换成 block 会把 .ddc-root 的列布局压扁

  requestAnimationFrame(function () {
    requestAnimationFrame(function () { window.__DEMO_READY__ = true; });
  });

  if (view === 'live') {
    var live = fx.live;
    // 运行时长按「打开页面时已经跑了 8 分 41 秒」算，否则会显示成真实时钟差。
    var startedAt = new Date(Date.now() - live.elapsedSec * 1000).toISOString();
    for (var k = 0; k < live.statuses.length; k += 1) live.statuses[k].startedAt = startedAt;
    var preload = live.preload;
    panel.updateLive(live.statuses[preload - 1], live.records.slice(0, preload));
    panel.tickClock(true);
    var i = preload;
    var t0 = performance.now();
    (function tick() {
      var due = preload + Math.floor((performance.now() - t0) / live.stepMs);
      while (i < Math.min(due, live.records.length)) {
        panel.updateLive(live.statuses[i], [live.records[i]]);
        i += 1;
      }
      panel.tickClock(true);
      if (i < live.records.length) requestAnimationFrame(tick);
    })();
  } else if (view === 'replay') {
    panel.startReplay(fx.replay.session, fx.replay.records, false);
    setTimeout(function () {
      var speed = panel.el.querySelector('.ddc-spd[data-ddc-spd="60"]');
      if (speed) speed.click();
      var play = panel.el.querySelector('.ddc-play');
      if (play) play.click();
    }, 600);
  } else if (view === 'history') {
    panel.showHistory(fx.history.sessions);
    panel.setView('history');
    var chips = panel.el.querySelectorAll('.ddc-chip');
    setTimeout(function () { if (chips[1]) chips[1].click(); }, 900);
    setTimeout(function () { if (chips[0]) chips[0].click(); }, 2100);
  }
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- CDP 截图

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function httpJson(url) {
  return new Promise((resolvePromise, reject) => {
    httpGet(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolvePromise(JSON.parse(data)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function launchEdge(port, profileDir, url) {
  const edge = process.env.EDGE_PATH
    || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const child = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=2',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    url,
  ], { stdio: 'ignore' });
  for (let i = 0; i < 80; i += 1) {
    await sleep(150);
    try {
      const targets = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return { child, wsUrl: page.webSocketDebuggerUrl };
    } catch {
      // 还没起来
    }
  }
  child.kill();
  throw new Error('Edge 调试端口没起来（在 DSH 文件沙箱里 Chromium 起不来时也会这样）');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolvePromise, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolvePromise(msg.result);
    }
  });
  const opened = new Promise((resolvePromise, reject) => {
    ws.addEventListener('open', resolvePromise);
    ws.addEventListener('error', reject);
  });
  return {
    opened,
    send(method, params = {}) {
      const id = (nextId += 1);
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolvePromise, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

async function capture(view, framesDir, { durationMs, fpsCap }) {
  const profile = join(BUILD, `edge-profile-${view}`);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Edge 收尾还没放开 */ }
  mkdirSync(profile, { recursive: true });
  try { rmSync(framesDir, { recursive: true, force: true }); } catch { /* 旧帧清不掉就重新建 */ }
  mkdirSync(framesDir, { recursive: true });
  const url = `file:///${HTML_PATH.replace(/\\/g, '/')}?view=${view}`;
  const { child, wsUrl } = await launchEdge(9400 + Math.floor(Math.random() * 40), profile, url);
  try {
    const client = cdp(wsUrl);
    await client.opened;
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1.5,
      mobile: false,
    });
    const box = await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({w:innerWidth,h:innerHeight,r:document.querySelector(".ddc-root").getBoundingClientRect().toJSON()})',
      returnByValue: true,
    });
    console.log(`[viewport] ${box.result.value}`);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      const res = await client.send('Runtime.evaluate', { expression: 'window.__DEMO_READY__ === true', returnByValue: true });
      ready = Boolean(res.result && res.result.value === true);
      if (!ready) await sleep(120);
    }
    if (!ready) throw new Error('演示页没准备好');

    const timing = [];
    const start = performance.now();
    let index = 0;
    const minGap = 1000 / fpsCap;
    while (performance.now() - start < durationMs) {
      const shot = await client.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 90,
        captureBeyondViewport: false,
      });
      const at = performance.now() - start;
      const name = String(index).padStart(4, '0') + '.jpg';
      writeFileSync(join(framesDir, name), Buffer.from(shot.data, 'base64'));
      timing.push({ name, at });
      index += 1;
      const wait = minGap - (performance.now() - start - at);
      if (wait > 0) await sleep(wait);
    }
    writeFileSync(join(framesDir, 'timing.json'), JSON.stringify(timing, null, 2));
    console.log(`[capture] ${view}: ${index} 帧，约 ${(index / (durationMs / 1000)).toFixed(1)} fps`);
  } finally {
    child.kill();
    await sleep(900);
  }
}

// ---------------------------------------------------------------- 编码

function run(cmd, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} 退出码 ${code}`))));
  });
}

async function encode(framesDir, outFile) {
  const timing = JSON.parse(readFileSync(join(framesDir, 'timing.json'), 'utf8'));
  const lines = [];
  for (let i = 0; i < timing.length; i += 1) {
    const next = timing[i + 1] ? timing[i + 1].at : timing[i].at + 1000 / 8;
    // 采样率低于真实时间，按 6–14 帧/秒重排，播放速度快约 2–3 倍但顺滑
    const duration = Math.min(0.14, Math.max(0.07, (next - timing[i].at) / 1000));
    lines.push(`file '${timing[i].name}'`);
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  lines.push(`file '${timing[timing.length - 1].name}'`);
  writeFileSync(join(framesDir, 'list.txt'), lines.join('\n') + '\n');
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', join(framesDir, 'list.txt'),
    '-fps_mode', 'passthrough',
    '-vf', 'scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=224:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
    '-loop', '0',
    outFile,
  ]);
  const size = readFileSync(outFile).length;
  console.log(`[encode] ${outFile.replace(ROOT + '\\', '')} (${(size / 1024 / 1024).toFixed(2)} MB)`);
}

// ---------------------------------------------------------------- main

const args = new Set(process.argv.slice(2));

async function main() {
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  if (!args.has('--encode-only')) {
    const { ledgerText, fixture } = buildFixture();
    writeFileSync(LEDGER_PATH, ledgerText);
    writeFileSync(HTML_PATH, buildHtml(fixture));
    console.log(`[fixture] ${ledgerText.trim().split('\n').length} 条记录 → docs/screenshots/demo-ledger.jsonl`);
    console.log(`[html] ${HTML_PATH.replace(ROOT + '\\', '')}`);
  }

  if (args.has('--html-only')) return;

  if (!args.has('--encode-only')) {
    await capture('live', join(BUILD, 'frames', 'live'), { durationMs: 9600, fpsCap: 30 });
    await capture('replay', join(BUILD, 'frames', 'replay'), { durationMs: 11000, fpsCap: 30 });
    await capture('history', join(BUILD, 'frames', 'history'), { durationMs: 5200, fpsCap: 30 });
  }

  await encode(join(BUILD, 'frames', 'live'), join(OUT, 'live.gif'));
  await encode(join(BUILD, 'frames', 'replay'), join(OUT, 'replay.gif'));
  await encode(join(BUILD, 'frames', 'history'), join(OUT, 'history.gif'));
}

main().catch((error) => {
  console.error('[demo-shots] 失败：', error.message);
  process.exit(1);
});
