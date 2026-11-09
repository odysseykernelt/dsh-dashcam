'use strict';

const { fileURLToPath } = require('node:url');
const { normalizeScope, credentialCapabilityForPath, credentialCapabilityForKey } = require('../contract/capabilities');
const { expandPath, normalizePath, realpathSafe } = require('../util/paths');
const { DashcamDenied } = require('../errors');

/**
 * 路径参数只接受 string / Buffer / URL（M2）。此前对其它类型做 String(value)
 * 兜底：数字 0 会被判成词法路径 "<root>/0"（可被 $PLUGIN/** 放行），而 OS
 * 实际执行的是 readFileSync(0)——读宿主 stdin。判定对象必须与执行对象一致，
 * 认不出的类型直接拒绝；fd 语义必须显式走单独的能力面，不允许在路径判定里
 * 蒙混过关。
 */
function toPathString(value) {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (value && typeof value === 'object' && typeof value.href === 'string') return fileURLToPath(value.href);
  throw new DashcamDenied(
    `路径参数类型非法：${Object.prototype.toString.call(value)}（只接受 string/Buffer/URL）`,
    { ruleId: 'invalid_path_type' },
  );
}

function defaultPortFor(protocol) {
  const value = String(protocol || '').toLowerCase();
  if (value === 'https:') return 443;
  if (value === 'http:') return 80;
  return null;
}

function parseRequestTarget(args, defaultProtocol = 'http:') {
  // R3（三视角审查）：Node 的 http.request(url, options) 语义是 options 字段
  // **覆盖** URL 的对应字段——只判 args[0] 会「连 B 记 A」。这里按 Node 语义
  // 先合并再返回，判定对象就是真实建连对象。
  const first = args[0];
  const options = args.length > 1 && args[1] && typeof args[1] === 'object' && !(args[1] instanceof URL)
    ? args[1]
    : null;
  let protocol = defaultProtocol;
  let host = 'localhost';
  let port;
  if (typeof first === 'string' || first instanceof URL) {
    const url = first instanceof URL ? first : new URL(first, `${defaultProtocol}//localhost`);
    protocol = url.protocol;
    host = url.hostname;
    port = url.port ? Number(url.port) : undefined;
  } else if (first && typeof first === 'object') {
    protocol = first.protocol || defaultProtocol;
    host = first.hostname || first.host || 'localhost';
    port = first.port !== undefined ? Number(first.port) : undefined;
  }
  if (options) {
    if (options.protocol) protocol = options.protocol;
    if (options.host || options.hostname) {
      host = options.host || options.hostname;
    }
    if (options.port !== undefined) port = Number(options.port);
  }
  // host 允许 'host:port' 复合形态（IPv6 除外）；显式 port 优先于复合形态里的端口。
  if (port === undefined && typeof host === 'string') {
    const at = host.lastIndexOf(':');
    if (at > 0 && !host.includes(']')) {
      const maybePort = Number(host.slice(at + 1));
      if (Number.isInteger(maybePort) && maybePort > 0) {
        port = maybePort;
        host = host.slice(0, at);
      }
    }
  }
  if (port === undefined || port === null) port = defaultPortFor(protocol);
  return { host, port, protocol };
}

/**
 * 把一次 fs 操作推导成 { capability, scope, action }。
 *
 * scope.paths（或 cred 的 scope.targets）里放的是**真实路径**，不是词法路径：
 * 判定对象必须是 OS 真正会操作的那个目标。纯词法判定的问题是，插件目录里的
 * 一个符号链接可以让词法路径落在 `$PLUGIN/**` 之内、实际被读写的却是范围外的
 * 文件——链接就是判定与 IO 之间的后门。realpathSafe 只在目标还不存在时退回
 * 「父目录真实路径 + basename」，并且不抛异常，因此写/新建场景不受影响。
 *
 * 凭证升级同样看真实路径：改个名字的链接不能把 cred.read 降级成 fs.read。
 * realpathSafe 只参与判定，实际 IO 依旧由插件自己发起（守卫链只负责放行/拒绝）。
 */
function deriveFsCapability(action, pathValue, ctx) {
  const rawPath = toPathString(pathValue);
  const lexical = normalizePath(expandPath(rawPath, ctx));
  const absolute = realpathSafe(lexical);
  // M15：realpath 非 ENOENT 失败（EACCES/ELOOP/ENAMETOOLONG…）返回 null——
  // 拿不到真实路径就按词法判等于给符号链接后门留 ELOOP 掩护，fail-closed。
  // 这里抛出的错误由 deriveOperation 的 catch 折算成 derive_failed 拒绝。
  if (absolute === null) {
    throw new Error(`realpath 解析失败（非 ENOENT），fail-closed 拒绝判定：${lexical}`);
  }
  const base = action === 'read' ? 'fs.read' : (action === 'delete' ? 'fs.delete' : 'fs.write');
  const capability = credentialCapabilityForPath(absolute, base);
  if (capability.startsWith('cred.')) {
    return { capability, scope: normalizeScope(capability, { targets: [absolute] }, ctx), action: `fs.${action}` };
  }
  return { capability, scope: normalizeScope(capability, { paths: [absolute] }, ctx), action: `fs.${action}` };
}

function deriveEnvCapability(action, key) {
  const name = String(key);
  // 读与写走同一套升级规则：覆写敏感环境变量等于注入凭证，
  // 不能因为落在 env.write 的授权面上就绕开 cred.write。
  const capability = credentialCapabilityForKey(name, action);
  if (capability === 'cred.read' || capability === 'cred.write') {
    return {
      capability,
      scope: normalizeScope(capability, { targets: [`env:${name}`] }),
      action: `env.${action}`,
    };
  }
  return {
    capability,
    scope: normalizeScope(capability, { keys: [name] }),
    action: `env.${action}`,
  };
}

/**
 * 推导能力。守卫链的第一步：把具体的原始操作翻译为
 * capability + 规范化 scope，后续只认这一层结果。
 */
function deriveOperation(operation, payload = {}, ctx = {}) {
  switch (operation) {
    case 'fs.read':
    case 'fs.write':
    case 'fs.delete':
      return deriveFsCapability(operation.split('.')[1], payload.path, ctx);
    case 'net.outbound': {
      const host = String(payload.host || '').toLowerCase();
      const port = Number(payload.port);
      if (!host || !Number.isInteger(port)) {
        throw new DashcamDenied(`无法推导出站目标：${payload.host}:${payload.port}`, {
          capability: 'net.outbound',
          ruleId: 'derive',
        });
      }
      return {
        capability: 'net.outbound',
        scope: normalizeScope('net.outbound', { hosts: [`${host}:${port}`] }),
        action: 'net.connect',
      };
    }
    case 'net.listen': {
      const address = String(payload.address || '127.0.0.1').toLowerCase();
      const port = payload.port === undefined ? 0 : Number(payload.port);
      return {
        capability: 'net.listen',
        scope: normalizeScope('net.listen', { address, ports: [port] }),
        action: 'net.listen',
      };
    }
    case 'proc.spawn': {
      const command = String(payload.command || '').trim();
      if (!command) {
        throw new DashcamDenied('无法推导出进程命令', { capability: 'proc.spawn', ruleId: 'derive' });
      }
      return {
        capability: 'proc.spawn',
        scope: normalizeScope('proc.spawn', { commands: [command] }),
        action: 'proc.spawn',
      };
    }
    case 'proc.signal': {
      const target = payload.target === process.pid ? 'self' : String(payload.target);
      return {
        capability: 'proc.signal',
        scope: normalizeScope('proc.signal', { targets: [target] }),
        action: 'proc.signal',
      };
    }
    case 'env.read':
    case 'env.write':
      return deriveEnvCapability(operation.split('.')[1], payload.key);
    default:
      throw new DashcamDenied(`未知操作 ${operation}`, { ruleId: 'derive' });
  }
}

/** 把 open 的 flags 翻译成需要的能力面。Bridge 与能力句柄共用这一套口径。 */
function capabilityNeedsForOpen(flags, constants) {
  if (typeof flags === 'number') {
    const writeBits = constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT
      | constants.O_TRUNC | constants.O_APPEND;
    return {
      read: (flags & constants.O_WRONLY) === 0,
      write: (flags & writeBits) !== 0,
    };
  }
  const value = String(flags === undefined || flags === null ? 'r' : flags);
  return { read: /[r+]/.test(value), write: /[wa+]/.test(value) };
}

module.exports = {
  deriveOperation,
  deriveFsCapability,
  deriveEnvCapability,
  parseRequestTarget,
  defaultPortFor,
  toPathString,
  capabilityNeedsForOpen,
};
