'use strict';

const Module = require('node:module');
const path = require('node:path');

/** 需要重定向的模块请求 → 句柄上的对应面。 */
const REDIRECTS = [
  ['fs', 'fs'],
  ['node:fs', 'fs'],
  ['fs/promises', 'promises'],
  ['node:fs/promises', 'promises'],
];

/**
 * 把 `require('fs')` 换成能力句柄。
 *
 * 这一步的意义是「不改插件代码也能进小世界」：插件照旧 require fs，
 * 拿到的却是封闭集合——用不到的方法直接不存在（readSync 之类），
 * 而不是靠 Hook 事后拦截。
 *
 * 两个必须遵守的顺序：
 *  1. 必须在 Bridge 与 handles 模块**自身**都已经加载之后再安装，
 *     否则它们 require 到的就是句柄，会递归。
 *  2. 只对 `pluginRoot` 下的模块生效（宿主的 require 不受影响）；
 *     入口模块的 parent 是 null，用 enter()/exit() 标记装载窗口兜住。
 */
// 同一进程只能有一条重定向：第二条会把第一条的 originalLoad 存成「已经被包装的版本」，
// 卸载顺序一错就再也还原不回去。与其静默互相覆盖，不如直接报错。
let current = null;

function createModuleRedirect({ handles, pluginRoot = null } = {}) {
  if (!handles || !handles.fs) throw new Error('createModuleRedirect 需要 handles.fs');
  const originalLoad = Module._load;
  const root = pluginRoot ? path.resolve(pluginRoot) : null;
  // Windows 文件系统不区分大小写，字符串比较区分——不折叠的话，
  // 宿主传 `C:\\PLUGIN`、实际模块是 `c:\\plugin\\...` 时会静默判定为「非插件模块」，
  // require('fs') 直接拿到原生 fs，整个封闭世界失效且没有任何告警。
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  const rootKey = root ? fold(root) : null;
  let installed = false;
  let loadDepth = 0;
  let hits = 0;

  function isPluginParent(parent) {
    if (!root) return true;
    if (!parent) return loadDepth > 0;
    const filename = typeof parent.filename === 'string' ? path.resolve(parent.filename) : '';
    if (!filename) return loadDepth > 0;
    const key = fold(filename);
    return key === rootKey || key.startsWith(rootKey + path.sep);
  }

  function patched(request, parent) {
    for (const [name, face] of REDIRECTS) {
      if (request === name && isPluginParent(parent)) {
        hits += 1;
        return face === 'fs' ? handles.fs : handles.fs.promises;
      }
    }
    return originalLoad.apply(this, arguments);
  }

  const api = {
    install() {
      if (installed) return false;
      if (current && current !== api) {
        throw new Error('同一进程只能启用一条模块重定向：请先卸载当前活动插件的 sandbox');
      }
      Module._load = patched;
      installed = true;
      current = api;
      return true;
    },
    uninstall() {
      if (!installed) return false;
      if (Module._load === patched) Module._load = originalLoad;
      installed = false;
      if (current === api) current = null;
      return true;
    },
    /** 入口模块 parent 为 null，用这个窗口把它归到插件名下。 */
    enter() {
      loadDepth += 1;
    },
    exit() {
      if (loadDepth > 0) loadDepth -= 1;
    },
    get installed() {
      return installed;
    },
    get hits() {
      return hits;
    },
    coverage() {
      return {
        kind: 'module-redirect',
        installed,
        redirected: REDIRECTS.map(([name]) => name),
        hits,
        note: '只覆盖 fs 系列；net / child_process 仍由原生 Hook 兜底。',
      };
    },
  };
  return api;
}

function activeRedirect() {
  return current;
}

module.exports = { createModuleRedirect, activeRedirect, REDIRECTS };
