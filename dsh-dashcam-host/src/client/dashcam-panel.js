// dsh-dashcam 面板 UI（纯 DOM，不依赖 React——React 只在 client.body.js 挂插槽）。
// 视觉与交互移植自参考稿 dashcam.html：实时/回放/录像历史三视图、时间轴画布、
// 事件流、检索过滤。数据形状见 lib/panel.js sanitizeRecord/computeStatus/
// clusterSessions——面板只消费脱敏后的展示形状，不接触账本原文。

const TYPE_TEXT = { think: 'LLM', read: '读取', edit: '编辑', bash: '命令', net: '出网', tel: '遥测', error: '异常' };
const TYPE_ORDER = ['think', 'read', 'edit', 'bash', 'net', 'tel', 'error'];
// 画布刻度：类型 → [高度比例, 颜色 CSS 变量名或色值]
const MARK = {
  edit: [1.0, '#f0d0a0'],
  bash: [0.72, '#a0e8c0'],
  net: [0.6, '#c8b8f0'],
  read: [0.46, '#a8c8f0'],
  think: [0.28, 'rgba(242,242,245,.62)'],
  tel: [0.18, 'rgba(242,242,245,.38)'],
  error: [1.0, '#d9534f'],
};
const SPEEDS = [1, 10, 60];

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function hms(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function shortHms(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  return hms(s).replace(/^00:/, '');
}

function clock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clockFull(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ts)}`;
}

function dateShort(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function createDashcamPanel(options) {
  const api = options.api || {};
  const root = document.createElement('div');
  root.className = 'ddc-root';
  root.setAttribute('data-ddc-root', '1');
  root.style.display = 'none';
  root.innerHTML = `
    <div class="ddc-page">
      <header class="ddc-topbar">
        <div>
          <h1>Agent Dashcam</h1>
          <p class="ddc-sub">判定链账本 · 实时录制与回放</p>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div class="ddc-rec"><span class="ddc-dot"></span><span class="ddc-lb">REC</span><span class="ddc-time num">--:--:--</span></div>
          <button class="ddc-close" title="关闭（Esc）">×</button>
        </div>
      </header>
      <nav class="ddc-tabs">
        <button class="ddc-tab on" data-ddc-view="live">实时录制</button>
        <button class="ddc-tab" data-ddc-view="replay">回放</button>
        <button class="ddc-tab" data-ddc-view="history">录像历史</button>
      </nav>

      <section class="ddc-view on" data-ddc-viewcard="live">
        <div class="ddc-metrics">
          <div class="ddc-card ddc-m"><div class="ddc-l">运行时长</div><div class="ddc-v ddc-m-elapsed">--:--:--</div></div>
          <div class="ddc-card ddc-m"><div class="ddc-l">纳管调用</div><div class="ddc-v ddc-m-tools">0</div></div>
          <div class="ddc-card ddc-m"><div class="ddc-l">改动文件</div><div class="ddc-v ddc-m-files">0</div></div>
          <div class="ddc-card ddc-m accent"><div class="ddc-l">异常</div><div class="ddc-v ddc-m-errors">0</div></div>
        </div>
        <div class="ddc-split">
          <section class="ddc-card" style="display:flex;flex-direction:column;min-height:0">
            <div class="ddc-card-h"><h2>实时事件流</h2><span class="ddc-meta ddc-stream-meta">共 0 条</span></div>
            <div class="ddc-body" style="flex:1;min-height:0">
              <div class="ddc-stream"></div>
            </div>
          </section>
          <div class="ddc-stack">
            <section class="ddc-card">
              <div class="ddc-card-h"><h2>当前步骤</h2><span class="ddc-meta ddc-step-age">—</span></div>
              <div class="ddc-body">
                <div class="ddc-step"><span class="ddc-tag t-tel ddc-step-tag">…</span><div><div class="ddc-title ddc-step-title">等待事件</div><div class="ddc-detail ddc-step-detail">—</div></div></div>
              </div>
            </section>
            <section class="ddc-card">
              <div class="ddc-card-h"><h2>判定链状态</h2></div>
              <div class="ddc-body">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                  <span style="font:400 12px/1 var(--ddc-font);color:var(--ddc-text-3)">拦截 / 判定</span>
                  <span style="font:600 13px/1 var(--ddc-mono)" class="ddc-bar-val">0 / 0</span>
                </div>
                <div class="ddc-barbg"><div class="ddc-bar" style="width:0%"></div></div>
                <div class="ddc-kv ddc-session-kv"></div>
              </div>
            </section>
          </div>
        </div>
      </section>

      <section class="ddc-view" data-ddc-viewcard="replay">
        <section class="ddc-card" style="display:flex;flex-direction:column;gap:10px;padding:var(--ddc-card-pad)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
            <div style="font:600 14px/1.3 var(--ddc-font)"><span class="ddc-rp-title">选择录像</span></div>
            <div style="font:400 12px/1 var(--ddc-mono);color:var(--ddc-text-3)" class="ddc-rp-clock">--:--:--</div>
          </div>
          <canvas class="ddc-tl"></canvas>
          <div class="ddc-legend"></div>
          <div class="ddc-ctl">
            <button class="ddc-btn primary ddc-play">播放</button>
            <span style="flex:1"></span>
            <span style="font:400 12px/1 var(--ddc-font);color:var(--ddc-text-3)">速度</span>
            ${SPEEDS.map((s) => `<button class="ddc-spd${s === 1 ? ' on' : ''}" data-ddc-spd="${s}">${s}×</button>`).join('')}
          </div>
        </section>
        <div class="ddc-rpsplit">
          <section class="ddc-card" style="display:flex;flex-direction:column;min-height:0">
            <div class="ddc-card-h"><h2>事件</h2><span class="ddc-meta ddc-rp-meta">—</span></div>
            <div class="ddc-body" style="flex:1;min-height:0">
              <div class="ddc-evlist"></div>
            </div>
          </section>
          <section class="ddc-card" style="display:flex;flex-direction:column;min-height:0">
            <div class="ddc-card-h"><h2>事件详情</h2></div>
            <div class="ddc-body ddc-rp-detail" style="flex:1;min-height:0;overflow-y:auto"></div>
          </section>
        </div>
      </section>

      <section class="ddc-view" data-ddc-viewcard="history">
        <div class="ddc-toolbar">
          <input class="ddc-search" placeholder="搜索 ID / 日期…" />
          <div class="ddc-chips">
            <button class="ddc-chip on" data-ddc-hf="all">全部</button>
            <button class="ddc-chip" data-ddc-hf="recording">录制中</button>
            <button class="ddc-chip" data-ddc-hf="completed">已完成</button>
          </div>
        </div>
        <div class="ddc-card" style="flex:1;min-height:0;display:flex;flex-direction:column">
          <div class="ddc-card-h"><h2>录像历史</h2><span class="ddc-meta ddc-hist-meta">—</span></div>
          <div class="ddc-body" style="flex:1;min-height:0">
            <div class="ddc-hlist"></div>
          </div>
        </div>
      </section>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const els = {
    rec: $('.ddc-rec'),
    recTime: $('.ddc-rec .ddc-time'),
    close: $('.ddc-close'),
    tabs: [...root.querySelectorAll('.ddc-tab')],
    mElapsed: $('.ddc-m-elapsed'),
    mTools: $('.ddc-m-tools'),
    mFiles: $('.ddc-m-files'),
    mErrors: $('.ddc-m-errors'),
    stream: $('.ddc-stream'),
    streamMeta: $('.ddc-stream-meta'),
    stepAge: $('.ddc-step-age'),
    stepTag: $('.ddc-step-tag'),
    stepTitle: $('.ddc-step-title'),
    stepDetail: $('.ddc-step-detail'),
    bar: $('.ddc-bar'),
    barVal: $('.ddc-bar-val'),
    sessionKv: $('.ddc-session-kv'),
    rpTitle: $('.ddc-rp-title'),
    rpClock: $('.ddc-rp-clock'),
    tl: $('.ddc-tl'),
    legend: $('.ddc-legend'),
    play: $('.ddc-play'),
    spds: [...root.querySelectorAll('.ddc-spd')],
    evlist: $('.ddc-evlist'),
    rpMeta: $('.ddc-rp-meta'),
    rpDetail: $('.ddc-rp-detail'),
    search: $('.ddc-search'),
    chips: [...root.querySelectorAll('.ddc-chip')],
    hlist: $('.ddc-hlist'),
    histMeta: $('.ddc-hist-meta'),
  };

  const state = {
    view: 'live',
    status: null,
    live: [],           // 升序的脱敏记录（实时流，尾部窗口）
    renderedSeq: 0,     // 已渲染到流里的最大 seq
    elapsedSec: null,
    hist: { sessions: [], filter: 'all', query: '' },
    rp: { session: null, events: [], dur: 0, t: 0, playing: false, speed: 1, active: -1, startStamp: 0 },
  };
  let rafId = 0;
  let tipEl = null;
  const disposers = [];

  // ---------- 通用 ----------
  function setView(view) {
    state.view = view;
    els.tabs.forEach((tab) => tab.classList.toggle('on', tab.dataset.ddcView === view));
    root.querySelectorAll('.ddc-view').forEach((card) => {
      card.classList.toggle('on', card.dataset.ddcViewcard === view);
    });
    if (view === 'replay') drawTimeline();
    if (view === 'history') renderHistory();
  }

  function evRow(e, timeText, clickable) {
    const row = document.createElement('div');
    const isError = e.type === 'error' || e.denied;
    row.className = 'ddc-ev' + (isError ? ' error' : '');
    if (clickable) {
      row.dataset.ddcSeq = String(e.seq);
      row.addEventListener('click', () => {
        const idx = state.rp.events.findIndex((ev) => ev.seq === e.seq);
        if (idx >= 0) seekTo(state.rp.events[idx].t);
      });
    }
    const time = document.createElement('span');
    time.className = 'ddc-time';
    time.textContent = timeText;
    const tag = document.createElement('span');
    tag.className = `ddc-tag t-${e.type}`;
    tag.textContent = TYPE_TEXT[e.type] || e.type;
    const main = document.createElement('div');
    main.style.minWidth = '0';
    main.style.flex = '1';
    const title = document.createElement('div');
    title.className = 'ddc-title';
    title.textContent = (e.denied && e.type !== 'error' ? '[拒绝] ' : '') + (e.title || '—');
    const detail = document.createElement('div');
    detail.className = 'ddc-detail';
    detail.textContent = e.detail || '';
    main.appendChild(title);
    if (e.detail) main.appendChild(detail);
    row.appendChild(time);
    row.appendChild(tag);
    row.appendChild(main);
    return row;
  }

  function extraBlock(e) {
    const lines = [];
    if (e.ruleId) lines.push(`规则   ${e.ruleId}`);
    lines.push(`决策   ${e.denied ? 'deny' : 'allow'}${e.intercepted ? '（已拦截）' : ''}`);
    if (e.extra && Array.isArray(e.extra.paths) && e.extra.paths.length) {
      lines.push(`路径   ${e.extra.paths.join('\n       ')}`);
    }
    if (e.extra && Array.isArray(e.extra.commands) && e.extra.commands.length) {
      lines.push(`命令   ${e.extra.commands.join('\n       ')}`);
    }
    if (e.extra && Array.isArray(e.extra.hosts) && e.extra.hosts.length) {
      lines.push(`主机   ${e.extra.hosts.join(', ')}`);
    }
    if (e.extra && typeof e.extra.commandLine === 'string' && e.extra.commandLine) {
      lines.push(`命令行 ${e.extra.commandLine}`);
    }
    return lines.join('\n');
  }

  // ---------- 实时 ----------
  function updateLive(status, records) {
    if (status) state.status = status;
    const s = state.status;
    if (s) {
      const counts = s.counts || {};
      // 纳管口径：judgments 是映射表内的五类 capability；映射表外（MCP/workflow/
      // subagent 等）走 telemetry/unmapped-tool，单独在判定链状态里展示。
      els.mTools.textContent = String(s.judgments || 0);
      els.mFiles.textContent = String(s.filesTouched || 0);
      els.mErrors.textContent = String(s.errors || 0);
      // 红色只反映真拦截：advisory 的 deny 是旁路命中（deny 账但未拦截），
      // 不进异常卡片，也不进这条比例——否则旁路模式下红色常亮失去警示。
      els.barVal.textContent = `${counts.intercepted || 0} / ${s.judgments || 0}`;
      const ratio = s.judgments ? clamp((counts.intercepted || 0) / s.judgments, 0, 1) : 0;
      els.bar.style.width = `${(ratio * 100).toFixed(1)}%`;
      const kv = [];
      kv.push(['模式', s.mode === 'enforce' ? 'enforce（强制）' : s.mode === 'advisory' ? 'advisory（旁路）' : '—', s.mode === 'enforce']);
      kv.push(['旁路命中', `${counts.bypass || 0} 次（deny 未拦截）`, false]);
      kv.push(['未纳管调用', `${counts.unmapped || 0} 次（telemetry）`, false]);
      kv.push(['插件版本', s.version || '—', false]);
      if (s.session && s.session.id) kv.push(['会话 ID', s.session.id, false]);
      if (s.session && s.session.model) kv.push(['模型', s.session.model, false]);
      kv.push(['账本记录', `#${s.ledgerSeq || 0}${s.windowed ? '（窗口截断）' : ''}`, false]);
      if (s.ledgerPath) kv.push(['账本路径', s.ledgerPath, false]);
      els.sessionKv.innerHTML = kv
        .map(([k, v, warn]) => `<div class="ddc-k">${esc(k)}</div><div class="ddc-val${warn ? ' warn' : ''}">${esc(v)}</div>`)
        .join('');
    }

    if (Array.isArray(records) && records.length) {
      state.live = state.live.concat(records).slice(-400);
    }
    const fresh = state.live.filter((e) => e.seq > state.renderedSeq);
    if (fresh.length) {
      const atTop = els.stream.querySelector('.ddc-ev');
      for (const e of fresh) {
        els.stream.insertBefore(evRow(e, clock(e.ts), false), atTop || null);
      }
      state.renderedSeq = fresh[fresh.length - 1].seq;
      // DOM 与 state.live 的 400 条窗口对齐：流是新的在上，超窗口的旧行从尾部
      // 移除——否则面板开一上午行数无限增长，「共 N 条」与屏幕也对不上。
      const rows = els.stream.querySelectorAll('.ddc-ev');
      for (let i = rows.length - 1; i >= 400; i -= 1) rows[i].remove();
    }
    els.streamMeta.textContent = `共 ${state.live.length} 条`;
    if (!state.live.length && !els.stream.querySelector('.ddc-empty')) {
      const empty = document.createElement('div');
      empty.className = 'ddc-empty';
      empty.textContent = '等待账本记录…';
      els.stream.appendChild(empty);
    } else if (state.live.length) {
      const empty = els.stream.querySelector('.ddc-empty');
      if (empty) empty.remove();
    }

    const last = state.live.length ? state.live[state.live.length - 1] : s && s.lastEvent ? s.lastEvent : null;
    if (last) {
      const isError = last.type === 'error' || last.denied;
      els.stepTag.className = `ddc-tag t-${last.type}`;
      els.stepTag.textContent = TYPE_TEXT[last.type] || last.type;
      els.stepTitle.textContent = (last.denied && last.type !== 'error' ? '[拒绝] ' : '') + (last.title || '—');
      els.stepTitle.parentElement.parentElement.classList.toggle('error', !!isError);
      els.stepDetail.textContent = last.detail || '—';
      if (last.ts) els.stepAge.dataset.ddcTs = last.ts;
    }
  }

  function tickClock(connected) {
    const s = state.status;
    if (s && s.startedAt) {
      const ms = Date.now() - Date.parse(s.startedAt);
      state.elapsedSec = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : null;
    } else {
      state.elapsedSec = null;
    }
    const text = state.elapsedSec == null ? '--:--:--' : hms(state.elapsedSec);
    els.recTime.textContent = text;
    els.rec.classList.toggle('ddc-off', !connected);
    els.mElapsed.textContent = text;
    if (els.stepAge.dataset.ddcTs) {
      const age = Math.max(0, Math.floor((Date.now() - Date.parse(els.stepAge.dataset.ddcTs)) / 1000));
      els.stepAge.textContent = age < 60 ? `${age} 秒前` : `${Math.floor(age / 60)} 分钟前`;
    }
    if (state.rp.playing) drawTimeline();
  }

  // ---------- 回放 ----------
  function startReplay(session, records, truncated = false) {
    pause();
    const rp = state.rp;
    rp.session = session || null;
    const list = Array.isArray(records) ? records.filter((e) => e && e.ts) : [];
    const startMs = list.length ? Date.parse(list[0].ts) : 0;
    const endMs = list.length ? Date.parse(list[list.length - 1].ts) : 0;
    rp.events = list.map((e) => ({ ...e, t: Math.max(0, (Date.parse(e.ts) - startMs) / 1000) }));
    rp.dur = session && session.duration ? session.duration : Math.max(1, (endMs - startMs) / 1000);
    rp.t = 0;
    rp.active = -1;
    rp.speed = 1;
    els.spds.forEach((b) => b.classList.toggle('on', b.dataset.ddcSpd === '1'));
    els.rpTitle.textContent = session
      ? `${session.id} · ${dateShort(session.started)}（${session.events} 事件 / ${session.errors} 异常）`
      : '最近记录';
    // 服务端 limit 截断时如实标注，避免「看起来完整其实少了」。
    els.rpMeta.textContent = `${rp.events.length} 条${truncated ? ' · 已截断（只载入前 2000 条）' : ''}`;
    els.evlist.innerHTML = '';
    for (const e of rp.events) {
      els.evlist.appendChild(evRow(e, shortHms(e.t), true));
    }
    if (!rp.events.length) {
      const empty = document.createElement('div');
      empty.className = 'ddc-empty';
      empty.textContent = '该录像段没有可用记录';
      els.evlist.appendChild(empty);
    }
    renderDetail(-1);
    drawTimeline();
    setView('replay');
  }

  function renderDetail(idx) {
    const rp = state.rp;
    const e = idx >= 0 ? rp.events[idx] : null;
    if (!e) {
      els.rpDetail.innerHTML = '<div class="ddc-empty">点击时间轴或事件查看详情</div>';
      return;
    }
    const block = extraBlock(e);
    els.rpDetail.innerHTML = `
      <div class="ddc-step"><span class="ddc-tag t-${e.type}">${TYPE_TEXT[e.type] || e.type}</span>
        <div><div class="ddc-title">${esc((e.denied && e.type !== 'error' ? '[拒绝] ' : '') + (e.title || '—'))}</div>
        <div class="ddc-detail">${esc(e.detail || '')}</div></div></div>
      <div class="ddc-kv">
        <div class="ddc-k">时间点</div><div class="ddc-val">${esc(clockFull(e.ts))}</div>
        <div class="ddc-k">相对</div><div class="ddc-val">+${shortHms(e.t)}</div>
        <div class="ddc-k">序号</div><div class="ddc-val">#${e.seq}</div>
      </div>
      ${block ? `<pre class="ddc-diff">${esc(block)}</pre>` : ''}`;
  }

  function seekTo(t) {
    const rp = state.rp;
    rp.t = clamp(t, 0, rp.dur);
    if (rp.playing) rp.startStamp = performance.now() - (rp.t / rp.speed) * 1000;
    syncActive();
    drawTimeline();
  }

  function syncActive() {
    const rp = state.rp;
    let idx = -1;
    for (let i = 0; i < rp.events.length; i += 1) {
      if (rp.events[i].t <= rp.t) idx = i;
      else break;
    }
    if (idx !== rp.active) {
      rp.active = idx;
      const rows = els.evlist.querySelectorAll('.ddc-ev[data-ddc-seq]');
      rows.forEach((row) => {
        row.classList.toggle('on', idx >= 0 && row.dataset.ddcSeq === String(rp.events[idx].seq));
      });
      if (idx >= 0) {
        const activeRow = els.evlist.querySelector(`.ddc-ev[data-ddc-seq="${rp.events[idx].seq}"]`);
        if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
      }
      renderDetail(idx);
    }
    const e = idx >= 0 ? rp.events[idx] : null;
    els.rpClock.textContent = `${hms(rp.t)} / ${hms(rp.dur)}${e ? ` · #${e.seq}` : ''}`;
  }

  function play() {
    const rp = state.rp;
    if (!rp.events.length) return;
    if (rp.t >= rp.dur) rp.t = 0;
    rp.playing = true;
    rp.startStamp = performance.now() - (rp.t / rp.speed) * 1000;
    els.play.textContent = '暂停';
    loop();
  }

  function pause() {
    state.rp.playing = false;
    els.play.textContent = '播放';
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function loop() {
    if (!state.rp.playing) return;
    const rp = state.rp;
    rp.t = Math.min(rp.dur, ((performance.now() - rp.startStamp) / 1000) * rp.speed);
    syncActive();
    drawTimeline();
    if (rp.t >= rp.dur) {
      pause();
      return;
    }
    rafId = requestAnimationFrame(loop);
  }

  function drawTimeline() {
    const canvas = els.tl;
    const rp = state.rp;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    const ctx = canvas.getContext('2d');
    const w = rect.width;
    const h = rect.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const style = getComputedStyle(root);
    const axis = style.getPropertyValue('--ddc-text-3').trim() || 'rgba(242,242,245,.38)';
    const line = 'rgba(255,255,255,.06)';
    const accent = style.getPropertyValue('--ddc-accent').trim() || '#d9534f';
    const padL = 8;
    const padR = 8;
    const axisY = h - 18;
    const markTop = 8;
    const markH = axisY - markTop - 6;

    // 轴线
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, axisY + 0.5);
    ctx.lineTo(w - padR, axisY + 0.5);
    ctx.stroke();

    // 时间刻度
    const dur = Math.max(1, rp.dur);
    const steps = [1, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400];
    let step = steps[steps.length - 1];
    for (const s of steps) {
      if (dur / s <= 8) {
        step = s;
        break;
      }
    }
    ctx.fillStyle = axis;
    ctx.font = '10px ' + (style.getPropertyValue('--ddc-mono').trim() || 'monospace');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = 0; t <= dur + 0.001; t += step) {
      const x = padL + (t / dur) * (w - padL - padR);
      ctx.strokeStyle = line;
      ctx.beginPath();
      ctx.moveTo(x, markTop);
      ctx.lineTo(x, axisY);
      ctx.stroke();
      ctx.fillText(shortHms(t), x, axisY + 5);
    }

    // 事件刻度
    for (const e of rp.events) {
      const mark = MARK[e.type] || MARK.tel;
      const x = padL + (e.t / dur) * (w - padL - padR);
      const height = markH * mark[0];
      ctx.strokeStyle = e.denied && e.type !== 'error' ? accent : mark[1];
      ctx.lineWidth = e.type === 'error' || e.denied ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, axisY);
      ctx.lineTo(x, axisY - height);
      ctx.stroke();
    }

    // 播放头
    const px = padL + (clamp(rp.t, 0, dur) / dur) * (w - padL - padR);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, markTop - 4);
    ctx.lineTo(px, axisY + 2);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(px - 4, markTop - 8);
    ctx.lineTo(px + 4, markTop - 8);
    ctx.lineTo(px, markTop - 2);
    ctx.closePath();
    ctx.fill();
  }

  function eventAtX(offsetX) {
    const rect = els.tl.getBoundingClientRect();
    const rp = state.rp;
    const dur = Math.max(1, rp.dur);
    const padL = 8;
    const padR = 8;
    const t = clamp(((offsetX - padL) / (rect.width - padL - padR)) * dur, 0, dur);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rp.events.length; i += 1) {
      const dist = Math.abs(rp.events[i].t - t);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    const tolerance = (dur / Math.max(1, rect.width - padL - padR)) * 8;
    return { t, idx: bestDist <= tolerance ? best : -1 };
  }

  function ensureTip() {
    if (!tipEl || !tipEl.isConnected) {
      tipEl = document.createElement('div');
      tipEl.className = 'ddc-tip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  // ---------- 历史 ----------
  function showHistory(sessions) {
    state.hist.sessions = Array.isArray(sessions) ? sessions : [];
    renderHistory();
  }

  function renderHistory() {
    const { sessions, filter, query } = state.hist;
    const q = query.trim().toLowerCase();
    const rows = sessions.filter((s) => {
      if (filter !== 'all' && s.status !== filter) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        (s.started || '').toLowerCase().includes(q) ||
        dateShort(s.started).toLowerCase().includes(q)
      );
    });
    els.hlist.innerHTML = '';
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'ddc-empty';
      empty.textContent = sessions.length ? '没有匹配的录像' : '账本里还没有录像段';
      els.hlist.appendChild(empty);
    }
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'ddc-hrow';
      const stText = s.status === 'recording' ? '<span class="ddc-st rec">录制中</span>' : '<span class="ddc-st done">已完成</span>';
      row.innerHTML = `
        <span class="ddc-hid">${esc(s.id)}</span>
        <span class="ddc-hstart">${esc(clockFull(s.started))}<span style="color:var(--ddc-text-3)"> → ${esc(clock(s.ended))}</span></span>
        <span class="ddc-num">${esc(hms(s.duration))}</span>
        <span class="ddc-num">${s.events}</span>
        <span class="ddc-num n-err">${s.errors}</span>
        <span class="ddc-hacts">${stText}</span>`;
      row.addEventListener('click', () => {
        if (typeof api.loadSession === 'function') api.loadSession(s);
      });
      els.hlist.appendChild(row);
    }
    els.histMeta.textContent = `${rows.length} / ${sessions.length} 段`;
  }

  // ---------- 事件接线 ----------
  els.close.addEventListener('click', () => {
    if (typeof options.onClose === 'function') options.onClose();
  });
  els.tabs.forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.ddcView)));
  els.play.addEventListener('click', () => (state.rp.playing ? pause() : play()));
  els.spds.forEach((btn) =>
    btn.addEventListener('click', () => {
      state.rp.speed = Number(btn.dataset.ddcSpd) || 1;
      els.spds.forEach((b) => b.classList.toggle('on', b === btn));
      if (state.rp.playing) state.rp.startStamp = performance.now() - (state.rp.t / state.rp.speed) * 1000;
    }),
  );
  els.tl.addEventListener('click', (event) => {
    const { t } = eventAtX(event.offsetX);
    seekTo(t);
  });
  els.tl.addEventListener('mousemove', (event) => {
    const { t, idx } = eventAtX(event.offsetX);
    if (idx < 0) {
      if (tipEl) tipEl.style.display = 'none';
      return;
    }
    const e = state.rp.events[idx];
    const tip = ensureTip();
    tip.innerHTML = `<div class="ddc-tt${e.type === 'error' || e.denied ? ' error' : ''}">${esc(TYPE_TEXT[e.type] || e.type)} · #${e.seq} · +${shortHms(e.t)}</div>
      <div class="ddc-tt">${esc(e.title || '')}</div>
      <div class="ddc-td">${esc(e.detail || '')}</div>`;
    tip.style.display = 'block';
    const pad = 14;
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    const box = tip.getBoundingClientRect();
    if (x + box.width > window.innerWidth - 8) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight - 8) y = event.clientY - box.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  els.tl.addEventListener('mouseleave', () => {
    if (tipEl) tipEl.style.display = 'none';
  });
  els.search.addEventListener('input', () => {
    state.hist.query = els.search.value || '';
    renderHistory();
  });
  els.chips.forEach((chip) =>
    chip.addEventListener('click', () => {
      state.hist.filter = chip.dataset.ddcHf || 'all';
      els.chips.forEach((c) => c.classList.toggle('on', c === chip));
      renderHistory();
    }),
  );
  els.legend.innerHTML = TYPE_ORDER.map((type) => `<span><i style="background:${MARK[type][1]}"></i>${TYPE_TEXT[type]}</span>`).join('');

  function onKeydown(event) {
    if (root.style.display === 'none') return;
    if (event.key === 'Escape') {
      if (typeof options.onClose === 'function') options.onClose();
      return;
    }
    if (state.view !== 'replay' || !state.rp.events.length) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    if (event.code === 'Space') {
      event.preventDefault();
      if (state.rp.playing) pause();
      else play();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const rp = state.rp;
      const idx = clamp(rp.active, 0, rp.events.length - 1);
      const prev = rp.events[clamp(idx - 1, 0, rp.events.length - 1)];
      seekTo(prev ? prev.t : 0);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const rp = state.rp;
      const idx = clamp(rp.active + 1, 0, rp.events.length - 1);
      const next = rp.events[idx];
      seekTo(next ? next.t : rp.dur);
    }
  }
  document.addEventListener('keydown', onKeydown, true);
  disposers.push(() => document.removeEventListener('keydown', onKeydown, true));

  const resizeObserver = new ResizeObserver(() => {
    if (state.view === 'replay') drawTimeline();
  });
  resizeObserver.observe(els.tl);
  disposers.push(() => resizeObserver.disconnect());

  function dispose() {
    pause();
    for (const dispose of disposers) dispose();
    if (tipEl && tipEl.isConnected) tipEl.remove();
    root.remove();
  }

  return {
    el: root,
    setView,
    updateLive,
    tickClock,
    showHistory,
    startReplay,
    dispose,
  };
}
