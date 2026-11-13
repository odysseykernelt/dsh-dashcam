// dsh-dashcam 面板引擎：徽章 + 弹窗面板的生命周期、数据轮询、单例防护。
// 单例姿势抄 tan-pet（generation 防级联、knownNodeClasses 清扫残留）；
// 只用 right/bottom 定位、直挂 document.body（dsh-app:// 下 iframe 会 404）。
// 轮询口径：status 常轮询（徽章计时器本地走秒）；面板打开且处于实时视图时
// 增量拉 records（since=lastSeq）；历史/回放按需拉。

import { createDashcamPanel, badgeTitle } from './dashcam-panel.js';

const BADGE_KEY = 'dsh.dashcam.badgeHidden';
const BADGE_POS_KEY = 'dsh.dashcam.badgePos';
const DRAG_THRESHOLD_PX = 4;
const DRAG_EDGE_PAD_PX = 8;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function fetchJSON(url) {
  return fetch(url, { credentials: 'same-origin' }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
}

function mountStyles() {
  const style = document.createElement('style');
  style.id = 'dsh-dashcam-panel-style';
  style.textContent = DASHCAM_CSS;
  document.head.appendChild(style);
}

const knownNodeClasses = ['ddc-badge', 'ddc-root', 'ddc-tip'];

export function mountDashcam() {
  const generation = Symbol('dsh-dashcam-panel');
  window.__DSH_DASHCAM_PANEL__ = generation;

  // 单例防护：清掉上一个实例可能残留的节点与样式（React StrictMode 双挂载、
  // 热重载都会触发级联 mount）。generation 符号让旧实例的异步回调自杀。
  for (const className of knownNodeClasses) {
    for (const node of document.querySelectorAll(`.${className}`)) node.remove();
  }
  const staleStyle = document.getElementById('dsh-dashcam-panel-style');
  if (staleStyle) staleStyle.remove();
  mountStyles();

  // ---------- 徽章 ----------
  const badge = document.createElement('div');
  badge.className = 'ddc-badge';
  badge.title = badgeTitle();
  badge.setAttribute('role', 'button');
  badge.setAttribute('tabindex', '0');
  badge.innerHTML = '<span class="ddc-dot"></span><span class="ddc-lb">REC</span><span class="ddc-time num">--:--:--</span>';
  document.body.appendChild(badge);
  const badgeTime = badge.querySelector('.ddc-time');
  try {
    if (localStorage.getItem(BADGE_KEY) === '1') badge.style.display = 'none';
    // 恢复上次拖拽的位置（right/bottom 坐标，与面板同款姿势）
    const savedPos = JSON.parse(localStorage.getItem(BADGE_POS_KEY) || 'null');
    if (savedPos && Number.isFinite(savedPos.right) && Number.isFinite(savedPos.bottom)) {
      badge.style.right = `${savedPos.right}px`;
      badge.style.bottom = `${savedPos.bottom}px`;
    }
  } catch { /* 隐身模式等场景 localStorage 不可用 */ }

  // 拖拽 + 点击区分：pointer 按下记录 right/bottom 起点，位移超过阈值算拖拽
  //（更新 right/bottom 并落盘），否则 pointerup 触发 toggle。只用 right/bottom
  // 定位是 tan-pet 的教训（top/left 在宿主布局里会被裁剪/覆盖）。
  let drag = null;
  badge.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = badge.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: window.innerWidth - rect.right,
      startBottom: window.innerHeight - rect.bottom,
      moved: false,
    };
    try { badge.setPointerCapture(event.pointerId); } catch { /* 老宿主可能不支持 */ }
  });
  badge.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    const right = clamp(drag.startRight - dx, DRAG_EDGE_PAD_PX, window.innerWidth - badge.offsetWidth - DRAG_EDGE_PAD_PX);
    const bottom = clamp(drag.startBottom - dy, DRAG_EDGE_PAD_PX, window.innerHeight - badge.offsetHeight - DRAG_EDGE_PAD_PX);
    badge.style.right = `${right}px`;
    badge.style.bottom = `${bottom}px`;
  });
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) {
      try {
        localStorage.setItem(BADGE_POS_KEY, JSON.stringify({
          right: parseFloat(badge.style.right) || 24,
          bottom: parseFloat(badge.style.bottom) || 24,
        }));
      } catch { /* 同上 */ }
    } else {
      toggle();
    }
  };
  badge.addEventListener('pointerup', endDrag);
  badge.addEventListener('pointercancel', () => { drag = null; });
  badge.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });

  // ---------- 面板 ----------
  let open = false;
  let lastSeq = 0;
  let connected = true;
  let failures = 0;
  let histCache = { at: 0, sessions: [] };
  // 2.2.0 静默加载：首次进实时视图用 tail=400 取**最新**记录（此前 since=0
  // 从窗口头部慢慢追，事件流永远落后）；之后按 since 增量。会话目录 30s 缓存。
  let livePrimed = false;
  let sessionDirCache = { at: 0, byId: new Map() };

  const panel = createDashcamPanel({
    api: {
      // 回放首屏只取窗口尾部 200 条（秒开），更早的批次后台静默补齐：
      // 游标向前推进（to=本批最早 seq-1），直到覆盖 session.from 或达 2000 上限。
      loadSession: async (session) => {
        try {
          const first = await fetchJSON(
            `/api/dsh-dashcam/records?since=${Math.max(session.from - 1, session.to - 200)}&to=${session.to}&limit=200`,
          );
          if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
          const records = first.records || [];
          panel.startReplay(session, records, false);
          let cursor = records.length ? records[0].seq - 1 : session.to;
          let loaded = records.length;
          while (cursor >= session.from && loaded < 2000) {
            const batch = await fetchJSON(
              `/api/dsh-dashcam/records?since=${Math.max(session.from - 1, cursor - 400)}&to=${cursor}&limit=400`,
            );
            if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
            const older = batch.records || [];
            if (!older.length) break;
            panel.prependReplayEvents(older);
            loaded += older.length;
            cursor = older[0].seq - 1;
          }
          // 游标还没走到 session.from 说明被 2000 上限截断——如实标注。
          if (cursor >= session.from) panel.setReplayTruncated(true);
        } catch (error) {
          panel.startReplay(session, [], false);
        }
      },
    },
    onClose: () => close(),
    onLanguageChange: () => { badge.title = badgeTitle(); },
    // 实时流搜索：宿主 /search 路由全账本匹配，结果交给面板三层分组渲染。
    onLiveSearch: async (query) => {
      try {
        const data = await fetchJSON(`/api/dsh-dashcam/search?q=${encodeURIComponent(query)}&limit=500`);
        if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
        if (!data || data.ok !== true) throw new Error('bad payload');
        panel.showLiveSearch(data);
      } catch {
        // 搜索失败静默：事件流不受影响
      }
    },
  });
  document.body.appendChild(panel.el);

  function openPanel() {
    open = true;
    panel.el.style.display = '';
    refreshStatus(true);
    refreshRecords(true);
    refreshSessionDirectory(true);
    if (currentView() === 'history') refreshHistory(true);
  }
  function close() {
    open = false;
    panel.el.style.display = 'none';
  }
  function toggle() {
    if (open) close();
    else openPanel();
  }
  function currentView() {
    const active = panel.el.querySelector('.ddc-tab.on');
    return active ? active.dataset.ddcView : 'live';
  }

  // 会话目录（id → 窗口标题）：实时流分组头与搜索结果分组用。
  // 目录缺席（老宿主/服务不可用）静默降级——面板对没标题的会话显示 id 前 8 位。
  async function refreshSessionDirectory(force) {
    if (!force && Date.now() - sessionDirCache.at < 30000) return;
    try {
      const data = await fetchJSON('/api/dsh-dashcam/sessions');
      if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
      if (!data || data.ok !== true) return;
      const byId = new Map();
      for (const item of data.sessions || []) {
        if (item && item.id != null) byId.set(String(item.id), item.title || null);
      }
      sessionDirCache = { at: Date.now(), byId };
      panel.updateSessionDirectory(byId);
    } catch {
      // 目录拉不到不影响事件流
    }
  }

  async function refreshStatus(force) {
    try {
      const data = await fetchJSON('/api/dsh-dashcam/status');
      if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
      if (!data || data.ok !== true) throw new Error('bad payload');
      failures = 0;
      if (!connected) {
        connected = true;
        panel.tickClock(true);
      }
      if (open || force) panel.updateLive(data, null);
      if (open && currentView() === 'live') refreshSessionDirectory(false);
    } catch {
      if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
      failures += 1;
      if (failures >= 2 && connected) {
        connected = false;
        badge.classList.add('ddc-off');
        panel.tickClock(false);
      }
    }
  }

  async function refreshRecords(force) {
    if ((!open || currentView() !== 'live') && !force) return;
    try {
      const url = livePrimed
        ? `/api/dsh-dashcam/records?since=${lastSeq}&limit=200`
        : `/api/dsh-dashcam/records?tail=400`;
      const data = await fetchJSON(url);
      if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
      if (!data || data.ok !== true) throw new Error('bad payload');
      if (!livePrimed) {
        // 首屏：tail 返回的是最新 400 条，增量游标直接跳到最新（此前 since=0
        // 会从账本窗口头部开始慢慢追，事件流永远落后）。
        livePrimed = true;
        lastSeq = Number.isFinite(data.lastSeq) ? data.lastSeq : 0;
        panel.updateLive(null, data.records || []);
        return;
      }
      if (Number.isFinite(data.lastSeq) && data.lastSeq > lastSeq) lastSeq = data.lastSeq;
      if (open) panel.updateLive(null, data.records || []);
    } catch {
      // records 拉取失败静默：status 轮询负责连接态展示
    }
  }

  async function refreshHistory() {
    try {
      const [data] = await Promise.all([fetchJSON('/api/dsh-dashcam/history')]);
      if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
      if (!data || data.ok !== true) throw new Error('bad payload');
      histCache = { at: Date.now(), sessions: data.sessions || [] };
      panel.showHistory(data.sessions || []);
    } catch {
      panel.showHistory([]);
    }
  }

  // 轮询：status 3s；records 2s；本地秒表 1s。
  const statusTimer = window.setInterval(() => {
    if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
    refreshStatus();
  }, 3000);
  const recordsTimer = window.setInterval(() => {
    if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
    refreshRecords();
  }, 2000);
  const clockTimer = window.setInterval(() => {
    if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
    panel.tickClock(connected);
    if (badgeTime) badgeTime.textContent = panel.el.querySelector('.ddc-rec .ddc-time').textContent;
    badge.classList.toggle('ddc-off', !connected);
  }, 1000);

  // 面板内切到历史视图时按需刷新（15s 客户端缓存）
  const tabObserver = new MutationObserver(() => {
    if (open && currentView() === 'history' && Date.now() - histCache.at > 15000) {
      refreshHistory();
    }
  });
  tabObserver.observe(panel.el.querySelector('.ddc-tabs'), { attributes: true, subtree: true, attributeFilter: ['class'] });

  refreshStatus(true);

  function dispose() {
    if (window.__DSH_DASHCAM_PANEL__ === generation) {
      window.__DSH_DASHCAM_PANEL__ = null;
      if (window.__DSH_DASHCAM_ENGINE__ === handle) window.__DSH_DASHCAM_ENGINE__ = null;
    }
    window.clearInterval(statusTimer);
    window.clearInterval(recordsTimer);
    window.clearInterval(clockTimer);
    tabObserver.disconnect();
    panel.dispose();
    badge.remove();
  }

  const handle = { toggle, open: openPanel, close, dispose, refreshHistory };
  window.__DSH_DASHCAM_ENGINE__ = handle;
  return handle;
}
