// dsh-dashcam 面板样式：忠实移植参考稿（dashcam.html）的暗玻璃 + REC 红 +
// 等宽数字风格，全部类名加 ddc- 前缀、只作用于 [data-ddc-root] 之下，
// 不外溢进宿主页面；徽章 .ddc-badge 与面板 .ddc-panel 是兄弟节点（都挂
// document.body，DSH 桌面 dsh-app:// 协议下 iframe 会 404——tan-pet 的教训）。
export const DASHCAM_CSS = `
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
