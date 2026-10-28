'use strict';

const fs = require('node:fs');
const { capabilityNeedsForOpen } = require('../derive');

const fsp = fs.promises;

/**
 * 能力句柄：给插件一个「更小的世界」，而不是往全局 API 上贴补丁。
 *
 * 封闭性来自三件事：
 *  1. 方法集合是手写闭集，未列出的方法**不存在**，调用即 TypeError；
 *  2. 只接受路径，不接受 fd，避免「先拿描述符再越界」整条路径；
 *  3. 对象冻结，插件不能替换方法绕过守卫。
 */
const READ_METHODS = [
  'readFile', 'readFileSync', 'readdir', 'readdirSync',
  'stat', 'statSync', 'lstat', 'lstatSync',
  'access', 'accessSync', 'existsSync',
  'realpath', 'realpathSync', 'readlink', 'readlinkSync',
  'statfs', 'statfsSync', 'openAsBlob', 'watchFile', 'unwatchFile',
  'opendir', 'opendirSync', 'createReadStream',
];

const WRITE_METHODS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync', 'truncate', 'truncateSync',
  'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync',
  'lchown', 'lchownSync', 'lutimes', 'lutimesSync',
  'mkdtemp', 'mkdtempSync', 'createWriteStream',
];

const DELETE_METHODS = ['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync'];

/** 双路径：复制 / 重命名既是读也是写。 */
const PAIR_METHODS = ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync'];

/** 符号链接：args[0] 是目标字符串（可悬空），只按写判定 args[1]。 */
const SYMLINK_METHODS = ['symlink', 'symlinkSync'];

/** 硬链接：args[0] 是已存在文件，必须同时有读权限，否则等于二次命名逃逸。 */
const HARDLINK_METHODS = ['link', 'linkSync'];

function createFsHandle({ guard } = {}) {
  if (!guard || typeof guard.enforce !== 'function') {
    throw new Error('createFsHandle 需要 guard');
  }

  function guardPath(action, target) {
    if (typeof target === 'number') {
      // 句柄只认路径。要 fd 请用 open()，它返回受限 FileHandle。
      throw new Error('能力句柄只接受路径，不接受文件描述符');
    }
    guard.enforce('fs.' + action, { path: target });
  }

  const single = (source, name, action) => {
    const original = source[name];
    if (typeof original !== 'function') return undefined;
    return function capabilityMethod(...args) {
      guardPath(action, args[0]);
      return original.apply(source, args);
    };
  };

  const pair = (source, name) => {
    const original = source[name];
    if (typeof original !== 'function') return undefined;
    return function capabilityMethod(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(source, args);
    };
  };

  const link = (source, name) => {
    const original = source[name];
    if (typeof original !== 'function') return undefined;
    return function capabilityMethod(...args) {
      guardPath('write', args[1]);
      return original.apply(source, args);
    };
  };

  const hardLink = (source, name) => {
    const original = source[name];
    if (typeof original !== 'function') return undefined;
    return function capabilityMethod(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(source, args);
    };
  };

  function bindSet(source, { withStreams = false } = {}) {
    const set = {};
    for (const name of READ_METHODS) {
      if (!withStreams && name === 'createReadStream') continue;
      const bound = single(source, name, 'read');
      if (bound) set[name] = bound;
    }
    for (const name of WRITE_METHODS) {
      if (!withStreams && name === 'createWriteStream') continue;
      const bound = single(source, name, 'write');
      if (bound) set[name] = bound;
    }
    for (const name of DELETE_METHODS) {
      const bound = single(source, name, 'delete');
      if (bound) set[name] = bound;
    }
    for (const name of PAIR_METHODS) {
      const bound = pair(source, name);
      if (bound) set[name] = bound;
    }
    for (const name of SYMLINK_METHODS) {
      const bound = link(source, name);
      if (bound) set[name] = bound;
    }
    for (const name of HARDLINK_METHODS) {
      const bound = hardLink(source, name);
      if (bound) set[name] = bound;
    }
    return Object.freeze(set);
  }

  /** 受限 FileHandle：能力面收窄到「拿着这个描述符能做的事」，且不给 fd。 */
  function scopedFileHandle(real) {
    const wrap = (name) => (...args) => real[name](...args);
    return Object.freeze({
      read: wrap('read'),
      readv: wrap('readv'),
      write: wrap('write'),
      writev: wrap('writev'),
      readFile: wrap('readFile'),
      writeFile: wrap('writeFile'),
      truncate: wrap('truncate'),
      stat: wrap('stat'),
      chmod: wrap('chmod'),
      chown: wrap('chown'),
      utimes: wrap('utimes'),
      sync: wrap('sync'),
      datasync: wrap('datasync'),
      close: wrap('close'),
      createReadStream: wrap('createReadStream'),
      createWriteStream: wrap('createWriteStream'),
    });
  }

  async function open(target, flags, mode) {
    const needs = capabilityNeedsForOpen(flags, fs.constants);
    if (needs.read) guardPath('read', target);
    if (needs.write) guardPath('write', target);
    return scopedFileHandle(await fsp.open(target, flags, mode));
  }

  const handle = {
    // 同名方法在句柄上是 fs 的形态（callback / sync），在 promises 上是 promise 形态。
    ...bindSet(fsp),
    ...bindSet(fs, { withStreams: true }),
    open,
  };

  Object.defineProperty(handle, 'promises', {
    value: bindSet(fsp),
    enumerable: true,
    writable: false,
    configurable: false,
  });

  // fs.constants 只是一堆数字，不构成能力面，放行能显著降低插件的改造量。
  Object.defineProperty(handle, 'constants', {
    value: Object.freeze({ ...fs.constants }),
    enumerable: true,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(handle, 'coverage', {
    value: () => ({
      kind: 'capability-handle',
      closed: true,
      methods: Object.keys(handle).sort(),
      note: '句柄之外没有入口：未列出的方法不存在，也不接受 fd 参数。',
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(handle);
}

module.exports = { createFsHandle };
