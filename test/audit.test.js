'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, cleanup } = require('./helpers/fixtures');
const { Ledger } = require('../src/runtime/ledger');
const { stableStringify, sha256 } = require('../src/util/stable');
const { OneSealStore } = require('../src/runtime/one-seal');
const { createGuardChain } = require('../src/runtime/guards');
const { LocalHost } = require('../src/host/local-host');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

function record(overrides = {}) {
  return {
    plugin: 'com.example.audit',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '读取缓存',
    ...overrides,
  };
}

test('Ledger：正常账本可逐行重算', () => {
  const dir = tempDir('audit-ok-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_granted', reason: '宿主未授予' }));
  const report = new Ledger(file).verify();
  assert.equal(report.ok, true);
  assert.equal(report.count, 2);
  assert.equal(report.errors.length, 0);
  assert.match(report.head, /^[a-f0-9]{64}$/);
  cleanup(dir);
});

test('Ledger：尾行损坏时报告 json_invalid，而不是让 verify 抛异常', () => {
  const dir = tempDir('audit-tail-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record());
  fs.appendFileSync(file, '{"v":1,"seq":3,"broken\n');
  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.equal(report.head, null);
  assert.ok(report.errors.some((error) => error.code === 'json_invalid' && error.line === 3));
  cleanup(dir);
});

test('Ledger：v1 历史账本仍可验证（版本感知字段集）', () => {
  const dir = tempDir('audit-v1-');
  const file = path.join(dir, 'ledger.jsonl');
  const base = {
    v: 1,
    seq: 1,
    ts: '2026-10-01T00:00:00.000Z',
    plugin: 'com.example.old',
    pluginVersion: '1.0.0',
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '旧版记录',
    prevHash: 'GENESIS',
  };
  base.hash = sha256(stableStringify(base));
  fs.writeFileSync(file, JSON.stringify(base) + '\n');
  const report = new Ledger(file).verify();
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.count, 1);
  cleanup(dir);
});

test('Ledger：v1 记录里塞入 intercepted 会被 hash 校验抓住', () => {
  const dir = tempDir('audit-v1-tamper-');
  const file = path.join(dir, 'ledger.jsonl');
  const base = {
    v: 1,
    seq: 1,
    ts: '2026-10-01T00:00:00.000Z',
    plugin: 'com.example.old',
    pluginVersion: null,
    capability: 'fs.read',
    action: 'fs.read',
    scope: { paths: ['/tmp/x'] },
    decision: 'allow',
    ruleId: 'two-key',
    reason: '旧版记录',
    prevHash: 'GENESIS',
  };
  base.hash = sha256(stableStringify(base));
  base.intercepted = true;
  fs.writeFileSync(file, JSON.stringify(base) + '\n');
  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'hash_mismatch'));
  cleanup(dir);
});

test('Ledger：中间行被篡改时定位到具体行号', () => {
  const dir = tempDir('audit-tamper-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record());
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.decision = 'deny';
  lines[0] = JSON.stringify(first);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const report = new Ledger(file).verify();
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.code === 'hash_mismatch' && error.line === 1));
  cleanup(dir);
});

test('One-Seal：审计写失败时释放占位，不白烧一次性授权（failMode=closed 显式开启）', () => {
  const dir = tempDir('audit-seal-');
  const scope = { paths: [path.join(dir, '**')] };
  const seal = new OneSealStore({ ttlMs: 60_000 });
  seal.issue({ id: 'seal-1', oneSeal: true, sealTtlMs: 60_000 });
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读取缓存' }],
      },
    },
    grants: [{
      id: 'seal-1',
      capability: 'fs.read',
      scope,
      enabled: true,
      oneSeal: true,
      expiresAt: null,
      sealTtlMs: 60_000,
    }],
    ledger: { append() { throw new Error('disk full'); } },
    seal,
    // closed 是 opt-in：只有显式配置才回到「写不进账就拒绝执行」的护栏语义。
    policy: { ledger: { failMode: 'closed' } },
  });

  assert.throws(() => guard.enforce('fs.read', { path: path.join(dir, 'a.txt') }), /Ledger 写入失败/);
  assert.equal(seal.isAvailable('seal-1'), true, '一次性授权不应被审计故障消耗');
  cleanup(dir);
});

test('One-Seal：failMode=open（默认）时账本故障不拦活，放行且消费一次性授权', () => {
  const dir = tempDir('audit-seal-open-');
  const scope = { paths: [path.join(dir, '**')] };
  const seal = new OneSealStore({ ttlMs: 60_000 });
  seal.issue({ id: 'seal-1', oneSeal: true, sealTtlMs: 60_000 });
  let appendCalls = 0;
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读取缓存' }],
      },
    },
    grants: [{
      id: 'seal-1',
      capability: 'fs.read',
      scope,
      enabled: true,
      oneSeal: true,
      expiresAt: null,
      sealTtlMs: 60_000,
    }],
    ledger: { append() { appendCalls += 1; throw new Error('disk full'); } },
    seal,
  });

  // 默认 open：账本故障不抛、活动照常放行（行车记录仪不拦车）；
  // 放行了就要烧掉一次性授权，不能留下可重放的窗口。
  const decision = guard.enforce('fs.read', { path: path.join(dir, 'a.txt') });
  assert.equal(decision.allowed, true);
  assert.equal(decision.ledgerSeq, null);
  assert.equal(seal.isAvailable('seal-1'), false, '放行必须 commit 一次性授权');
  // 原始写入 + ledger_fail 标记都尝试过（标记也失败属预期）。
  assert.equal(appendCalls, 2);
  cleanup(dir);
});

test('归属标注：账本记录带 profiled / manifestHash（有契约与零契约两种形态）', () => {
  const dir = tempDir('audit-attribution-');
  const scope = { paths: [path.join(dir, '**')] };
  const requests = [{ capability: 'fs.read', scope, reason: '读取缓存' }];
  const manifestOf = (reqs) => ({
    id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
    dashcam: { spec: 'dsh-dashcam/1', content: null, requests: reqs },
  });

  // 有契约：profiled=true，manifestHash 是声明清单的稳定哈希。
  const fileA = path.join(dir, 'a.jsonl');
  const guardA = createGuardChain({
    manifest: manifestOf(requests),
    grants: [{ id: 'g1', capability: 'fs.read', scope, enabled: true }],
    ledger: new Ledger(fileA),
  });
  guardA.enforce('fs.read', { path: path.join(dir, 'a.txt') });
  const rowA = new Ledger(fileA).records()[0];
  assert.equal(rowA.profiled, true);
  assert.equal(rowA.manifestHash, sha256(stableStringify(requests)));

  // 零契约：profiled=false，manifestHash=null——「没契约」本身是可审计事实。
  const fileB = path.join(dir, 'b.jsonl');
  const guardB = createGuardChain({
    manifest: manifestOf([]),
    grants: [],
    ledger: new Ledger(fileB),
  });
  const denial = guardB.check('fs.read', { path: path.join(dir, 'b.txt') });
  assert.equal(denial.allowed, false);
  const rowB = new Ledger(fileB).records()[0];
  assert.equal(rowB.profiled, false);
  assert.equal(rowB.manifestHash, null);
  cleanup(dir);
});

test('N1：本进程首次打开的账本若刚被外部写入，构造时显式告警', () => {
  const dir = tempDir('audit-n1-');
  const file = path.join(dir, 'ledger.jsonl');
  // 模拟另一个写入者进程刚落了一行（本进程对这条路径没有任何共享基准）。
  fs.writeFileSync(file, `${JSON.stringify({ v: 4, seq: 1, note: '外部写入' })}\n`, 'utf8');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    new Ledger(file);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((message) => message.includes('最近 5 秒内被外部修改')),
    `应有外部新写告警，实际：${JSON.stringify(warnings)}`,
  );
  cleanup(dir);
});

test('N1：默认账本路径按实例区分（profile → .dsh-ledger-<profile>.jsonl）', () => {
  const defaultHost = new LocalHost();
  assert.ok(
    defaultHost.baseLedgerPath.endsWith(path.join('.dsh-ledger-default.jsonl'))
      || defaultHost.baseLedgerPath.endsWith('.dsh-ledger-default.jsonl'),
    defaultHost.baseLedgerPath,
  );
  const webHost = new LocalHost({ profile: 'web' });
  assert.ok(webHost.baseLedgerPath.endsWith('.dsh-ledger-web.jsonl'), webHost.baseLedgerPath);
});

test('CLI verify-ledger：脱离宿主进程验链，篡改行报非零退出', () => {
  const dir = tempDir('audit-cli-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_granted', reason: '宿主未授予' }));

  const bin = path.join(__dirname, '..', 'bin', 'dsh-dashcam.js');
  const good = spawnSync(process.execPath, [bin, 'verify-ledger', file], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  const parsed = JSON.parse(good.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.records, 2);
  assert.equal(parsed.lastSeq, 2);

  // 篡改中间行的 reason（不改 hash）→ 校验失败、退出码 1。
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const forged = JSON.parse(lines[0]);
  forged.reason = '被篡改的理由';
  lines[0] = stableStringify(forged);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  const bad = spawnSync(process.execPath, [bin, 'verify-ledger', file], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const badParsed = JSON.parse(bad.stdout);
  assert.equal(badParsed.ok, false);
  assert.ok(badParsed.errors.some((error) => error.code === 'hash_mismatch'));
  cleanup(dir);
});

test('N5：rotate 归档旧段、新段以 segment-rotate 链接记录开头，链可验', () => {
  const dir = tempDir('audit-rotate-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_granted', reason: '宿主未授予' }));
  const before = new Ledger(file);
  const firstHash = before.records()[0].hash;
  const lastHash = before.records()[1].hash;

  const result = ledger.rotate();
  assert.ok(result.archivedPath.endsWith('.jsonl'), result.archivedPath);
  assert.ok(fs.existsSync(result.archivedPath), '旧段应保留');
  assert.equal(result.records, 2);
  assert.equal(result.lastSeq, 2);
  assert.equal(result.firstHash, firstHash);
  assert.equal(result.lastHash, lastHash);

  // 新段：链接记录 seq=1，scope 携带旧段首尾 hash（basename，不带绝对路径）。
  const fresh = new Ledger(file);
  const link = fresh.append({
    plugin: 'dsh-dashcam',
    pluginVersion: 'test',
    capability: 'telemetry',
    action: 'segment-rotate',
    scope: {
      archived: path.basename(result.archivedPath),
      records: result.records,
      lastSeq: result.lastSeq,
      prevSegmentFirstHash: result.firstHash,
      prevSegmentLastHash: result.lastHash,
    },
    decision: 'allow',
    ruleId: 'rotate',
    reason: '账本轮转：新段从此开始',
    intercepted: false,
  });
  assert.equal(link.seq, 1);
  assert.equal(new Ledger(file).verify().ok, true);
  // 旧段归档后仍可独立验链。
  assert.equal(new Ledger(result.archivedPath).verify().ok, true);
  // 坏账拒绝轮转。
  const brokenFile = path.join(dir, 'broken.jsonl');
  const broken = new Ledger(brokenFile);
  broken.append(record());
  const lines = fs.readFileSync(brokenFile, 'utf8').split('\n').filter(Boolean);
  const forged = JSON.parse(lines[0]);
  forged.reason = '篡改';
  fs.writeFileSync(brokenFile, `${stableStringify(forged)}\n`, 'utf8');
  assert.throws(() => new Ledger(brokenFile).rotate(), /拒绝轮转/);
  cleanup(dir);
});

test('N5：_recover 尾读——超过尾窗的大账本仍能正确续写（seq/hash 接上）', () => {
  const dir = tempDir('audit-tail-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  // >64KB 尾窗：每条约 200B，写 500 条。
  for (let index = 0; index < 500; index += 1) {
    ledger.append(record({ reason: `填充记录 ${index}，padding`.padEnd(160, 'x') }));
  }
  const all = new Ledger(file).records();
  assert.equal(all.length, 500);
  assert.equal(all[499].seq, 500);
  // 尾读之后继续追加：seq 与 prevHash 必须接上（append 内部断言 prevHash 一致性）。
  const next = new Ledger(file).append(record({ reason: '尾读后续写' }));
  assert.equal(next.seq, 501);
  assert.equal(new Ledger(file).verify().ok, true);
  cleanup(dir);
});

test('N5：redact 折叠 home 为 $HOME、保留归属字段，输出为可验的新链', () => {
  const dir = tempDir('audit-redact-');
  const file = path.join(dir, 'ledger.jsonl');
  const ledger = new Ledger(file);
  const homePath = path.join(os.homedir(), 'secret-project', 'token.pem');
  ledger.append(record({ plugin: 'p1', reason: `读取 ${homePath} 失败`, scope: { paths: [homePath] } }));
  ledger.append(record({ plugin: 'p2', decision: 'deny', ruleId: 'not_declared', reason: '宿主未授予' }));

  const bin = path.join(__dirname, '..', 'bin', 'dsh-dashcam.js');
  const out = path.join(dir, 'redacted.jsonl');
  const run = spawnSync(process.execPath, [bin, 'redact', file, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const summary = JSON.parse(run.stdout);
  assert.equal(summary.records, 2);
  assert.ok(summary.replacements >= 2, `至少折叠 home 两次：${JSON.stringify(summary)}`);

  const redacted = new Ledger(out);
  assert.equal(redacted.verify().ok, true, '脱敏副本自身应是完整可验的新链');
  const rows = redacted.records();
  assert.ok(!JSON.stringify(rows).includes(os.homedir()), '不得残留 home 前缀');
  assert.ok(rows[0].scope.paths[0].includes('$HOME'));
  // 归属字段原样保留：谁干的不能被脱敏抹掉。
  assert.equal(rows[0].plugin, 'p1');
  assert.equal(rows[1].plugin, 'p2');
  assert.equal(typeof rows[0].profiled, 'boolean');
  assert.equal(rows[1].manifestHash, rows[1].profiled ? rows[1].manifestHash : null);
  cleanup(dir);
});

test('One-Seal：成功放行后 commit，第二次必然失败', () => {
  const dir = tempDir('audit-seal-ok-');
  const scope = { paths: [path.join(dir, '**')] };
  const file = path.join(dir, 'ledger.jsonl');
  const seal = new OneSealStore({ ttlMs: 60_000 });
  seal.issue({ id: 'seal-1', oneSeal: true, sealTtlMs: 60_000 });
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope, reason: '读取缓存' }],
      },
    },
    grants: [{
      id: 'seal-1',
      capability: 'fs.read',
      scope,
      enabled: true,
      oneSeal: true,
      expiresAt: null,
      sealTtlMs: 60_000,
    }],
    ledger: new Ledger(file),
    seal,
  });
  guard.enforce('fs.read', { path: path.join(dir, 'a.txt') });
  assert.equal(seal.isAvailable('seal-1'), false);
  assert.throws(() => guard.enforce('fs.read', { path: path.join(dir, 'b.txt') }), /一次性授予/);
  cleanup(dir);
});

test('审计归因：reason 来自真正覆盖请求的那条声明', () => {
  const dir = tempDir('audit-reason-');
  const file = path.join(dir, 'ledger.jsonl');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [
          { capability: 'net.outbound', scope: { hosts: ['metrics.example:443'] }, reason: '上报指标' },
          { capability: 'net.outbound', scope: { hosts: ['cdn.example:443'] }, reason: '下载依赖' },
        ],
      },
    },
    grants: [
      { id: 'g1', capability: 'net.outbound', scope: { hosts: ['metrics.example:443'] }, enabled: true },
      { id: 'g2', capability: 'net.outbound', scope: { hosts: ['cdn.example:443'] }, enabled: true },
    ],
    ledger: new Ledger(file),
  });
  guard.enforce('net.outbound', { host: 'cdn.example', port: 443 });
  const last = new Ledger(file).records().at(-1);
  assert.equal(last.decision, 'allow');
  assert.equal(last.reason, '下载依赖');
  cleanup(dir);
});

test('Ledger：intercepted 标记未声明调用，interceptions() 按该口径统计', () => {
  const dir = tempDir('audit-intercept-');
  const file = path.join(dir, 'ledger.jsonl');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
      },
    },
    grants: [{ id: 'g1', capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, enabled: true }],
    ledger: new Ledger(file),
  });

  const denied = guard.check('net.outbound', { host: 'evil.example', port: 443 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'not_declared');
  assert.equal(denied.intercepted, true);

  const ledger = new Ledger(file);
  assert.equal(ledger.verify().ok, true);
  const record = ledger.records().at(-1);
  assert.equal(record.intercepted, true);
  assert.equal(record.ruleId, 'not_declared');
  assert.equal(ledger.interceptions().length, 1);
  assert.equal(guard.stats.intercepted, 1);
  cleanup(dir);
});

test('守卫入口：installNativeHooks 把 fs 直调接入同一条守卫链', () => {
  const dir = tempDir('audit-hook-');
  const file = path.join(dir, 'ledger.jsonl');
  const outsideDir = tempDir('audit-hook-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [],
      },
    },
    grants: [],
    ledger: new Ledger(file),
  });
  const hooks = guard.installNativeHooks();
  assert.ok(hooks);
  assert.equal(guard.hooks, hooks);
  try {
    assert.throws(() => fs.readFileSync(outside, 'utf8'), /未在 manifest 中声明|未授予/);
  } finally {
    guard.uninstallNativeHooks();
  }
  assert.equal(guard.hooks, null);
  assert.equal(new Ledger(file).interceptions().length, 1);
  cleanup(dir);
  cleanup(outsideDir);
});

test('Ledger MAC：有密钥的账本无法被无密钥者重算', () => {
  const dir = tempDir('audit-mac-');
  const file = path.join(dir, 'ledger.jsonl');
  const key = 'test-mac-key-32bytes-padded-000000';
  const ledger = new Ledger(file, { macKey: key });
  ledger.append(record());
  ledger.append(record({ decision: 'deny', ruleId: 'not_declared', intercepted: true }));
  assert.equal(new Ledger(file, { macKey: key }).verify().ok, true);
  assert.equal(new Ledger(file).records()[0].v, 4);

  // 篡改者重算了哈希链但没有密钥：mac 校验必须抓出来。
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const forged = JSON.parse(lines[1]);
  forged.reason = '伪造原因';
  delete forged.hash;
  forged.hash = sha256(stableStringify({ ...forged, mac: undefined }));
  forged.mac = '0'.repeat(64); // 没有密钥，只能瞎编
  lines[1] = stableStringify(forged);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const result = new Ledger(file, { macKey: key }).verify();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.code === 'mac_mismatch'));

  // 错误的密钥同样全部失败。
  fs.writeFileSync(file, '');
  const other = new Ledger(file, { macKey: 'wrong-key' });
  other.append(record());
  assert.equal(new Ledger(file, { macKey: key }).verify().ok, false);
  cleanup(dir);
});

test('TOCTOU：open 后按 fd 复核，符号链接替换落点被二次判定拦截', (t) => {
  const dir = tempDir('audit-toctou-');
  const outsideDir = tempDir('audit-toctou-out-');
  const outside = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const linkInside = path.join(dir, 'alias.txt');
  try {
    fs.symlinkSync(outside, linkInside);
  } catch (error) {
    t.skip(`当前环境不允许创建符号链接：${error.code}`);
    cleanup(dir);
    cleanup(outsideDir);
    return;
  }
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: {
        spec: 'dsh-dashcam/1',
        content: null,
        requests: [{ capability: 'fs.read', scope: { paths: [`${dir.replace(/\\/g, '/')}/**`] }, reason: '读取插件目录' }],
      },
    },
    grants: [{ id: 'g1', capability: 'fs.read', scope: { paths: [`${dir.replace(/\\/g, '/')}/**`] }, enabled: true }],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  const hooks = guard.installNativeHooks();
  try {
    // 链接本体在插件目录内（判定通过），落点在目录外（fd 复核必须拦下）。
    // Linux 上 fd 复核走另一分支，文案是「未声明的能力或范围」；Windows 上是「未授予/拒绝」。
    assert.throws(() => fs.readFileSync(linkInside, 'utf8'), /未在 manifest 中声明|未授予|未声明的能力或范围|拒绝/);
  } finally {
    guard.uninstallNativeHooks();
    cleanup(dir);
    cleanup(outsideDir);
  }
});

test('globSync：路径在返回值里，逐个结果都要过守卫', (t) => {
  if (typeof fs.globSync !== 'function') {
    t.skip('当前 Node 版本没有 fs.globSync');
    return;
  }
  const dir = tempDir('audit-glob-');
  const outsideDir = tempDir('audit-glob-out-');
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: { spec: 'dsh-dashcam/1', content: null, requests: [] },
    },
    grants: [],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  guard.installNativeHooks();
  try {
    assert.throws(
      () => fs.globSync('*.txt', { cwd: outsideDir }),
      /未在 manifest 中声明|未授予/,
    );
  } finally {
    guard.uninstallNativeHooks();
    cleanup(dir);
    cleanup(outsideDir);
  }
});

test('worker_threads：Worker 创建收敛到 proc.spawn 判定', (t) => {
  const dir = tempDir('audit-worker-');
  const workerFile = path.join(dir, 'worker.js');
  fs.writeFileSync(workerFile, '/* worker */');
  const guard = createGuardChain({
    manifest: {
      id: 'p', name: 'P', version: '1.0.0', entry: 'index.js', kind: 'dashcam',
      dashcam: { spec: 'dsh-dashcam/1', content: null, requests: [] },
    },
    grants: [],
    ledger: new Ledger(path.join(dir, 'ledger.jsonl')),
  });
  guard.installNativeHooks();
  try {
    const { Worker } = require('node:worker_threads');
    assert.throws(() => new Worker(workerFile), /未在 manifest 中声明|未授予/);
  } finally {
    guard.uninstallNativeHooks();
    cleanup(dir);
  }
});
