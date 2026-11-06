// 1.10.8+ 宿主适配层冒烟（不进 DSH、不启动 headless）：验证 apply() 的 fail-fast 与 advisory/enforce 接线。
// 用法：node test/smoke-host.mjs（或在包根目录 npm run smoke）
// 覆盖 11 项断言：fail-fast（字符串 requests / grants）、advisory（deny 记账 + intercepted=false + 放行）、
// enforce（授权放行 / 未声明拦截 / allow+deny 的 intercepted 口径）。
import { apply } from '../lib/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 账本一律落在临时目录：跑一次冒烟不在仓库/用户目录留下任何痕迹。
const RESULTS = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-covenant-host-smoke-'));
const log = [];
const origError = console.error;
const origInfo = console.info;
const origWarn = console.warn;
console.error = (...a) => { log.push(['error', a.join(' ')]); };
console.warn = (...a) => { log.push(['warn', a.join(' ')]); };
console.info = (...a) => { log.push(['info', a.join(' ')]); };

function makeCtx() {
  const handlers = {};
  const effects = [];
  return {
    handlers,
    effects,
    on(event, fn) { handlers[event] = fn; },
    effect(fn) { effects.push(fn); },
  };
}

function freshLog() { log.length = 0; }
function mounted(ctx) { return typeof ctx.handlers['tools/pre-execute'] === 'function'; }

// 同一 plugin id 二次 activate 会被 activeRuntimes 守护拒绝，用例之间必须 deactivate。
function deactivate(ctx) {
  for (const fn of ctx.effects) {
    try { const cleanup = fn(); if (typeof cleanup === 'function') cleanup(); } catch {}
  }
  ctx.effects.length = 0;
  ctx.handlers['tools/pre-execute'] = undefined;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name} ${detail}`); }
}

// 1) requests 写成字符串数组 → 配置错误，不挂判定链
{
  freshLog();
  const ctx = makeCtx();
  apply(ctx, {
    requests: ['fs.read'],
    ledgerPath: `${RESULTS}/smoke-1.jsonl`,
  });
  check('fail-fast: 字符串 requests 不挂载', !mounted(ctx) && ctx.effects.length === 0);
  const err = log.find(([level]) => level === 'error');
  check('fail-fast: 错误信息含 YAML 格式提示', !!err && /能力请求必须是对象/.test(err[1]) && /README 3\.4/.test(err[1]), JSON.stringify(err));
  check('fail-fast: 未打印挂载日志', !log.some(([l, m]) => l === 'info' && /判定链已挂载/.test(m)));
}

// 2) grants 写成字符串数组 → 同样 fail-fast
{
  freshLog();
  const ctx = makeCtx();
  apply(ctx, {
    requests: [{ capability: 'fs.read', scope: { paths: [RESULTS] }, reason: 'r' }],
    grants: ['fs.read'],
    ledgerPath: `${RESULTS}/smoke-2.jsonl`,
  });
  check('fail-fast: 字符串 grants 不挂载', !mounted(ctx) && ctx.effects.length === 0);
  check('fail-fast: grants 错误信息', !!log.find(([l, m]) => l === 'error' && /grants 非法|grant 必须是对象/.test(m)), JSON.stringify(log));
}

// 3) advisory：read 未声明 → 落账 deny + intercepted=false，且放行（next 被调用）
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-advisory.jsonl`;
  try { fs.unlinkSync(ledgerPath); } catch {}
  apply(ctx, { ledgerPath });
  check('advisory: 已挂载', mounted(ctx));
  let nextCalled = false;
  const decision = await ctx.handlers['tools/pre-execute'](
    { name: 'read', arguments: { file_path: path.join(RESULTS, 'package.json') } },
    () => { nextCalled = true; return 'NEXT'; },
  );
  check('advisory: 未声明读取放行', decision === 'NEXT' && nextCalled, String(decision));
  const recs = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  check('advisory: 账本 decision=deny & intercepted=false', recs.length === 1 && recs[0].decision === 'deny' && recs[0].intercepted === false, JSON.stringify(recs));
  deactivate(ctx);
}

// 4) enforce：声明并授权的读放行；未声明的 shell 拦截
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-enforce.jsonl`;
  try { fs.unlinkSync(ledgerPath); } catch {}
  const scopeDir = path.join(RESULTS, 'sandbox').replace(/\\/g, '/');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'package.json'), '{}');
  apply(ctx, {
    enforce: true,
    ledgerPath,
    requests: [{ capability: 'fs.read', scope: { paths: [`${scopeDir}/**`] }, reason: 'r' }],
    grants: [{ id: 'g1', capability: 'fs.read', scope: { paths: [`${scopeDir}/**`] } }],
  });
  check('enforce: 已挂载', mounted(ctx));
  let nextCalled = false;
  const allow = await ctx.handlers['tools/pre-execute'](
    { name: 'read', arguments: { file_path: path.join(scopeDir, 'package.json') } },
    () => { nextCalled = true; return 'NEXT'; },
  );
  check('enforce: 已授权读取放行', allow === 'NEXT' && nextCalled);
  const deny = await ctx.handlers['tools/pre-execute'](
    { name: 'pwsh', arguments: { command: 'echo hi' } },
    () => 'NEXT',
  );
  check('enforce: 未声明 shell 被拦', deny && deny.kind === 'deny' && /proc\.spawn/.test(deny.reason), JSON.stringify(deny));
  const recs = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
  check('enforce: allow intercepted=false', recs[0].decision === 'allow' && recs[0].intercepted === false);
  check('enforce: deny intercepted=true', recs[1].decision === 'deny' && recs[1].intercepted === true, JSON.stringify(recs[1]));
  deactivate(ctx);
}

console.error = origError;
console.warn = origWarn;
console.info = origInfo;
console.log(`\nSMOKE ${failed === 0 ? 'ALL PASS' : 'HAS FAILURES'} passed=${passed} failed=${failed}`);
try { fs.rmSync(RESULTS, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
