'use strict';

// P1：单包分发的安装期不变量。
//
// 2026-11-09 的两次宿主崩溃都出在这里：DSH 的 client-modules 按**包名**为插件建
// 客户端行，加载完 bundle 后只认 `__ModuleLoader__.load({ id })` 与行 id 相同的
// 注册。bundle 的生产者 dsh-dashcam-host/build.mjs 曾拿宿主适配层的包名
// （dsh-dashcam-host）当注册 id，与插件包名 dsh-dashcam 不一致，加载器判定
// “没注册”后回退到第二个 URL 再执行一次，第二次触发
// duplicate factory registration 并让整个 web-boot 失败。
//
// 这里把约束钉死，避免以后再靠 `dsh plugin add` 装一遍才发现。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const hostDir = path.join(repoRoot, 'dsh-dashcam-host');

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8'));

test('P1：客户端 bundle 的注册 id 必须等于插件包名', () => {
  const pkg = readJson('package.json');
  const bundle = fs.readFileSync(path.join(hostDir, 'lib', 'client.js'), 'utf8');
  const match = bundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/);
  assert.ok(match, 'lib/client.js 应以 __ModuleLoader__.load({ id: "<包名>" }) 开头');
  assert.equal(match[1], pkg.name, 'bundle 注册 id 与插件包名不一致（加载器会重复执行 bundle）');
});

test('P1：嵌套宿主 package.json 只做 ESM 标记，不重复声明插件身份', () => {
  const host = readJson(path.join('dsh-dashcam-host', 'package.json'));
  const root = readJson('package.json');
  assert.equal(host.type, 'module', '宿主 lib/*.js 是 ESM，需 type: module');
  assert.equal(host.dsh, undefined, 'dsh 字段只能出现在根包（否则客户端声明会双份）');
  assert.equal(host.exports, undefined, 'exports 只能出现在根包（否则 ./client 会解析出第二条客户端行）');
  assert.ok(root.dsh && root.dsh.client, '根包应持有唯一一份 dsh.client 声明');
});

test('P1：根包的客户端声明与挂载补丁互相对得上', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.dsh.client.platform, 'web');
  const clientRel = pkg.exports['./client'];
  assert.equal(typeof clientRel, 'string');
  assert.ok(fs.existsSync(path.join(repoRoot, clientRel)), `exports["./client"] 指向不存在的文件：${clientRel}`);

  const patch = fs.readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, new RegExp(`id:\\s*${pkg.name}\\b`), 'cordis.patch.yml 的挂载 id 必须与包名一致');
  assert.match(patch, new RegExp(`name:\\s*'${pkg.name}'`), '挂载 name 应为包名（解析到 package.json 的 main）');
});
