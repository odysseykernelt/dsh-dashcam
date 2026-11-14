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
//   node tools/screenshots/make-demo-shots.mjs --lang=en   # 英文版，输出 *.en.gif
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

// 语言：`--lang=en` 出英文版，文件名带 .en 后缀，不覆盖中文那组。
// 面板文案自带 zh/en 双语，演示页只需要把 ddc-lang 钉成对应语言，
// 再把 <html lang> 和左下角的 DEMO 标记一起换掉。
const LANG_ARG = process.argv.slice(2).find((arg) => arg.startsWith('--lang='));
const LANG = (LANG_ARG ? LANG_ARG.slice('--lang='.length).trim() : 'zh') === 'en' ? 'en' : 'zh';
const LANG_SUFFIX = LANG === 'en' ? '.en' : '';
const HTML_PATH = join(BUILD, `demo${LANG_SUFFIX}.html`);
const LEDGER_PATH = join(OUT, 'demo-ledger.jsonl');

// 1028×816 让面板正好是 980×720（CSS 里是 min(980px, 100vw-48px) 这类写法）。
const VIEWPORT = { width: 1028, height: 816 };
// 抓帧像素密度：1.5 更清晰，但每帧要 300–400ms，GIF 只有 2–3fps，动效会跳。
// 1.0 能到 8–10fps；缩到 900px 宽后文字略软，动图里连贯更值钱。
const DPR = Number(process.env.SHOT_DPR || 1);
const SHOT_QUALITY = Number(process.env.SHOT_QUALITY || 88);
const DEMO_NOW = Date.parse('2026-11-13T19:42:00+08:00');

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
// 英文版截图里的对话内容也得是英文，否则中文碎句会漏进英文界面。
const M = (zh, en) => (LANG === 'en' ? en : zh);

const HEADS = [
  M('把面板里的拒绝事件标红', 'mark denied events red in the panel'),
  M('README 首屏能不能压短一点', 'can the README hero be shorter'),
  M('这个规则命中之后会不会漏记账', 'does this rule miss ledger entries'),
  M('帮我看下 test 为什么挂在 CI 上', 'why do the tests fail on CI'),
  M('把账本路径写进面板状态里', 'put the ledger path in the panel status'),
];

const iso = (baseMs, offsetSec) => new Date(baseMs + offsetSec * 1000).toISOString();

let SEQ = 104;

// 2.2.0 的实时流按「对话窗口」分组：账本 v4 的 session 字段（tools/pre-execute
// 落账）或 scope.sessionId（ingress 自带）。withSession() 给一段记录打上当前窗口，
// 这样一次截图里能同时出现三个窗口的标题。
let CURRENT_SESSION = null;
function withSession(sid, fn) {
  const previous = CURRENT_SESSION;
  CURRENT_SESSION = sid;
  try { fn(); } finally { CURRENT_SESSION = previous; }
}

function record(ts, capability, action, scope, extra = {}) {
  return {
    v: 4,
    seq: SEQ++,
    ts,
    ...(CURRENT_SESSION ? { session: CURRENT_SESSION } : {}),
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

// 三个「对话窗口」同时在动：2.2.0 的实时流按窗口分组，标题来自 /sessions 目录。
const S_MAIN = '01JCE7F3X2'; // 面板 2.2.0：分组与筛选
const S_DOCS = '01JCF8Q2N4'; // README 首屏改版
const S_REL = '01JCG3M1K7'; // release v2.2.0 打包

// 特色会话：11-13 晚上，手工编排成「改面板 → 改 README → 打包 → 跑测试」的一条线，
// 中间夹一次凭证路径的旁路拒绝和一条入站异常，另有两个窗口插进来。截图的主场。
function featuredSession() {
  // 会话贴着 DEMO_NOW 收尾，面板里的「刚刚 / 秒前」才说得通
  const base = DEMO_NOW - (8 * 60 + 50) * 1000;
  const rows = [];

  // mount 是宿主启动事件，不属于任何对话窗口——面板归到「系统」组。
  rows.push(mount(iso(base, 0)));

  withSession(S_MAIN, () => {
    rows.push(
      inbound(iso(base, 12), M('把面板里的拒绝事件标红', 'mark denied events red in the panel'), S_MAIN),
      request(iso(base, 18), 12, 2, 0, S_MAIN),
      read(iso(base, 26), 'dsh-dashcam-host/src/client/dashcam-panel.js'),
      read(iso(base, 41), 'dsh-dashcam-host/src/client/dashcam-css.js'),
      request(iso(base, 63), 15, 1, 0, S_MAIN),
      write(iso(base, 80), 'dsh-dashcam-host/src/client/dashcam-panel.js'),
      bash(iso(base, 112), 'pnpm test'),
      read(iso(base, 130), 'dsh-dashcam-host/test/panel-host.mjs'),
    );
  });

  withSession(S_DOCS, () => {
    rows.push(
      read(iso(base, 135), 'README.md'),
      write(iso(base, 150), 'README.md'),
      bash(iso(base, 162), 'git diff --stat'),
      commandLine(iso(base, 163), 'git diff --stat'),
      inbound(iso(base, 170), M('首屏加一行对比表口牙', 'add a comparison row to the hero'), S_DOCS),
    );
  });

  withSession(S_MAIN, () => {
    rows.push(
      request(iso(base, 180), 19, 3, 1, S_MAIN),
      write(iso(base, 196), 'dsh-dashcam-host/src/client/dashcam-css.js'),
      request(iso(base, 210), 22, 4, 0, S_MAIN),
      bash(iso(base, 223), 'node --test dsh-dashcam-host/test/panel-host.mjs'),
      read(iso(base, 240), 'dsh-dashcam-host/src/client/dashcam-engine.js'),
    );
  });

  withSession(S_REL, () => {
    rows.push(
      bash(iso(base, 246), 'npm pack --pack-destination .build/release'),
      commandLine(iso(base, 247), 'npm pack --pack-destination .build/release'),
      net(iso(base, 252), 'registry.npmjs.org'),
      read(iso(base, 258), 'package.json'),
      write(iso(base, 266), '.build/release/SHA256SUMS'),
    );
  });

  withSession(S_MAIN, () => {
    rows.push(
      inbound(iso(base, 275), M('顺手把拒绝那条也标红', 'also flag that denied one in red'), S_MAIN),
      read(iso(base, 286), 'C:/Users/dev/.aws/credentials', {
        cred: true,
        decision: 'deny',
        ruleId: 'scope_mismatch',
        reason: M('授予存在但不覆盖请求范围：cred.read (paths: C:/Users/dev/.aws/credentials)', 'grant exists but does not cover the requested scope: cred.read (paths: C:/Users/dev/.aws/credentials)'),
      }),
      read(iso(base, 300), 'docs/SPEC.md'),
      request(iso(base, 314), 24, 5, 2, S_MAIN),
      write(iso(base, 330), 'docs/SPEC.md'),
      unmapped(iso(base, 345), 'mcp__github__get_file_contents'),
      anomaly(iso(base, 358), 'inbound_changed', S_MAIN),
      bash(iso(base, 372), 'pnpm test'),
      inbound(iso(base, 384), M('中文那份也一起改', 'update the zh-CN one too'), S_MAIN),
      request(iso(base, 396), 27, 1, 0, S_MAIN),
      read(iso(base, 404), 'README.zh-CN.md'),
      write(iso(base, 420), 'README.zh-CN.md'),
      bash(iso(base, 445), 'git diff --stat'),
      commandLine(iso(base, 446), 'git diff --stat'),
      inbound(iso(base, 462), M('这次先不 tag，等发版再说', "don't tag this time, wait for the release"), S_MAIN),
      request(iso(base, 492), 31, 6, 3, S_MAIN),
    );
  });

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
  // 同一个窗口里跑了一整段：非 mount 的记录都归到这条会话。
  for (const rec of rows) if (rec.action !== 'mount') rec.session = sid;
  return { records: rows, startedAt: base };
}

// 会话标题：面板按 /sessions 目录把同一个窗口的记录标题出来（「系统」给 mount）。
// 这里给每条假会话一个像人话的标题，截图里才能看出「哪个窗口在动」。
const SESSION_TITLES = {
  [S_MAIN]: '面板 2.2.0：分组与筛选',
  [S_DOCS]: 'README 首屏改版',
  [S_REL]: 'release v2.2.0 打包',
  '01JC001013': '修复 live 视图滚动跳动',
  '01JC001012': 'release 说明草稿',
  '01JC001011': '快速看看测试挂了没有',
  '01JC001010': 'session 归属去重',
  '01JC001009': 'README 英文版润色',
  '01JC001008': '加一个 denied 类型过滤',
  '01JC001007': '账本轮转策略',
  '01JC001006': '插件页截图方案',
  '01JC001005': 'CI 在 Windows 上的坑',
  '01JC001004': '先看看日志',
  '01JC001003': '初始化仓库',
};

const SESSION_TITLES_EN = {
  [S_MAIN]: 'Panel 2.2.0: filters',
  [S_DOCS]: 'README hero rewrite',
  [S_REL]: 'release v2.2.0 notes',
  '01JC001013': 'Fix live view scroll jump',
  '01JC001012': 'release notes draft',
  '01JC001011': 'quick check: tests green?',
  '01JC001010': 'session attribution dedupe',
  '01JC001009': 'polish English README',
  '01JC001008': 'add a denied type filter',
  '01JC001007': 'ledger rotation policy',
  '01JC001006': 'plugin page screenshots',
  '01JC001005': 'CI quirks on Windows',
  '01JC001004': 'just look at the logs',
  '01JC001003': 'init repo',
};

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
  const sessionDirectory = { ...(LANG === 'en' ? SESSION_TITLES_EN : SESSION_TITLES) };
  return { all, featured, sessionDirectory };
}

// ---------------------------------------------------------------- 组装数据

function buildFixture() {
  const { all, featured, sessionDirectory } = buildLedger();
  const sessions = clusterSessions(all, DEMO_NOW);
  const bySession = new Map();
  for (const session of sessions) {
    const rows = all.filter((rec) => rec.seq >= session.from && rec.seq <= session.to);
    bySession.set(session.id, rows.map(sanitizeRecord).filter(Boolean));
  }
  const featuredRows = featured.records.map(sanitizeRecord).filter(Boolean);
  // 每条状态都按「前 N 条」重算，这样直播视图的计数器随事件流一起长。
  const statuses = featuredRows.map((_, index) => computeStatus(featured.records.slice(0, index + 1), {
    version: '2.2.0',
    ledgerPath: 'C:\\Users\\dev\\.dsh\\dsh-dashcam\\ledger.jsonl',
  }));
  const featuredRow = sessions.find((session) => session.from === featured.records[0].seq);
  return {
    ledgerText: all.map((rec) => JSON.stringify(rec)).join('\n') + '\n',
    fixture: {
      live: { records: featuredRows, statuses, preload: 12, stepMs: 300, elapsedSec: 8 * 60 + 41 },
      replay: { session: sessions[1], records: bySession.get(sessions[1].id) || [] },
      history: { sessions },
      featured: featuredRow,
      sessionDirectory,
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
<html lang="${LANG === 'en' ? 'en' : 'zh-CN'}">
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
<div class="ddc-demo-flag">${LANG === 'en' ? 'DEMO · <b>simulated ledger</b>' : 'DEMO · <b>模拟账本</b>'}<br>not a real session</div>
<script>
(function () {
  // 面板挑语言是先读 localStorage['ddc-lang'] 再看 navigator.language；headless 的
  // navigator 是 en-US，不先钉住中文版整块 UI 会变英文。这里按 --lang 钉死。
  try { localStorage.setItem('ddc-lang', '${LANG}'); } catch (e) {}
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
  // renderStream 每次整表重画，.ddc-ev 的入场动画会跟着重播；真机 1–3 秒一条时
  // 只是偶尔闪，假账本 0.3 秒一条就变成整块闪烁。截图里关掉入场动画，拍「稳定态」。
  style.textContent = DASHCAM_CSS + ' .ddc-ev{animation:none} .ddc-root{animation:none}';
  document.head.appendChild(style);

  function q(sel) { return panel.el.querySelector(sel); }

  var panel = createDashcamPanel({
    api: {
      loadSession: function (session) {
        panel.startReplay(session, fx.records[session.id] || [], false);
        setTimeout(function () {
          var speed = q('.ddc-spd[data-ddc-spd="60"]');
          if (speed) speed.click();
          var play = q('.ddc-play');
          if (play) play.click();
        }, 500);
      },
    },
    // 实时流搜索：真机是 engine 拿查询词去 /search，只在账本里翻；这里在假账本里翻。
    onLiveSearch: function (query) {
      if (view !== 'live') return;
      var needle = query.toLowerCase();
      var hits = [];
      for (var k = live.records.length - 1; k >= 0; k -= 1) {
        if (JSON.stringify(live.records[k]).toLowerCase().indexOf(needle) >= 0) hits.push(live.records[k]);
      }
      panel.showLiveSearch({ ok: true, query: query, records: hits, total: hits.length, truncated: false });
    },
    onClose: function () {},
  });
  document.body.appendChild(panel.el);
  // 真机打开面板是 display=''（CSS 的 .ddc-root{display:flex} 生效）；写成 block 会压扁布局。
  panel.el.style.display = '';
  panel.updateSessionDirectory(new Map(Object.entries(fx.sessionDirectory || {})));

  var live = fx.live;
  var timers = [];
  function at(ms, fn) { timers.push(setTimeout(fn, ms)); }
  function clickType(key) {
    var chip = q('.ddc-chip[data-ddc-lf="' + key + '"]');
    if (chip) chip.click();
  }
  function clickWindow(label) {
    var chips = panel.el.querySelectorAll('.ddc-dynchips[data-ddc-dyn="session"] .ddc-chip');
    for (var k = 0; k < chips.length; k += 1) {
      if (chips[k].textContent.trim() === label) { chips[k].click(); return; }
    }
  }

  if (view === 'live') {
    // 运行时长按「打开页面时已经跑了 8 分 41 秒」算，否则会显示成真实时钟差。
    var startedAt = new Date(Date.now() - live.elapsedSec * 1000).toISOString();
    for (var k = 0; k < live.statuses.length; k += 1) live.statuses[k].startedAt = startedAt;
    var preload = live.preload;
    panel.updateLive(live.statuses[preload - 1], live.records.slice(0, preload));
    panel.tickClock(true);

    var i = preload;
    var streamT0 = performance.now();
    (function tick() {
      var due = preload + Math.floor((performance.now() - streamT0) / live.stepMs);
      while (i < Math.min(due, live.records.length)) {
        panel.updateLive(live.statuses[i], [live.records[i]]);
        i += 1;
      }
      panel.tickClock(true);
      if (i < live.records.length) requestAnimationFrame(tick);
    })();

    // 演示顺序：先按类型筛一次 → 复位 → 搜「credentials」→ 清空 → 按窗口筛一次。
    at(2000, function () { clickType('think'); });
    at(3200, function () { clickType('all'); });
    at(3600, function () {
      var input = q('.ddc-lsearch');
      if (!input) return;
      var text = 'credentials';
      var step = 0;
      var typer = setInterval(function () {
        step += 1;
        input.value = text.slice(0, step);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (step >= text.length) clearInterval(typer);
      }, 70);
      timers.push({ cancel: function () { clearInterval(typer); } });
    });
    at(5600, function () {
      var input = q('.ddc-lsearch');
      if (!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur();
    });
    at(6600, function () { clickWindow(fx.sessionDirectory['01JCF8Q2N4'] || 'README 首屏改版'); });
  } else if (view === 'replay') {
    panel.startReplay(fx.replay.session, fx.replay.records, false);
    at(600, function () {
      var speed = q('.ddc-spd[data-ddc-spd="60"]');
      if (speed) speed.click();
      var play = q('.ddc-play');
      if (play) play.click();
    });
  } else if (view === 'history') {
    panel.showHistory(fx.history.sessions);
    panel.setView('history');
    at(700, function () {
      var chip = q('.ddc-chip[data-ddc-hf="recording"]');
      if (chip) chip.click();
    });
    at(1900, function () {
      var chip = q('.ddc-chip[data-ddc-hf="all"]');
      if (chip) chip.click();
    });
    // 列表比一屏长：慢慢往下滚，让「更早的录像」也露一下脸。
    at(2500, function () {
      // .ddc-hlist 自己就是滚动容器（overflow-y:auto），父节点不滚，滚它会静默无效。
      var box = q('.ddc-hlist');
      if (!box) return;
      var from = box.scrollTop;
      var to = Math.min(box.scrollHeight - box.clientHeight, from + 240);
      if (to <= from) return;
      var t0 = performance.now();
      (function glide() {
        var p = Math.min(1, (performance.now() - t0) / 1400);
        box.scrollTop = from + (to - from) * (0.5 - Math.cos(Math.PI * p) / 2);
        if (p < 1) requestAnimationFrame(glide);
      })();
    });
  }

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      // 首帧必须已经画完再让抓帧脚本开工，否则第一帧是空白。
      window.__DEMO_READY__ = true;
    });
  });
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
    '--force-device-scale-factor=' + DPR,
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
      deviceScaleFactor: DPR,
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
        quality: SHOT_QUALITY,
        optimizeForSpeed: true,
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
  // 抓帧能到 7fps，但 60 帧的 GIF 要 1.6MB——README 首屏放三张就 5MB，太重了。
  // 每 200ms 留一帧（5fps）体量减半，播放按真实间隔排，看起来还是连续在动。
  const GIF_FPS = Number(process.env.GIF_FPS || 5);
  const kept = [];
  let lastAt = -Infinity;
  for (const frame of timing) {
    if (frame.at - lastAt >= 1000 / GIF_FPS - 1) {
      kept.push(frame);
      lastAt = frame.at;
    }
  }
  if (kept[kept.length - 1] !== timing[timing.length - 1]) kept.push(timing[timing.length - 1]);

  const lines = [];
  for (let i = 0; i < kept.length; i += 1) {
    const next = kept[i + 1] ? kept[i + 1].at : kept[i].at + 1000 / GIF_FPS;
    // 时长按真实间隔排（0.07 是 GIF 下限，0.25 防止某帧卡太久）
    const duration = Math.min(0.25, Math.max(0.07, (next - kept[i].at) / 1000));
    lines.push(`file '${kept[i].name}'`);
    lines.push(`duration ${duration.toFixed(3)}`);
  }
  lines.push(`file '${kept[kept.length - 1].name}'`);
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
  console.log(`[encode] ${outFile.replace(ROOT + '\\', '')} (${kept.length} 帧, ${(size / 1024 / 1024).toFixed(2)} MB)`);
}

// ---------------------------------------------------------------- main

const args = new Set(process.argv.slice(2));
// --only=live,replay,history：只跑其中几个视图（调一张图时省时间）。
const onlyArg = [...args].find((arg) => arg.startsWith('--only='));
const ONLY = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
const wants = (view) => !ONLY || ONLY.has(view);

async function main() {
  mkdirSync(BUILD, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  if (!args.has('--encode-only')) {
    const { ledgerText, fixture } = buildFixture();
    // 英文版只把假账本内联进 demo 页，不覆盖 docs/ 里那份对外发布的演示数据（保持中文唯一一份）。
    if (LANG === 'zh') writeFileSync(LEDGER_PATH, ledgerText);
    writeFileSync(HTML_PATH, buildHtml(fixture));
    console.log(`[fixture] ${ledgerText.trim().split('\n').length} 条记录${LANG === 'zh' ? ' → docs/screenshots/demo-ledger.jsonl' : '（只内联进 demo.en.html，不落 docs/）'}`);
    console.log(`[html] ${HTML_PATH.replace(ROOT + '\\', '')}`);
  }

  if (args.has('--html-only')) return;

  const frames = (view) => join(BUILD, 'frames', view + LANG_SUFFIX);
  const outGif = (view) => join(OUT, view + LANG_SUFFIX + '.gif');

  if (!args.has('--encode-only')) {
    if (wants('live')) await capture('live', frames('live'), { durationMs: 8600, fpsCap: 30 });
    if (wants('replay')) await capture('replay', frames('replay'), { durationMs: 11000, fpsCap: 30 });
    if (wants('history')) await capture('history', frames('history'), { durationMs: 5200, fpsCap: 30 });
  }

  if (wants('live')) await encode(frames('live'), outGif('live'));
  if (wants('replay')) await encode(frames('replay'), outGif('replay'));
  if (wants('history')) await encode(frames('history'), outGif('history'));
}

main().catch((error) => {
  console.error('[demo-shots] 失败：', error.message);
  process.exit(1);
});
