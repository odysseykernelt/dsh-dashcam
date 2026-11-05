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

test('签署：含符号链接的包直接拒绝签署（F2）', (t) => {
  const keys = makeKeys();
  const plugin = createPlugin({ dir: tempDir('sign-symlink-'), requests: [] });
  const stash = `${plugin.dir}-stash`;
  fs.mkdirSync(stash, { recursive: true });
  fs.writeFileSync(path.join(stash, 'secret.txt'), 'TOP-SECRET');
  try {
    try {
      // junction：Windows 无需特权的目录链接；POSIX 上忽略类型参数，退化为普通符号链接。
      fs.symlinkSync(stash, path.join(plugin.dir, 'stashed-link'), 'junction');
    } catch (error) {
      t.skip(`当前平台无法创建符号链接：${error.code || error.message}`);
      return;
    }
    assert.throws(() => signPlugin(plugin, keys), /符号链接/, 'symlink 不再是清单盲区，签署必须失败');
  } finally {
    cleanup(plugin.dir);
    cleanup(stash);
  }
});

test('验签：签署后混入的符号链接在重建清单阶段整包拒装（F2）', (t) => {
  const keys = makeKeys();
  const trust = trustFor(keys);
  const plugin = createPlugin({ dir: tempDir('sign-symlink2-'), requests: [] });
  signPlugin(plugin, keys);
  const stash = `${plugin.dir}-stash`;
  fs.mkdirSync(stash, { recursive: true });
  fs.writeFileSync(path.join(stash, 'secret.txt'), 'TOP-SECRET');
  try {
    try {
      fs.symlinkSync(stash, path.join(plugin.dir, 'stashed-link'), 'junction');
    } catch (error) {
      t.skip(`当前平台无法创建符号链接：${error.code || error.message}`);
      return;
    }
    const result = verifyBundle({ pluginDir: plugin.dir, trust });
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'manifest_rebuild');
    assert.ok(result.errors.some((error) => error.code === 'invalid_bundle_entry'),
      '应报出明确的非法条目错误，而不是静默漏检');
  } finally {
    cleanup(plugin.dir);
    cleanup(stash);
  }
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

test('验签：双公钥并行轮换；retire 后旧包拒验、新包不受影响（M12）', () => {
  const keys = makeKeys();
  const plugin = createPlugin({ dir: tempDir('sign-rotate-'), requests: [] });
  signPlugin(plugin, keys);

  const trust = trustFor(keys);
  rotateKey(trust, { keyId: keys.alternatePublisher.keyId, role: 'publisher', publicKey: keys.alternatePublisher.publicKey });
  rotateKey(trust, { keyId: keys.alternateReviewer.keyId, role: 'reviewer', publicKey: keys.alternateReviewer.publicKey });
  // 轮换窗口内新旧双钥并行（都是 active）：两代包都能过。
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

  // retire 即失验（M12）：旧钥签的包必须拒验，而不是继续被信任表放行。
  retireKey(trust, keys.publisher.keyId);
  retireKey(trust, keys.reviewer.keyId);
  const retiredResult = verifyBundle({ pluginDir: plugin.dir, trust });
  assert.equal(retiredResult.ok, false, 'retired 密钥不得继续验签');
  assert.equal(retiredResult.stage, 'keyid');
  assert.ok(
    retiredResult.errors.some((error) => error.code === 'publisher_key_unknown' || error.code === 'reviewer_key_unknown'),
    '应在 keyId 阶段报出密钥不可用',
  );
  // 新钥签的包不受旧钥 retire 影响。
  assert.equal(verifyBundle({ pluginDir: next.dir, trust }).ok, true);

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
