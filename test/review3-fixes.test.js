'use strict';

/**
 * 第三轮三视角审查（S0/S2/S3）的回归用例。
 * 共同主题：**判定必须发生在重入窗口之外**，配置不能静默失效，失败路径必须能回滚。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadPolicy } = require('../src/policy');
const { createPluginRuntime } = require('../src/index');
const { LocalHost } = require('../src/host/local-host');
const { hostPatternCovers, normalizeRequest, normalizeGrant } = require('../src/contract/capabilities');

// 在 Bridge 补丁之前钉住原生读，用例自己读账本时才不会被守卫拦住。
const REAL_READ = fs.readFileSync;

function manifestFor(requests, pluginRoot = null) {
  return {
    id: 'com.example.review3',
    name: 'Review3',
    version: '1.0.0',
    entry: 'index.js',
    kind: 'covenant',
    covenant: {
      spec: 'dsh-covenant/1',
      content: null,
      // 守卫链只认已归一化的请求（与 loadManifest 的输出同形）：net 的 hosts
      // 在归一化后是 { host, port } 对象，直接塞原始字符串会判成 not_declared。
      requests: requests.map((request) => normalizeRequest(request, { pluginRoot })),
    },
  };
}

function scopedRoot() {
  const dir = tempDir('review3-');
  const pluginRoot = path.join(dir, 'plugin');
  fs.mkdirSync(pluginRoot, { recursive: true });
  const inside = path.join(pluginRoot, 'ok.txt');
  fs.writeFileSync(inside, 'insider');
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'TOP-SECRET');
  return { dir, pluginRoot, inside, outside, ledgerPath: path.join(dir, 'ledger.jsonl') };
}

function countRecords(ledgerPath) {
  try {
    return REAL_READ(ledgerPath, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

test('S0：判定期间的参数强转不能再借重入窗口越权（且必须落账）', () => {
  const ctx = scopedRoot();
  const requests = [{ capability: 'fs.read', scope: { paths: [`${ctx.pluginRoot}/**`] }, reason: '读自己目录' }];
  const grants = [{ capability: 'fs.read', scope: { paths: [`${ctx.pluginRoot}/**`] } }];
  const runtime = createPluginRuntime({
    manifest: manifestFor(requests),
    grants,
    ledgerPath: ctx.ledgerPath,
    pluginRoot: ctx.pluginRoot,
    patchBuiltins: true,
    autoSweep: false,
  });
  try {
    let stolen = null;
    let error = null;
    try {
      // 守卫判定会把参数强转成路径；toString 里跑的是插件代码。
      fs.existsSync({
        toString() {
          stolen = fs.readFileSync(ctx.outside, 'utf8');
          return ctx.inside;
        },
      });
    } catch (failure) {
      error = failure;
    }
    assert.equal(stolen, null, '强转里发起的越权读取必须被守卫挡住');
    assert.ok(error, '拒绝必须以异常暴露，而不是静默放行');
    // 内层拒绝会被外层 derive 包装成 derive_failed（判定期间的一次拒绝），
    // 两种码都说明「没有静默放行」。
    assert.match(String(error.ruleId || error.message), /derive_failed|not_declared|未声明|拒绝|denied/i);
    const records = REAL_READ(ctx.ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.some((r) => JSON.stringify(r.scope).includes('secret.txt')), true, '越权尝试必须留痕');
  } finally {
    runtime.dispose();
    cleanup(ctx.dir);
  }
});

test('S2：一次 ctx.handles 调用只写一条账本（不再被 Bridge 二次判定）', () => {
  const ctx = scopedRoot();
  const requests = [{ capability: 'fs.read', scope: { paths: [`${ctx.pluginRoot}/**`] }, reason: '读自己目录' }];
  const grants = [{ capability: 'fs.read', scope: { paths: [`${ctx.pluginRoot}/**`] } }];
  const runtime = createPluginRuntime({
    manifest: manifestFor(requests),
    grants,
    ledgerPath: ctx.ledgerPath,
    pluginRoot: ctx.pluginRoot,
    patchBuiltins: true,
    autoSweep: false,
  });
  try {
    const before = countRecords(ctx.ledgerPath);
    runtime.handles.fs.readFileSync(ctx.inside, 'utf8');
    const added = countRecords(ctx.ledgerPath) - before;
    assert.equal(added, 1, `一次句柄调用只应产生 1 条记录，实际 ${added} 条`);
  } finally {
    runtime.dispose();
    cleanup(ctx.dir);
  }
});

test('S2：sandbox 字符串写法被识别，非法 mode 直接报错', () => {
  assert.equal(loadPolicy({ sandbox: 'handles' }).sandbox.mode, 'handles');
  assert.equal(loadPolicy({}).sandbox.mode, 'global');
  assert.equal(loadPolicy({ sandbox: { mode: 'global' } }).sandbox.mode, 'global');
  assert.throws(() => loadPolicy({ sandbox: 'bogus' }), /sandbox\.mode 非法/);
  assert.throws(() => loadPolicy({ sandbox: { mode: 'bogus' } }), /sandbox\.mode 非法/);
});

test('S2：activate 抛错时注册回滚，不会卡在「已有活动 Bridge」', async () => {
  const dir = tempDir('review3-rollback-');
  const pluginDir = path.join(dir, 'plugin');
  createPlugin({
    dir: pluginDir,
    requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读自己目录' }],
    code: [
      "'use strict';",
      'module.exports = {',
      "  activate() { throw new Error('boom'); },",
      '  invoke() { return { ok: true }; },',
      '  deactivate() {},',
      '};',
    ].join('\n'),
  });
  const host = new LocalHost({
    ledgerPath: path.join(dir, 'ledger.jsonl'),
    policy: { grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
  });
  try {
    await host.install(pluginDir);
    await assert.rejects(() => host.register('com.example.test'), /注册失败（activate 抛错）/);
    // 未回滚时第二次注册会命中「已有活动 Bridge」，这里是同一条 activate 错误。
    await assert.rejects(() => host.register('com.example.test'), /注册失败（activate 抛错）/);
    assert.equal(host.active, null);
  } finally {
    try { await host.uninstall('com.example.test'); } catch { /* 未注册成功 */ }
    cleanup(dir);
  }
});

test('S3：跨主机重定向必须重新判定；同主机重定向仍然跟到底', async () => {
  const dir = tempDir('review3-redirect-');
  const pluginRoot = path.join(dir, 'plugin');
  fs.mkdirSync(pluginRoot, { recursive: true });
  const ledgerPath = path.join(dir, 'ledger.jsonl');

  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('INTERNAL');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const targetPort = target.address().port;

  const origin = http.createServer((req, res) => {
    if (req.url === '/cross') {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/secret` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('OK');
  });
  await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = origin.address().port;

  const requests = [{ capability: 'net.outbound', scope: { hosts: [`127.0.0.1:${originPort}`] }, reason: '出网' }];
  // 授予同样要与 loadPolicy 的输出同形：net 的 hosts 归一化后是 { host, port }。
  const grants = [normalizeGrant({ capability: 'net.outbound', scope: { hosts: [`127.0.0.1:${originPort}`] } })];
  const runtime = createPluginRuntime({
    manifest: manifestFor(requests),
    grants,
    ledgerPath,
    pluginRoot,
    patchBuiltins: true,
    autoSweep: false,
  });
  try {
    // 授权范围内的跳转：仍然要跟到底，保持原生语义。
    const response = await fetch(`http://127.0.0.1:${originPort}/final`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');

    // 越出授权面的跳转：第一跳放行，第二跳必须拒绝。
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${originPort}/cross`),
      /not_declared|未声明|拒绝|denied/i,
    );
    const records = countRecords(ledgerPath);
    assert.ok(records >= 2, '第一跳的判定与新跳的拒绝都必须写进账本');
  } finally {
    runtime.dispose();
    await new Promise((resolve) => origin.close(resolve));
    await new Promise((resolve) => target.close(resolve));
    cleanup(dir);
  }
});

test('S3：IPv6 host 断言不因方括号写法差异而失效', () => {
  assert.equal(hostPatternCovers('::1:443', '[::1]:443'), true);
  assert.equal(hostPatternCovers('[::1]:443', '::1:443'), true);
  assert.equal(hostPatternCovers('[::1]:443', '[::1]:80'), false);
  assert.equal(hostPatternCovers('*.example.com:443', 'api.example.com:443'), true);
});
