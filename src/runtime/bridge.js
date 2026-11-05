'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const childProcess = require('node:child_process');
const { CovenantDenied } = require('../errors');
const { keyPatternCovers } = require('../contract/capabilities');
const { isSensitiveEnvKey } = require('../util/paths');
const { parseRequestTarget, toPathString, capabilityNeedsForOpen } = require('./derive');
const { fetchWithRevalidation } = require('./redirects');
const { sha256 } = require('../util/stable');
const { resolveLimits } = require('../policy');

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
  '卸载（dispose）之后仍在事件队列里的定时器/回调：Bridge 已还原原生模块，这些调用不再经过守卫链',
  '已授权的 worker_threads / 子进程内部：独立 realm 或独立进程，本进程的 Hook 对其不可见',
  'fs options 白名单（FS_OPTIONS）之外的键会被丢弃：Node 新版本给 fs 方法新增 options 键而白名单未同步时，该键静默失效（丢功能不丢安全），升级 Node 后需要对照核补',
  'options 里的回调与实现对象按引用保留（cp 的 filter、createReadStream 的自定义 fs 等）：回调在原生重入窗口内执行，其内部的越权调用会被直通——宿主不得让插件传入自带逻辑的回调',
  'options 的深层嵌套值（第二层及以下的对象/存取器）按引用保留：白名单只做第一层提取，深层的 getter 仍可能在原生窗口内执行',
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
 * 刻意按引用保留的原生类型：语义依赖内部槽位（Buffer 的字节数据、URL 的
 * 解析状态、AbortSignal 的信号状态），拷贝即破坏。这是设计而非疏漏。
 */
function isNativeObject(value) {
  return Buffer.isBuffer(value)
    || ArrayBuffer.isView(value)
    || value instanceof URL
    || (typeof AbortSignal === 'function' && value instanceof AbortSignal)
    || value instanceof Date
    || value instanceof RegExp;
}

/**
 * 纯数据浅拷：逐自有可枚举键 defineProperty。
 * 不用 Object.assign：源对象带自有可枚举 `__proto__` 数据属性时，assign 的
 * [[Set]] 会命中 Object.prototype 的 `__proto__` setter，把副本原型换成
 * 攻击者对象——原生随后读副本属性就在直通窗口里执行攻击者的 getter
 * （H1 证据 B 实证路径）。defineProperty 走 [[DefineOwnProperty]]：`__proto__`
 * 只会成为副本的自有数据属性，原型链不受影响。getter 的值读取发生在拷贝
 * 当下（callDepth === 0），副作用照常走守卫链。
 */
function plainCopy(source) {
  // 副本用 null 原型：原生读副本属性时完全不触原型链，连 Object.prototype
  // 上的存取器/方法面（__proto__ getter、hasOwnProperty 等）也不给窗口。
  const copy = Object.setPrototypeOf({}, null);
  for (const key of Object.keys(source)) {
    Object.defineProperty(copy, key, {
      value: source[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * fs/fsp 的 options 白名单：每个方法原生实现实际读取的键。
 * options 交给原生前提取成纯对象：类实例/继承对象的 getter 在提取的 [[Get]]
 * 中触发——此刻 callDepth === 0，越权副作用撞守卫链并被记账（H1 证据 A）；
 * 副本本身只有数据，原生重入窗口里不再有插件代码可执行。
 * 白名单是刻意的保守面：Node 新增 options 键而这里没跟上时该键被丢弃
 * （丢功能不丢安全），残余面见 KNOWN_GAPS。
 */
const FS_OPTIONS = {
  readFile: { index: 1, keys: ['encoding', 'flag', 'signal'] },
  readFileSync: { index: 1, keys: ['encoding', 'flag', 'signal'] },
  createReadStream: { index: 1, keys: ['encoding', 'fd', 'flags', 'mode', 'autoClose', 'emitClose', 'start', 'end', 'highWaterMark', 'fs'] },
  createWriteStream: { index: 1, keys: ['encoding', 'fd', 'flags', 'mode', 'autoClose', 'emitClose', 'start', 'highWaterMark', 'fs'] },
  readdir: { index: 1, keys: ['encoding', 'withFileTypes', 'recursive'] },
  readdirSync: { index: 1, keys: ['encoding', 'withFileTypes', 'recursive'] },
  stat: { index: 1, keys: ['bigint', 'throwIfNoEntry'] },
  statSync: { index: 1, keys: ['bigint', 'throwIfNoEntry'] },
  lstat: { index: 1, keys: ['bigint', 'throwIfNoEntry'] },
  lstatSync: { index: 1, keys: ['bigint', 'throwIfNoEntry'] },
  statfs: { index: 1, keys: ['bigint'] },
  statfsSync: { index: 1, keys: ['bigint'] },
  readlink: { index: 1, keys: ['encoding'] },
  readlinkSync: { index: 1, keys: ['encoding'] },
  watchFile: { index: 1, keys: ['persistent', 'interval', 'bigint'] },
  openAsBlob: { index: 1, keys: ['type'] },
  writeFile: { index: 2, keys: ['encoding', 'mode', 'flag', 'flush', 'signal'] },
  writeFileSync: { index: 2, keys: ['encoding', 'mode', 'flag', 'flush', 'signal'] },
  appendFile: { index: 2, keys: ['encoding', 'mode', 'flag', 'signal'] },
  appendFileSync: { index: 2, keys: ['encoding', 'mode', 'flag', 'signal'] },
  mkdir: { index: 1, keys: ['recursive', 'mode'] },
  mkdirSync: { index: 1, keys: ['recursive', 'mode'] },
  rm: { index: 1, keys: ['force', 'maxRetries', 'recursive', 'retryDelay', 'signal'] },
  rmSync: { index: 1, keys: ['force', 'maxRetries', 'recursive', 'retryDelay', 'signal'] },
  rmdir: { index: 1, keys: ['maxRetries', 'recursive', 'retryDelay'] },
  rmdirSync: { index: 1, keys: ['maxRetries', 'recursive', 'retryDelay'] },
  opendir: { index: 1, keys: ['encoding', 'bufferSize', 'recursive'] },
  opendirSync: { index: 1, keys: ['encoding', 'bufferSize', 'recursive'] },
  realpath: { index: 1, keys: ['encoding'] },
  realpathSync: { index: 1, keys: ['encoding'] },
  mkdtemp: { index: 1, keys: ['encoding'] },
  mkdtempSync: { index: 1, keys: ['encoding'] },
  cp: { index: 2, keys: ['mode', 'force', 'errorOnExist', 'dereference', 'verbatimSymlinks', 'filter', 'recursive', 'signal'] },
  cpSync: { index: 2, keys: ['mode', 'force', 'errorOnExist', 'dereference', 'verbatimSymlinks', 'filter', 'recursive', 'signal'] },
};

/**
 * options 白名单提取：参数确为对象（排除回调函数与数组）且不是刻意保留的
 * 原生类型时才进行。提取值里的函数（如 cp 的 filter）按引用保留，
 * 其残余风险见 KNOWN_GAPS。
 */
function extractOptionsArg(args, spec) {
  if (!spec) return args;
  const candidate = args[spec.index];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return args;
  if (isNativeObject(candidate)) return args;
  const extracted = {};
  for (const key of spec.keys) {
    // [[Get]] 走原型链：类实例/继承对象的 getter 在此触发（callDepth === 0）。
    const value = candidate[key];
    // 只回填有值的键：Node 22 起部分原生实现（如 fs.cp）对「键存在但值为
    // undefined」做严格类型校验（ERR_INVALID_ARG_TYPE），缺省键必须保持缺省。
    if (value !== undefined) extracted[key] = value;
  }
  const next = args.slice();
  next[spec.index] = extracted;
  return next;
}

/**
 * 剥离参数里的 Proxy 陷阱与存取器（F1：options-Proxy 逃逸；H1：类实例与
 * `__proto__` 自有属性逃逸）。
 * 原生 fs/net 会在 invokeOriginal 的重入窗口里**同步**读取 options 对象的属性；
 * 插件若把 Proxy、带 getter 的对象或类实例当参数传入，陷阱代码就在窗口内执行，
 * 它再发起的调用会被 guardedEntry 当作原生重入直通放行（已实证可越权写文件）。
 * 所以在开窗之前把对象参数浅拷成纯数据：getter 与 Proxy 陷阱的副作用在拷贝
 * 当下触发——此刻 callDepth 仍为 0，副作用照常走守卫链；副本交给原生后，
 * 原生读到的只是数据，不再触发任何插件代码。
 * fs 系方法的 options 参数另有更精确的白名单提取（extractOptionsArg），
 * 这里是其余入口的兜底层。Buffer/TypedArray/URL/AbortSignal 等原生类型
 * 按引用保留：语义依赖内部槽位，拷贝即破坏。
 */
function stripArgTraps(args) {
  let copy = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === null || typeof arg !== 'object') continue;
    if (isNativeObject(arg)) continue;
    if (!copy) copy = args.slice();
    // 拷贝读取自有可枚举属性：getter 与 Proxy 陷阱在此刻（callDepth === 0）
    // 触发，其副作用仍受守卫链约束。
    try {
      copy[index] = Array.isArray(arg) ? Array.prototype.slice.call(arg) : plainCopy(arg);
    } catch {
      copy[index] = arg; // 无法拷贝（如已吊销的 Proxy）：原样交给原生，由原生抛它自己的类型错误。
    }
  }
  return copy || args;
}

/**
 * Bridge：把 fs/net/proc/env/凭证访问收敛到守卫链。
 * 只包装 Node 内置模块的公开入口；所有包装器都保留原始函数引用，
 * 以便卸载与完整性检测。
 */
function createBridge({ guard, ledger, plugin = null, autoSweep = false, globBatchSize = null } = {}) {
  if (!guard) throw new Error('createBridge 需要 guard');

  const checks = [];
  const restores = [];
  // 装不上的入口：必须可见。否则「守卫已安装」是假象——某个入口 patch 失败，
  // 它就是裸的，而 installed 仍然是 true。
  const unpatched = [];
  const pluginInfo = plugin || guard.manifest || {};
  let envProxy = null;
  let envDescriptor = null;
  let fetchDescriptor = null;
  let installed = false;
  // 重入计数：Node 内置实现经常互相调用（如 appendFileSync → writeFileSync、
  // http.get → http.request）。原始实现执行期间必须直通，否则会重复守卫甚至递归。
  // 关键：这个窗口只包住**原生调用**，不包住判定。判定期间插件传入的参数会被强转
  // （路径、URL、命令），toString/valueOf 里跑的是插件代码；若判定也在窗口内，
  // 插件就能在强转里发起任意调用而不进守卫链、不落账本。
  let callDepth = 0;

  function patchMethod(target, prop, maker, label) {
    if (!target) { unpatched.push({ prop, reason: 'target_missing' }); return false; }
    const descriptor = Object.getOwnPropertyDescriptor(target, prop);
    const original = target[prop];
    if (typeof original !== 'function') { unpatched.push({ prop, reason: 'not_function' }); return false; }
    // 交给 maker 的是「带重入窗口的原生调用」，判定代码因此始终在 callDepth === 0 下执行。
    const invokeOriginal = function invokeOriginal(...callArgs) {
      // 先剥离陷阱再开窗：顺序不能反，否则剥离本身就发生在直通窗口里了。
      const safeArgs = stripArgTraps(callArgs);
      callDepth += 1;
      try {
        return original.apply(this, safeArgs);
      } finally {
        callDepth -= 1;
      }
    };
    const inner = maker(invokeOriginal);
    const wrapped = function guardedEntry(...args) {
      if (callDepth > 0) return original.apply(this, args);
      return inner.apply(this, args);
    };
    if (!safeDefine(target, prop, wrapped, descriptor)) {
      unpatched.push({ prop, reason: 'define_failed' });
      return false;
    }
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

  /**
   * glob 的基准目录。Node 允许 `cwd` 是字符串**或 URL**；以前只认字符串，
   * URL 会被静默忽略并退回 process.cwd()——结果路径按错误的基准解析，
   * 判定的对象和真实被遍历的对象就不是同一个了。认不出的类型直接拒绝。
   */
  function globBaseDir(args) {
    const options = args.find((arg) => arg && typeof arg === 'object' && arg.cwd !== undefined);
    if (!options) return process.cwd();
    const { cwd } = options;
    if (typeof cwd === 'string') return path.resolve(cwd);
    if (cwd instanceof URL) return path.resolve(fileURLToPath(cwd));
    throw new Error(`glob 的 cwd 类型不受支持：${Object.prototype.toString.call(cwd)}（只接受 string 或 URL）`);
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
  const GLOB_BATCH_SIZE = Number.isFinite(globBatchSize) && globBatchSize > 0
    ? globBatchSize
    : resolveLimits().globBatchSize;

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
        // 先算基准目录再调原生：写成 guardGlobResults(original(...), globBaseDir(args))
        // 时，参数求值顺序会让原生在 cwd 校验之前先跑，非法 cwd 由 Node 自己抛，
        // 我们那条「不静默忽略」的拒绝永远走不到。
        const baseDir = globBaseDir(args);
        return guardGlobResults(original.apply(this, args), baseDir);
      }, 'fs.globSync');
    }
    if (typeof fs.glob === 'function') {
      // fs.glob 是**回调式**（Node 22：glob(pattern[, options], callback)），
      // 异步迭代器在 fs.promises.glob 上。当成迭代器包装会把回调丢掉，
      // 调用方直接收到 "The cb argument must be of type function"。
      patchMethod(fs, 'glob', (original) => function wrappedGlob(...args) {
        const baseDir = globBaseDir(args);
        const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
        if (!callback) {
          // 没有回调：交给原生去抛它自己的类型错误，别替它决定语义。
          return original.apply(this, args);
        }
        const leading = args.slice(0, -1);
        return original.call(this, ...leading, function onGlob(error, entries) {
          if (error) return callback.call(this, error);
          try {
            guardGlobResults(entries, baseDir);
          } catch (denied) {
            return callback.call(this, denied);
          }
          return callback.call(this, null, entries);
        });
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

  function wrapFsMethod(action, { paths = [0], promises = false, method = null } = {}) {
    return (original) => function wrappedFs(...args) {
      for (const index of paths) guardPath(action, args[index]);
      // H1：options 交给原生前做白名单提取，类实例/继承 getter 在提取时
      // （callDepth === 0）被守卫拦截并记账，原生重入窗口里只剩纯数据。
      const callArgs = extractOptionsArg(args, method ? FS_OPTIONS[method] : null);
      if (promises) return original.apply(this, callArgs);
      return original.apply(this, callArgs);
    };
  }

  function installFs() {
    const readMethods = ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'existsSync', 'readlink', 'readlinkSync', 'statfs', 'statfsSync', 'watchFile', 'unwatchFile', 'openAsBlob'];
    const writeMethods = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync', 'createWriteStream'];
    const deleteMethods = ['unlink', 'unlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync'];
    for (const method of readMethods) patchMethod(fs, method, wrapFsMethod('read', { method }));
    for (const method of writeMethods) patchMethod(fs, method, wrapFsMethod('write', { method }));
    for (const method of deleteMethods) patchMethod(fs, method, wrapFsMethod('delete', { method }));

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
    patchMethod(fs, 'opendir', wrapFsMethod('read', { method: 'opendir' }), 'fs.opendir');
    patchMethod(fs, 'opendirSync', wrapFsMethod('read', { method: 'opendirSync' }), 'fs.opendirSync');
    patchMethod(fs, 'realpath', wrapFsMethod('read', { method: 'realpath' }), 'fs.realpath');
    patchMethod(fs, 'realpathSync', wrapFsMethod('read', { method: 'realpathSync' }), 'fs.realpathSync');
    for (const method of ['truncate', 'truncateSync', 'chmod', 'chmodSync', 'chown', 'chownSync', 'utimes', 'utimesSync', 'lchown', 'lchownSync', 'lutimes', 'lutimesSync']) {
      patchMethod(fs, method, wrapFsMethod('write', { method }), `fs.${method}`);
    }
    for (const method of ['mkdtemp', 'mkdtempSync']) {
      patchMethod(fs, method, wrapFsMethod('write', { method }), `fs.${method}`);
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
      return original.apply(this, extractOptionsArg(args, FS_OPTIONS.cp));
    });
    patchMethod(fs, 'cpSync', (original) => function wrappedCpSync(...args) {
      guardPath('read', args[0]);
      guardPath('write', args[1]);
      return original.apply(this, extractOptionsArg(args, FS_OPTIONS.cpSync));
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
      patchMethod(fsp, 'readFile', wrapFsMethod('read', { promises: true, method: 'readFile' }));
      patchMethod(fsp, 'readdir', wrapFsMethod('read', { promises: true, method: 'readdir' }));
      patchMethod(fsp, 'stat', wrapFsMethod('read', { promises: true, method: 'stat' }));
      patchMethod(fsp, 'lstat', wrapFsMethod('read', { promises: true, method: 'lstat' }));
      patchMethod(fsp, 'access', wrapFsMethod('read', { promises: true, method: 'access' }));
      patchMethod(fsp, 'writeFile', wrapFsMethod('write', { promises: true, method: 'writeFile' }));
      patchMethod(fsp, 'appendFile', wrapFsMethod('write', { promises: true, method: 'appendFile' }));
      patchMethod(fsp, 'mkdir', wrapFsMethod('write', { promises: true, method: 'mkdir' }));
      patchMethod(fsp, 'unlink', wrapFsMethod('delete', { promises: true, method: 'unlink' }));
      patchMethod(fsp, 'rm', wrapFsMethod('delete', { promises: true, method: 'rm' }));
      patchMethod(fsp, 'rmdir', wrapFsMethod('delete', { promises: true, method: 'rmdir' }));
      patchMethod(fsp, 'copyFile', (original) => function wrappedCopyFile(...args) {
        guardPath('read', args[0]);
        guardPath('write', args[1]);
        return original.apply(this, args);
      });
      // H4：fs.cp/cpSync 早已受控，fsp.cp 一直漏在补丁表外——
      // 授权模型里「树拷贝」是读写双面越界，不能只堵同步入口。
      patchMethod(fsp, 'cp', (original) => function wrappedCp(...args) {
        guardPath('read', args[0]);
        guardPath('write', args[1]);
        return original.apply(this, extractOptionsArg(args, FS_OPTIONS.cp));
      }, 'fsp.cp');
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
      patchMethod(fsp, 'opendir', wrapFsMethod('read', { promises: true, method: 'opendir' }), 'fsp.opendir');
      patchMethod(fsp, 'realpath', wrapFsMethod('read', { promises: true, method: 'realpath' }), 'fsp.realpath');
      // H4 覆盖表核补：fs 侧早已受控而 fsp 侧漏网的四个方法。
      patchMethod(fsp, 'readlink', wrapFsMethod('read', { promises: true, method: 'readlink' }), 'fsp.readlink');
      patchMethod(fsp, 'statfs', wrapFsMethod('read', { promises: true, method: 'statfs' }), 'fsp.statfs');
      for (const method of ['truncate', 'chmod', 'chown', 'utimes', 'mkdtemp']) {
        patchMethod(fsp, method, wrapFsMethod('write', { promises: true, method }), `fsp.${method}`);
      }
      for (const method of ['lchown', 'lutimes']) {
        patchMethod(fsp, method, wrapFsMethod('write', { promises: true, method }), `fsp.${method}`);
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
        // 原生 fetch 默认跟随重定向，且跟随后的跳数不再经过守卫链。交给复判器：
        // 每一跳重新判定，跳数封顶，拿不到可复放 body 就交回调用方。
        return fetchWithRevalidation({
          nativeFetch: original,
          input,
          init,
          resolveTarget(value) {
            if (typeof value === 'string' || value instanceof URL) {
              return parseRequestTarget([value], 'https:');
            }
            if (value && typeof value === 'object' && typeof value.url === 'string') {
              return parseRequestTarget([value.url], 'https:');
            }
            return { host: 'localhost', port: 443 };
          },
          guardTarget(target) {
            guard.enforce('net.outbound', { host: target.host, port: target.port || 443 });
          },
        });
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

  /** shell 元字符：; | & $ ` > < 换行等——出现即代表命令会被 shell 重新解释。 */
  const SHELL_METACHARS = /[;|&$`<>\n\r]/;

  /**
   * H3：exec/execSync（以及 shell:true 的 spawn 系）把整串命令交给 shell 解释，
   * 而判定只看得到首词——`git;curl evil|sh` 会以 git 的名义跑任意程序。
   * 含元字符的命令直接拒绝（先按 deny 记账再抛错），错误信息引导 execFile。
   */
  function denyShellMetachar(rawCommand) {
    const command = String(rawCommand || '');
    if (!SHELL_METACHARS.test(command)) return false;
    if (ledger && typeof ledger.append === 'function') {
      try {
        ledger.append({
          plugin: pluginInfo.id,
          pluginVersion: pluginInfo.version,
          capability: 'proc.spawn',
          action: 'spawn',
          scope: { command: command.slice(0, 200) },
          decision: 'deny',
          ruleId: 'shell_metachar',
          reason: 'shell 元字符使首词判定失效，请改用 execFile 逐参数传递',
          intercepted: true,
        });
      } catch {
        // 记账失败不改变拒绝结论。
      }
    }
    throw new CovenantDenied(
      '拒绝含 shell 元字符（; | & $ ` > < 换行等）的命令：首词判定无法覆盖 shell 的重新解释，请改用 execFile 逐参数传递',
      { capability: 'proc.spawn', scope: { command: command.slice(0, 200) }, ruleId: 'shell_metachar' },
    );
  }

  function installProc() {
    const spawnLike = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
    for (const method of spawnLike) {
      patchMethod(childProcess, method, (original) => function wrappedSpawn(...args) {
        // options 里的 shell / execPath 会改变实际执行的程序或解释器：
        //  - shell:true → 命令经 shell 重新解释，首词判定失效（与 exec 同型注入面）；
        //  - 自定义 shell 字符串 → 实际执行的是未经判定的解释器，直接拒绝；
        //  - fork 的 execPath → 判定的是 modulePath，实际跑的却是 execPath 指定的程序。
        const options = args.find((arg, index) => index > 0
          && arg && typeof arg === 'object' && !Array.isArray(arg));
        if (options) {
          if (typeof options.shell === 'string') {
            throw new CovenantDenied(
              `spawn 系入口不接受自定义 shell（${options.shell}）：该解释器未经 proc.spawn 判定`,
              { capability: 'proc.spawn', scope: { command: String(args[0]).slice(0, 200) }, ruleId: 'shell_custom' },
            );
          }
          if (options.shell === true) denyShellMetachar(args[0]);
          if (method === 'fork' && typeof options.execPath === 'string' && options.execPath !== process.execPath) {
            throw new CovenantDenied(
              `fork 的 execPath（${options.execPath}）不是当前 Node：判定的 modulePath 与实际执行的程序错位`,
              { capability: 'proc.spawn', scope: { command: options.execPath }, ruleId: 'fork_execpath' },
            );
          }
        }
        const command = firstCommand(args);
        guard.enforce('proc.spawn', { command });
        return original.apply(this, args);
      });
    }
    for (const method of ['exec', 'execSync']) {
      patchMethod(childProcess, method, (original) => function wrappedExec(...args) {
        denyShellMetachar(args[0]);
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
    if (!envDescriptor || envDescriptor.configurable === false) {
      unpatched.push({ prop: 'process.env', reason: 'descriptor_locked' });
      return;
    }

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
      unpatched.push({ prop: 'process.env', reason: 'define_failed' });
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
    return { ok: violations.length === 0 && unpatched.length === 0, violations, unpatched: unpatched.slice() };
  }

  /** 覆盖自检：哪些入口受控、哪些不受控，一次说清楚。 */
  function coverage() {
    return {
      entries: checks.length,
      guarded: checks.map((check) => check.label || check.prop),
      unpatched: unpatched.slice(),
      complete: unpatched.length === 0,
      knownGaps: KNOWN_GAPS.slice(),
      caveat: 'guarded 之外的一切入口都不受控：这是契约层，不是沙箱。',
    };
  }

  /**
   * 装不上就记账：不阻断装载（那是宿主策略），但绝不假装完整。
   * 账本记录 ruleId='bridge_incomplete'，coverage().unpatched 给出明细。
   */
  function reportIncomplete() {
    if (unpatched.length === 0) return;
    if (!ledger || typeof ledger.append !== 'function') return;
    const detail = unpatched.map((item) => `${item.prop}(${item.reason})`).join(', ');
    try {
      ledger.append({
        plugin: pluginInfo.id,
        pluginVersion: pluginInfo.version,
        capability: 'integrity',
        action: 'patch',
        scope: { unpatched: unpatched.map((item) => item.prop) },
        decision: 'deny',
        ruleId: 'bridge_incomplete',
        reason: `有 ${unpatched.length} 个入口未能安装 Hook：${detail}`,
      });
    } catch {
      // 账本写不进去也不清空 unpatched：coverage() 仍然会暴露它。
    }
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
    reportIncomplete();
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
