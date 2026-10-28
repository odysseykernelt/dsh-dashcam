'use strict';

/**
 * 符号链接逃逸测试。
 *
 * 背景：scope 判定原本是纯词法的。插件目录里放一个符号链接指向目录外的文件时，
 * 词法路径仍在 `$PLUGIN/**` 之内，判定通过，但 OS 实际读的是范围外的目标。
 * 这就是一条真实的逃逸路径，守卫链必须以「OS 真正会操作的真实路径」作为判定对象。
 *
 * 平台说明：Windows 上创建文件符号链接需要管理员权限或「开发者模式」。
 * 拿不到权限时对应用例用 t.skip 跳过并写明原因，不会变成红灯，也不会静默假装通过。
 * 目录联接（junction）在 Windows 上不需要特权，因此额外用目录链接覆盖同一条逃逸路径，
 * 保证在没有符号链接权限的机器上仍然能真正验证「链接把判定带出范围」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { normalizeGrant } = require('../src/contract/capabilities');
const { Ledger } = require('../src/runtime/ledger');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');
const { deriveFsCapability } = require('../src/runtime/derive');
const { realpathSafe, normalizePath } = require('../src/util/paths');

const IS_WINDOWS = process.platform === 'win32';

/** 与 bypass.test.js 同构：真实 manifest + 真实授予 + 真守卫链。 */
function setup({ requests = [], files = {} } = {}) {
  // 先规范化插件根：macOS 的临时目录是 /var/... 的别名（真实路径 /private/var/...）。
  // 主机侧本就应该用真实路径当 pluginRoot，否则「根的别名」会被误判成越界；
  // 这里先补齐，保证本文件只考察「链接逃逸」这一件事。
  const dir = realpathSafe(tempDir('symlink-'));
  createPlugin({ dir, requests, files });
  const { manifest } = loadManifest(dir);
  const ledger = new Ledger(path.join(dir, 'ledger.jsonl'));
  const seal = new OneSealStore();
  const grants = requests.map((request, index) => normalizeGrant({
    capability: request.cap,
    scope: request.scope,
  }, { pluginRoot: dir }, index));
  const guard = createGuardChain({ manifest, grants, ledger, seal, pluginRoot: dir });
  return { dir, manifest, ledger, seal, guard, grants };
}

/**
 * 建链接。Windows 上无权限时 symlinkSync 抛 EPERM/EACCES，
 * 这里只把「权限不足」识别为跳过信号，其它错误照旧抛出，避免掩盖真实故障。
 */
const NO_PRIVILEGE = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EINVAL', 'UNKNOWN']);

function makeLink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return { ok: true };
  } catch (error) {
    const code = String((error && error.code) || 'UNKNOWN');
    if (NO_PRIVILEGE.has(code)) return { ok: false, code };
    throw error;
  }
}

function skipNoPrivilege(t, kind, code) {
  t.skip(`当前环境无法创建${kind}（${code}）：Windows 需要管理员权限或开发者模式，本用例未执行`);
}

/** 词法路径是否落在 root 之内。用来说明「旧实现会放行」的前提确实成立。 */
function lexicallyInside(root, target) {
  const base = normalizePath(root).replace(/\/$/, '');
  const value = normalizePath(target);
  return value === base || value.startsWith(`${base}/`);
}

test('符号链接：插件内指向范围外文件的链接读取被拒绝', (t) => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const outsideDir = tempDir('symlink-out-');
  try {
    const secret = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    const link = path.join(runtime.dir, 'escape.txt');
    const linked = makeLink(secret, link, 'file');
    if (!linked.ok) {
      skipNoPrivilege(t, '文件符号链接', linked.code);
      return;
    }

    // 前提：词法路径在 $PLUGIN/** 之内，这正是旧实现放行的原因。
    assert.equal(lexicallyInside(runtime.dir, link), true);
    // 判定对象必须是 OS 真正会读的那个路径。
    assert.equal(realpathSafe(link), realpathSafe(secret));

    const decision = runtime.guard.check('fs.read', { path: link });
    assert.equal(decision.allowed, false);
    assert.equal(decision.capability, 'fs.read');
    assert.equal(decision.code, 'not_declared');
    assert.throws(() => runtime.guard.enforce('fs.read', { path: link }), /未声明|未授予/);

    // 逃逸是真的：不经守卫时链接确实读得到范围外的内容，唯一拦截点就是守卫链。
    assert.equal(fs.readFileSync(link, 'utf8'), 'secret');
  } finally {
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('符号链接：指向插件内文件的链接放行', (t) => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  try {
    const target = path.join(runtime.dir, 'own.txt');
    fs.writeFileSync(target, 'own');
    const link = path.join(runtime.dir, 'alias.txt');
    const linked = makeLink(target, link, 'file');
    if (!linked.ok) {
      skipNoPrivilege(t, '文件符号链接', linked.code);
      return;
    }

    // 真实目标仍在插件目录内，判定必须放行——不能因为「是链接」就一律拒绝。
    assert.equal(realpathSafe(link), realpathSafe(target));
    assert.equal(lexicallyInside(runtime.dir, realpathSafe(link)), true);

    const decision = runtime.guard.enforce('fs.read', { path: link });
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.scope.paths, [realpathSafe(target)]);
    assert.equal(fs.readFileSync(link, 'utf8'), 'own');
  } finally {
    cleanup(runtime.dir);
  }
});

test('目录链接：指向范围外目录时，读取其中的文件被拒绝', (t) => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const outsideDir = tempDir('symlink-dirout-');
  try {
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    // Windows 用 junction（无需特权），POSIX 用普通目录符号链接。
    const linkDir = path.join(runtime.dir, 'vendor');
    const linked = makeLink(outsideDir, linkDir, IS_WINDOWS ? 'junction' : 'dir');
    if (!linked.ok) {
      skipNoPrivilege(t, '目录链接', linked.code);
      return;
    }

    const through = path.join(linkDir, 'secret.txt');
    // 词法上仍在插件目录内；真实路径已经跑到了目录外。
    assert.equal(lexicallyInside(runtime.dir, through), true);
    assert.equal(realpathSafe(through), `${realpathSafe(outsideDir)}/secret.txt`);
    assert.throws(() => runtime.guard.enforce('fs.read', { path: through }), /未声明|未授予/);

    // 同目录链接若指向插件内部，则真实目标在范围内，必须放行：
    // 拒绝的依据是最终目标，而不是「路径里出现了链接」。
    const innerDir = path.join(runtime.dir, 'data');
    fs.mkdirSync(innerDir, { recursive: true });
    fs.writeFileSync(path.join(innerDir, 'own.txt'), 'own');
    const innerLink = path.join(runtime.dir, 'inner');
    const innerLinked = makeLink(innerDir, innerLink, IS_WINDOWS ? 'junction' : 'dir');
    if (innerLinked.ok) {
      const allowed = runtime.guard.enforce('fs.read', { path: path.join(innerLink, 'own.txt') });
      assert.equal(allowed.allowed, true);
      assert.deepEqual(allowed.scope.paths, [realpathSafe(path.join(innerDir, 'own.txt'))]);
    }
  } finally {
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('路径不存在：写场景不因 realpath 失败而崩溃，判定仍基于词法路径', () => {
  const runtime = setup({
    requests: [{ cap: 'fs.write', scope: { paths: ['$PLUGIN/**'] }, reason: '写入自身文件' }],
  });
  try {
    const missing = path.join(runtime.dir, 'not-yet.txt');
    assert.equal(fs.existsSync(missing), false);

    // 工具函数一律不抛异常：ENOENT 时退化为「父目录真实路径 + basename」。
    const dirReal = realpathSafe(runtime.dir);
    assert.equal(realpathSafe(missing), `${dirReal}/${path.basename(missing)}`);
    // 临时目录本身没有别名时，回退结果就完全等于词法路径。
    if (dirReal === normalizePath(runtime.dir)) {
      assert.equal(realpathSafe(missing), normalizePath(missing));
    }

    // 多层父目录还不存在时，继续向上回溯到第一个存在的祖先。
    const deep = path.join(runtime.dir, 'a', 'b', 'c.txt');
    assert.equal(realpathSafe(deep), `${dirReal}/a/b/c.txt`);

    // 判定用的是回退后的词法路径（不是异常、也不是 undefined）。
    assert.deepEqual(
      deriveFsCapability('write', missing, { pluginRoot: runtime.dir }).scope.paths,
      [realpathSafe(missing)],
    );
    const decision = runtime.guard.enforce('fs.write', { path: missing });
    assert.equal(decision.allowed, true);
    assert.deepEqual(decision.scope.paths, [realpathSafe(missing)]);

    // 放行之后确实写得进去（没装 Bridge，这里就是原生写）。
    fs.writeFileSync(missing, 'new');
    assert.equal(fs.readFileSync(missing, 'utf8'), 'new');
  } finally {
    cleanup(runtime.dir);
  }
});

test('凭证升级：链接的真实目标是凭证文件时按 cred.read 判定', (t) => {
  const runtime = setup({
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  const outsideDir = tempDir('symlink-cred-');
  try {
    const secret = path.join(outsideDir, 'id_rsa');
    fs.writeFileSync(secret, 'private-key');
    // 链接自身的名字无害，敏感的是真实目标。
    const link = path.join(runtime.dir, 'notes.txt');
    const linked = makeLink(secret, link, 'file');
    if (!linked.ok) {
      skipNoPrivilege(t, '文件符号链接', linked.code);
      return;
    }

    // 升级必须基于同一个真实路径，否则「改个名字的链接」就能把 cred.read 降级成 fs.read。
    const derived = deriveFsCapability('read', link, { pluginRoot: runtime.dir });
    assert.equal(derived.capability, 'cred.read');
    assert.deepEqual(derived.scope.targets, [realpathSafe(secret)]);

    const decision = runtime.guard.check('fs.read', { path: link });
    assert.equal(decision.allowed, false);
    assert.equal(decision.capability, 'cred.read');
    assert.throws(() => runtime.guard.enforce('fs.read', { path: link }), (error) => {
      assert.equal(error.capability, 'cred.read');
      return true;
    });
  } finally {
    cleanup(runtime.dir);
    cleanup(outsideDir);
  }
});

test('真实根别名：pluginRoot 是目录联接时，$PLUGIN/** 授予仍然有效', (t) => {
  // 判定改用真实路径之后，若 pluginRoot 本身是链接（macOS 的 /var → /private/var 就是），
  // 授予按词法根展开、请求按真实根判定，两边永远对不上 —— 等于把所有 $PLUGIN 授予作废。
  // expandPath 现在会先把根规范化成真实路径，本用例锁死这个行为。
  const realRoot = realpathSafe(tempDir('alias-real-'));
  const aliasParent = tempDir('alias-link-');
  const alias = path.join(aliasParent, 'alias');
  try {
    fs.symlinkSync(realRoot, alias, 'junction');
  } catch (error) {
    t.skip(`当前环境无法创建目录联接：${error.code || error.message}`);
    return;
  }

  createPlugin({
    dir: realRoot,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  // 故意用**别名**当插件根：宿主从符号链接路径装载插件是很常见的场景。
  const { manifest } = loadManifest(alias);
  const ledger = new Ledger(path.join(realRoot, 'ledger.jsonl'));
  const grant = normalizeGrant({
    capability: 'fs.read',
    scope: { paths: ['$PLUGIN/**'] },
  }, { pluginRoot: alias }, 0);
  const guard = createGuardChain({ manifest, grants: [grant], ledger, pluginRoot: alias });

  const target = path.join(realRoot, 'own.txt');
  fs.writeFileSync(target, 'own');
  try {
    const decision = guard.enforce('fs.read', { path: path.join(alias, 'own.txt') });
    assert.equal(decision.allowed, true, '别名根下的自身文件不该被拒');
    assert.throws(
      () => guard.enforce('fs.read', { path: path.join(aliasParent, 'outside.txt') }),
      /未声明|未授予|未在 manifest/,
    );
  } finally {
    cleanup(realRoot);
    cleanup(aliasParent);
  }
});
