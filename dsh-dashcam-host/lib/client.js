window.__ModuleLoader__.load({
  id: "dsh-dashcam",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// dsh-dashcam 面板样式：忠实移植参考稿（dashcam.html）的暗玻璃 + REC 红 +
// 等宽数字风格，全部类名加 ddc- 前缀、只作用于 [data-ddc-root] 之下，
// 不外溢进宿主页面；徽章 .ddc-badge 与面板 .ddc-panel 是兄弟节点（都挂
// document.body，DSH 桌面 dsh-app:// 协议下 iframe 会 404——tan-pet 的教训）。
const DASHCAM_CSS = `
.ddc-badge,.ddc-root,.ddc-root *{box-sizing:border-box}
.ddc-badge,.ddc-root{--ddc-glass:rgba(255,255,255,.08);--ddc-glass-border:rgba(255,255,255,.12);--ddc-line:rgba(255,255,255,.06);--ddc-text:#f2f2f5;--ddc-text-2:rgba(242,242,245,.62);--ddc-text-3:rgba(242,242,245,.38);--ddc-accent:#d9534f;--ddc-accent-rgb:217,83,79;--ddc-accent-soft:#f0b9b6;--ddc-r-card:16px;--ddc-r-sm:8px;--ddc-gap:20px;--ddc-card-pad:16px 20px;--ddc-ease:200ms ease-out;--ddc-shadow:0 2px 8px rgba(0,0,0,.24);--ddc-shadow-hover:0 8px 24px rgba(0,0,0,.32);--ddc-blur:blur(20px) saturate(140%);--ddc-font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;--ddc-mono:ui-monospace,"SF Mono","Cascadia Mono",Consolas,"Roboto Mono",monospace}
.ddc-badge{position:fixed;right:24px;bottom:24px;z-index:2147483000;display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:999px;border:1px solid var(--ddc-glass-border);background:linear-gradient(180deg,rgba(20,20,28,.92),rgba(10,10,15,.92));backdrop-filter:var(--ddc-blur);-webkit-backdrop-filter:var(--ddc-blur);box-shadow:0 8px 24px rgba(0,0,0,.4);color:var(--ddc-text);font:600 13px/1 var(--ddc-font);cursor:pointer;user-select:none;touch-action:none;letter-spacing:.04em}
.ddc-badge:hover{border-color:rgba(var(--ddc-accent-rgb),.55);box-shadow:0 10px 28px rgba(0,0,0,.5)}
.ddc-badge .ddc-dot{width:8px;height:8px;border-radius:50%;background:var(--ddc-accent);box-shadow:0 0 0 4px rgba(var(--ddc-accent-rgb),.2);animation:ddcPulse 2s infinite}
.ddc-badge.ddc-off .ddc-dot{background:rgba(255,255,255,.25);box-shadow:none;animation:none}
.ddc-badge .ddc-time{font:600 12px/1 var(--ddc-mono);color:var(--ddc-text-2);letter-spacing:.06em}
@keyframes ddcPulse{0%,100%{opacity:1}50%{opacity:.4}}
.ddc-root{position:fixed;right:24px;bottom:24px;z-index:2147483000;width:min(980px,calc(100vw - 48px));height:min(720px,calc(100vh - 96px));display:flex;flex-direction:column;overflow:hidden;border-radius:20px;border:1px solid rgba(255,255,255,.14);background:radial-gradient(1200px 600px at 85% -10%,rgba(var(--ddc-accent-rgb),.1),transparent 60%),linear-gradient(180deg,#0d0d13,#0a0a0f 60%,#14141c);backdrop-filter:var(--ddc-blur);-webkit-backdrop-filter:var(--ddc-blur);box-shadow:0 24px 80px rgba(0,0,0,.6);color:var(--ddc-text);font:400 14px/1.5 var(--ddc-font);animation:ddcPanelIn 240ms cubic-bezier(.2,.9,.3,1)}
@keyframes ddcPanelIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.ddc-root *,.ddc-root *::before,.ddc-root *::after{box-sizing:border-box}
.ddc-page{flex:1;min-height:0;display:flex;flex-direction:column;gap:var(--ddc-gap);padding:22px 26px}
.ddc-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px}
.ddc-topbar h1{margin:0;font:700 22px/1.2 var(--ddc-font);letter-spacing:-.02em}
.ddc-topbar .ddc-sub{margin:4px 0 0;font:400 13px/1.4 var(--ddc-font);color:var(--ddc-text-2)}
.ddc-rec{display:flex;align-items:center;gap:9px;padding:8px 14px;border-radius:999px;border:1px solid rgba(var(--ddc-accent-rgb),.3);background:rgba(var(--ddc-accent-rgb),.08);font:600 12px/1 var(--ddc-mono);letter-spacing:.08em}
.ddc-rec .ddc-dot{width:7px;height:7px;border-radius:50%;background:var(--ddc-accent);animation:ddcPulse 2s infinite}
.ddc-rec.ddc-off{border-color:var(--ddc-glass-border);background:var(--ddc-glass);color:var(--ddc-text-2)}
.ddc-rec.ddc-off .ddc-dot{background:rgba(255,255,255,.3);animation:none}
.ddc-close{width:32px;height:32px;border-radius:10px;border:1px solid transparent;background:transparent;color:var(--ddc-text-2);font:400 20px/1 var(--ddc-font);cursor:pointer;transition:all var(--ddc-ease)}
.ddc-close:hover{background:var(--ddc-glass);border-color:var(--ddc-glass-border);color:var(--ddc-text)}
.ddc-tabs{display:flex;gap:6px;padding:5px;border-radius:12px;border:1px solid var(--ddc-line);background:rgba(0,0,0,.25)}
.ddc-tabs .ddc-tab{flex:0 0 auto;padding:9px 18px;border:0;border-radius:8px;background:transparent;color:var(--ddc-text-2);font:600 13px/1 var(--ddc-font);cursor:pointer;transition:all var(--ddc-ease)}
.ddc-tabs .ddc-tab:hover{color:var(--ddc-text)}
.ddc-tabs .ddc-tab.on{background:var(--ddc-glass);border:1px solid var(--ddc-glass-border);color:var(--ddc-text)}
.ddc-view{display:none;flex:1;min-height:0;flex-direction:column;gap:var(--ddc-gap)}
.ddc-view.on{display:flex}
.ddc-card{border:1px solid var(--ddc-line);border-radius:var(--ddc-r-card);background:var(--ddc-glass);box-shadow:var(--ddc-shadow);transition:border-color var(--ddc-ease),box-shadow var(--ddc-ease)}
.ddc-card:hover{border-color:var(--ddc-glass-border);box-shadow:var(--ddc-shadow-hover)}
.ddc-card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--ddc-line)}
.ddc-card-h h2{margin:0;font:600 13px/1 var(--ddc-font);letter-spacing:.1em;color:var(--ddc-text-2);text-transform:uppercase}
.ddc-card-h .ddc-meta{font:400 12px/1 var(--ddc-font);color:var(--ddc-text-3)}
.ddc-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:var(--ddc-gap)}
.ddc-m{padding:16px 18px}
.ddc-m .ddc-l{font:400 12px/1 var(--ddc-font);color:var(--ddc-text-3)}
.ddc-m .ddc-v{margin-top:8px;font:600 30px/1 var(--ddc-mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.ddc-m .ddc-u{font:600 13px/1 var(--ddc-font);color:var(--ddc-text-3);margin-left:4px}
.ddc-m.accent .ddc-v{color:var(--ddc-accent-soft)}
.ddc-split{flex:1;min-height:0;display:grid;grid-template-columns:1.7fr 1fr;gap:var(--ddc-gap)}
.ddc-stack{display:flex;flex-direction:column;gap:var(--ddc-gap);min-height:0}
.ddc-body{padding:var(--ddc-card-pad);display:flex;flex-direction:column;gap:10px}
.ddc-stream{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px 4px 2px 2px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
.ddc-stream::-webkit-scrollbar{width:6px}
.ddc-stream::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
.ddc-ev{display:flex;align-items:baseline;gap:12px;padding:10px 12px;border-radius:var(--ddc-r-sm);border:1px solid var(--ddc-line);background:rgba(0,0,0,.2);animation:ddcEvIn 240ms ease-out}
@keyframes ddcEvIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
.ddc-ev .ddc-time{font:400 12px/1.4 var(--ddc-mono);color:var(--ddc-text-3);white-space:nowrap;font-variant-numeric:tabular-nums}
.ddc-ev .ddc-tag{flex:0 0 auto;padding:3px 8px;border-radius:6px;font:600 11px/1 var(--ddc-font);letter-spacing:.06em}
.ddc-tag.t-think{background:rgba(255,255,255,.06);color:var(--ddc-text-2)}
.ddc-tag.t-read{background:rgba(120,180,255,.12);color:#a8c8f0}
.ddc-tag.t-edit{background:rgba(255,200,120,.14);color:#f0d0a0}
.ddc-tag.t-bash{background:rgba(150,255,200,.1);color:#a0e8c0}
.ddc-tag.t-net{background:rgba(180,150,255,.12);color:#c8b8f0}
.ddc-tag.t-tel{background:rgba(255,255,255,.05);color:var(--ddc-text-3)}
.ddc-tag.t-error{background:rgba(var(--ddc-accent-rgb),.15);color:var(--ddc-accent-soft)}
.ddc-ev .ddc-title{font:400 13px/1.4 var(--ddc-font);color:var(--ddc-text);word-break:break-all}
.ddc-ev.error .ddc-title{color:var(--ddc-accent-soft)}
.ddc-ev .ddc-detail{font:400 12px/1.4 var(--ddc-font);color:var(--ddc-text-3);word-break:break-all}
.ddc-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;padding:28px;color:var(--ddc-text-3);font:400 13px/1.6 var(--ddc-font);text-align:center}
.ddc-kv{display:grid;grid-template-columns:auto 1fr;gap:7px 16px;font:400 13px/1.5 var(--ddc-font)}
.ddc-kv .ddc-k{color:var(--ddc-text-3);white-space:nowrap}
.ddc-kv .ddc-val{color:var(--ddc-text);font-family:var(--ddc-mono);font-size:12px;word-break:break-all;text-align:right}
.ddc-kv .ddc-val.warn{color:var(--ddc-accent-soft)}
.ddc-bar{height:100%;border-radius:5px;background:linear-gradient(90deg,rgba(var(--ddc-accent-rgb),.8),var(--ddc-accent));transition:width 500ms ease}
.ddc-barbg{height:10px;border-radius:5px;background:rgba(255,255,255,.08);overflow:hidden}
.ddc-step{display:flex;align-items:baseline;gap:12px}
.ddc-step .ddc-title{font:600 14px/1.4 var(--ddc-font);word-break:break-all}
.ddc-step.error .ddc-title{color:var(--ddc-accent-soft)}
.ddc-step .ddc-detail{font:400 12px/1.4 var(--ddc-font);color:var(--ddc-text-3);word-break:break-all}
.ddc-tl{width:100%;height:120px;display:block;cursor:crosshair;border-radius:var(--ddc-r-sm)}
.ddc-legend{display:flex;flex-wrap:wrap;gap:6px 16px;padding:2px 4px}
.ddc-legend span{display:inline-flex;align-items:center;gap:6px;font:400 12px/1 var(--ddc-font);color:var(--ddc-text-2)}
.ddc-legend i{width:10px;height:10px;border-radius:2px;background:var(--ddc-text-3)}
.ddc-ctl{display:flex;gap:8px;align-items:center}
.ddc-btn{padding:8px 14px;border-radius:var(--ddc-r-sm);border:1px solid var(--ddc-glass-border);background:var(--ddc-glass);color:var(--ddc-text);font:600 12px/1 var(--ddc-font);cursor:pointer;transition:all var(--ddc-ease)}
.ddc-btn:hover{background:rgba(255,255,255,.12)}
.ddc-btn.primary{background:var(--ddc-accent);border-color:transparent;color:#fff}
.ddc-btn.primary:hover{background:#e0605c}
.ddc-spd{padding:6px 10px;border-radius:6px;border:1px solid var(--ddc-line);background:transparent;color:var(--ddc-text-2);font:600 11px/1 var(--ddc-mono);cursor:pointer}
.ddc-spd.on{border-color:rgba(var(--ddc-accent-rgb),.4);color:var(--ddc-accent-soft);background:rgba(var(--ddc-accent-rgb),.08)}
.ddc-rpsplit{flex:1;min-height:0;display:grid;grid-template-columns:1.25fr 1fr;gap:var(--ddc-gap)}
.ddc-evlist{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:2px 4px 2px 2px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
.ddc-evlist::-webkit-scrollbar{width:6px}
.ddc-evlist::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
.ddc-evlist .ddc-ev{cursor:pointer}
.ddc-evlist .ddc-ev.on{border-color:rgba(var(--ddc-accent-rgb),.5);background:rgba(var(--ddc-accent-rgb),.07)}
.ddc-diff{margin:0;padding:12px 14px;border-radius:var(--ddc-r-sm);border:1px solid var(--ddc-line);background:rgba(0,0,0,.3);font:400 12px/1.6 var(--ddc-mono);color:var(--ddc-text-2);white-space:pre-wrap;word-break:break-all;max-height:220px;overflow-y:auto;scrollbar-width:thin}
.ddc-toolbar{display:flex;gap:10px;align-items:center}
.ddc-search{flex:1;min-width:120px;padding:9px 14px;border-radius:var(--ddc-r-sm);border:1px solid var(--ddc-line);background:rgba(0,0,0,.25);color:var(--ddc-text);font:400 13px/1 var(--ddc-font);outline:none;transition:border-color var(--ddc-ease)}
.ddc-search:focus{border-color:rgba(var(--ddc-accent-rgb),.4)}
.ddc-search::placeholder{color:var(--ddc-text-3)}
.ddc-chips{display:flex;gap:6px}
.ddc-chip{padding:8px 12px;border-radius:999px;border:1px solid var(--ddc-line);background:transparent;color:var(--ddc-text-2);font:500 12px/1 var(--ddc-font);cursor:pointer;transition:all var(--ddc-ease)}
.ddc-chip.on{border-color:rgba(var(--ddc-accent-rgb),.45);color:var(--ddc-accent-soft);background:rgba(var(--ddc-accent-rgb),.08)}
.ddc-livetool{display:flex;flex-direction:column;gap:8px;padding:0 0 8px;border-bottom:1px solid var(--ddc-line)}
.ddc-livetool .ddc-search{flex:none}
.ddc-livetool .ddc-chips{flex-wrap:wrap}
.ddc-subchips{align-items:center;gap:6px}
.ddc-chiplb{flex:none;font:500 10px/1 var(--ddc-font);color:var(--ddc-text-3);letter-spacing:.04em}
.ddc-chip{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ddc-ghead{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:var(--ddc-r-sm);background:rgba(255,255,255,.04);border:1px solid var(--ddc-line);font:600 11px/1.2 var(--ddc-font);color:var(--ddc-text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ddc-ghead .ddc-gt{font:600 12px/1.2 var(--ddc-font);color:var(--ddc-text);overflow:hidden;text-overflow:ellipsis}
.ddc-ghead .ddc-gt.mute{color:var(--ddc-text-2)}
.ddc-ghead .ddc-gtime{margin-left:auto;font:400 11px/1 var(--ddc-mono);color:var(--ddc-text-3);flex:none}
.ddc-dsep{display:flex;align-items:center;gap:8px;margin:4px 0 0;color:var(--ddc-text-3);font:500 10px/1 var(--ddc-font);letter-spacing:.04em}
.ddc-dsep::before,.ddc-dsep::after{content:'';flex:1;height:1px;background:var(--ddc-line)}
.ddc-hlist{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:2px 4px 2px 2px;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.15) transparent}
.ddc-hlist::-webkit-scrollbar{width:6px}
.ddc-hlist::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}
.ddc-hrow{display:grid;grid-template-columns:90px 1.2fr repeat(4,minmax(60px,auto)) auto;gap:10px;align-items:center;padding:14px 18px;border-radius:var(--ddc-r-sm);border:1px solid var(--ddc-line);background:rgba(0,0,0,.2);cursor:pointer;transition:all var(--ddc-ease)}
.ddc-hrow:hover{border-color:var(--ddc-glass-border);background:rgba(0,0,0,.3)}
.ddc-hrow .ddc-hid{font:600 13px/1 var(--ddc-mono);color:var(--ddc-accent-soft)}
.ddc-hrow .ddc-hstart{font:400 13px/1.3 var(--ddc-font);color:var(--ddc-text)}
.ddc-hrow .ddc-num{font:400 13px/1 var(--ddc-mono);font-variant-numeric:tabular-nums;color:var(--ddc-text-2)}
.ddc-hrow .ddc-num.n-err{color:var(--ddc-accent-soft)}
.ddc-hrow .ddc-hacts{display:flex;gap:6px;justify-content:flex-end}
.ddc-st{display:inline-flex;align-items:center;gap:6px;font:500 12px/1 var(--ddc-font)}
.ddc-st::before{content:"";width:6px;height:6px;border-radius:50%}
.ddc-st.rec{color:var(--ddc-accent-soft)}.ddc-st.rec::before{background:var(--ddc-accent);animation:ddcPulse 2s infinite}
.ddc-st.done{color:var(--ddc-text-2)}.ddc-st.done::before{background:rgba(255,255,255,.3)}
.ddc-tip{position:fixed;z-index:2147483600;pointer-events:none;padding:10px 14px;border-radius:10px;border:1px solid var(--ddc-glass-border);background:rgba(12,12,18,.96);box-shadow:0 8px 24px rgba(0,0,0,.5);font:400 12px/1.5 var(--ddc-font);color:var(--ddc-text);max-width:420px;display:none}
.ddc-tip .ddc-tt{font:600 12px/1.4 var(--ddc-font);margin-bottom:2px}
.ddc-tip .ddc-td{color:var(--ddc-text-3)}
.ddc-tip .ddc-tt.error{color:var(--ddc-accent-soft)}
@media (max-width:1024px){.ddc-metrics{grid-template-columns:repeat(2,1fr)}.ddc-split,.ddc-rpsplit{grid-template-columns:1fr}.ddc-hrow{grid-template-columns:80px 1fr repeat(4,minmax(52px,auto));font-size:12px}}
@media (max-width:767px){.ddc-root{right:12px;bottom:12px;width:calc(100vw - 24px);height:calc(100vh - 72px)}.ddc-badge{right:12px;bottom:12px}.ddc-page{padding:16px;gap:14px}.ddc-metrics{grid-template-columns:repeat(2,1fr)}.ddc-m .ddc-v{font-size:24px}.ddc-hrow{grid-template-columns:70px 1fr auto auto;grid-auto-flow:row}.ddc-hrow .ddc-hstart{grid-column:2}.ddc-topbar h1{font-size:18px}}
`;

// dsh-dashcam 面板 UI（纯 DOM，不依赖 React——React 只在 client.body.js 挂插槽）。
// 视觉与交互移植自参考稿 dashcam.html：实时/回放/录像历史三视图、时间轴画布、
// 事件流、检索过滤。数据形状见 lib/panel.js sanitizeRecord/computeStatus/
// clusterSessions——面板只消费脱敏后的展示形状，不接触账本原文。

// ---------- i18n：zh / en 双语词典 ----------
// 中文文案与 1.x 逐字节一致（勿顺手润色）；英文用自然 UI English。
// 语言持久化在 localStorage["ddc-lang"]，默认按 navigator.language 探测。
const LANG_KEY = 'ddc-lang';
const I18N = {
  zh: {
    'type.think': 'LLM',
    'type.read': '读取',
    'type.edit': '编辑',
    'type.bash': '命令',
    'type.net': '出网',
    'type.tel': '遥测',
    'type.error': '异常',
    'sub.title': '判定链账本 · 实时录制与回放',
    'close.title': '关闭（Esc）',
    'lang.title': '切换语言 / Switch language',
    'tab.live': '实时录制',
    'tab.replay': '回放',
    'tab.history': '录像历史',
    'metric.elapsed': '运行时长',
    'metric.tools': '纳管调用',
    'metric.files': '改动文件',
    'metric.errors': '异常',
    'card.stream': '实时事件流',
    'card.step': '当前步骤',
    'card.judge': '判定链状态',
    'card.events': '事件',
    'card.detail': '事件详情',
    'card.history': '录像历史',
    'judge.axis': '拦截 / 判定',
    'stream.count': '共 {n} 条',
    'step.waiting': '等待事件',
    'kv.mode': '模式',
    'mode.enforce': 'enforce（强制）',
    'mode.advisory': 'advisory（旁路）',
    'kv.bypass': '旁路命中',
    'unit.bypass': '次（deny 未拦截）',
    'kv.unmapped': '未纳管调用',
    'unit.unmapped': '次（telemetry）',
    'kv.version': '插件版本',
    'kv.session': '会话 ID',
    'kv.model': '模型',
    'kv.ledger': '账本记录',
    'unit.windowed': '（窗口截断）',
    'kv.ledgerPath': '账本路径',
    'empty.stream': '等待账本记录…',
    'group.system': '系统',
    'group.session': '会话 {id}',
    'chip.deniedOnly': '仅拦截',
    'chip.window': '窗口',
    'chip.date': '日期',
    'live.search.ph': '搜索关键词（插件 / 消息 / 路径 / 命令 / 主机 / 规则）…',
    'search.results': '{n} 条结果',
    'search.empty': '没有匹配的事件',
    'search.truncated': '账本较大，仅搜索了最近 8MB',
    'deny.prefix': '[拒绝] ',
    'rp.pick': '选择录像',
    'rp.sessionTitle': '{id} · {date}（{events} 事件 / {errors} 异常）',
    'rp.recent': '最近记录',
    'unit.entries': '条',
    'rp.truncated': '已截断（只载入前 2000 条）',
    'rp.empty': '该录像段没有可用记录',
    'speed.label': '速度',
    'play': '播放',
    'pause': '暂停',
    'detail.hint': '点击时间轴或事件查看详情',
    'kv.time': '时间点',
    'kv.rel': '相对',
    'kv.seq': '序号',
    'kv.rule': '规则',
    'kv.decision': '决策',
    'kv.intercepted': '（已拦截）',
    'kv.paths': '路径',
    'kv.commands': '命令',
    'kv.hosts': '主机',
    'kv.commandLine': '命令行',
    'search.placeholder': '搜索 ID / 日期…',
    'chip.all': '全部',
    'chip.recording': '录制中',
    'chip.completed': '已完成',
    'st.recording': '录制中',
    'st.completed': '已完成',
    'empty.history.match': '没有匹配的录像',
    'empty.history.none': '账本里还没有录像段',
    'unit.sessions': '段',
    'time.secAgo': '秒前',
    'time.minAgo': '分钟前',
    'unit.events': '事件',
    'unit.errors': '异常',
    // 事件标题/详情：宿主发结构化 key，面板按当前语言渲染。
    // 中文串与旧版宿主侧拼装逐字节一致，勿顺手润色。
    'ev.read': '读取 {target}',
    'ev.readBare': '读取',
    'ev.edit': '编辑 {target}',
    'ev.editBare': '编辑',
    'ev.delete': '删除 {target}',
    'ev.deleteBare': '删除',
    'ev.command': '命令 {target}',
    'ev.commandBare': '命令',
    'ev.net': '出网 {target}',
    'ev.netBare': '出网',
    'ev.llmRequest': 'LLM 请求',
    'ev.inbound': '入站消息',
    'ev.anomaly': '入站异常',
    'ev.commandLine': '命令行存档',
    'ev.unmapped': '未映射 · {tool}',
    'ev.unmappedBare': '未映射工具',
    'ev.unjudgeable': '无法判定 · {tool}',
    'ev.unjudgeableBare': '无法判定',
    'ev.mount': '判定链挂载',
    'ev.ingressMount': 'ingress 挂载',
    'ev.ingressDisabled': 'ingress 关闭',
    'evd.morePaths': '等 {n} 个路径',
    'evd.moreCommands': '等 {n} 条',
    'evd.messages': '{n} 条消息',
    'evd.chars': '{n} 字',
    'evd.mountMode': '模式 {mode}',
    'evd.disabled': '未启用',
    'badge.title': 'Agent Dashcam（Ctrl+Shift+D，拖动可换位置）',
  },
  en: {
    'type.think': 'LLM',
    'type.read': 'Reading',
    'type.edit': 'Edit',
    'type.bash': 'Command',
    'type.net': 'Network',
    'type.tel': 'Telemetry',
    'type.error': 'Error',
    'sub.title': 'Judgment ledger · live recording & replay',
    'close.title': 'Close (Esc)',
    'lang.title': 'Switch language / 切换语言',
    'tab.live': 'Live',
    'tab.replay': 'Replay',
    'tab.history': 'History',
    'metric.elapsed': 'Running time',
    'metric.tools': 'Monitored calls',
    'metric.files': 'Files touched',
    'metric.errors': 'Errors',
    'card.stream': 'Live events',
    'card.step': 'Current step',
    'card.judge': 'Judgment chain',
    'card.events': 'Events',
    'card.detail': 'Event detail',
    'card.history': 'Recording history',
    'judge.axis': 'Intercepted / Judged',
    'stream.count': '{n} entries',
    'step.waiting': 'Waiting for events',
    'kv.mode': 'Mode',
    'mode.enforce': 'enforce (blocking)',
    'mode.advisory': 'advisory (bypass)',
    'kv.bypass': 'Bypass hits',
    'unit.bypass': 'hits (deny not enforced)',
    'kv.unmapped': 'Unmonitored calls',
    'unit.unmapped': 'hits (telemetry)',
    'kv.version': 'Plugin version',
    'kv.session': 'Session ID',
    'kv.model': 'Model',
    'kv.ledger': 'Ledger entry',
    'unit.windowed': ' (windowed)',
    'kv.ledgerPath': 'Ledger path',
    'empty.stream': 'Waiting for ledger entries…',
    'group.system': 'System',
    'group.session': 'Session {id}',
    'chip.deniedOnly': 'Intercepted only',
    'chip.window': 'Window',
    'chip.date': 'Date',
    'live.search.ph': 'Search (plugin / message / path / command / host / rule)…',
    'search.results': '{n} results',
    'search.empty': 'No matching events',
    'search.truncated': 'Large ledger: only the most recent 8 MB searched',
    'deny.prefix': '[denied] ',
    'rp.pick': 'Select a recording',
    'rp.sessionTitle': '{id} · {date} ({events} events / {errors} errors)',
    'rp.recent': 'Recent recording',
    'unit.entries': 'entries',
    'rp.truncated': 'Truncated (first 2000 entries only)',
    'rp.empty': 'No records in this segment',
    'speed.label': 'Speed',
    'play': 'Play',
    'pause': 'Pause',
    'detail.hint': 'Click the timeline or an event for details',
    'kv.time': 'At',
    'kv.rel': 'Offset',
    'kv.seq': 'Seq',
    'kv.rule': 'Rule',
    'kv.decision': 'Decision',
    'kv.intercepted': ' (blocked)',
    'kv.paths': 'Path',
    'kv.commands': 'Command',
    'kv.hosts': 'Hosts',
    'kv.commandLine': 'Command line',
    'search.placeholder': 'Search ID / date…',
    'chip.all': 'All',
    'chip.recording': 'Recording',
    'chip.completed': 'Completed',
    'st.recording': 'Recording',
    'st.completed': 'Completed',
    'empty.history.match': 'No matching recordings',
    'empty.history.none': 'No recordings in the ledger yet',
    'unit.sessions': 'sessions',
    'time.secAgo': 'sec ago',
    'time.minAgo': 'min ago',
    'unit.events': 'events',
    'unit.errors': 'errors',
    'ev.read': 'Reading {target}',
    'ev.readBare': 'Reading',
    'ev.edit': 'Editing {target}',
    'ev.editBare': 'Editing',
    'ev.delete': 'Deleting {target}',
    'ev.deleteBare': 'Deleting',
    'ev.command': 'Command {target}',
    'ev.commandBare': 'Command',
    'ev.net': 'Outbound {target}',
    'ev.netBare': 'Outbound',
    'ev.llmRequest': 'LLM request',
    'ev.inbound': 'Inbound message',
    'ev.anomaly': 'Inbound anomaly',
    'ev.commandLine': 'Command line archive',
    'ev.unmapped': 'Unmapped · {tool}',
    'ev.unmappedBare': 'Unmapped tool',
    'ev.unjudgeable': 'Unjudgeable · {tool}',
    'ev.unjudgeableBare': 'Unjudgeable',
    'ev.mount': 'Judgment chain mounted',
    'ev.ingressMount': 'Ingress mounted',
    'ev.ingressDisabled': 'Ingress disabled',
    'evd.morePaths': '{n} paths total',
    'evd.moreCommands': '{n} commands total',
    'evd.messages': '{n} messages',
    'evd.chars': '{n} chars',
    'evd.mountMode': 'Mode {mode}',
    'evd.disabled': 'Not enabled',
    'badge.title': 'Agent Dashcam (Ctrl+Shift+D, drag to move)',
  },
};
// 切换按钮永远显示「可切换到的那个语言」的名字，方便用户随时找到它。
const LANG_TOGGLE_LABEL = { zh: 'EN', en: '中文' };

// 宿主侧测试用：断言 zh/en 两包 key 集合一致（build.mjs 拼接时会剥掉 export 前缀）。
const DASHCAM_I18N = I18N;

// 徽章 tooltip 由 engine 持有（不在面板 DOM 里），挂在面板外按当前语言取文案。
function badgeTitle() {
  return t('badge.title');
}

function detectLanguage() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* 隐私模式等场景 localStorage 不可用 */ }
  const nav = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let lang = detectLanguage();

function t(key) {
  const pack = I18N[lang] || I18N.en;
  return Object.prototype.hasOwnProperty.call(pack, key) ? pack[key] : key;
}

function tf(key, params) {
  let text = t(key);
  for (const name of Object.keys(params)) text = text.replace(`{${name}}`, String(params[name]));
  return text;
}

function typeText(type) {
  const key = `type.${type}`;
  const pack = I18N[lang] || I18N.en;
  return Object.prototype.hasOwnProperty.call(pack, key) ? pack[key] : type;
}

// 事件标题/详情：宿主发结构化 key + 变量（见 lib/panel.js sanitizeRecord），
// 这里按当前语言渲染。字符串部分原样输出（路径/命令/主机等数据），{k,v} 查词典。
function evPart(part) {
  if (typeof part === 'string') return part;
  if (!part || !part.k) return '';
  return part.v ? tf(part.k, part.v) : t(part.k);
}

function evTitle(e) {
  return e.titleKey ? evPart({ k: e.titleKey, v: e.titleVars }) : (e.titleText || '');
}

function evDetail(e) {
  const parts = Array.isArray(e.detailParts) ? e.detailParts : [];
  return parts.map(evPart).filter(Boolean).join(' · ');
}

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

function createDashcamPanel(options) {
  const api = options.api || {};
  const root = document.createElement('div');
  root.style.display = 'none';

  const state = {
    view: 'live',
    status: null,
    live: [],           // 升序的脱敏记录（实时流，尾部窗口）
    renderedSeq: 0,     // 已渲染到流里的最大 seq
    elapsedSec: null,
    hist: { sessions: [], filter: 'all', query: '' },
    rp: { session: null, events: [], dur: 0, t: 0, playing: false, speed: 1, active: -1, startStamp: 0, truncated: false },
    // 2.2.0：实时视图会话归属 + 分类过滤 + 静默搜索
    liveFilter: { types: new Set(), deniedOnly: false, sessions: new Set(), dates: new Set() },
    sessionDir: new Map(), // sessionId -> 标题|null（null session 不入表）
    liveSearch: { query: '', records: [], total: 0, truncated: false, active: false },
  };
  let rafId = 0;
  let tipEl = null;
  let els = null;
  let resizeObserver = null;
  const disposers = [];

  // ---------- DOM 骨架（语言切换时按当前词典重跑） ----------
  function panelTemplate() {
    return `
    <div class="ddc-page">
      <header class="ddc-topbar">
        <div>
          <h1>Agent Dashcam</h1>
          <p class="ddc-sub">${t('sub.title')}</p>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div class="ddc-rec"><span class="ddc-dot"></span><span class="ddc-lb">REC</span><span class="ddc-time num">--:--:--</span></div>
          <button class="ddc-btn ddc-lang" data-ddc-lang="1" title="${t('lang.title')}" style="padding:7px 10px;font:600 11px/1 var(--ddc-mono);color:var(--ddc-text-2)">${LANG_TOGGLE_LABEL[lang] || 'EN'}</button>
          <button class="ddc-close" title="${t('close.title')}">×</button>
        </div>
      </header>
      <nav class="ddc-tabs">
        <button class="ddc-tab on" data-ddc-view="live">${t('tab.live')}</button>
        <button class="ddc-tab" data-ddc-view="replay">${t('tab.replay')}</button>
        <button class="ddc-tab" data-ddc-view="history">${t('tab.history')}</button>
      </nav>

      <section class="ddc-view on" data-ddc-viewcard="live">
        <div class="ddc-metrics">
          <div class="ddc-card ddc-m"><div class="ddc-l">${t('metric.elapsed')}</div><div class="ddc-v ddc-m-elapsed">--:--:--</div></div>
          <div class="ddc-card ddc-m"><div class="ddc-l">${t('metric.tools')}</div><div class="ddc-v ddc-m-tools">0</div></div>
          <div class="ddc-card ddc-m"><div class="ddc-l">${t('metric.files')}</div><div class="ddc-v ddc-m-files">0</div></div>
          <div class="ddc-card ddc-m accent"><div class="ddc-l">${t('metric.errors')}</div><div class="ddc-v ddc-m-errors">0</div></div>
        </div>
        <div class="ddc-split">
          <section class="ddc-card" style="display:flex;flex-direction:column;min-height:0">
            <div class="ddc-card-h"><h2>${t('card.stream')}</h2><span class="ddc-meta ddc-stream-meta">${tf('stream.count', { n: 0 })}</span></div>
            <div class="ddc-livetool">
              <input class="ddc-search ddc-lsearch" placeholder="${t('live.search.ph')}" />
              <div class="ddc-chips">
                <button class="ddc-chip on" data-ddc-lf="all">${t('chip.all')}</button>
                ${TYPE_ORDER.map((type) => `<button class="ddc-chip" data-ddc-lf="${type}">${typeText(type)}</button>`).join('')}
                <button class="ddc-chip" data-ddc-lf="denied">${t('chip.deniedOnly')}</button>
              </div>
              <div class="ddc-chips ddc-subchips"><span class="ddc-chiplb">${t('chip.window')}</span><span class="ddc-dynchips" data-ddc-dyn="session"></span></div>
              <div class="ddc-chips ddc-subchips"><span class="ddc-chiplb">${t('chip.date')}</span><span class="ddc-dynchips" data-ddc-dyn="date"></span></div>
            </div>
            <div class="ddc-body" style="flex:1;min-height:0">
              <div class="ddc-stream"></div>
            </div>
          </section>
          <div class="ddc-stack">
            <section class="ddc-card">
              <div class="ddc-card-h"><h2>${t('card.step')}</h2><span class="ddc-meta ddc-step-age">—</span></div>
              <div class="ddc-body">
                <div class="ddc-step"><span class="ddc-tag t-tel ddc-step-tag">…</span><div><div class="ddc-title ddc-step-title">${t('step.waiting')}</div><div class="ddc-detail ddc-step-detail">—</div></div></div>
              </div>
            </section>
            <section class="ddc-card">
              <div class="ddc-card-h"><h2>${t('card.judge')}</h2></div>
              <div class="ddc-body">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                  <span style="font:400 12px/1 var(--ddc-font);color:var(--ddc-text-3)">${t('judge.axis')}</span>
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
            <div style="font:600 14px/1.3 var(--ddc-font)"><span class="ddc-rp-title">${t('rp.pick')}</span></div>
            <div style="font:400 12px/1 var(--ddc-mono);color:var(--ddc-text-3)" class="ddc-rp-clock">--:--:--</div>
          </div>
          <canvas class="ddc-tl"></canvas>
          <div class="ddc-legend"></div>
          <div class="ddc-ctl">
            <button class="ddc-btn primary ddc-play">${t('play')}</button>
            <span style="flex:1"></span>
            <span style="font:400 12px/1 var(--ddc-font);color:var(--ddc-text-3)">${t('speed.label')}</span>
            ${SPEEDS.map((s) => `<button class="ddc-spd${s === 1 ? ' on' : ''}" data-ddc-spd="${s}">${s}×</button>`).join('')}
          </div>
        </section>
        <div class="ddc-rpsplit">
          <section class="ddc-card" style="display:flex;flex-direction:column;min-height:0">
            <div class="ddc-card-h"><h2>${t('card.events')}</h2><span class="ddc-meta ddc-rp-meta">—</span></div>
            <div class="ddc-body" style="flex:1;min-height:0">
              <div class="ddc-evlist"></div>
            </div>
          </section>
          <section class="ddc-card" style="display:flex;flex-direction:column;min-height:0">
            <div class="ddc-card-h"><h2>${t('card.detail')}</h2></div>
            <div class="ddc-body ddc-rp-detail" style="flex:1;min-height:0;overflow-y:auto"></div>
          </section>
        </div>
      </section>

      <section class="ddc-view" data-ddc-viewcard="history">
        <div class="ddc-toolbar">
          <input class="ddc-search ddc-hsearch" placeholder="${t('search.placeholder')}" />
          <div class="ddc-chips">
            <button class="ddc-chip on" data-ddc-hf="all">${t('chip.all')}</button>
            <button class="ddc-chip" data-ddc-hf="recording">${t('chip.recording')}</button>
            <button class="ddc-chip" data-ddc-hf="completed">${t('chip.completed')}</button>
          </div>
        </div>
        <div class="ddc-card" style="flex:1;min-height:0;display:flex;flex-direction:column">
          <div class="ddc-card-h"><h2>${t('card.history')}</h2><span class="ddc-meta ddc-hist-meta">—</span></div>
          <div class="ddc-body" style="flex:1;min-height:0">
            <div class="ddc-hlist"></div>
          </div>
        </div>
      </section>
    </div>`;
  }

  function collectEls() {
    const $ = (sel) => root.querySelector(sel);
    return {
      rec: $('.ddc-rec'),
      recTime: $('.ddc-rec .ddc-time'),
      close: $('.ddc-close'),
      lang: $('.ddc-lang'),
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
      search: $('.ddc-hsearch'),
      lsearch: $('.ddc-lsearch'),
      histChips: [...root.querySelectorAll('.ddc-chip[data-ddc-hf]')],
      liveChips: [...root.querySelectorAll('.ddc-chip[data-ddc-lf]')],
      dynSession: root.querySelector('.ddc-dynchips[data-ddc-dyn="session"]'),
      dynDate: root.querySelector('.ddc-dynchips[data-ddc-dyn="date"]'),
      chips: [...root.querySelectorAll('.ddc-chip[data-ddc-hf]')],
      hlist: $('.ddc-hlist'),
      histMeta: $('.ddc-hist-meta'),
    };
  }

  function buildDom(preserveTabs) {
    // 语言切换时保留 .ddc-tabs 节点：engine 对它挂了 MutationObserver（历史视图
    // 按需刷新），节点换新会让 observer 盯着游离节点，历史自动刷新从此失效。
    const savedNav = preserveTabs && els ? els.tabs[0].parentElement : null;
    root.className = 'ddc-root';
    root.setAttribute('data-ddc-root', '1');
    root.innerHTML = panelTemplate();
    if (savedNav) {
      root.querySelector('.ddc-tabs').replaceWith(savedNav);
      const tabKeys = { live: 'tab.live', replay: 'tab.replay', history: 'tab.history' };
      savedNav.querySelectorAll('.ddc-tab').forEach((btn) => {
        btn.textContent = t(tabKeys[btn.dataset.ddcView] || btn.dataset.ddcView);
      });
    }
    els = collectEls();
    wireEvents(!savedNav);
    els.legend.innerHTML = TYPE_ORDER.map((type) => `<span><i style="background:${MARK[type][1]}"></i>${typeText(type)}</span>`).join('');
    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (state.view === 'replay') drawTimeline();
    });
    resizeObserver.observe(els.tl);
  }

  function wireEvents(wireTabs) {
    if (wireTabs) {
      els.tabs.forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.ddcView)));
    }
    els.lang.addEventListener('click', switchLanguage);
    els.close.addEventListener('click', () => {
      if (typeof options.onClose === 'function') options.onClose();
    });
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
      tip.innerHTML = `<div class="ddc-tt${e.type === 'error' || e.denied ? ' error' : ''}">${esc(typeText(e.type) || e.type)} · #${e.seq} · +${shortHms(e.t)}</div>
        <div class="ddc-tt">${esc(evTitle(e))}</div>
        <div class="ddc-td">${esc(evDetail(e))}</div>`;
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
    els.histChips.forEach((chip) =>
      chip.addEventListener('click', () => {
        state.hist.filter = chip.dataset.ddcHf || 'all';
        els.histChips.forEach((c) => c.classList.toggle('on', c === chip));
        renderHistory();
      }),
    );
    // 实时流搜索：输入停顿 400ms 后交给 engine（fetch /search），清空即恢复事件流。
    let liveSearchTimer = 0;
    els.lsearch.addEventListener('input', () => {
      const query = (els.lsearch.value || '').trim();
      if (liveSearchTimer) clearTimeout(liveSearchTimer);
      if (!query) {
        state.liveSearch = { query: '', records: [], total: 0, truncated: false, active: false };
        renderStream();
        return;
      }
      liveSearchTimer = setTimeout(() => {
        liveSearchTimer = 0;
        if (typeof options.onLiveSearch === 'function') options.onLiveSearch(query);
      }, 400);
    });
    // 分类 chip：多选类型 + 独立的「仅拦截」。无选中类型 = 全部。
    els.liveChips.forEach((chip) =>
      chip.addEventListener('click', () => {
        const key = chip.dataset.ddcLf || 'all';
        if (key === 'all') {
          // 「全部」复位所有维度：类型 + 会话 + 日期（仅拦截是独立开关，不动）。
          state.liveFilter.types.clear();
          state.liveFilter.sessions.clear();
          state.liveFilter.dates.clear();
        } else if (key === 'denied') {
          state.liveFilter.deniedOnly = !state.liveFilter.deniedOnly;
        } else if (state.liveFilter.types.has(key)) {
          state.liveFilter.types.delete(key);
        } else {
          state.liveFilter.types.add(key);
        }
        syncLiveChips();
        renderStream();
      }),
    );
  }

  function syncLiveChips() {
    els.liveChips.forEach((chip) => {
      const key = chip.dataset.ddcLf || 'all';
      const on = key === 'all'
        ? state.liveFilter.types.size === 0 && state.liveFilter.sessions.size === 0
          && state.liveFilter.dates.size === 0 && !state.liveFilter.deniedOnly
        : key === 'denied' ? state.liveFilter.deniedOnly : state.liveFilter.types.has(key);
      chip.classList.toggle('on', on);
    });
  }

  // 语言切换：同一 root 节点上原位重建 DOM（panel.el 身份不变，engine 侧
  // appendChild / display 控制 / 快捷查询都不受影响），state 全保留，
  // 重建后按当前视图从 state 重新渲染，不丢已收到的事件。
  function rebuild() {
    const wasPlaying = state.rp.playing;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    state.rp.playing = false;
    buildDom(true);
    els.search.value = state.hist.query;
    els.lsearch.value = state.liveSearch.query;
    els.chips.forEach((c) => c.classList.toggle('on', (c.dataset.ddcHf || 'all') === state.hist.filter));
    syncLiveChips();
    state.renderedSeq = 0;
    updateLive(null, null);
    if (state.rp.session || state.rp.events.length) renderReplayList();
    setView(state.view);
    const text = state.elapsedSec == null ? '--:--:--' : hms(state.elapsedSec);
    els.recTime.textContent = text;
    els.mElapsed.textContent = text;
    updateStepAge();
    if (wasPlaying && state.rp.events.length && state.rp.t < state.rp.dur) play();
  }

  function switchLanguage() {
    lang = lang === 'zh' ? 'en' : 'zh';
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch { /* 同 detectLanguage：localStorage 不可用时不落盘，仅本次生效 */ }
    rebuild();
    if (typeof options.onLanguageChange === 'function') options.onLanguageChange();
  }

  buildDom(false);

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
    tag.textContent = typeText(e.type);
    const main = document.createElement('div');
    main.style.minWidth = '0';
    main.style.flex = '1';
    const title = document.createElement('div');
    title.className = 'ddc-title';
    title.textContent = (e.denied && e.type !== 'error' ? t('deny.prefix') : '') + (evTitle(e) || '—');
    const detail = document.createElement('div');
    detail.className = 'ddc-detail';
    detail.textContent = evDetail(e);
    main.appendChild(title);
    if (detail.textContent) main.appendChild(detail);
    row.appendChild(time);
    row.appendChild(tag);
    row.appendChild(main);
    return row;
  }

  function extraBlock(e) {
    const lines = [];
    if (e.ruleId) lines.push(`${t('kv.rule')}   ${e.ruleId}`);
    lines.push(`${t('kv.decision')}   ${e.denied ? 'deny' : 'allow'}${e.intercepted ? t('kv.intercepted') : ''}`);
    if (e.extra && Array.isArray(e.extra.paths) && e.extra.paths.length) {
      lines.push(`${t('kv.paths')}   ${e.extra.paths.join('\n       ')}`);
    }
    if (e.extra && Array.isArray(e.extra.commands) && e.extra.commands.length) {
      lines.push(`${t('kv.commands')}   ${e.extra.commands.join('\n       ')}`);
    }
    if (e.extra && Array.isArray(e.extra.hosts) && e.extra.hosts.length) {
      lines.push(`${t('kv.hosts')}   ${e.extra.hosts.join(', ')}`);
    }
    if (e.extra && typeof e.extra.commandLine === 'string' && e.extra.commandLine) {
      lines.push(`${t('kv.commandLine')} ${e.extra.commandLine}`);
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
      kv.push([t('kv.mode'), s.mode === 'enforce' ? t('mode.enforce') : s.mode === 'advisory' ? t('mode.advisory') : '—', s.mode === 'enforce']);
      kv.push([t('kv.bypass'), `${counts.bypass || 0} ${t('unit.bypass')}`, false]);
      kv.push([t('kv.unmapped'), `${counts.unmapped || 0} ${t('unit.unmapped')}`, false]);
      kv.push([t('kv.version'), s.version || '—', false]);
      if (s.session && s.session.id) kv.push([t('kv.session'), s.session.id, false]);
      if (s.session && s.session.model) kv.push([t('kv.model'), s.session.model, false]);
      kv.push([t('kv.ledger'), `#${s.ledgerSeq || 0}${s.windowed ? t('unit.windowed') : ''}`, false]);
      if (s.ledgerPath) kv.push([t('kv.ledgerPath'), s.ledgerPath, false]);
      els.sessionKv.innerHTML = kv
        .map(([k, v, warn]) => `<div class="ddc-k">${esc(k)}</div><div class="ddc-val${warn ? ' warn' : ''}">${esc(v)}</div>`)
        .join('');
    }

    if (Array.isArray(records) && records.length) {
      state.live = state.live.concat(records).slice(-400);
    }
    // 2.2.0：流改为「会话分组 + 日期分隔」整体重画（scroll 位置保留）；搜索
    // 结果接管流容器期间，事件只进 state 不动 DOM，避免打断查看。
    if (state.liveSearch.active) {
      els.streamMeta.textContent = tf('search.results', { n: state.liveSearch.total });
    } else {
      renderStream();
    }

    const last = state.live.length ? state.live[state.live.length - 1] : s && s.lastEvent ? s.lastEvent : null;
    if (last) {
      const isError = last.type === 'error' || last.denied;
      els.stepTag.className = `ddc-tag t-${last.type}`;
      els.stepTag.textContent = typeText(last.type);
      els.stepTitle.textContent = (last.denied && last.type !== 'error' ? t('deny.prefix') : '') + (evTitle(last) || '—');
      els.stepTitle.parentElement.parentElement.classList.toggle('error', !!isError);
      els.stepDetail.textContent = evDetail(last) || '—';
      if (last.ts) els.stepAge.dataset.ddcTs = last.ts;
    }
  }

  function updateStepAge() {
    if (!els.stepAge.dataset.ddcTs) return;
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(els.stepAge.dataset.ddcTs)) / 1000));
    els.stepAge.textContent = age < 60 ? `${age} ${t('time.secAgo')}` : `${Math.floor(age / 60)} ${t('time.minAgo')}`;
  }

  // ---------- 实时流分组（2.2.0） ----------
  // 会话标签：目录里有标题用标题；没有标题降级「会话 + id 前 8 位」；
  // 无归属（null）归「系统」组。
  function sessionLabel(sid) {
    if (!sid) return { label: t('group.system'), known: true };
    const title = state.sessionDir.get(sid);
    if (title) return { label: title, known: true };
    return { label: tf('group.session', { id: sid.slice(0, 8) }), known: false };
  }

  function liveFilterPass(e) {
    if (state.liveFilter.deniedOnly && !(e.denied || e.intercepted)) return false;
    if (state.liveFilter.types.size && !state.liveFilter.types.has(e.type)) return false;
    if (state.liveFilter.sessions.size && !state.liveFilter.sessions.has(e.session || '')) return false;
    if (state.liveFilter.dates.size && !state.liveFilter.dates.has(dateKey(e.ts))) return false;
    return true;
  }

  function dateKey(ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function dateLabel(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // chip 行的紧凑日期文案（不带年份，避免行宽爆炸）
  function chipDateLabel(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
  }

  // 会话/日期 chip 行：从 state.live 派生（用未过滤集合——过滤到 0 条时 chip
  // 仍在，用户能点回别的窗口/日期）。行内新→旧；点击切换选中后整体重画。
  function renderDynChips() {
    const sessions = new Map(); // key(''=系统) -> { label, n }
    const dates = new Map();    // dateKey -> { ts, n }
    for (let i = state.live.length - 1; i >= 0; i -= 1) {
      const e = state.live[i];
      const sidKey = e.session || '';
      if (!sessions.has(sidKey)) sessions.set(sidKey, { label: sessionLabel(e.session || null).label });
      const dk = dateKey(e.ts);
      if (dk && !dates.has(dk)) dates.set(dk, { ts: e.ts });
    }
    const mkChip = (label, on, onClick) => {
      const chip = document.createElement('button');
      chip.className = `ddc-chip${on ? ' on' : ''}`;
      chip.textContent = label;
      chip.addEventListener('click', onClick);
      return chip;
    };
    els.dynSession.replaceChildren(...[...sessions.entries()].map(([key, s]) =>
      mkChip(s.label, state.liveFilter.sessions.has(key), () => {
        if (state.liveFilter.sessions.has(key)) state.liveFilter.sessions.delete(key);
        else state.liveFilter.sessions.add(key);
        syncLiveChips();
        renderStream();
      }),
    ));
    els.dynDate.replaceChildren(...[...dates.entries()].map(([dk, d]) =>
      mkChip(chipDateLabel(d.ts), state.liveFilter.dates.has(dk), () => {
        if (state.liveFilter.dates.has(dk)) state.liveFilter.dates.delete(dk);
        else state.liveFilter.dates.add(dk);
        syncLiveChips();
        renderStream();
      }),
    ));
  }

  // 组头 = 窗口标题 + 起始时间；组内跨天插日期分隔条。整体重画但保留 scroll。
  function renderStream() {
    const scroller = els.stream;
    const savedScroll = scroller.scrollTop;
    const list = state.live.filter(liveFilterPass); // 升序
    const frag = document.createDocumentFragment();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'ddc-empty';
      empty.textContent = state.live.length ? t('search.empty') : t('empty.stream');
      frag.appendChild(empty);
    } else {
      // 相邻同 session 的连续段为一组（state.live 升序，从旧到新扫）；
      // 展示序仍是新在上：组按新→旧排，组内事件也新→旧。
      const runs = [];
      for (const e of list) {
        const sid = e.session || null;
        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun.sid === sid) lastRun.items.push(e);
        else runs.push({ sid, items: [e] });
      }
      for (let ri = runs.length - 1; ri >= 0; ri -= 1) {
        const run = runs[ri];
        const meta = sessionLabel(run.sid);
        const head = document.createElement('div');
        head.className = 'ddc-ghead';
        head.innerHTML = `<span class="ddc-gt${meta.known ? '' : ' mute'}">${esc(meta.label)}</span>`
          + `<span class="ddc-gtime">${esc(dateShort(run.items[0].ts))}</span>`;
        frag.appendChild(head);
        let prevDate = '';
        for (let ii = run.items.length - 1; ii >= 0; ii -= 1) {
          const e = run.items[ii];
          const dk = dateKey(e.ts);
          if (dk && dk !== prevDate) {
            const sep = document.createElement('div');
            sep.className = 'ddc-dsep';
            sep.textContent = dateLabel(e.ts);
            frag.appendChild(sep);
            prevDate = dk;
          }
          frag.appendChild(evRow(e, clock(e.ts), false));
        }
      }
    }
    scroller.replaceChildren(frag);
    scroller.scrollTop = savedScroll;
    els.streamMeta.textContent = tf('stream.count', { n: state.live.length });
    renderDynChips();
  }

  // 搜索结果接管流容器：按 窗口 → 日期 → 类型 三层组织。
  function showLiveSearch(result) {
    state.liveSearch = {
      query: result.query || '',
      records: Array.isArray(result.records) ? result.records : [],
      total: Number(result.total) || 0,
      truncated: result.truncated === true,
      active: true,
    };
    const scroller = els.stream;
    const savedScroll = scroller.scrollTop;
    const frag = document.createDocumentFragment();
    const records = state.liveSearch.records; // 新→旧
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'ddc-empty';
      empty.textContent = t('search.empty');
      frag.appendChild(empty);
    } else {
      // 第一层：会话窗口（连续段；搜索结果按时间混排，同会话可能分段出现）
      const runs = [];
      for (const e of records) {
        const sid = e.session || null;
        const lastRun = runs[runs.length - 1];
        if (lastRun && lastRun.sid === sid) lastRun.items.push(e);
        else runs.push({ sid, items: [e] });
      }
      for (const run of runs) {
        const meta = sessionLabel(run.sid);
        const head = document.createElement('div');
        head.className = 'ddc-ghead';
        head.innerHTML = `<span class="ddc-gt${meta.known ? '' : ' mute'}">${esc(meta.label)}</span>`
          + `<span class="ddc-gtime">${esc(dateShort(run.items[0].ts))}</span>`;
        frag.appendChild(head);
        let prevDate = '';
        let prevType = '';
        for (const e of run.items) {
          const dk = dateKey(e.ts);
          if (dk && dk !== prevDate) {
            const sep = document.createElement('div');
            sep.className = 'ddc-dsep';
            sep.textContent = dateLabel(e.ts);
            frag.appendChild(sep);
            prevDate = dk;
            prevType = '';
          }
          // 第二层内第三层：同类型连续块合并标题（类型 chip 行），不同类型插行
          if (e.type !== prevType) {
            const typeHead = document.createElement('div');
            typeHead.className = 'ddc-dsep';
            typeHead.textContent = typeText(e.type);
            frag.appendChild(typeHead);
            prevType = e.type;
          }
          frag.appendChild(evRow(e, clock(e.ts), false));
        }
      }
      if (state.liveSearch.truncated) {
        const note = document.createElement('div');
        note.className = 'ddc-dsep';
        note.textContent = t('search.truncated');
        frag.appendChild(note);
      }
    }
    scroller.replaceChildren(frag);
    scroller.scrollTop = savedScroll;
    els.streamMeta.textContent = tf('search.results', { n: state.liveSearch.total });
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
    updateStepAge();
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
    // 服务端 limit 截断时如实标注，避免「看起来完整其实少了」。
    rp.truncated = truncated;
    renderReplayList();
    drawTimeline();
    setView('replay');
  }

  // 回放列表/详情按 state.rp 重画：startReplay 与语言切换重建共用，
  // 不动 rp.t/rp.active，重建不丢播放进度。
  function renderReplayList() {
    const rp = state.rp;
    els.spds.forEach((b) => b.classList.toggle('on', Number(b.dataset.ddcSpd) === rp.speed));
    els.rpTitle.textContent = rp.session
      ? tf('rp.sessionTitle', { id: rp.session.id, date: dateShort(rp.session.started), events: rp.session.events, errors: rp.session.errors })
      : t('rp.recent');
    els.rpMeta.textContent = `${rp.events.length} ${t('unit.entries')}${rp.truncated ? ` · ${t('rp.truncated')}` : ''}`;
    els.evlist.innerHTML = '';
    for (const e of rp.events) {
      els.evlist.appendChild(evRow(e, shortHms(e.t), true));
    }
    if (!rp.events.length) {
      const empty = document.createElement('div');
      empty.className = 'ddc-empty';
      empty.textContent = t('rp.empty');
      els.evlist.appendChild(empty);
    }
    if (rp.active >= 0) syncActive();
    else renderDetail(-1);
  }

  function renderDetail(idx) {
    const rp = state.rp;
    const e = idx >= 0 ? rp.events[idx] : null;
    if (!e) {
      els.rpDetail.innerHTML = `<div class="ddc-empty">${t('detail.hint')}</div>`;
      return;
    }
    const block = extraBlock(e);
    els.rpDetail.innerHTML = `
      <div class="ddc-step"><span class="ddc-tag t-${e.type}">${typeText(e.type)}</span>
        <div><div class="ddc-title">${esc((e.denied && e.type !== 'error' ? t('deny.prefix') : '') + (evTitle(e) || '—'))}</div>
        <div class="ddc-detail">${esc(evDetail(e))}</div></div></div>
      <div class="ddc-kv">
        <div class="ddc-k">${t('kv.time')}</div><div class="ddc-val">${esc(clockFull(e.ts))}</div>
        <div class="ddc-k">${t('kv.rel')}</div><div class="ddc-val">+${shortHms(e.t)}</div>
        <div class="ddc-k">${t('kv.seq')}</div><div class="ddc-val">#${e.seq}</div>
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
    els.play.textContent = t('pause');
    loop();
  }

  function pause() {
    state.rp.playing = false;
    els.play.textContent = t('play');
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
      empty.textContent = sessions.length ? t('empty.history.match') : t('empty.history.none');
      els.hlist.appendChild(empty);
    }
    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'ddc-hrow';
      const stText = s.status === 'recording' ? `<span class="ddc-st rec">${t('st.recording')}</span>` : `<span class="ddc-st done">${t('st.completed')}</span>`;
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
    els.histMeta.textContent = `${rows.length} / ${sessions.length} ${t('unit.sessions')}`;
  }

  // ---------- 回放静默补齐（2.2.0） ----------
  // 首屏只取了窗口尾部的 ~200 条，这里把更早的批次按 seq 升序并进去：
  // 重算 t 时间轴、重画列表与时间轴（保持当前进度），不留 loading 态。
  function prependReplayEvents(records) {
    const rp = state.rp;
    const known = new Set(rp.events.map((e) => e.seq));
    const incoming = (Array.isArray(records) ? records : []).filter((e) => e && e.ts && !known.has(e.seq));
    if (!incoming.length) return 0;
    rp.events = rp.events.concat(incoming.map((e) => ({ ...e, t: 0 }))).sort((a, b) => a.seq - b.seq);
    rebaseReplayTimeline();
    if (state.view === 'replay') {
      renderReplayList();
      drawTimeline();
    }
    return incoming.length;
  }

  // 时间轴基点 = 最早事件的 ts；时长以数据跨度为准（比聚类估的 duration 更真）。
  function rebaseReplayTimeline() {
    const rp = state.rp;
    if (!rp.events.length) return;
    const startMs = Date.parse(rp.events[0].ts);
    const endMs = Date.parse(rp.events[rp.events.length - 1].ts);
    for (const e of rp.events) e.t = Math.max(0, (Date.parse(e.ts) - startMs) / 1000);
    rp.dur = Math.max(1, (endMs - startMs) / 1000);
  }

  function setReplayTruncated(truncated) {
    state.rp.truncated = truncated === true;
    if (state.view === 'replay') renderReplayList();
  }

  function updateSessionDirectory(entries) {
    state.sessionDir = entries instanceof Map ? entries : new Map();
    if (!state.liveSearch.active) renderStream();
  }

  // ---------- 全局接线 ----------
  // 挂在具体节点上的事件接线都在 wireEvents()（语言重建时对新节点重跑）；
  // 这里只放跨重建注册一次的监听。els / resizeObserver 是 let，闭包永远取当前值。
  disposers.push(() => {
    if (resizeObserver) resizeObserver.disconnect();
  });

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
    showLiveSearch,
    startReplay,
    prependReplayEvents,
    setReplayTruncated,
    updateSessionDirectory,
    dispose,
  };
}

// dsh-dashcam 面板引擎：徽章 + 弹窗面板的生命周期、数据轮询、单例防护。
// 单例姿势抄 tan-pet（generation 防级联、knownNodeClasses 清扫残留）；
// 只用 right/bottom 定位、直挂 document.body（dsh-app:// 下 iframe 会 404）。
// 轮询口径：status 常轮询（徽章计时器本地走秒）；面板打开且处于实时视图时
// 增量拉 records（since=lastSeq）；历史/回放按需拉。


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

function mountDashcam() {
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

// client.body.js — React 半侧：把面板挂进 DSH Web 的 shell.overlay 插槽，
// 注册 Ctrl+Shift+D 快捷键与设置入口。姿势与 dsh-deepseek-tan-pet 相同。
// 面板本体（dashcam-engine/dashcam-panel）是纯 DOM，不依赖 React。

const React = require('react');

function DashcamMount() {
  React.useEffect(() => {
    const engine = mountDashcam();
    return () => engine.dispose();
  }, []);
  return React.createElement('div', { style: { display: 'none' } });
}

exports.name = 'dsh-dashcam-host';
exports.inject = ['slots', 'shortcuts'];
exports.apply = (ctx) => {
  ctx.effect(() => {
    const disposers = [];

    try {
      const slots = ctx.get('slots');
      disposers.push(
        slots.inject('shell.overlay', () =>
          slots.register({ name: 'shell.overlay', id: 'dsh-dashcam-panel', order: 13 }, DashcamMount),
        ),
      );
    } catch (error) {
      console.warn('[dsh-dashcam] shell.overlay 插槽注册失败：', error);
    }

    try {
      const shortcuts = ctx.get('shortcuts');
      disposers.push(
        shortcuts.register({
          id: 'dsh-dashcam:toggle-panel',
          regions: ['page'],
          combo: { primary: true, shift: true, code: 'KeyD' },
          title: 'Agent Dashcam 面板开关',
          run: () => {
            try {
              const engine = window.__DSH_DASHCAM_ENGINE__;
              if (engine && typeof engine.toggle === 'function') engine.toggle();
            } catch (error) {
              console.warn('[dsh-dashcam] 切换面板失败：', error);
            }
            return { handled: true };
          },
        }),
      );
    } catch (error) {
      console.warn('[dsh-dashcam] 快捷键注册失败：', error);
    }

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch { /* 卸载失败不致命 */ }
      }
    };
  }, 'dsh-dashcam: client unmount');
};

    return module.exports;
  }
});
