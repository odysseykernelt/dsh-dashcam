'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const path = require('node:path');
const childProcess = require('node:child_process');
const { CovenantDenied } = require('../errors');
const { keyPatternCovers } = require('../contract/capabilities');
const { isSensitiveEnvKey } = require('../util/paths');
const { parseRequestTarget, toPathString, capabilityNeedsForOpen } = require('./derive');
const { sha256 } = require('../util/stable');

const fsp = fs.promises;

// 复核用的 realpath 必须是模块加载时抓到的原生版本。
// Bridge 安装后 fs.realpathSync 是包装过的；异步路径里 callDepth 已经归零，
// 再调它就会重新进守卫链——轻则多写一条账本，重则把「只写」的 open 判成越权。
const REAL_REALPATH_SYNC = typeof fs.realpathSync.native === 'function'
  ? fs.realpathSync.native
  : fs.realpathSync;

/** 补丁式覆盖永远是真子集。把差集明确写出来，比假装它不存在有用。 */
const KNOWN_GAPS = Object.freeze([
  'vm 内生成的代码与原生扩展（.node）：同一进程内没有第二道墙，根治只有分进程或分 realm',
  '直接 syscall 或 process.binding',
  'Bridge 安装前已解构保存的函数引用',
  'Bridge 安装前打开的文件描述符',
  '未列入补丁表的入口：http2、WebSocket、dgram，以及 fs 的部分低层 API',
  'TOCTOU 残余窗口：fd 复核把窗口压到 open 返回之后，但无法证明路径在 IO 期间不变；目录级 rename 攻击仍需宿主侧文件系统隔离',
  '未声明且非敏感的环境变量读取（只有敏感命名或已声明前缀才进守卫链）',
]);

function safeDefine(target, prop, value, descriptor) {
  try {
    Object.defineProperty(target, prop, {
      ...(descriptor || {}),
      value,
      writable: true,
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : true,
    });
    return true;
  } catch {
    try {
      target[prop] = value;
      return true;
    } catch {
      return false;
    }
  }
}

function firstPathArg(args) {
  return args[0];
}

function firstCommand(args) {
  const raw = args[0];
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  const quoted = trimmed.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return quoted ? (quoted[1] || quoted[2] || quoted[3]) : trimmed;
}

/**
 * Bridge：把 fs/net/proc/env/凭证访问收敛到守卫链。
 * 只包装 Node 内置模块的公开入口；所有包装器都保留原始函数引用，
 * 以便卸载与完整性检测。
 */
function createBridge({ guard, ledger, plugin = null, autoSweep = false } = {}) {
  if (!guard) throw new Error('createBridge 需要 guard');

  const checks = [];
  const restores = [];
  const pluginInfo = plugin || guard.manifest || {};
  let envProxy = null;
  let envDescriptor = null;
  let fetchDescriptor = null;
  let installed = false;
  // 重入计数：Node 内置实现经常互相调用（如 appendFileSync → writeFileSync、
  // http.get → http.request）。原始实现执行期间必须直通，否则会重复守卫甚至递归。
  let callDepth = 0;

  function patchMethod(target, prop, maker, label) {
    if (!target) return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, prop);
    const original = target[prop];
    if (typeof original !== 'function') return false;
    const inner = maker(original);
    const wrapped = function passthroughAware(...args) {
      if (callDepth > 0) return original.apply(this, args);
      callDepth += 1;
      try {
        return inner.apply(this, args);
      } finally {
        callDepth -= 1;
      }
    };
    if (!safeDefine(target, prop, wrapped, descriptor)) return false;
    checks.push({ target, prop, original, wrapped, label: label || prop });
    restores.push(() => {
      try {
        if (descriptor) Object.defineProperty(target, prop, descriptor);
        else target[prop] = original;
      } catch {
        try {
          target[prop] = original;
        } catch {
          // 卸载失败时保留引用，交由完整性检测报告。
        }
      }
    });
    return true;
  }

  /**
   * 数字是文件描述符：句柄在 open 时已经判过，fd 之后无法再映射回路径，
   * 所以这里直通。真正的关口在 guardOpen——这也是 readSync/writeSync
   * 故意不包装的原因（包了也只能拿到一个无法定性的 fd）。
   */
  function guardPath(action, pathValue) {
    if (typeof pathValue === 'number') return;
    guard.enforce(`fs.${action}`, { path: pathValue });
  }

  function guardOpen(pathValue, flags) {
    const needs = capabilityNeedsForOpen(flags, fs.constants);
    if (needs.read) guardPath('read', pathValue);
    if (needs.write) guardPath('write', pathValue);
    return needs;
  }

  /**
   * TOCTOU 复核：判定用 realpath，判定到真实 IO 之间仍有窗口。
   * open 拿到 fd 之后立刻按 fd 复核：
   *  1. fstat：设备 / fifo / socket 不是能力模型能表达的对象，直接拒绝；
   *  2. realpath 重解析：路径在判定后被换成越权目标（符号链接替换、目录 rename）
   *     时，最终落点会再进一次守卫链——没有声明就拒绝并立刻关 fd。
   * 注意 realpathSync/fstatSync/closeSync 都被包在 callDepth>0 的直通区里，
   * 不会递归回守卫。
   */
  function recheckOpenedFd(fd, pathValue, needs) {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() && !stats.isDirectory()) {
      throw new CovenantDenied('open 目标不是普通文件或目录（设备/fifo/socket），拒绝放行', {
        capability: needs && needs.write ? 'fs.write' : 'fs.read',
        scope: { paths: [toPathString(pathValue)] },
        ruleId: 'fd_recheck',
      });
    }
    let resolved = null;
    try {
      resolved = REAL_REALPATH_SYNC(pathValue);
    } catch {
      // 新建文件尚不存在时 realpath 会 ENOENT；路径级判定已在 guardOpen 完成。
      return;
    }
    if (resolved && typeof pathValue === 'string'
      && path.resolve(resolved) !== path.resolve(pathValue)) {
      if (!needs || needs.read) guardPath('read', resolved);
      if (needs && needs.write) guardPath('write', resolved);
    }
  }

  function guardOpenSync(original, args) {
    const needs = guardOpen(args[0], args[1]);
    const fd = original.apply(this, args);
    try {
      recheckOpenedFd(fd, args[0], needs);
    } catch (error) {
      try { fs.closeSync(fd); } catch { /* fd 可能已被错误路径消耗 */ }
      throw error;
    }
    return fd;
  }

  /** glob / globSync：路径在返回值里而不是参数里，必须逐个结果判定。 */
  function globEntryPath(entry, baseDir) {
    const base = baseDir || process.cwd();
    if (typeof entry === 'string') return path.resolve(base, entry);
    // Dirent：parentPath（新版）或 path（旧版）+ name。
    const parent = entry.parentPath || entry.path || base;
    return path.resolve(parent, entry.name);
  }

  function globBaseDir(args) {
    const options = args.find((arg) => arg && typeof arg === 'object' && typeof arg.cwd === 'string');
    return options ? path.resolve(options.cwd) : process.cwd();
  }

  /**
   * glob 结果的判定：**逐个判、只写一条账本**。
   *
   * 逐条 guardPath 的后果是 1 万文件的目录 = 1 万条账本记录 + 1 万次 open/write/close，
   * 审计文件会被自己的遍历撑爆。所以走 enforceBatch：判定质量不降级，记账合并。
   * 同一路径出现多次（globSync 可能混给字符串与 Dirent）只判一次。
   */
  function guardGlobResults(entries, baseDir) {
    const seen = new Set();
    const payloads = [];
    for (const entry of entries) {
      const target = globEntryPath(entry, baseDir);
      if (seen.has(target)) continue;
      seen.add(target);
      payloads.push({ path: target });
    }
    if (payloads.length === 0) return entries;
    guard.enforceBatch('fs.read', payloads);
    return entries;
  }

  /** 分块：既不把单条账本撑到无限大，也不把百万条结果挂内存里。 */
  const GLOB_BATCH_SIZE = 256;

  /**
   * 异步迭代器版本：**先判定、再交付**。拒绝发生在消费者拿到这一批路径之前，
   * 已交付的前几批是已经判过的（流式 API 只能做到这个粒度）。
   */
  function wrapGlobIterator(iter, baseDir) {
    return (async function* guarded() {
      let chunk = [];
      const flush = function* () {
        if (chunk.length === 0) return;
        const pending = chunk;
        chunk = [];
        guardGlobResults(pending, baseDir);
        yield* pending;
      };
      for await (const entry of iter) {
        chunk.push(entry);
        if (chunk.length >= GLOB_BATCH_SIZE) yield* flush();
      }
      yield* flush();
    })();
  }

  function installGlob() {
    if (typeof fs.globSync === 'function') {
      patchMethod(fs, 'globSync', (original) => function wrappedGlobSync(...args) {
        return guardGlobResults(original.apply(this, args), globBaseDir(args));
      }, 'fs.globSync');
    }
    if (typeof fs.glob === 'function') {
      patchMethod(fs, 'glob', (original) => function wrappedGlob(...args) {
        return wrapGlobIterator(original.apply(this, args), globBaseDir(args));
      }, 'fs.glob');
    }
    if (fsp && typeof fsp.glob === 'function') {
      patchMethod(fsp, 'glob', (original) => function wrappedFspGlob(...args) {
        return wrapGlobIterator(original.apply(this, args), globBaseDir(args));
      }, 'fsp.glob');
    }
  }

  /**
   * worker_threads：Worker 内部代码不经过本进程已安装的 Hook（模块表是新的），
   * Node 层无法看护其内部行为。能做的根治是把 Worker 创建本身收敛到守卫链：
   * command = 入口文件路径（声明按 proc.spawn 的命令精确/基名口径匹配）。
   * vm 无法这样处理：它共享本进程对象图，只能列入 knownGaps。
   */
  /**
   * Worker 的命令名口径。
   * `new Worker(code, { eval: true })` 的第一个参数是**源码**：直接塞进 command 会
   * 把整段代码写进账本（撑大、且可能带敏感字面量），而且它永远匹配不上任何命令声明。
   * 所以 eval 模式用稳定标识 `worker:eval:<源码 sha256 前 12 位>`——可去重、可对账，
   * 但不把源码本身落盘。
   */
  function workerCommand(filename, options) {
    if (options && options.eval === true) {
      return `worker:eval:${sha256(String(filename)).slice(0, 12)}`;
    }
    return toPathString(filename);
  }

  function installWorkerGuard() {
    let workerThreads;
    try {
      workerThreads = require('node:worker_threads');
    } catch {
      return;
    }
    const OriginalWorker = workerThreads && workerThreads.Worker;
    if (typeof OriginalWorker !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(workerThreads, 'Worker');
    const WrappedWorker = function Worker(filename, options) {
      if (callDepth === 0) {
        guard.enforce('proc.spawn', { command: workerCommand(filename, options) });
      }
      // 用 Original 作为 new.target，保证 instanceof 与内部槽位与原类一致。
      return Reflect.construct(OriginalWorker, [filename, options],
        new.target === WrappedWorker ? OriginalWorker : new.target);
    };
    Object.setPrototypeOf(WrappedWorker, OriginalWorker);
    WrappedWorker.prototype = OriginalWorker.prototype;
    if (!safeDefine(workerThreads, 'Worker', WrappedWorker, descriptor)) return;
    checks.push({ target: workerThreads, prop: 'Worker', original: OriginalWorker, wrapped: WrappedWorker, label: 'worker_threads.Worker' });
    restores.push(() => {
      try {
        if (descriptor) Object.defineProperty(workerThreads, 'Worker', descriptor);
        else workerThreads.Worker = OriginalWorker;
      } catch {
        workerThreads.Worker = OriginalWorker;
      }
    });
  }

  function wrapFsMethod(action, { paths = [0], promises = false } = {}) {
    return (original) => function wrappedFs(...args) {
      for (const index of paths) guardPath(action, args[index]);
      if (promises) return original.apply(this, args);
      return original.apply(this, args);
    };
  }

  function installFs() {
    const readMethods = ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'existsSync', 'readlink', 'readlinkSync', 'statfs', 'statfsSync', 'watchFile', 'unwatchFile', 'openAsBlob'];
    const writeMethods = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'createWriteStream'];
    const deleteMethods = ['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync'];
    for (const method of readMethods) patchMethod(fs, method, wrapFsMethod('read'));
    for (const method of writeMethods) patchMethod(fs, method, wrapFsMethod('write'));
    for (const method of deleteMethods) patchMethod(fs, method, wrapFsMethod('delete'));

    // 句柄获取点才是关口：open/opendir 一旦放行，后续 fd 级操作无法再定性。
    patchMethod(fs, 'open', (original) => function wrappedOpen(pathValue, flags, ...rest) {
      // open(path, callback) 省略 flags 是合法调用，先归一化再判定。
      if (typeof flags === 'function') {
        rest.unshift(flags);
        flags = undefined;
      }
      const needs = guardOpen(pathValue, flags);
      const callback = rest.length > 0 && typeof rest[rest.length - 1] === 'function'
        ? rest[rest.length - 1] : null;
      if (callback) {
        rest[rest.length - 1] = function onOpened(err, fd) {
          if (!err && typeof fd === 'number') {
            try {
              recheckOpenedFd(fd, pathValue, needs);
            } catch (error) {
              try { fs.closeSync(fd); } catch { /* 同上 */ }
              return callback.call(this, error);
            }
          }
          return callback.call(this, err, fd);
        };
      }
      return original.call(this, pathValue, flags, ...rest);
    }, 'fs.open');
    patchMethod(fs, 'openSync', (original) => function wrappedOpenSync(...args) {
      return guardOpenSync(original, args);
    }, 'fs.openSync');
    patchMethod(fs, 'opendir', wrapFsMethod('read'), 'fs.opendir');
    patchMethod(fs, 'opendirSync', wrapFsMethod('read'), 'fs.opendirSync');
    patchMethod(fs, 'realpath', wrapFsMethod('read'), 'fs.realpath');
    patchMethod(fs, 'realpathSync', wrapFsMethod('read'), 'fs.realpathSync');
    for (const method of ['truncate', 'truncateSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync', 'lchown', 'lchownSync', 'lutimes', 'lutimesSync']) {
      patchMethod(fs, method, wrapFsMethod('write'), `fs.${method}`);
    }
    for (const method of ['mkdtemp', 'mkdtempSync']) {
      patchMethod(fs, method, wrapFsMethod('write'), `fs.${method}`);
    }
    for (const method of ['symlink', 'symlinkSync']) {
      // 符号链接：args[0] 只是目标字符串（可以悬空），真正落盘的是 args[1]。
      patchMethod(fs, method, (original) => function wrappedSymlink(...args) {
        guardPath('write', args[1]);
        return original.apply(this, args);
      }, `fs.${method}`);
    }
    for (const method of ['link', 'linkSync']) {
      // 硬链接不一样：args[0] 是**已存在**的文件，链接之后它有了第二个名字。
      // 真实路径判定帮不上忙（两个名字都是真的），所以必须同时要求读权限，
      // 否则「先把外部文件 link 进插件目录，再当普通文件读」就绕开了 fs.read。
      patchMethod(fs, method, (original) => function wrappedLink(...args) {
        guardPath('read', args[0]);
        guardPath('write', args[1]);
        return original.apply(this, args);
      }, `fs.${method}`);
    }

    // 双路径操作：复制/重命名同时是读与写。
    patchMethod(fs, 'copyFile', (original) => function wrappedCopyFile(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, args);
    });
    patchMethod(fs, 'copyFileSync', (original) => function wrappedCopyFileSync(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, args);
    });
    // cp / cpSync 会整棵树地拷：一次调用同时越过读写两面。
    patchMethod(fs, 'cp', (original) => function wrappedCp(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, args);
    });
    patchMethod(fs, 'cpSync', (original) => function wrappedCpSync(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, args);
    });
    patchMethod(fs, 'rename', (original) => function wrappedRename(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, args);
    });
    patchMethod(fs, 'renameSync', (original) => function wrappedRenameSync(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, args);
    });

    if (fsp) {
      patchMethod(fsp, 'readFile', wrapFsMethod('read'));
      patchMethod(fsp, 'readdir', wrapFsMethod('read'));
      patchMethod(fsp, 'stat', wrapFsMethod('read'));
      patchMethod(fsp, 'lstat', wrapFsMethod('read'));
      patchMethod(fsp, 'access', wrapFsMethod('read'));
      patchMethod(fsp, 'writeFile', wrapFsMethod('write'));
      patchMethod(fsp, 'appendFile', wrapFsMethod('write'));
      patchMethod(fsp, 'mkdir', wrapFsMethod('write'));
      patchMethod(fsp, 'unlink', wrapFsMethod('delete'));
      patchMethod(fsp, 'rm', wrapFsMethod('delete'));
      patchMethod(fsp, 'rmdir', wrapFsMethod('delete'));
      patchMethod(fsp, 'copyFile', (original) => function wrappedCopyFile(...args) {
        guardPath('read', args[0]);
        guardPath('write', args[1]);
        return original.apply(this, args);
      });
      patchMethod(fsp, 'rename', (original) => function wrappedRename(...args) {
        guardPath('read', args[0]);
        guardPath('write', args[1]);
        return original.apply(this, args);
      });
      // FileHandle 的 read/write 同样靠 open 先决：这里守住 open 即可。
      patchMethod(fsp, 'open', (original) => async function wrappedOpen(...args) {
        const needs = guardOpen(args[0], args[1]);
        const handle = await original.apply(this, args);
        try {
          recheckOpenedFd(handle.fd, args[0], needs);
        } catch (error) {
          try { await handle.close(); } catch { /* 句柄可能已失效 */ }
          throw error;
        }
        return handle;
      }, 'fsp.open');
      patchMethod(fsp, 'opendir', wrapFsMethod('read'), 'fsp.opendir');
      patchMethod(fsp, 'realpath', wrapFsMethod('read'), 'fsp.realpath');
      for (const method of ['truncate', 'chmod', 'chown', 'utimes', 'mkdtemp']) {
        patchMethod(fsp, method, wrapFsMethod('write'), `fsp.${method}`);
      }
      patchMethod(fsp, 'symlink', (original) => function wrappedSymlink(...args) {
        guardPath('write', args[1]);
        return original.apply(this, args);
      }, 'fsp.symlink');
      // 硬链接的 args[0] 是已存在文件：必须同时要读权限，与 fs.link 同口径。
      // 只守 args[1] 的话，fs.promises.link 就是那条硬链接逃逸的后门。
      patchMethod(fsp, 'link', (original) => function wrappedLink(...args) {
        guardPath('read', args[0]);
        guardPath('write', args[1]);
        return original.apply(this, args);
      }, 'fsp.link');
    }
  }

  function installNet() {
    function guardRequest(args, protocol) {
      const target = parseRequestTarget(args, protocol);
      guard.enforce('net.outbound', { host: target.host, port: target.port || 443 });
    }

    patchMethod(http, 'request', (original) => function wrappedHttpRequest(...args) {
      guardRequest(args, 'http:');
      return original.apply(this, args);
    });
    patchMethod(http, 'get', (original) => function wrappedHttpGet(...args) {
      guardRequest(args, 'http:');
      return original.apply(this, args);
    });
    patchMethod(https, 'request', (original) => function wrappedHttpsRequest(...args) {
      guardRequest(args, 'https:');
      return original.apply(this, args);
    });
    patchMethod(https, 'get', (original) => function wrappedHttpsGet(...args) {
      guardRequest(args, 'https:');
      return original.apply(this, args);
    });

    function guardSocket(args) {
      let host;
      let port;
      if (typeof args[0] === 'number') {
        port = args[0];
        host = typeof args[1] === 'string' ? args[1] : 'localhost';
      } else if (args[0] && typeof args[0] === 'object') {
        host = args[0].host || args[0].hostname || 'localhost';
        port = args[0].port;
      }
      guard.enforce('net.outbound', { host, port: port || 0 });
    }

    // net.connect / createConnection 只是便捷入口；真正的关口在 Socket 实例上，
    // 否则 new net.Socket().connect(port, host) 一行就能绕开出站管控。
    patchMethod(net.Socket.prototype, 'connect', (original) => function wrappedSocketConnect(...args) {
      guardSocket(args);
      return original.apply(this, args);
    }, 'net.Socket#connect');
    patchMethod(net, 'connect', (original) => function wrappedNetConnect(...args) {
      guardSocket(args);
      return original.apply(this, args);
    });
    patchMethod(net, 'createConnection', (original) => function wrappedNetCreateConnection(...args) {
      guardSocket(args);
      return original.apply(this, args);
    });
    patchMethod(tls, 'connect', (original) => function wrappedTlsConnect(...args) {
      guardSocket(args);
      return original.apply(this, args);
    });

    patchMethod(dns, 'lookup', (original) => function wrappedDnsLookup(...args) {
      guard.enforce('net.outbound', { host: String(args[0]), port: 53 });
      return original.apply(this, args);
    });
    patchMethod(dns, 'resolve', (original) => function wrappedDnsResolve(...args) {
      guard.enforce('net.outbound', { host: String(args[0]), port: 53 });
      return original.apply(this, args);
    });
    if (dns.promises) {
      for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
        patchMethod(dns.promises, method, (original) => function wrappedDnsPromise(...args) {
          guard.enforce('net.outbound', { host: String(args[0]), port: 53 });
          return original.apply(this, args);
        }, `dns.promises.${method}`);
      }
    }

    patchMethod(net.Server.prototype, 'listen', (original) => function wrappedListen(...args) {
      let port = args[0];
      let address = '127.0.0.1';
      if (port && typeof port === 'object') {
        address = port.host || port.address || address;
        port = port.port;
      } else if (typeof args[1] === 'string') {
        address = args[1];
      }
      guard.enforce('net.listen', { address, port: port === undefined ? 0 : port });
      return original.apply(this, args);
    });

    if (typeof globalThis.fetch === 'function') {
      const original = globalThis.fetch;
      fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      const wrapped = function wrappedFetch(input, init) {
        if (callDepth > 0) return original.call(this, input, init);
        let target;
        if (typeof input === 'string' || input instanceof URL) {
          target = parseRequestTarget([input], 'https:');
        } else if (input && typeof input === 'object' && input.url) {
          target = parseRequestTarget([input.url], 'https:');
        } else {
          target = { host: 'localhost', port: 443 };
        }
        callDepth += 1;
        try {
          guard.enforce('net.outbound', { host: target.host, port: target.port || 443 });
        } finally {
          callDepth -= 1;
        }
        return original.call(this, input, init);
      };
      if (safeDefine(globalThis, 'fetch', wrapped, fetchDescriptor)) {
        checks.push({ target: globalThis, prop: 'fetch', original, wrapped });
        restores.push(() => {
          if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
          else globalThis.fetch = original;
        });
      }
    }
  }

  function installProc() {
    const spawnLike = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
    for (const method of spawnLike) {
      patchMethod(childProcess, method, (original) => function wrappedSpawn(...args) {
        const command = firstCommand(args);
        guard.enforce('proc.spawn', { command });
        return original.apply(this, args);
      });
    }
    for (const method of ['exec', 'execSync']) {
      patchMethod(childProcess, method, (original) => function wrappedExec(...args) {
        const command = firstCommand(args);
        guard.enforce('proc.spawn', { command });
        return original.apply(this, args);
      });
    }

    const originalKill = process.kill;
    const wrappedKill = function wrappedKill(pid, signal) {
      const target = pid === process.pid ? 'self' : (pid === 0 ? 'children' : `pid:${pid}`);
      guard.enforce('proc.signal', { target });
      return originalKill.call(process, pid, signal);
    };
    if (safeDefine(process, 'kill', wrappedKill, Object.getOwnPropertyDescriptor(process, 'kill'))) {
      checks.push({ target: process, prop: 'kill', original: originalKill, wrapped: wrappedKill });
      restores.push(() => {
        process.kill = originalKill;
      });
    }
  }

  function collectDeclaredEnvKeys() {
    const requests = (pluginInfo && pluginInfo.covenant && pluginInfo.covenant.requests) || [];
    const keys = [];
    for (const request of requests) {
      if (request.capability === 'env.read' || request.capability === 'env.write') {
        keys.push(...request.scope.keys);
      }
      if (request.capability === 'cred.read' || request.capability === 'cred.write') {
        for (const target of request.scope.targets) {
          if (target.startsWith('env:')) keys.push(target.slice(4));
        }
      }
    }
    return keys;
  }

  function installEnv() {
    const declared = collectDeclaredEnvKeys();
    const shouldGuard = (key, action) => {
      if (isSensitiveEnvKey(key)) return true;
      return declared.some((pattern) => keyPatternCovers(pattern, key));
    };
    const target = process.env;
    envDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
    if (!envDescriptor || envDescriptor.configurable === false) return;

    let inGuard = false;
    envProxy = new Proxy(target, {
      get(inner, prop, receiver) {
        if (typeof prop !== 'string' || inGuard || callDepth > 0) return Reflect.get(inner, prop, receiver);
        if (!shouldGuard(prop, 'read')) return Reflect.get(inner, prop, receiver);
        inGuard = true;
        try {
          guard.enforce('env.read', { key: prop });
        } finally {
          inGuard = false;
        }
        return Reflect.get(inner, prop, receiver);
      },
      set(inner, prop, value, receiver) {
        if (typeof prop !== 'string' || inGuard || callDepth > 0) return Reflect.set(inner, prop, value, receiver);
        if (shouldGuard(prop, 'write')) {
          const wasInGuard = inGuard;
          inGuard = true;
          try {
            guard.enforce('env.write', { key: prop });
          } finally {
            inGuard = wasInGuard;
          }
        }
        return Reflect.set(inner, prop, value, receiver);
      },
      deleteProperty(inner, prop) {
        if (typeof prop === 'string' && shouldGuard(prop, 'write')) {
          const wasInGuard = inGuard;
          inGuard = true;
          try {
            guard.enforce('env.write', { key: prop });
          } finally {
            inGuard = wasInGuard;
          }
        }
        return Reflect.deleteProperty(inner, prop);
      },
    });

    if (!safeDefine(process, 'env', envProxy, envDescriptor)) {
      envProxy = null;
      return;
    }
    checks.push({
      target: process,
      prop: 'env',
      original: target,
      wrapped: envProxy,
      kind: 'accessor',
    });
    restores.push(() => {
      if (envDescriptor) Object.defineProperty(process, 'env', envDescriptor);
    });
  }

  function verifyIntegrity() {
    const violations = [];
    for (const check of checks) {
      const current = check.target[check.prop];
      if (current !== check.wrapped) {
        violations.push({
          target: check.prop,
          kind: check.kind || 'function',
          expected: check.wrapped,
          actual: current,
        });
      }
    }
    if (violations.length > 0) {
      guard.setCompromised(`检测到 ${violations.map((item) => item.target).join(', ')} 被替换`);
      if (ledger) {
        try {
          ledger.append({
            plugin: pluginInfo.id,
            pluginVersion: pluginInfo.version,
            capability: 'integrity',
            action: 'patch',
            scope: { targets: violations.map((item) => item.target) },
            decision: 'deny',
            ruleId: 'tamper_detected',
            reason: '运行时内置 API 被重新赋值，可能是 patch 注入',
          });
        } catch {
          // 审计失败不影响检测结果。
        }
      }
    }
    return { ok: violations.length === 0, violations };
  }

  /** 覆盖自检：哪些入口受控、哪些不受控，一次说清楚。 */
  function coverage() {
    return {
      entries: checks.length,
      guarded: checks.map((check) => check.label || check.prop),
      knownGaps: KNOWN_GAPS.slice(),
      caveat: 'guarded 之外的一切入口都不受控：这是契约层，不是沙箱。',
    };
  }

  function install() {
    if (installed) return;
    installed = true;
    installFs();
    installNet();
    installProc();
    installEnv();
    installGlob();
    installWorkerGuard();
    if (autoSweep && guard.seal) guard.seal.startAutoSweep();
  }

  function uninstall() {
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        // 忽略单个恢复失败，整包卸载由宿主重启兜底。
      }
    }
    restores.length = 0;
    checks.length = 0;
    envProxy = null;
    installed = false;
  }

  install();

  return {
    guard,
    install,
    uninstall,
    verifyIntegrity,
    coverage,
    checks,
    get installed() {
      return installed;
    },
    originals: checks.map((check) => ({ target: check.prop, original: check.original })),
  };
}

module.exports = { createBridge, firstCommand, toPathString };
