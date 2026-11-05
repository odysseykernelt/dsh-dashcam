'use strict';

const { fileURLToPath } = require('node:url');
const { normalizeScope, credentialCapabilityForPath, credentialCapabilityForKey } = require('../contract/capabilities');
const { expandPath, normalizePath, realpathSafe } = require('../util/paths');
const { CovenantDenied } = require('../errors');

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
  throw new CovenantDenied(
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
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    const url = first instanceof URL ? first : new URL(first, `${defaultProtocol}//localhost`);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : defaultPortFor(url.protocol),
      protocol: url.protocol,
    };
  }
  if (first && typeof first === 'object') {
    const protocol = first.protocol || defaultProtocol;
    return {
      host: first.hostname || first.host || 'localhost',
      port: first.port ? Number(first.port) : defaultPortFor(protocol),
      protocol,
    };
  }
  return { host: 'localhost', port: defaultPortFor(defaultProtocol), protocol: defaultProtocol };
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
        throw new CovenantDenied(`无法推导出站目标：${payload.host}:${payload.port}`, {
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
        throw new CovenantDenied('无法推导出进程命令', { capability: 'proc.spawn', ruleId: 'derive' });
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
      throw new CovenantDenied(`未知操作 ${operation}`, { ruleId: 'derive' });
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
