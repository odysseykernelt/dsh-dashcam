'use strict';

// 安全审查「快赢批」（2026-11-05，v1.10.6）medium 项回归测试：
//   M2  数字 path 判定对象 ≠ 执行对象（守卫按字符串 "0" 判定、OS 读 fd 0）
//   M6  uninstall 回收链半途失败跳过后续清理
//   M12 retired 密钥仍可验签
//   M13 凭证黑名单漏 ~/.git-credentials、~/.config/gh/hosts.yml
//   M14 npm test 脚本漏文件（child-host / child / protocol 三个测试文件没被跑）
// M12 的端到端轮换用例（retire 后旧包拒验）在 test/signatures.test.js。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { tempDir, cleanup, createPlugin } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { createGuardChain } = require('../src/runtime/guards');
const { LocalHost } = require('../src/host/local-host');
const { ChildHost } = require('../src/host/child-host');
const { createTrust, findKey, retireKey } = require('../src/signing/trust');
const { isCredentialPath } = require('../src/util/paths');

// child-host.test.js 同款骨架：createGuardChain 期望 manifest 里的 scope 是
// 已展开的绝对路径（真实流程由 parseManifest 完成）。
function guardWithFsReadGrant(dir) {
  const scope = { paths: [dir.replace(/\\/g, '/') + '/**'] };
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const guard = createGuardChain({
    manifest: {
      id: 'com.example.quickwins',
      name: 'QuickWins',
      version: '1.0.0',
      entry: 'x.js',
      kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读自身文件' }],
      },
    },
    grants: [{ id: 'g', capability: 'fs.read', scope, enabled: true, expiresAt: null, oneSeal: false }],
    ledger,
    pluginRoot: dir,
  });
  return { guard, ledger };
}

// ── M12：retired 密钥不得验签 ──────────────────────────────────────

test('M12：findKey 只接受 active——retired / revoked / 过期密钥一律不可用', () => {
  const trust = createTrust([
    { keyId: 'k-active', role: 'publisher', publicKey: 'pk-1' },
    { keyId: 'k-retired', role: 'publisher', publicKey: 'pk-2', status: 'retired' },
    { keyId: 'k-revoked', role: 'publisher', publicKey: 'pk-3', status: 'revoked' },
    { keyId: 'k-expired', role: 'publisher', publicKey: 'pk-4', notAfter: 1000 },
  ]);
  assert.ok(findKey(trust, 'k-active', 'publisher'), 'active 密钥应可用');
  assert.equal(findKey(trust, 'k-retired', 'publisher'), null, 'retired 密钥不得再验签（M12）');
  assert.equal(findKey(trust, 'k-revoked', 'publisher'), null, 'revoked 密钥不得验签');
  assert.equal(findKey(trust, 'k-expired', 'publisher', 2000), null, '过期密钥不得验签');
  assert.equal(findKey(trust, 'k-active', 'reviewer'), null, '角色不匹配的密钥不可用');
  // retire 即失验：轮换窗口关闭后，同一把 keyId 立刻从验签面消失。
  retireKey(trust, 'k-active');
  assert.equal(findKey(trust, 'k-active', 'publisher'), null, 'retire 之后不得再验签');
});

// ── M2：数字 path 在判定层直接拒绝 ─────────────────────────────────

test('M2：数字 path 被拒——即使字符串形态落在授权面内（invalid_path_type）', () => {
  const dir = tempDir('m2-guard-');
  try {
    const { guard, ledger } = guardWithFsReadGrant(dir);
    // 前置：字符串 "0"（相对路径）解析为 <root>/0，落在 $root/** 授权内——
    // M2 之前数字 0 也被 String() 成 "0" 走这条路放行，随后 readFileSync(0)
    // 读的是宿主 stdin。判定对象必须与执行对象一致。
    assert.doesNotThrow(() => guard.enforce('fs.read', { path: '0' }), '字符串 "0" 走正常路径判定');
    // 数字直接拒绝，且授权面大小无关。
    for (const bad of [0, 3, -1]) {
      assert.throws(
        () => guard.enforce('fs.read', { path: bad }),
        (error) => error.code === 'DASHCAM_DENIED' && error.ruleId === 'invalid_path_type',
        `数字 path ${bad} 必须按 invalid_path_type 拒绝`,
      );
    }
    // 写面同理；无 href 的对象也不再 String() 强转（toString 副作用无从触发）。
    assert.throws(() => guard.enforce('fs.write', { path: 1 }), (error) => error.ruleId === 'invalid_path_type');
    assert.throws(
      () => guard.enforce('fs.read', { path: { toString() { return '0'; } } }),
      (error) => error.ruleId === 'invalid_path_type',
      '非 string/Buffer/URL 的对象路径必须被类型门拒绝',
    );
    // string / Buffer / URL 三种合法类型照常走路径判定，不被类型门误伤。
    assert.doesNotThrow(() => guard.enforce('fs.read', { path: Buffer.from('0', 'utf8') }));
    assert.doesNotThrow(() => guard.enforce('fs.read', { path: pathToFileURL(path.join(dir, '0')) }));
    // 拒绝必须落账，且带精确 ruleId。
    assert.ok(
      ledger.records().some((record) => record.decision === 'deny' && record.ruleId === 'invalid_path_type'),
      'invalid_path_type 拒绝必须留痕',
    );
  } finally {
    cleanup(dir);
  }
});

test('M2：ChildHost 的 fs 入口——数字 path 在任何真实 IO 之前被拒', () => {
  const dir = tempDir('m2-child-');
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
    const { guard, ledger } = guardWithFsReadGrant(dir);
    // 不 start()、不 fork：直接打宿主侧处理函数，验证判定与 IO 的先后关系。
    const host = new ChildHost({ guard, childEntry: path.join(__dirname, '..', 'examples', 'child-plugin.js') });
    assert.throws(() => host._fsRead({ path: 0 }), (error) => error.ruleId === 'invalid_path_type', 'fs.read 数字 path 必须被拒');
    assert.throws(() => host._fsWrite({ path: 0, data: 'x' }), (error) => error.ruleId === 'invalid_path_type', 'fs.write 数字 path 必须被拒');
    assert.throws(
      () => host._fsReadMany({ paths: [path.join(dir, 'a.txt'), 0] }),
      (error) => error.ruleId === 'invalid_path_type' && error.batch && error.batch.count === 2,
      '批量读里的数字 path 同样必须被拒（且批量已推进到第 2 个目标）',
    );
    assert.ok(
      ledger.records().some((record) => record.decision === 'deny' && record.ruleId === 'invalid_path_type'),
      '宿主侧账本必须留痕',
    );
  } finally {
    cleanup(dir);
  }
});

// ── M6：uninstall 回收链逐项兜底 ───────────────────────────────────

test('M6：redirect.uninstall 抛错不跳过 bridge.uninstall / seal.stop / active 清理', async () => {
  const dir = tempDir('m6-uninstall-');
  const nativeRead = fs.readFileSync;
  try {
    createPlugin({
      dir: path.join(dir, 'plugin'),
      id: 'com.example.m6.uninstall',
      requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读' }],
    });
    const host = new LocalHost({
      ledgerPath: path.join(dir, 'ledger.jsonl'),
      policy: {
        sandbox: { mode: 'handles' },
        grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }],
      },
    });
    await host.install(path.join(dir, 'plugin'));
    await host.register('com.example.m6.uninstall');
    assert.notEqual(fs.readFileSync, nativeRead, '前置：注册后 Bridge Hook 已装上');
    assert.ok(host.active.redirect, '前置：handles 模式创建了模块重定向');

    const { redirect, bridge, seal } = host.active;
    const realRedirectUninstall = redirect.uninstall.bind(redirect);
    let bridgeUninstalled = false;
    let sealStopped = false;
    const realBridgeUninstall = bridge.uninstall.bind(bridge);
    const realSealStop = seal.stop.bind(seal);
    bridge.uninstall = () => { bridgeUninstalled = true; return realBridgeUninstall(); };
    seal.stop = () => { sealStopped = true; return realSealStop(); };
    redirect.uninstall = () => { throw new Error('redirect 卸载失败（注入）'); };
    try {
      // 回收失败必须可见：错误照常抛给调用方……
      await assert.rejects(() => host.uninstall('com.example.m6.uninstall'), /redirect 卸载失败/);
      // ……但其余清理一步都不许跳过（M6 之前这里会全部被跳过）。
      assert.equal(bridgeUninstalled, true, 'bridge.uninstall 不得被跳过');
      assert.equal(sealStopped, true, 'seal.stop 不得被跳过');
      assert.equal(host.active, null, 'active 必须清零，不能留在半卸载状态');
      assert.equal(fs.readFileSync, nativeRead, 'bridge 卸载后 fs 应回到原生');
    } finally {
      // 无论断言成败，都还原注入并真正拆掉模块重定向，避免 Module._load 残留补丁。
      redirect.uninstall = realRedirectUninstall;
      realRedirectUninstall();
    }
    // 半途失败的 uninstall 之后，宿主可重新注册（active 已清零）。
    await host.register('com.example.m6.uninstall');
    await host.uninstall('com.example.m6.uninstall');
    assert.equal(fs.readFileSync, nativeRead, '再次卸载后 Hook 仍干净');
  } finally {
    cleanup(dir);
  }
});

// ── M13：git / gh 凭证路径触发 cred.read ───────────────────────────

test('M13：读 ~/.git-credentials 与 ~/.config/gh/hosts.yml 升级为 cred.read 判定', () => {
  const dir = tempDir('m13-cred-');
  try {
    // 用临时目录模拟家目录下的凭证位置：黑名单按路径段匹配，不锚定真实 $HOME。
    const gitCreds = path.join(dir, '.git-credentials');
    const ghHosts = path.join(dir, '.config', 'gh', 'hosts.yml');
    fs.writeFileSync(gitCreds, 'https://pat@github.example\n');
    fs.mkdirSync(path.dirname(ghHosts), { recursive: true });
    fs.writeFileSync(ghHosts, 'github.com:\n  oauth_token: xxx\n');

    const { guard, ledger } = guardWithFsReadGrant(dir);
    for (const target of [gitCreds, ghHosts]) {
      // 授权面是 fs.read <dir>/**：凭证路径必须升级判定，不能被普通读放行。
      let error = null;
      try { guard.enforce('fs.read', { path: target }); } catch (denied) { error = denied; }
      assert.ok(error, `${target} 必须被拒绝`);
      assert.equal(error.capability, 'cred.read', `${target} 应升级为 cred.read 判定`);
      assert.ok(error.ruleId === 'not_declared' || error.ruleId === 'not_granted');
    }
    const records = ledger.records();
    for (const target of [gitCreds, ghHosts]) {
      assert.ok(
        records.some((record) => record.decision === 'deny'
          && record.capability === 'cred.read'
          && JSON.stringify(record.scope).includes(path.basename(target))),
        `${path.basename(target)} 的 cred.read 拒绝必须留痕`,
      );
    }
    // 单元口径：新增路径命中，~/.dsh 按注释约定暂不列入。
    assert.equal(isCredentialPath('/home/u/.git-credentials'), true);
    assert.equal(isCredentialPath('/home/u/.config/gh/hosts.yml'), true);
    assert.equal(isCredentialPath('C:\\Users\\u\\.git-credentials'), true, 'Windows 分隔符同样命中');
    assert.equal(isCredentialPath('/home/u/.dsh/ledger.jsonl'), false, '~/.dsh 暂不列入（口径见 paths.js 注释）');
    assert.equal(isCredentialPath('/home/u/notes.txt'), false);
  } finally {
    cleanup(dir);
  }
});

// ── M14：test 脚本覆盖磁盘全部测试文件 ─────────────────────────────

test('M14：npm test 脚本覆盖磁盘上全部 test/*.test.js（脚本覆盖数 = 磁盘文件数）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const script = pkg.scripts && pkg.scripts.test;
  assert.ok(typeof script === 'string' && script.includes('node --test'), 'test 脚本应显式列举测试文件');
  const listed = new Set();
  for (const match of script.matchAll(/test\/([\w.-]+\.test\.js)/g)) listed.add(match[1]);
  const onDisk = new Set(fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js')));
  assert.ok(onDisk.size > 0, '前置：磁盘上应有测试文件');
  assert.deepEqual(
    [...onDisk].filter((name) => !listed.has(name)).sort(),
    [],
    'test 脚本漏了这些文件（M14：child-host / child / protocol 曾整段没被跑）',
  );
  assert.deepEqual(
    [...listed].filter((name) => !onDisk.has(name)).sort(),
    [],
    'test 脚本列举了磁盘上不存在的文件',
  );
});
