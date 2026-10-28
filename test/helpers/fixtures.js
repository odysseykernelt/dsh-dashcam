'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTrust } = require('../../src/signing/trust');
const { signBundle } = require('../../src/signing/bundle');

function tempDir(prefix = 'dsh-covenant-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeKeys() {
  const make = () => crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const publisher = make();
  const reviewer = make();
  return {
    publisher: { keyId: 'publisher-test', ...publisher },
    reviewer: { keyId: 'reviewer-test', ...reviewer },
    alternatePublisher: { keyId: 'publisher-next', ...make() },
    alternateReviewer: { keyId: 'reviewer-next', ...make() },
  };
}

function trustFor(keys) {
  return createTrust([
    { keyId: keys.publisher.keyId, role: 'publisher', publicKey: keys.publisher.publicKey, status: 'active' },
    { keyId: keys.reviewer.keyId, role: 'reviewer', publicKey: keys.reviewer.publicKey, status: 'active' },
  ]);
}

function defaultCharter(overrides = {}) {
  return {
    rating: 'general',
    scenes: ['hud'],
    commercialUse: 'allowed',
    sourceFingerprint: `sha256:${'a'.repeat(64)}`,
    enterpriseExcluded: false,
    ...overrides,
  };
}

function createPlugin({
  dir = tempDir(),
  id = 'com.example.test',
  version = '1.0.0',
  requests = [],
  charter = defaultCharter(),
  legacy = false,
  code,
  contributes = { registrations: [{ type: 'command', id: 'test.ping' }] },
  patches = [],
  scripts = {},
  uninstall,
  files = {},
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: 'Test Plugin',
    version,
    entry: 'index.js',
    contributes,
    patches,
    scripts,
  };
  if (uninstall !== undefined) manifest.uninstall = uninstall;
  if (!legacy) {
    manifest.covenant = {
      spec: 'dsh-covenant/1',
      capabilities: { requests },
      content: charter,
    };
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'index.js'), code || [
    "'use strict';",
    'module.exports = {',
    "  activate() {},",
    "  invoke(action) { return { ok: true, action }; },",
    "  deactivate() {},",
    '};',
  ].join('\n'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  for (const patch of patches) {
    const target = path.resolve(dir, patch.path);
    if (!target.startsWith(`${path.resolve(dir)}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, '// patch\n');
  }
  return { dir, manifest, keys: null };
}

function signPlugin(plugin, keys, reviewerKeys = null) {
  signBundle({
    pluginDir: plugin.dir,
    plugin: plugin.manifest.id,
    version: plugin.manifest.version,
    publisher: { keyId: keys.publisher.keyId, privateKey: keys.publisher.privateKey },
    reviewer: {
      keyId: (reviewerKeys || keys).reviewer.keyId,
      privateKey: (reviewerKeys || keys).reviewer.privateKey,
    },
  });
  return plugin;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 上偶发占用，测试结束后系统会清理临时目录。
  }
}

module.exports = { tempDir, makeKeys, trustFor, defaultCharter, createPlugin, signPlugin, cleanup };
