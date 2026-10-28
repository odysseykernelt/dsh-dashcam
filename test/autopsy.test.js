'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, createPlugin, signPlugin, makeKeys, cleanup } = require('./helpers/fixtures');
const { runAutopsy } = require('../src/autopsy/autopsy');

test('Autopsy：完整包离线六段全部通过', () => {
  const keys = makeKeys();
  const dir = tempDir('autopsy-ok-');
  const plugin = createPlugin({ dir, requests: [] });
  signPlugin(plugin, keys);
  const report = runAutopsy({
    pluginDir: dir,
    profile: { plugins: [plugin.manifest.id], registry: [] },
    bundlePatch: [],
    policy: {},
  });
  assert.equal(report.ok, true, JSON.stringify(report.missing));
  assert.deepEqual(report.segments.map((segment) => segment.name), [
    'existence', 'declaration', 'activation', 'registration', 'capability', 'uninstall',
  ]);
  assert.ok(report.segments.every((segment) => segment.status === 'pass'));
  cleanup(dir);
});

test('Autopsy：缺少入口文件时 existence 段指明缺失项', () => {
  const keys = makeKeys();
  const dir = tempDir('autopsy-entry-');
  const plugin = createPlugin({ dir, requests: [] });
  signPlugin(plugin, keys);
  fs.rmSync(path.join(dir, 'index.js'));
  const report = runAutopsy({ pluginDir: dir, profile: { plugins: [plugin.manifest.id] } });
  assert.equal(report.ok, false);
  const existence = report.segments.find((segment) => segment.name === 'existence');
  assert.equal(existence.status, 'fail');
  assert.ok(existence.missing.some((item) => item.item === 'index.js'));
  cleanup(dir);
});

test('Autopsy：profile 未启用插件时 activation 段失败', () => {
  const keys = makeKeys();
  const dir = tempDir('autopsy-activation-');
  const plugin = createPlugin({ dir, requests: [] });
  signPlugin(plugin, keys);
  const report = runAutopsy({ pluginDir: dir, profile: { plugins: [] } });
  assert.equal(report.ok, false);
  const activation = report.segments.find((segment) => segment.name === 'activation');
  assert.equal(activation.status, 'fail');
  assert.ok(activation.missing.some((item) => item.item === 'activation'));
  cleanup(dir);
});

test('Autopsy：bundle patch 可离线激活，不启动宿主', () => {
  const keys = makeKeys();
  const dir = tempDir('autopsy-patch-');
  const plugin = createPlugin({
    dir,
    requests: [],
    patches: [{ path: 'patches/fix.js', reason: '修复入口' }],
    uninstall: { reversePatches: [{ path: 'patches/revert.js', reason: '回滚修复' }] },
  });
  signPlugin(plugin, keys);
  const report = runAutopsy({
    pluginDir: dir,
    profile: { plugins: [] },
    bundlePatch: [{ op: 'add', path: 'plugins.-', value: plugin.manifest.id }],
  });
  assert.equal(report.ok, true, JSON.stringify(report.missing));
  assert.equal(report.segments.find((segment) => segment.name === 'activation').status, 'pass');
  assert.equal(report.offline, true);

  const missingReverse = createPlugin({
    dir: tempDir('autopsy-reverse-'),
    requests: [],
    patches: [{ path: 'patches/fix.js', reason: '修复入口' }],
  });
  signPlugin(missingReverse, keys);
  const failed = runAutopsy({
    pluginDir: missingReverse.dir,
    profile: { plugins: [missingReverse.manifest.id] },
  });
  const uninstall = failed.segments.find((segment) => segment.name === 'uninstall');
  assert.equal(uninstall.status, 'fail');
  assert.ok(uninstall.missing.some((item) => item.item === 'uninstall.reversePatches'));
  cleanup(dir);
  cleanup(missingReverse.dir);
});

test('Autopsy：缺少 profile 与注册项时给出 skip / fail', () => {
  const keys = makeKeys();
  const dir = tempDir('autopsy-profile-');
  const plugin = createPlugin({ dir, requests: [], contributes: {} });
  signPlugin(plugin, keys);
  const report = runAutopsy({ pluginDir: dir });
  const activation = report.segments.find((segment) => segment.name === 'activation');
  assert.equal(activation.status, 'skip');
  const registration = report.segments.find((segment) => segment.name === 'registration');
  assert.equal(registration.status, 'fail');
  assert.ok(registration.missing.some((item) => item.item === 'contributes.registrations'));
  cleanup(dir);
});
