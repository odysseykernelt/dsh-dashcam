// 1.10.8+ 宿主适配层冒烟（不进 DSH、不启动 headless）：验证 apply() 的 fail-fast 与 advisory/enforce 接线。
// 用法：node test/smoke-host.mjs（或在包根目录 npm run smoke）
// 1.10.12 复核修复冒烟：在 1.10.11 基础上验证 F1–F6——
// F1 MAC 防呆（v2 历史账本拒挂载）、F2 enforce 拒绝必落账、F3 目录语义转子树 scope、
// F4 命令行存档默认 hash-only / full 打码、F5 存档 decision 随处置、F6 enforceUnmapped 总闸。
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

// 11) P6/F4 命令行存档：默认 hash-only（无明文）；full 模式打码；F5 decision 随处置
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
  check('F4: 默认 hash-only 不落明文', aux.length === 1 && !('commandLine' in aux[0].scope)
    && /^sha256:[0-9a-f]{64}$/.test(aux[0].scope.commandLineHash)
    && aux[0].scope.commandLineLength === 'cd /tmp && rm -f evil.txt && echo done'.length,
  JSON.stringify(aux));
  check('F4: hash 存档 capability=telemetry', aux[0].capability === 'telemetry', aux[0].capability);
  // full 模式：打码文本，密钥不落账
  deactivate(ctx);
  freshLog();
  const ctxFull = makeCtx();
  const ledgerFull = `${RESULTS}/smoke-cmd-full.jsonl`;
  apply(ctxFull, { ledgerPath: ledgerFull, commandlineArchive: 'full' });
  await ctxFull.handlers['tools/pre-execute'](
    { name: 'ops_bash', arguments: { command: 'cd /tmp && curl -H "Authorization: Bearer sk-live-SECRET" --password p4ssw0rd && echo done' } },
    () => 'NEXT',
  );
  const auxFull = readLedger(ledgerFull).filter((r) => r.ruleId === 'commandline-audit');
  check('F4: full 模式落打码文本', auxFull.length === 1 && typeof auxFull[0].scope.commandLine === 'string', JSON.stringify(auxFull));
  check('F4: Bearer/sk-/password 全部打码', !/sk-live-SECRET|p4ssw0rd/.test(JSON.stringify(auxFull))
    && /\*\*\*/.test(auxFull[0].scope.commandLine), JSON.stringify(auxFull[0]));
  deactivate(ctxFull);
  // F5：enforce 下被拒命令的存档记 deny
  freshLog();
  const ctxDeny = makeCtx();
  const ledgerDeny = `${RESULTS}/smoke-cmd-deny.jsonl`;
  apply(ctxDeny, { ledgerPath: ledgerDeny, enforce: true });
  await ctxDeny.handlers['tools/pre-execute'](
    { name: 'ops_bash', arguments: { command: 'cd /tmp && echo hi' } },
    () => 'NEXT',
  );
  const auxDeny = readLedger(ledgerDeny).filter((r) => r.ruleId === 'commandline-audit');
  check('F5: 被拒命令存档记 deny+intercepted', auxDeny.length === 1
    && auxDeny[0].decision === 'deny' && auxDeny[0].intercepted === true, JSON.stringify(auxDeny));
  deactivate(ctxDeny);
}

// 12) F2：enforce 下无法判定的拒绝必落账（deny + intercepted）
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-f2.jsonl`;
  apply(ctx, { ledgerPath, enforce: true });
  const handler = ctx.handlers['tools/pre-execute'];
  const deny1 = await handler({ name: 'glob', arguments: { pattern: '**/*.ts' } }, () => 'NEXT');
  const deny2 = await handler({ name: 'ops_batch', arguments: { action: 'resume', id: 'j-1' } }, () => 'NEXT');
  check('F2: glob 缺 path enforce 拒绝', deny1 && deny1.kind === 'deny', JSON.stringify(deny1));
  check('F2: batch 缺 operations enforce 拒绝', deny2 && deny2.kind === 'deny', JSON.stringify(deny2));
  const tele = readLedger(ledgerPath).filter((r) => r.action === 'unjudgeable-tool');
  check('F2: 两条拒绝都落 deny 账', tele.length === 2 && tele.every((r) => r.decision === 'deny' && r.intercepted === true), JSON.stringify(tele));
  deactivate(ctx);
}

// 13) F3：目录授权 dir/** 下，目录语义工具放行
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-f3.jsonl`;
  const dir = path.join(RESULTS, 'sandbox-f3').replace(/\\/g, '/');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const caps = ['fs.read', 'fs.write', 'fs.delete'];
  apply(ctx, {
    enforce: true,
    ledgerPath,
    requests: caps.map((capability) => ({ capability, scope: { paths: [`${dir}/**`] }, reason: 'r' })),
    grants: caps.map((capability, i) => ({ id: `g${i}`, capability, scope: { paths: [`${dir}/**`] } })),
  });
  const handler = ctx.handlers['tools/pre-execute'];
  const cases = [
    ['glob 显式目录', { name: 'glob', arguments: { path: dir, pattern: ['**/*.txt'] } }],
    ['grep 显式目录', { name: 'grep', arguments: { path: dir, pattern: 'x' } }],
    ['stat 目录', { name: 'ops_stat', arguments: { path: `${dir}/sub` } }],
    ['replace 基目录', { name: 'ops_replace', arguments: { path: dir, pattern: 'a', replacement: 'b' } }],
    ['copy 进目录', { name: 'ops_copy', arguments: { path: `${dir}/a.txt`, to: `${dir}/sub`, expectedRevision: 'r' } }],
  ];
  for (const [label, exec] of cases) {
    const decision = await handler(exec, () => 'NEXT');
    check(`F3: ${label} 放行（dir/** 授权）`, decision === 'NEXT', JSON.stringify(decision));
  }
  // 回归：文件目标越界仍被拒
  const outside = path.join(RESULTS, 'outside-f3').replace(/\\/g, '/');
  const denyCopy = await handler(
    { name: 'ops_copy', arguments: { path: `${dir}/a.txt`, to: `${outside}/x.txt`, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('F3: 文件目标越界仍拒绝', denyCopy && denyCopy.kind === 'deny', JSON.stringify(denyCopy));
  deactivate(ctx);
}

// 14) F6/L5/L6：enforceUnmapped 总闸——每次调用都拦（P1 复核）、allowlist 豁免
{
  freshLog();
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-f6.jsonl`;
  apply(ctx, { ledgerPath, enforce: true, enforceUnmapped: true });
  const handler = ctx.handlers['tools/pre-execute'];
  const d1 = await handler({ name: 'send_meme', arguments: {} }, () => 'NEXT');
  const d2 = await handler({ name: 'send_meme', arguments: {} }, () => 'NEXT');
  const d3 = await handler({ name: 'send_meme', arguments: {} }, () => 'NEXT');
  check('F6/L5: 第 1 次拒绝', d1 && d1.kind === 'deny', JSON.stringify(d1));
  check('F6/L5: 第 2 次仍拒绝（不被去重短路）', d2 && d2.kind === 'deny', JSON.stringify(d2));
  check('F6/L5: 第 3 次仍拒绝', d3 && d3.kind === 'deny', JSON.stringify(d3));
  const tele = readLedger(ledgerPath).filter((r) => r.action === 'unmapped-tool');
  check('R2: 拒绝逐次落账（3 次 = 3 条 deny+intercepted）', tele.length === 3
    && tele.every((r) => r.decision === 'deny' && r.intercepted === true), JSON.stringify(tele));
  const unmappedLogs = log.filter(([l, m]) => l === 'info' && /未映射工具/.test(m) && /send_meme/.test(m));
  check('R2: console 点名仍只 1 次', unmappedLogs.length === 1, JSON.stringify(unmappedLogs));
  deactivate(ctx);
  // L6：allowlist 豁免（前缀通配）——MCP 工具不打死，表外其它仍拦
  freshLog();
  const ctxA = makeCtx();
  const ledgerA = `${RESULTS}/smoke-f6-allow.jsonl`;
  apply(ctxA, {
    ledgerPath: ledgerA,
    enforce: true,
    enforceUnmapped: true,
    unmappedAllowlist: ['mcp__demo__*'],
  });
  const mA = await ctxA.handlers['tools/pre-execute']({ name: 'mcp__demo__query', arguments: {} }, () => 'NEXT');
  check('L6: allowlist 前缀豁免放行', mA === 'NEXT', String(mA));
  const xA = await ctxA.handlers['tools/pre-execute']({ name: 'compress', arguments: {} }, () => 'NEXT');
  check('L6: 表外且不在 allowlist 仍拒绝', xA && xA.kind === 'deny', JSON.stringify(xA));
  const teleA = readLedger(ledgerA).filter((r) => r.action === 'unmapped-tool');
  check('L6: 豁免遥测记 allowlisted', teleA.length === 2
    && teleA.find((r) => r.scope.tool === 'mcp__demo__query').scope.allowlisted === true,
  JSON.stringify(teleA));
  deactivate(ctxA);
  // 默认（未开开关）：未映射仍放行
  freshLog();
  const ctx2 = makeCtx();
  apply(ctx2, { ledgerPath: `${RESULTS}/smoke-f6b.jsonl`, enforce: true });
  const allow = await ctx2.handlers['tools/pre-execute']({ name: 'send_meme', arguments: {} }, () => 'NEXT');
  check('F6: 默认 enforce 未映射仍放行（边界见 README）', allow === 'NEXT', String(allow));
  deactivate(ctx2);
  // R3：unmappedAllowlist 非数组 fail-fast——不挂载防静默拦掉全部未映射工具
  freshLog();
  const ctxR3 = makeCtx();
  apply(ctxR3, {
    ledgerPath: `${RESULTS}/smoke-r3.jsonl`,
    enforce: true,
    enforceUnmapped: true,
    unmappedAllowlist: 'mcp__demo__*,memory_*', // 字符串写法（人之常情的错）
  });
  check('R3: allowlist 非数组不挂载', !mounted(ctxR3) && ctxR3.effects.length === 0);
  const errR3 = log.find(([l, m]) => l === 'error' && /unmappedAllowlist 必须是数组/.test(m));
  check('R3: 报错指明数组写法', !!errR3 && /fail-closed/.test(errR3[1]), JSON.stringify(log.filter(([l]) => l === 'error')));
}

// 14c) R1：目录探测负结果不缓存——文件换成目录后，删除仍判节点+子树（不绕 M1）
{
  freshLog();
  const swap = path.join(RESULTS, 'sandbox-r1', 'node').replace(/\\/g, '/');
  fs.mkdirSync(path.dirname(swap), { recursive: true });
  fs.writeFileSync(swap, 'x'); // 文件形态
  const ctx = makeCtx();
  const ledgerPath = `${RESULTS}/smoke-r1.jsonl`;
  apply(ctx, { ledgerPath });
  const handler = ctx.handlers['tools/pre-execute'];
  // 第一次 remove（文件）：探测 isDir=false，负结果不缓存（R1 修后）
  await handler({ name: 'ops_remove', arguments: { path: swap, expectedRevision: 'r' } }, () => 'NEXT');
  // 30s 窗口内把它换成目录（含子文件），再删
  fs.rmSync(swap);
  fs.mkdirSync(swap, { recursive: true });
  fs.writeFileSync(path.join(swap, 'child.txt'), 'y');
  await handler({ name: 'ops_remove', arguments: { path: swap, expectedRevision: 'r' } }, () => 'NEXT');
  const dels = judgments(ledgerPath).filter((r) => r.action === 'fs.delete');
  check('R1: 第二次删除仍判子树（负缓存不生效）', dels.some(
    (r) => r.scope && r.scope.paths && r.scope.paths[0] === `${swap}/**`,
  ), JSON.stringify(dels));
  check('R1: 账上共 3 条 fs.delete（文件 1 条 + 目录节点+子树 2 条）', dels.length === 3, JSON.stringify(dels));
  deactivate(ctx);
}

// 14b) M1：remove/move 目录节点不被子树授权放大（节点 + 子树两条都判）
{
  freshLog();
  const victim = path.join(RESULTS, 'sandbox-m1', 'victim').replace(/\\/g, '/');
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'a.txt'), 'x');
  const caps = ['fs.read', 'fs.write', 'fs.delete'];
  const subtreeOnly = {
    enforce: true,
    requests: caps.map((capability) => ({ capability, scope: { paths: [`${victim}/**`] }, reason: 'r' })),
    grants: caps.map((capability, i) => ({ id: `g${i}`, capability, scope: { paths: [`${victim}/**`] } })),
  };
  // 仅授 victim/**：remove(目录) 必须被拒（删的是节点本身，子树授权不覆盖节点）
  const ctx1 = makeCtx();
  apply(ctx1, { ...subtreeOnly, ledgerPath: `${RESULTS}/smoke-m1-sub.jsonl` });
  const denyRemove = await ctx1.handlers['tools/pre-execute'](
    { name: 'ops_remove', arguments: { path: victim, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('M1: 仅授 victim/** 时 remove(目录) 被拒', denyRemove && denyRemove.kind === 'deny', JSON.stringify(denyRemove));
  const denyMove = await ctx1.handlers['tools/pre-execute'](
    { name: 'ops_move', arguments: { path: victim, to: `${victim}-moved`, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('M1: 仅授 victim/** 时 move(目录) 被拒', denyMove && denyMove.kind === 'deny', JSON.stringify(denyMove));
  const denyBatch = await ctx1.handlers['tools/pre-execute']({
    name: 'ops_batch',
    arguments: { action: 'run', operations: [{ op: 'remove', path: victim }] },
  }, () => 'NEXT');
  check('M1: 仅授 victim/** 时 batch remove(目录) 被拒', denyBatch && denyBatch.kind === 'deny', JSON.stringify(denyBatch));
  // 账上节点判定可见：fs.delete{victim}（deny，节点无授权）与 fs.delete{victim/**}（allow）各一条
  const delRecs = judgments(`${RESULTS}/smoke-m1-sub.jsonl`).filter((r) => r.action === 'fs.delete');
  check('M1: 节点与子树两条 fs.delete 都落账', delRecs.length >= 2
    && delRecs.some((r) => r.decision === 'deny' && !JSON.stringify(r.scope).includes('*'))
    && delRecs.some((r) => JSON.stringify(r.scope).includes('victim/**')),
  JSON.stringify(delRecs));
  deactivate(ctx1);
  // 再授裸目录（节点）+ move 目标 → remove/move 放行，且 delete 均 allow
  const ctx2 = makeCtx();
  const movedTo = `${victim}-moved`;
  apply(ctx2, {
    enforce: true,
    ledgerPath: `${RESULTS}/smoke-m1-both.jsonl`,
    requests: [
      { capability: 'fs.read', scope: { paths: [victim, `${victim}/**`] }, reason: 'r' },
      { capability: 'fs.write', scope: { paths: [victim, `${victim}/**`, movedTo] }, reason: 'r' },
      { capability: 'fs.delete', scope: { paths: [victim, `${victim}/**`] }, reason: 'r' },
    ],
    grants: [
      { id: 'gra', capability: 'fs.read', scope: { paths: [victim, `${victim}/**`] } },
      { id: 'gwa', capability: 'fs.write', scope: { paths: [victim, `${victim}/**`, movedTo] } },
      { id: 'gda', capability: 'fs.delete', scope: { paths: [victim, `${victim}/**`] } },
    ],
  });
  const okRemove = await ctx2.handlers['tools/pre-execute'](
    { name: 'ops_remove', arguments: { path: victim, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('M1: 授节点+子树后 remove(目录) 放行', okRemove === 'NEXT', JSON.stringify(okRemove));
  const okMove = await ctx2.handlers['tools/pre-execute'](
    { name: 'ops_move', arguments: { path: victim, to: movedTo, expectedRevision: 'r' } },
    () => 'NEXT',
  );
  check('M1: 授节点+子树后 move(目录) 放行', okMove === 'NEXT', JSON.stringify(okMove));
  const delRecs2 = judgments(`${RESULTS}/smoke-m1-both.jsonl`).filter((r) => r.action === 'fs.delete');
  check('M1: 两条 fs.delete 均 allow', delRecs2.length >= 4 && delRecs2.every((r) => r.decision === 'allow'), JSON.stringify(delRecs2));
  deactivate(ctx2);
}

// 15) F1：MAC 防呆——v2 历史账本拒绝挂载，新账本正常
{
  freshLog();
  const ledgerV2 = `${RESULTS}/smoke-f1-v2.jsonl`;
  fs.writeFileSync(ledgerV2, `${JSON.stringify({ id: 'r1', v: 2, plugin: 'x', decision: 'allow', ts: 't' })}\n`);
  const ctx = makeCtx();
  apply(ctx, { ledgerPath: ledgerV2, ledgerMacKey: 'k'.repeat(64) });
  check('F1: v2 历史账本 + MAC 不挂载', !mounted(ctx) && ctx.effects.length === 0);
  const err = log.find(([l, m]) => l === 'error' && /mac_missing|迁移/.test(m));
  check('F1: 报错含迁移步骤', !!err && /ledger-v2-archive/.test(err[1]), JSON.stringify(err));
  // L3：拒绝留痕——side 日志 <ledgerPath>.guard.log 存在且写明 stage=mac-v2-history
  const guardLogPath = `${ledgerV2}.guard.log`;
  check('L3: 防呆拒绝写 side 日志', fs.existsSync(guardLogPath)
    && /stage=mac-v2-history/.test(fs.readFileSync(guardLogPath, 'utf8')), guardLogPath);
  // L1：env 变量名配了但没设值 → 独立报错（不冒充「不能原地启用」）
  freshLog();
  const ctxEnv = makeCtx();
  const ledgerEnv = `${RESULTS}/smoke-f1-env.jsonl`;
  apply(ctxEnv, { ledgerPath: ledgerEnv, ledgerMacKeyEnv: 'DSH_COVENANT_SMOKE_UNSET' });
  check('L1: env 未设置不挂载', !mounted(ctxEnv));
  const envErr = log.find(([l, m]) => l === 'error' && /未设置/.test(m));
  check('L1: 报错区分 env 未设置（非 v2 迁移文案）', !!envErr
    && /DSH_COVENANT_SMOKE_UNSET/.test(envErr[1]) && !/mac_missing/.test(envErr[1]), JSON.stringify(envErr));
  check('L1: env 未设置也写 side 日志', fs.existsSync(`${ledgerEnv}.guard.log`)
    && /stage=mac-env-missing/.test(fs.readFileSync(`${ledgerEnv}.guard.log`, 'utf8')));
  // 新账本（不存在）+ MAC：正常挂载
  freshLog();
  const ctx2 = makeCtx();
  apply(ctx2, { ledgerPath: `${RESULTS}/smoke-f1-new.jsonl`, ledgerMacKey: 'k'.repeat(64) });
  check('F1: 新账本 + MAC 正常挂载', mounted(ctx2));
  deactivate(ctx2);
}

// 16) D4 MAC 密钥透传：账本升级 v3 且带 mac
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
