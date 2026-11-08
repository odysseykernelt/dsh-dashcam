'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { LocalHost } = require('../src/host/local-host');
const { Ledger } = require('../src/runtime/ledger');
const { createPlugin, tempDir, cleanup } = require('./helpers/fixtures');

// Bridge 一旦装上，本测试进程自己的 fs 调用也会被守卫；先钉住原生引用。
const REAL_EXISTS = fs.existsSync;

const READ_SELF = [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读自己的缓存文件' }];
const GRANT_READ_SELF = [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }];

function readLedger(file) {
  try {
    return new Ledger(file).records();
  } catch {
    return [];
  }
}

function denied(records, capability) {
  return records.some((record) => record.decision === 'deny'
    && record.ruleId === 'not_declared'
    && (!capability || record.capability === capability));
}

async function withHost({ id, requests = [], code, files = {}, grants = [], sandbox = { mode: 'handles' }, run }) {
  const dir = tempDir('attack-');
  const pluginDir = path.join(dir, 'plugin');
  createPlugin({ dir: pluginDir, id, requests, code, files });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { grants, sandbox },
  });
  let result;
  try {
    await host.install(pluginDir);
    await host.register(id);
    result = await run({ host });
  } finally {
    try { await host.uninstall(id); } catch { /* 已卸载 */ }
  }
  const records = readLedger(path.join(dir, 'ledger.jsonl'));
  cleanup(dir);
  return { result, records };
}

// ── 第一类：重入与原型链 ─────────────────────────────────────────────

test('攻击 1.1：toString 重入——非路径类型在判定层直接拒绝（M2），强转副作用无从触发', async () => {
  const dir = tempDir('attack-');
  const pluginDir = path.join(dir, 'plugin');
  const outside = path.join(dir, 'outside.txt');
  const pwn = path.join(dir, 'pwned.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    'const path = require("path");',
    `const PWN = ${JSON.stringify(pwn)};`,
    `const OUTSIDE = ${JSON.stringify(outside)};`,
    "const ALLOWED = path.join(__dirname, 'data.txt');",
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    try { out.normalRead = fs.readFileSync(ALLOWED, "utf8").trim(); } catch (e) { out.normalRead = e.code; }',
    '    try {',
    '      fs.readFileSync({ toString() { fs.writeFileSync(PWN, "pwned"); return OUTSIDE; } }, "utf8");',
    '      out.attack = "NOT-DENIED";',
    '    } catch (e) { out.attack = e.code || "error"; out.rule = e.ruleId; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  createPlugin({
    dir: pluginDir,
    id: 'com.example.attack.tostring',
    requests: READ_SELF,
    code,
    files: { 'data.txt': 'cache\n' },
  });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { grants: GRANT_READ_SELF },
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.attack.tostring');
    const out = await host.invoke('com.example.attack.tostring');
    assert.equal(out.normalRead, 'cache', '声明范围内的读取应当放行');
    // M2 之前：路径参数被 String() 强转，toString 里的嵌套写入要靠重入守卫拦；
    // 现在非 string/Buffer/URL 的路径在判定层直接拒绝（invalid_path_type），
    // toString 根本不会被调用——攻击面在更早的位置关死。
    assert.equal(out.attack, 'DASHCAM_DENIED', '非路径类型的参数必须被拒绝');
    assert.equal(out.rule, 'invalid_path_type', '应给出精确的拒绝规则号');
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    assert.ok(
      records.some((record) => record.decision === 'deny' && record.ruleId === 'invalid_path_type'),
      '账本应按 invalid_path_type 记账',
    );
  } finally {
    try { await host.uninstall('com.example.attack.tostring'); } catch { /* 已卸载 */ }
    assert.equal(REAL_EXISTS(pwn), false, 'pwned.txt 不允许落地');
    cleanup(dir);
  }
});

test('攻击 1.2：Proxy get 陷阱——参数求值期间的嵌套读取同样被拒', async () => {
  const dir = tempDir('attack-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    `const OUTSIDE = ${JSON.stringify(outside)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = { leaked: "no" };',
    '    const proxy = new Proxy({}, {',
    '      get(target, key) {',
    '        if (typeof key === "string") {',
    '          try { fs.readFileSync(OUTSIDE); out.leaked = "LEAKED"; } catch (e) { out.leaked = e.code || "error"; }',
    '        }',
    '        return undefined;',
    '      },',
    '    });',
    '    try { fs.readFileSync(proxy); out.attack = "NOT-DENIED"; } catch (e) { out.attack = e.code || "error"; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.proxy',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.proxy'),
    }));
  } finally {
    cleanup(dir);
  }
  assert.equal(result.leaked, 'DASHCAM_DENIED', 'Proxy 陷阱里的读取必须被拒');
  assert.equal(result.attack, 'DASHCAM_DENIED', '外层调用同样应被拒');
});

test('攻击 1.3：Object.prototype 污染——不放大能力面', async () => {
  const dir = tempDir('attack-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    `const OUTSIDE = ${JSON.stringify(outside)};`,
    '// 试图让守卫在缺失自有属性时继承到"全放行"的 scope',
    "Object.prototype.paths = ['/**'];",
    "Object.prototype.capabilities = ['fs.write'];",
    "Object.prototype.commands = ['*'];",
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    try { fs.writeFileSync(OUTSIDE, "pwned"); out.write = "NOT-DENIED"; } catch (e) { out.write = e.code || "error"; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.proto',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.proto'),
    }));
  } finally {
    delete Object.prototype.paths;
    delete Object.prototype.capabilities;
    delete Object.prototype.commands;
    cleanup(dir);
  }
  assert.equal(result.write, 'DASHCAM_DENIED', '原型污染不得让未声明写入通过');
});

test('攻击 1.4：options-Proxy 逃逸——原生读取 options 期间的嵌套写入被守卫拒绝', async () => {
  // F1 回归：原生 fs 会在重入窗口（callDepth>0）里同步读 options.encoding，
  // 未修复时陷阱内的 writeFileSync 会被当作原生重入直通放行。
  const dir = tempDir('attack-');
  const pluginDir = path.join(dir, 'plugin');
  const pwn = path.join(dir, 'pwned.txt');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    'const path = require("path");',
    `const PWN = ${JSON.stringify(pwn)};`,
    "const ALLOWED = path.join(__dirname, 'data.txt');",
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    // 目标必须真持有 encoding 属性：剥离走 Object.assign，空目标不会触发 get 陷阱。',
    '    const options = new Proxy({ encoding: "utf8" }, {',
    '      get(target, key, receiver) {',
    '        if (key === "encoding") {',
    '          try { fs.writeFileSync(PWN, "pwned"); out.attack = "NOT-DENIED"; }',
    '          catch (e) { out.attack = e.code || "error"; }',
    '        }',
    '        return Reflect.get(target, key, receiver);',
    '      },',
    '    });',
    '    try { out.read = fs.readFileSync(ALLOWED, options).trim(); } catch (e) { out.read = e.code || "error"; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  createPlugin({
    dir: pluginDir,
    id: 'com.example.attack.optionsproxy',
    requests: READ_SELF,
    code,
    files: { 'data.txt': 'cache\n' },
  });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { grants: GRANT_READ_SELF },
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.attack.optionsproxy');
    const out = await host.invoke('com.example.attack.optionsproxy');
    assert.equal(out.read, 'cache', 'options 剥离后，声明范围内的读取本身应当正常放行');
    assert.equal(out.attack, 'DASHCAM_DENIED', '陷阱内的嵌套写入必须撞上守卫链');
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    assert.ok(denied(records, 'fs.write'), '账本应记录陷阱写入的拒绝');
  } finally {
    try { await host.uninstall('com.example.attack.optionsproxy'); } catch { /* 已卸载 */ }
    assert.equal(REAL_EXISTS(pwn), false, 'pwned.txt 不允许落地');
    cleanup(dir);
  }
});

test('攻击 1.5：类实例 getter 逃逸——options 提取期间的嵌套写入被守卫拒绝（H1 证据 A）', async () => {
  // H1 回归：类实例（原型非 Object.prototype/null）曾按引用直通原生，原生在
  // callDepth>0 的重入窗口里读 options.encoding 时执行插件 getter——getter 内
  // 的 writeFileSync 被 guardedEntry 当作原生重入直通放行，越权写零记账。
  const dir = tempDir('attack-');
  const pluginDir = path.join(dir, 'plugin');
  const pwn = path.join(dir, 'pwned.txt');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    'const path = require("path");',
    `const PWN = ${JSON.stringify(pwn)};`,
    "const ALLOWED = path.join(__dirname, 'data.txt');",
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    class Evil {',
    '      get encoding() {',
    '        try { fs.writeFileSync(PWN, "pwned"); out.attack = "NOT-DENIED"; }',
    '        catch (e) { out.attack = e.code || "error"; }',
    '        return "utf8";',
    '      }',
    '    }',
    '    try { out.read = fs.readFileSync(ALLOWED, new Evil()).trim(); } catch (e) { out.read = e.code || "error"; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  createPlugin({
    dir: pluginDir,
    id: 'com.example.attack.classevil',
    requests: READ_SELF,
    code,
    files: { 'data.txt': 'cache\n' },
  });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { grants: GRANT_READ_SELF },
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.attack.classevil');
    const out = await host.invoke('com.example.attack.classevil');
    assert.equal(out.read, 'cache', 'getter 返回 utf8，声明范围内的读取照常放行');
    assert.equal(out.attack, 'DASHCAM_DENIED', '类实例 getter 里的越权写入必须撞上守卫链');
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    assert.ok(denied(records, 'fs.write'), '账本应记录 getter 写入的拒绝');
  } finally {
    try { await host.uninstall('com.example.attack.classevil'); } catch { /* 已卸载 */ }
    assert.equal(REAL_EXISTS(pwn), false, 'pwned.txt 不允许落地');
    cleanup(dir);
  }
});

test('攻击 1.6：自有 __proto__ 属性换原型——Object.assign 机制被 defineProperty 提取堵死（H1 证据 B）', async () => {
  // H1 回归：普通对象带自有可枚举 __proto__ 数据属性时，旧实现的 Object.assign
  // 复制会触发 Object.prototype.__proto__ setter 把副本原型换成攻击者对象——
  // 纯普通对象也能把 getter 送进重入窗口。变体二再叠原型链 getter（组合形态）。
  const dir = tempDir('attack-');
  const pluginDir = path.join(dir, 'plugin');
  const pwn = path.join(dir, 'pwned.txt');
  const code = [
    "'use strict';",
    'const fs = require("fs");',
    'const path = require("path");',
    `const PWN = ${JSON.stringify(pwn)};`,
    "const ALLOWED = path.join(__dirname, 'data.txt');",
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    const evil = {',
    '      get encoding() {',
    '        try { fs.writeFileSync(PWN, "pwned"); out.attack = "NOT-DENIED"; }',
    '        catch (e) { out.attack = e.code || "error"; }',
    '        return "utf8";',
    '      },',
    '    };',
    // 变体一：自有可枚举 __proto__ 数据属性。Object.assign 的 [[Set]] 会命中
    // Object.prototype.__proto__ setter 换掉副本原型；白名单提取只读固定键的
    // [[Get]] 并 defineProperty 回填，__proto__ 键不可达，evil 不在访问路径上。
    '    const src = {};',
    '    Object.defineProperty(src, "__proto__", { value: evil, enumerable: true });',
    '    try { out.isBuffer = Buffer.isBuffer(fs.readFileSync(ALLOWED, src)); } catch (e) { out.isBuffer = e.code || "error"; }',
    // 变体二（组合形态）：原型链挂 evil getter + 自有 __proto__ 陷阱——
    // 白名单提取 encoding 时 [[Get]] 走原型链触发 getter，此刻 callDepth===0。
    '    const src2 = Object.create(evil);',
    '    Object.defineProperty(src2, "__proto__", { value: evil, enumerable: true });',
    '    try { out.read = fs.readFileSync(ALLOWED, src2).trim(); } catch (e) { out.read = e.code || "error"; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  createPlugin({
    dir: pluginDir,
    id: 'com.example.attack.protoescape',
    requests: READ_SELF,
    code,
    files: { 'data.txt': 'cache\n' },
  });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { grants: GRANT_READ_SELF },
  });
  try {
    await host.install(pluginDir);
    await host.register('com.example.attack.protoescape');
    const out = await host.invoke('com.example.attack.protoescape');
    assert.equal(out.isBuffer, true, '变体一 encoding 应不可达（返回 Buffer），插件代码零执行');
    assert.equal(out.read, 'cache', '变体二 getter 返回 utf8，读取照常放行');
    assert.equal(out.attack, 'DASHCAM_DENIED', '原型链 getter 里的越权写入必须撞上守卫链');
    const records = readLedger(path.join(dir, 'ledger.jsonl'));
    assert.ok(denied(records, 'fs.write'), '账本应记录 getter 写入的拒绝');
  } finally {
    try { await host.uninstall('com.example.attack.protoescape'); } catch { /* 已卸载 */ }
    assert.equal(REAL_EXISTS(pwn), false, 'pwned.txt 不允许落地');
    cleanup(dir);
  }
});

// ── 第二类：加载器逃逸 ─────────────────────────────────────────────

test('攻击 2.1：process.getBuiltinModule 拿到的是补丁后的同一模块，不是逃逸', async () => {
  const dir = tempDir('attack-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  const code = [
    "'use strict';",
    `const OUTSIDE = ${JSON.stringify(outside)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = { available: typeof process.getBuiltinModule === "function" };',
    '    if (!out.available) { out.attack = "unavailable"; return out; }',
    '    const native = process.getBuiltinModule("fs");',
    '    out.hasRead = !!(native && typeof native.readFileSync === "function");',
    '    try { native.readFileSync(OUTSIDE); out.attack = "LEAKED"; } catch (e) { out.attack = e.code || "error"; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.builtin',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.builtin'),
    }));
  } finally {
    cleanup(dir);
  }
  if (!result.available) {
    assert.equal(result.attack, 'unavailable');
    return;
  }
  assert.equal(result.hasRead, true, 'getBuiltinModule 确实能返回模块对象');
  assert.equal(result.attack, 'DASHCAM_DENIED', '但该对象已被 Bridge 补丁，读取仍被拒');
});

test('攻击 2.2：从非插件父模块 require("fs") 发起调用，仍走守卫链', async () => {
  const dir = tempDir('attack-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  const code = [
    "'use strict';",
    'const Module = require("module");',
    `const OUTSIDE = ${JSON.stringify(outside)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    try {',
    '      const foreign = new Module("/host/foreign.js", null);',
    '      const rawFs = foreign.require("fs");',
    '      out.hasRead = typeof rawFs.readFileSync === "function";',
    '      try { rawFs.readFileSync(OUTSIDE); out.attack = "LEAKED"; } catch (e) { out.attack = e.code || "error"; }',
    '    } catch (e) { out.attack = e.code || e.message; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.foreign',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.foreign'),
    }));
  } finally {
    cleanup(dir);
  }
  assert.equal(result.attack, 'DASHCAM_DENIED', '换一个父模块拿到的仍是被补丁的 fs');
});

test('攻击 2.3：删除 require.cache 后重新 require，封闭面不被还原', async () => {
  const code = [
    "'use strict';",
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    try {',
    '      delete require.cache[require.resolve("fs")];',
    '      const again = require("fs");',
    '      out.readFileSync = typeof again.readFileSync === "function";',
    '      out.readSync = typeof again.readSync === "function";',
    '    } catch (e) { out.error = e.message; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  ({ result } = await withHost({
    id: 'com.example.attack.cache',
    requests: [],
    grants: [],
    code,
    run: async ({ host }) => host.invoke('com.example.attack.cache'),
  }));
  assert.equal(result.readFileSync, true, '句柄面仍可用 readFileSync');
  assert.equal(result.readSync, false, 'handles 模式不存在的 readSync 不能靠清缓存复活');
});

// ── 第三类：异步上下文 ─────────────────────────────────────────────

test('攻击 3.1：Worker eval 逃逸——未授权 proc.spawn 时创建即被拒', async () => {
  const dir = tempDir('attack-');
  const pwn = path.join(dir, 'worker.txt');
  const code = [
    "'use strict';",
    'const { Worker } = require("worker_threads");',
    `const PWN = ${JSON.stringify(pwn)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    try {',
    '      const worker = new Worker(`require("fs").writeFileSync(${JSON.stringify(PWN)}, "pwned")`, { eval: true });',
    '      worker.unref();',
    '      return { worker: "CREATED" };',
    '    } catch (e) { return { worker: e.code || "error" }; }',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.worker',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.worker'),
    }));
  } finally {
    cleanup(dir);
  }
  assert.equal(result.worker, 'DASHCAM_DENIED', 'Worker 创建必须收敛到 proc.spawn 守卫');
});

test('攻击 3.2：卸载后的残留定时器——Bridge 已拆，写入成功（已知缺口）', async () => {
  const dir = tempDir('attack-');
  const pwn = path.join(dir, 'late.txt');
  const code = [
    "'use strict';",
    `const PWN = ${JSON.stringify(pwn)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    setTimeout(() => {',
    '      try { require("fs").writeFileSync(PWN, "late-write"); } catch (e) { /* 卸载后不应再有守卫 */ }',
    '    }, 40);',
    '    return { scheduled: true };',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  const pluginDir = path.join(dir, 'plugin');
  createPlugin({ dir: pluginDir, id: 'com.example.attack.timer', code });
  const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl'), policy: {} });
  let gaps;
  try {
    await host.install(pluginDir);
    await host.register('com.example.attack.timer');
    await host.invoke('com.example.attack.timer');
    gaps = host.coverage().knownGaps;
    await host.uninstall('com.example.attack.timer');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(REAL_EXISTS(pwn), true,
      '已知缺口：卸载后仍在队列里的定时器不再经过守卫链（knownGaps 已声明）');
    assert.ok(gaps.some((gap) => gap.includes('卸载')),
      'knownGaps 必须如实标注卸载后的异步残留');
  } finally {
    try { await host.uninstall('com.example.attack.timer'); } catch { /* 已卸载 */ }
    cleanup(dir);
  }
});

test('攻击 3.3：装载期间的延迟写入——仍在生命周期内时照常被拒', async () => {
  const dir = tempDir('attack-');
  const pwn = path.join(dir, 'live.txt');
  const code = [
    "'use strict';",
    `const PWN = ${JSON.stringify(pwn)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    setTimeout(() => {',
    '      try { require("fs").writeFileSync(PWN, "live-write"); } catch (e) { /* 预期被拒 */ }',
    '    }, 40);',
    '    return { scheduled: true };',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  const dir2 = tempDir('attack-');
  const pluginDir = path.join(dir2, 'plugin');
  createPlugin({ dir: pluginDir, id: 'com.example.attack.live', code });
  const host = new LocalHost({ ledgerPath: path.join(dir2, 'ledger.jsonl'), policy: {} });
  try {
    await host.install(pluginDir);
    await host.register('com.example.attack.live');
    await host.invoke('com.example.attack.live');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(REAL_EXISTS(pwn), false, '定时器只要还在 Bridge 生命周期内，就仍受守卫');
  } finally {
    try { await host.uninstall('com.example.attack.live'); } catch { /* 已卸载 */ }
    cleanup(dir2);
    cleanup(dir);
  }
});

// ── 第四类：降维打击 ─────────────────────────────────────────────

test('攻击 4.1：execSync 未声明 proc.spawn——抛出致命拒绝且无副作用', async () => {
  const dir = tempDir('attack-');
  const pwn = path.join(dir, 'shell.txt');
  const code = [
    "'use strict';",
    'const cp = require("child_process");',
    `const PWN = ${JSON.stringify(pwn)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    try { cp.execSync(`echo pwned > "${PWN}"`); return { shell: "EXECUTED" }; }',
    '    catch (e) { return { shell: e.code || "error" }; }',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.exec',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.exec'),
    }));
  } finally {
    cleanup(dir);
  }
  assert.equal(result.shell, 'DASHCAM_DENIED', '未授权命令执行必须是致命拒绝');
  assert.equal(REAL_EXISTS(pwn), false, '命令不得真的执行');
});

test('攻击 4.2：new Function 拿到的全局 process，其 fs 仍是被补丁的模块', async () => {
  const dir = tempDir('attack-');
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  const code = [
    "'use strict';",
    `const OUTSIDE = ${JSON.stringify(outside)};`,
    'module.exports = {',
    '  activate() {},',
    '  invoke() {',
    '    const out = {};',
    '    try {',
    '      const globalProcess = new Function("return process")();',
    '      const native = globalProcess.getBuiltinModule ? globalProcess.getBuiltinModule("fs") : null;',
    '      if (!native) { out.attack = "no-layer"; return out; }',
    '      try { native.readFileSync(OUTSIDE); out.attack = "LEAKED"; } catch (e) { out.attack = e.code || "error"; }',
    '    } catch (e) { out.attack = e.message; }',
    '    return out;',
    '  },',
    '  deactivate() {},',
    '};',
  ].join('\n');
  let result;
  try {
    ({ result } = await withHost({
      id: 'com.example.attack.dynamic',
      requests: [],
      grants: [],
      code,
      run: async ({ host }) => host.invoke('com.example.attack.dynamic'),
    }));
  } finally {
    cleanup(dir);
  }
  assert.equal(result.attack, 'DASHCAM_DENIED', '动态代码拿到的仍是补丁对象，读取被拒');
});

test('coverage().knownGaps 如实自述：realm 级逃逸与已授权进程内不可见', async () => {
  const dir = tempDir('attack-');
  const pluginDir = path.join(dir, 'plugin');
  createPlugin({ dir: pluginDir, id: 'com.example.gaps' });
  const host = new LocalHost({ ledgerPath: path.join(dir, 'ledger.jsonl'), policy: {} });
  try {
    await host.install(pluginDir);
    await host.register('com.example.gaps');
    const gaps = host.coverage().knownGaps;
    assert.ok(gaps.some((gap) => gap.includes('vm')), '必须声明 vm / 原生扩展没有第二道墙');
    assert.ok(gaps.some((gap) => gap.includes('worker_threads')), '必须声明已授权 Worker 内部不可见');
    assert.ok(gaps.some((gap) => gap.includes('卸载')), '必须声明卸载后的异步残留');
    assert.ok(gaps.some((gap) => gap.includes('process.binding')), '必须声明低层 syscall 逃逸');
  } finally {
    try { await host.uninstall('com.example.gaps'); } catch { /* 已卸载 */ }
    cleanup(dir);
  }
});
