'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, signPlugin, makeKeys, trustFor, cleanup } = require('./helpers/fixtures');
const { verifyBundle, signBundle } = require('../src/signing/bundle');
const { createTrust, rotateKey, retireKey, revokeKey } = require('../src/signing/trust');

test('验签：重建清单、keyId、发布者、审核者四步全部通过', () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const plugin = createPlugin({ dir: tempDir('sign-ok-'), requests: [] });
  signPlugin(plugin, keys);
  const result = verifyBundle({ pluginDir: plugin.dir, trust });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.stage, 'ok');
  assert.equal(result.files.some((file) => file.path === 'manifest.json'), true);
  cleanup(plugin.dir);
});

test('验签：文件被篡改在重建清单阶段失败并指到文件', () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const plugin = createPlugin({ dir: tempDir('sign-tamper-'), requests: [] });
  signPlugin(plugin, keys);
  fs.appendFileSync(path.join(plugin.dir, 'index.js'), '\n// injected\n');
  const result = verifyBundle({ pluginDir: plugin.dir, trust });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'manifest_rebuild');
  assert.ok(result.errors.some((error) => error.code === 'hash_mismatch' && error.file === 'index.js'));
  cleanup(plugin.dir);
});

test('验签：未知 keyId 在 keyId 阶段失败', () => {
  const keys = makeKeys();
  const plugin = createPlugin({ dir: tempDir('sign-keyid-'), requests: [] });
  signPlugin(plugin, keys);
  const trust = createTrust([
    { keyId: 'other-publisher', role: 'publisher', publicKey: keys.alternatePublisher.publicKey },
    { keyId: keys.reviewer.keyId, role: 'reviewer', publicKey: keys.reviewer.publicKey },
  ]);
  const result = verifyBundle({ pluginDir: plugin.dir, trust });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'keyid');
  assert.ok(result.errors.some((error) => error.code === 'publisher_key_unknown'));
  cleanup(plugin.dir);
});

test('验签：发布者或审核者公钥不匹配时分别在对应阶段失败', () => {
  const keys = makeKeys();
  const plugin = createPlugin({ dir: tempDir('sign-pub-'), requests: [] });
  signPlugin(plugin, keys);

  const badPublisher = createTrust([
    { keyId: keys.publisher.keyId, role: 'publisher', publicKey: keys.alternatePublisher.publicKey },
    { keyId: keys.reviewer.keyId, role: 'reviewer', publicKey: keys.reviewer.publicKey },
  ]);
  const publisherResult = verifyBundle({ pluginDir: plugin.dir, trust: badPublisher });
  assert.equal(publisherResult.stage, 'publisher');
  assert.equal(publisherResult.errors[0].code, 'publisher_signature_invalid');

  const badReviewer = createTrust([
    { keyId: keys.publisher.keyId, role: 'publisher', publicKey: keys.publisher.publicKey },
    { keyId: keys.reviewer.keyId, role: 'reviewer', publicKey: keys.alternateReviewer.publicKey },
  ]);
  const reviewerResult = verifyBundle({ pluginDir: plugin.dir, trust: badReviewer });
  assert.equal(reviewerResult.stage, 'reviewer');
  assert.equal(reviewerResult.errors[0].code, 'reviewer_signature_invalid');
  cleanup(plugin.dir);
});

test('验签：双公钥并行轮换，旧包在 retire 后仍可验证', () => {
  const keys = makeKeys();
  const plugin = createPlugin({ dir: tempDir('sign-rotate-'), requests: [] });
  signPlugin(plugin, keys);

  const trust = trustFor(keys);
  rotateKey(trust, { keyId: keys.alternatePublisher.keyId, role: 'publisher', publicKey: keys.alternatePublisher.publicKey });
  rotateKey(trust, { keyId: keys.alternateReviewer.keyId, role: 'reviewer', publicKey: keys.alternateReviewer.publicKey });
  assert.equal(verifyBundle({ pluginDir: plugin.dir, trust }).ok, true);

  const next = createPlugin({ dir: tempDir('sign-next-'), requests: [] });
  signBundle({
    pluginDir: next.dir,
    plugin: next.manifest.id,
    version: next.manifest.version,
    publisher: { keyId: keys.alternatePublisher.keyId, privateKey: keys.alternatePublisher.privateKey },
    reviewer: { keyId: keys.alternateReviewer.keyId, privateKey: keys.alternateReviewer.privateKey },
  });
  assert.equal(verifyBundle({ pluginDir: next.dir, trust }).ok, true);

  retireKey(trust, keys.publisher.keyId);
  retireKey(trust, keys.reviewer.keyId);
  assert.equal(verifyBundle({ pluginDir: plugin.dir, trust }).ok, true);

  revokeKey(trust, keys.alternatePublisher.keyId);
  assert.equal(verifyBundle({ pluginDir: next.dir, trust }).ok, false);
  cleanup(plugin.dir);
  cleanup(next.dir);
});

test('验签：缺少 signatures.json 时整包拒装', () => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const plugin = createPlugin({ dir: tempDir('sign-missing-'), requests: [] });
  const result = verifyBundle({ pluginDir: plugin.dir, trust });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'signature_file');
  assert.equal(result.errors[0].code, 'signature_missing');
  cleanup(plugin.dir);
});
