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

  const panel = createDashcamPanel({
    api: {
      loadSession: async (session) => {
        try {
          const data = await fetchJSON(
            `/api/dsh-dashcam/records?since=${Math.max(0, session.from - 1)}&to=${session.to}&limit=2000`,
          );
          if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
          panel.startReplay(session, data.records || [], data.truncated === true);
        } catch (error) {
          panel.startReplay(session, [], false);
        }
      },
    },
    onClose: () => close(),
    onLanguageChange: () => { badge.title = badgeTitle(); },
  });
  document.body.appendChild(panel.el);

  function openPanel() {
    open = true;
    panel.el.style.display = '';
    refreshStatus(true);
    refreshRecords(true);
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
      const data = await fetchJSON(`/api/dsh-dashcam/records?since=${lastSeq}&limit=200`);
      if (window.__DSH_DASHCAM_PANEL__ !== generation) return;
      if (!data || data.ok !== true) throw new Error('bad payload');
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
