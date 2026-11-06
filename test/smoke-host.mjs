// 1.10.8+ 宿主适配层冒烟（不进 DSH、不启动 headless）：验证 apply() 的 fail-fast 与 advisory/enforce 接线。
// 用法：node test/smoke-host.mjs（或在包根目录 npm run smoke）
// 覆盖：fail-fast（字符串 requests / grants）、advisory（deny 记账 + intercepted=false + 放行）、
// enforce（授权放行 / 未声明拦截 / allow+deny 的 intercepted 口径）、
// ops_* 前缀映射与参数形态（command/script_path/files 数组/batch 展开）、
// 1.10.11：copy/move 双端判定、edit 映射、remove=fs.delete、read_files 逐 path、
// glob 缺 path 可见化、完整命令行存档、dryRun 降级、未映射遥测落账、mount 记录、MAC 密钥透传。
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

function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
}

// 能力判定记录（排除 mount / 遥测 / 命令行存档等附加审计记录）。
function judgments(ledgerPath) {
  return readLedger(ledgerPath).filter(
    (r) => r.capability !== 'telemetry' && r.ruleId !== 'commandline-audit',
  );
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

// 3) advisory：read 未声明 → 落账 deny + intercepted=false，且放行（next 被调用）；mount 记录落账
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-advisory.jsonl`;
  try { fs.unlinkSync(ledgerPath); } catch {}
  apply(ctx, { ledgerPath });
  check('advisory: 已挂载', mounted(ctx));
  const mountRecs = readLedger(ledgerPath).filter((r) => r.action === 'mount' && r.ruleId === 'mount');
  check('mount: 挂载记录落账本', mountRecs.length === 1 && mountRecs[0].scope.mode === 'advisory', JSON.stringify(mountRecs));
  let nextCalled = false;
  const decision = await ctx.handlers['tools/pre-execute'](
    { name: 'read', arguments: { file_path: path.join(RESULTS, 'package.json') } },
    () => { nextCalled = true; return 'NEXT'; },
  );
  check('advisory: 未声明读取放行', decision === 'NEXT' && nextCalled, String(decision));
  const recs = judgments(ledgerPath);
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
  const recs = judgments(ledgerPath);
  check('enforce: allow intercepted=false', recs[0].decision === 'allow' && recs[0].intercepted === false);
  check('enforce: deny intercepted=true', recs[1].decision === 'deny' && recs[1].intercepted === true, JSON.stringify(recs[1]));
  deactivate(ctx);
}

// 5) ops_* 映射：dsh-ops 前缀剥离 + 参数形态覆盖，全部按 advisory 记账放行
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-ops.jsonl`;
  try { fs.unlinkSync(ledgerPath); } catch {}
  apply(ctx, { ledgerPath });
  check('ops: 已挂载', mounted(ctx));
  const handler = ctx.handlers['tools/pre-execute'];
  const cases = [
    ['ops_bash（command）', { name: 'ops_bash', arguments: { command: 'git status', description: 'd' } }, 'proc.spawn'],
    ['ops_bash（script_path）', { name: 'ops_bash', arguments: { script_path: 'C:/tmp/build.sh', description: 'd' } }, 'proc.spawn'],
    ['ops_read_files（files 数组）', { name: 'ops_read_files', arguments: { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] } }, 'fs.read'],
    ['ops_glob', { name: 'ops_glob', arguments: { path: 'C:/repo', pattern: ['**/*.md'] } }, 'fs.read'],
    ['ops_grep', { name: 'ops_grep', arguments: { path: 'C:/repo', pattern: 'todo' } }, 'fs.read'],
    ['ops_write_file', { name: 'ops_write_file', arguments: { path: 'C:/repo/out.txt', content: 'x' } }, 'fs.write'],
    ['edit（核心工具，P2）', { name: 'edit', arguments: { file_path: 'C:/repo/x.ts', old_string: 'a', new_string: 'b' } }, 'fs.write'],
    ['ops_copy（读源+写目标，P1）', { name: 'ops_copy', arguments: { path: 'C:/repo/a.txt', to: 'C:/repo/b.txt', expectedRevision: 'r' } }, 'fs.write'],
    ['ops_move（删源+写目标，P1/P8）', { name: 'ops_move', arguments: { path: 'C:/repo/a.txt', to: 'C:/repo/b.txt', expectedRevision: 'r' } }, 'fs.write'],
    ['ops_remove（fs.delete，P8）', { name: 'ops_remove', arguments: { path: 'C:/repo/a.txt', expectedRevision: 'r' } }, 'fs.delete'],
  ];
  for (const [label, exec] of cases) {
    const before = judgments(ledgerPath).length;
    const decision = await handler(exec, () => 'NEXT');
    if (decision !== 'NEXT') { check(`ops: ${label} 放行`, false, String(decision)); continue; }
    const recs = judgments(ledgerPath).slice(before);
    const expected = cases.find(([l]) => l === label)[2];
    const last = recs[recs.length - 1];
    check(`ops: ${label} 记账 ${expected}`, recs.length >= 1 && last && last.capability === expected, JSON.stringify(last));
  }
  // 首词口径与形态细节
  const all = judgments(ledgerPath);
  check('ops: bash 首词口径', all[0].scope && all[0].scope.commands && all[0].scope.commands[0] === 'git', JSON.stringify(all[0]));
  check('ops: script_path 整串记账', all[1].scope && all[1].scope.commands && all[1].scope.commands[0] === 'C:/tmp/build.sh', JSON.stringify(all[1]));
  check('ops: read_files 记首个 path', all[2].scope && all[2].scope.paths && all[2].scope.paths[0].endsWith('src/a.ts'), JSON.stringify(all[2]));
  // copy = fs.read(源) + fs.write(目标)；move = fs.read + fs.delete(源) + fs.write(目标)
  const copyOps = all.filter((r) => r.scope && r.scope.paths && (r.scope.paths.some((p) => p.endsWith('repo/a.txt')) || r.scope.paths.some((p) => p.endsWith('repo/b.txt'))));
  const copySeq = copyOps.filter((r) => r.action.startsWith('fs.'));
  check('ops: copy 源记 fs.read', copySeq.some((r) => r.action === 'fs.read' && r.scope.paths[0].endsWith('repo/a.txt')), JSON.stringify(copySeq));
  check('ops: copy 目标记 fs.write', copySeq.some((r) => r.action === 'fs.write' && r.scope.paths[0].endsWith('repo/b.txt')), JSON.stringify(copySeq));
  check('ops: move 源记 fs.delete', copySeq.some((r) => r.action === 'fs.delete' && r.scope.paths[0].endsWith('repo/a.txt')), JSON.stringify(copySeq));
  deactivate(ctx);
}

// 6) 未映射遥测：放行但点名一次 + 落账本；noop 工具不打扰
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-tele.jsonl`;
  apply(ctx, { ledgerPath });
  const handler = ctx.handlers['tools/pre-execute'];
  let n1 = 0;
  await handler({ name: 'mcp__demo__query', arguments: {} }, () => { n1 += 1; return 'NEXT'; });
  await handler({ name: 'mcp__demo__query', arguments: {} }, () => { n1 += 1; return 'NEXT'; });
  const unmappedLogs = log.filter(([l, m]) => l === 'info' && /未映射工具/.test(m) && /mcp__demo__query/.test(m));
  check('遥测: 未映射工具放行', n1 === 2);
  check('遥测: 同名只报一次', unmappedLogs.length === 1, JSON.stringify(unmappedLogs));
  const teleRecs = readLedger(ledgerPath).filter((r) => r.action === 'unmapped-tool');
  check('遥测: 账本落 unmapped-tool 记录', teleRecs.length === 1 && teleRecs[0].scope.tool === 'mcp__demo__query', JSON.stringify(teleRecs));
  const before = log.filter(([l, m]) => l === 'info' && /未映射工具/.test(m)).length;
  await handler({ name: 'ops_discover_tools', arguments: {} }, () => 'NEXT');
  await handler({ name: 'ops_result', arguments: { reference: 'r' } }, () => 'NEXT');
  const after = log.filter(([l, m]) => l === 'info' && /未映射工具/.test(m)).length;
  check('遥测: noop 工具不报', after === before, `${before} -> ${after}`);
  deactivate(ctx);
}

// 7) P1 enforce：copy/move 目标越界必须被拒（源在授权域内、目标在域外）
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-copy-enforce.jsonl`;
  const scopeDir = path.join(RESULTS, 'sandbox2').replace(/\\/g, '/');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.writeFileSync(path.join(scopeDir, 'a.txt'), 'x');
  const outside = path.join(RESULTS, 'outside', 'evil-copy-target-smoke.txt').replace(/\\/g, '/');
  const caps = ['fs.read', 'fs.write', 'fs.delete'];
  apply(ctx, {
    enforce: true,
    ledgerPath,
    requests: caps.map((capability) => ({ capability, scope: { paths: [`${scopeDir}/**`] }, reason: 'r' })),
    grants: caps.map((capability, i) => ({ id: `g${i}`, capability, scope: { paths: [`${scopeDir}/**`] } })),
  });
  const handler = ctx.handlers['tools/pre-execute'];
  const denyCopy = await handler(
    { name: 'ops_copy', arguments: { path: `${scopeDir}/a.txt`, to: outside, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('P1: copy 目标越界被拦', denyCopy && denyCopy.kind === 'deny', JSON.stringify(denyCopy));
  const denyMove = await handler(
    { name: 'ops_move', arguments: { path: `${scopeDir}/a.txt`, to: outside, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('P1: move 目标越界被拦', denyMove && denyMove.kind === 'deny', JSON.stringify(denyMove));
  // 域内复制/移动放行
  const okCopy = await handler(
    { name: 'ops_copy', arguments: { path: `${scopeDir}/a.txt`, to: `${scopeDir}/b.txt`, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('P1: 域内 copy 放行', okCopy === 'NEXT', JSON.stringify(okCopy));
  const okMove = await handler(
    { name: 'ops_move', arguments: { path: `${scopeDir}/a.txt`, to: `${scopeDir}/c.txt`, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('P1: 域内 move 放行', okMove === 'NEXT', JSON.stringify(okMove));
  const recs = judgments(ledgerPath);
  const copyDeny = recs.find((r) => r.decision === 'deny' && r.action === 'fs.write' && JSON.stringify(r.scope).includes('evil-copy-target'));
  check('P1: 拒绝记录指向越界目标', !!copyDeny, JSON.stringify(recs));
  deactivate(ctx);
}

// 8) P3 ops_batch：operations[] 逐条展开判定/记账；enforce 整批最严处置
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-batch.jsonl`;
  apply(ctx, { ledgerPath });
  const handler = ctx.handlers['tools/pre-execute'];
  const before = judgments(ledgerPath).length;
  const decision = await handler({
    name: 'ops_batch',
    arguments: {
      root: 'C:/repo',
      action: 'run',
      operations: [
        { op: 'copy', path: 'C:/repo/a.txt', to: 'C:/repo/b.txt' },
        { op: 'move', path: 'C:/repo/c.txt', to: 'C:/repo/d.txt' },
        { op: 'remove', path: 'C:/repo/e.txt' },
      ],
    },
  }, () => 'NEXT');
  check('P3: batch advisory 放行', decision === 'NEXT', String(decision));
  const recs = judgments(ledgerPath).slice(before);
  const ops = recs.map((r) => r.action);
  check('P3: batch 展开为 6 条判定', recs.length === 6, JSON.stringify(ops));
  check('P3: copy=读源+写目标', ops[0] === 'fs.read' && ops[1] === 'fs.write', JSON.stringify(ops));
  check('P3: move=读+删+写', ops[2] === 'fs.read' && ops[3] === 'fs.delete' && ops[4] === 'fs.write', JSON.stringify(ops));
  check('P3: remove=删', ops[5] === 'fs.delete', JSON.stringify(ops));
  // 无法判定的 batch（无 operations[]）：advisory 落遥测放行
  const before2 = readLedger(ledgerPath).length;
  await handler({ name: 'ops_batch', arguments: { root: 'C:/repo', action: 'resume', id: 'j-1' } }, () => 'NEXT');
  const tele = readLedger(ledgerPath).slice(before2).filter((r) => r.action === 'unjudgeable-tool');
  check('P3: 缺 operations 遥测落账', tele.length === 1 && /子操作不可见/.test(tele[0].reason), JSON.stringify(tele));
  deactivate(ctx);
}

// 9) P3 enforce：batch 含越界条目 → 整批拒绝
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-batch-enforce.jsonl`;
  const scopeDir = path.join(RESULTS, 'sandbox3').replace(/\\/g, '/');
  fs.mkdirSync(scopeDir, { recursive: true });
  const outside = path.join(RESULTS, 'outside', 'evil-batch-target-smoke.txt').replace(/\\/g, '/');
  const caps = ['fs.read', 'fs.write', 'fs.delete'];
  apply(ctx, {
    enforce: true,
    ledgerPath,
    requests: caps.map((capability) => ({ capability, scope: { paths: [`${scopeDir}/**`] }, reason: 'r' })),
    grants: caps.map((capability, i) => ({ id: `g${i}`, capability, scope: { paths: [`${scopeDir}/**`] } })),
  });
  const deny = await ctx.handlers['tools/pre-execute']({
    name: 'ops_batch',
    arguments: {
      action: 'run',
      operations: [
        { op: 'copy', path: `${scopeDir}/a.txt`, to: `${scopeDir}/b.txt` },
        { op: 'copy', path: `${scopeDir}/a.txt`, to: outside },
      ],
    },
  }, () => 'NEXT');
  check('P3: batch 越界整批拒绝', deny && deny.kind === 'deny', JSON.stringify(deny));
  deactivate(ctx);
}

// 10) P4 read_files 逐 path；P5 glob 缺 path；P9 dryRun
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-read.jsonl`;
  apply(ctx, { ledgerPath });
  const handler = ctx.handlers['tools/pre-execute'];
  // P4：3 个文件 3 条 fs.read
  const before = judgments(ledgerPath).length;
  await handler({
    name: 'ops_read_files',
    arguments: { files: [{ path: 'C:/repo/a.ts' }, { path: 'C:/home/demo/keys/id_rsa' }, { path: 'C:/repo/c.ts' }] },
  }, () => 'NEXT');
  const recs = judgments(ledgerPath).slice(before);
  check('P4: read_files 逐 path 记账', recs.length === 3 && recs.every((r) => r.action === 'fs.read'), JSON.stringify(recs.map((r) => r.scope)));
  // 第 2 个路径是 id_rsa → 凭证升级为 cred.read（scope.targets），但必须可见、可判
  check('P4: 第 2 个路径可见（cred.read 升级）', recs[1] && recs[1].capability === 'cred.read'
    && JSON.stringify(recs[1].scope).includes('id_rsa'), JSON.stringify(recs[1]));
  // P5：glob 缺 path → advisory 遥测放行
  const before2 = readLedger(ledgerPath).length;
  const globOk = await handler({ name: 'glob', arguments: { pattern: '**/*.ts' } }, () => 'NEXT');
  const tele = readLedger(ledgerPath).slice(before2).filter((r) => r.action === 'unjudgeable-tool');
  check('P5: glob 缺 path advisory 放行', globOk === 'NEXT', String(globOk));
  check('P5: glob 缺 path 遥测落账', tele.length === 1 && /session cwd/.test(tele[0].reason), JSON.stringify(tele));
  // P9：dryRun 按只读记账
  const before3 = judgments(ledgerPath).length;
  await handler({ name: 'ops_write_file', arguments: { path: 'C:/repo/out.txt', content: 'x', expectedRevision: null, dryRun: true } }, () => 'NEXT');
  const dry = judgments(ledgerPath).slice(before3);
  check('P9: dryRun 记 fs.read 不记 fs.write', dry.length === 1 && dry[0].action === 'fs.read', JSON.stringify(dry));
  deactivate(ctx);
}

// 11) P6 完整命令行存档：判定首词 + 截断文本 + SHA-256
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-cmd.jsonl`;
  apply(ctx, { ledgerPath });
  await ctx.handlers['tools/pre-execute'](
    { name: 'ops_bash', arguments: { command: 'cd /tmp && rm -f evil.txt && echo done' } },
    () => 'NEXT',
  );
  const judge = judgments(ledgerPath);
  check('P6: 判定仍是首词', judge.length === 1 && judge[0].scope.commands[0] === 'cd', JSON.stringify(judge));
  const aux = readLedger(ledgerPath).filter((r) => r.ruleId === 'commandline-audit');
  check('P6: 命令行存档落账', aux.length === 1 && /rm -f evil\.txt/.test(aux[0].scope.commandLine), JSON.stringify(aux));
  check('P6: 存档含 SHA-256 hash', aux[0] && /^sha256:[0-9a-f]{64}$/.test(aux[0].scope.commandLineHash), JSON.stringify(aux[0]));
  deactivate(ctx);
}

// 12) D4 MAC 密钥透传：账本升级 v3 且带 mac
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-mac.jsonl`;
  apply(ctx, { ledgerPath, ledgerMacKey: 'm'.repeat(64) });
  const recs = readLedger(ledgerPath);
  check('D4: mount 记录为 v3 且带 mac', recs.length >= 1 && recs[0].v === 3 && typeof recs[0].mac === 'string' && recs[0].mac.length === 64, JSON.stringify(recs[0]));
  deactivate(ctx);
  // 非法密钥（过短）→ activate 失败不挂载
  freshLog();
  const ctx2 = makeCtx();
  apply(ctx2, { ledgerPath: `${RESULTS}/smoke-mac2.jsonl`, ledgerMacKey: 'short' });
  check('D4: 过短密钥不挂载', !mounted(ctx2), JSON.stringify(log));
}

console.error = origError;
console.warn = origWarn;
console.info = origInfo;
console.log(`\nSMOKE ${failed === 0 ? 'ALL PASS' : 'HAS FAILURES'} passed=${passed} failed=${failed}`);
try { fs.rmSync(RESULTS, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
