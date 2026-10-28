'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tempDir, createPlugin, cleanup } = require('./helpers/fixtures');
const { loadManifest } = require('../src/contract/manifest');
const { scanPlugin } = require('../src/gates/safety');
const { loadPolicy } = require('../src/policy');
const { buildPortrait, renderPortrait, CAVEAT } = require('../src/portrait/portrait');

function portraitFor(requests, code) {
  const dir = tempDir('portrait-');
  createPlugin({ dir, requests, code });
  const { manifest } = loadManifest(dir);
  const scanResult = scanPlugin(dir, { policy: loadPolicy({}), manifest });
  const portrait = buildPortrait({ manifest, scan: scanResult.scan });
  cleanup(dir);
  return portrait;
}

test('画像卡：高风险项触发高红档，首屏不泄露细节', () => {
  const portrait = portraitFor([
    { cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取缓存' },
    { cap: 'cred.read', scope: { targets: ['env:PLATFORM_KEY'] }, reason: '读取平台密钥' },
  ]);
  assert.equal(portrait.tier, 'high');
  assert.equal(portrait.firstScreen.highRiskCount, 1);
  assert.equal(portrait.firstScreen.groupCounts.cred, 1);
  assert.equal(portrait.firstScreen.caveat, CAVEAT);
  const firstScreen = JSON.stringify(portrait.firstScreen);
  assert.equal(firstScreen.includes('读取平台密钥'), false);
  assert.equal(firstScreen.includes('读取缓存'), false);
  assert.equal(portrait.rejectionReason, null);

  const rendered = renderPortrait(portrait);
  assert.ok(rendered.includes('[!] cred.read'));
  assert.ok(rendered.includes('需强制确认'));
  assert.ok(rendered.includes(CAVEAT));
});

test('画像卡：中风险展开勾选，低风险折叠', () => {
  const medium = portraitFor([
    { cap: 'net.outbound', scope: { hosts: ['api.example.com:443'] }, reason: '调用 API' },
    { cap: 'fs.read', scope: { paths: ['$PLUGIN/**'] }, reason: '读取缓存' },
  ]);
  assert.equal(medium.tier, 'medium');
  assert.ok(renderPortrait(medium).includes('[ ] net.outbound'));

  const low = portraitFor([
    { cap: 'fs.read', scope: { paths: ['$PLUGIN/a/**'] }, reason: '读取 A' },
    { cap: 'fs.read', scope: { paths: ['$PLUGIN/b/**'] }, reason: '读取 B' },
  ]);
  assert.equal(low.tier, 'low');
  assert.ok(renderPortrait(low).includes('已折叠 2 项'));
});

test('画像卡：拒绝原因直出原文，不包装', () => {
  const dir = tempDir('portrait-reject-');
  createPlugin({ dir, requests: [{ cap: 'proc.spawn', scope: { commands: ['node'] }, reason: '原始拒绝原因' }] });
  const { manifest } = loadManifest(dir);
  const portrait = buildPortrait({ manifest, rejection: { reason: '原始拒绝原因' } });
  const rendered = renderPortrait(portrait);
  assert.ok(rendered.includes('拒绝原因：原始拒绝原因'));
  cleanup(dir);
});
