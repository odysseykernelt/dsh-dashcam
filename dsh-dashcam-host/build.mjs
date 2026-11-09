// 构建 lib/client.js：把 src/client/*.js（ESM 源）与 src/client.body.js（CJS 形态
// 的 React 半侧）拼成 DSH Web 的 __ModuleLoader__ 浏览器包。姿势与
// dsh-deepseek-tan-pet / DSH 自带 client 包一致——不引第三方打包器，纯文本拼装：
//   1) 丢掉 import 行（源内互相引用靠拼接顺序保证）；
//   2) `export function/const` 去掉 export 前缀；
//   3) client.body.js 的 exports.* 赋值保留，作为模块出口。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
// 注册 id 必须等于**插件包**（根包）的包名：DSH 的 client-modules 按包名建行，
// 加载完 bundle 后只认 id 与行 id 相同的注册。本目录是宿主适配层，包名
// dsh-dashcam-host 与插件身份不同，不能拿它当注册 id（2.0.0/2.0.1 的崩溃即此）。
const pkg = JSON.parse(readFileSync(join(root, '..', 'package.json'), 'utf8'));

function toBody(file) {
  const source = readFileSync(join(root, file), 'utf8');
  return source
    .split('\n')
    .filter((line) => !/^import\s/.test(line))
    .join('\n')
    .replace(/^export\s+(?=(const|function|class))/gm, '');
}

const bodies = [
  toBody('src/client/dashcam-css.js'),
  toBody('src/client/dashcam-panel.js'),
  toBody('src/client/dashcam-engine.js'),
  readFileSync(join(root, 'src/client.body.js'), 'utf8'),
];

const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${bodies.join('\n')}
    return module.exports;
  }
});
`;

writeFileSync(join(root, 'lib/client.js'), bundle);
console.log(`[build] lib/client.js 已生成（${bundle.length} 字符）`);
