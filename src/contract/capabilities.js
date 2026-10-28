'use strict';

const { CovenantInputError } = require('../errors');
const {
  expandPath,
  realpathSafe,
  hasGlob,
  staticPrefix,
  globToRegExp,
  isCredentialPath,
  isSensitiveEnvKey,
  normalizePath,
  IS_WINDOWS,
} = require('../util/paths');

/**
 * 能力分类。运行时只能通过这些能力访问宿主资源；
 * 未列入表中的操作一律视为未建模，由门禁补充规则。
 */
const CAPABILITY_GROUPS = Object.freeze({
  fs: ['fs.read', 'fs.write', 'fs.delete'],
  net: ['net.outbound', 'net.listen'],
  proc: ['proc.spawn', 'proc.signal'],
  env: ['env.read', 'env.write'],
  cred: ['cred.read', 'cred.write'],
});

const ALL_CAPABILITIES = Object.freeze(Object.values(CAPABILITY_GROUPS).flat());

const GROUP_OF = new Map();
for (const [group, capabilities] of Object.entries(CAPABILITY_GROUPS)) {
  for (const capability of capabilities) GROUP_OF.set(capability, group);
}

/** 高风险能力：画像卡中必须红显并强制确认。 */
const HIGH_RISK_CAPABILITIES = new Set([
  'cred.read',
  'cred.write',
  'proc.spawn',
  'proc.signal',
  'net.listen',
  'fs.delete',
]);

function isCapability(capability) {
  return ALL_CAPABILITIES.includes(capability);
}

function groupOf(capability) {
  return GROUP_OF.get(capability) || null;
}

function inputError(message, field) {
  return new CovenantInputError(message, { code: 'SCOPE_INVALID', field });
}

function asArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw inputError(`${field} 必须是非空数组`, field);
  }
  return value;
}

function normalizeString(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw inputError(`${field} 必须是非空字符串`, field);
  return text;
}

function normalizeFsPaths(value, field, ctx) {
  return asArray(value, field).map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw inputError(`${field}[${index}] 必须是非空路径`, `${field}[${index}]`);
    }
    return expandPath(item, ctx);
  });
}

function splitHostPort(raw, field) {
  const value = normalizeString(raw, field).toLowerCase();
  if (value === '*' || value === '*:*') throw inputError(`${field} 不允许全通配`, field);
  let host;
  let port;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) throw inputError(`${field} 的 IPv6 地址缺少 ]`, field);
    host = value.slice(1, end);
    const rest = value.slice(end + 1);
    port = rest.startsWith(':') ? rest.slice(1) : '';
  } else {
    const index = value.lastIndexOf(':');
    if (index === -1) {
      host = value;
      port = '';
    } else {
      host = value.slice(0, index);
      port = value.slice(index + 1);
    }
  }
  if (!port || !/^\d+$/.test(port)) {
    throw inputError(`${field} 必须写成 host:port（明确端口，防止跨协议越权）`, field);
  }
  const portNumber = Number(port);
  if (portNumber < 0 || portNumber > 65535) throw inputError(`${field} 端口越界`, field);
  if (host.startsWith('*.')) {
    const base = host.slice(2);
    if (!base.includes('.') || base.includes('*')) throw inputError(`${field} 通配主机必须是 *.example.com`, field);
  } else if (host.includes('*')) {
    throw inputError(`${field} 只允许 *. 前缀通配`, field);
  }
  if (!/^[a-z0-9.:*-]+$/.test(host)) throw inputError(`${field} 主机名非法`, field);
  return `${host}:${portNumber}`;
}

function normalizeHosts(value, field) {
  return asArray(value, field).map((item, index) => splitHostPort(item, `${field}[${index}]`));
}

function normalizePorts(value, field) {
  return asArray(value, field).map((item, index) => {
    const port = Number(item);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw inputError(`${field}[${index}] 必须是 0..65535 的整数`, `${field}[${index}]`);
    }
    return port;
  }).filter((port, index, list) => list.indexOf(port) === index);
}

function normalizeCommand(value, field) {
  const command = normalizeString(value, field);
  if (/[\u0000-\u001f]/.test(command)) throw inputError(`${field} 包含控制字符`, field);
  return command;
}

function normalizeCommands(value, field) {
  return asArray(value, field).map((item, index) => normalizeCommand(item, `${field}[${index}]`));
}

function normalizeEnvKeys(value, field) {
  return asArray(value, field).map((item, index) => {
    const key = normalizeString(item, `${field}[${index}]`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(key)) {
      throw inputError(`${field}[${index}] 不是合法的环境变量名（只允许末尾 * 通配）`, `${field}[${index}]`);
    }
    return key;
  });
}

function normalizeSignalTargets(value, field) {
  const allowed = /^(self|children|pid:\d+)$/;
  return asArray(value, field).map((item, index) => {
    const target = normalizeString(item, `${field}[${index}]`);
    if (!allowed.test(target)) {
      throw inputError(`${field}[${index}] 只允许 self / children / pid:<n>`, `${field}[${index}]`);
    }
    return target;
  });
}

function normalizeCredTarget(value, field, ctx) {
  const target = normalizeString(value, field);
  if (target.startsWith('env:')) {
    const key = target.slice(4);
    if (!/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(key)) throw inputError(`${field} 的 env: 目标非法`, field);
    return `env:${key}`;
  }
  if (target.startsWith('keychain:')) {
    const name = target.slice('keychain:'.length);
    if (!name || name.includes('*') && !name.endsWith('*')) {
      throw inputError(`${field} 的 keychain: 目标只允许末尾 * 通配`, field);
    }
    return `keychain:${name}`;
  }
  return expandPath(target, ctx);
}

function normalizeCredTargets(value, field, ctx) {
  return asArray(value, field).map((item, index) => normalizeCredTarget(item, `${field}[${index}]`, ctx));
}

/**
 * 规范化 scope。scope 的形状由能力决定，未知字段直接报错，
 * 避免插件用“看起来像声明、实际被忽略”的字段蒙混过关。
 */
function normalizeScope(capability, raw, ctx = {}) {
  if (!isCapability(capability)) {
    throw inputError(`未知能力 ${capability}`, 'capability');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw inputError('scope 必须是对象', 'scope');
  }
  switch (capability) {
    case 'fs.read':
    case 'fs.write':
    case 'fs.delete':
      return { paths: normalizeFsPaths(raw.paths, 'scope.paths', ctx) };
    case 'net.outbound':
      return { hosts: normalizeHosts(raw.hosts, 'scope.hosts') };
    case 'net.listen': {
      const address = raw.address === undefined ? '127.0.0.1' : normalizeString(raw.address, 'scope.address');
      if (!/^[a-z0-9.:*-]+$/.test(address.toLowerCase())) {
        throw inputError('scope.address 非法', 'scope.address');
      }
      return { address: address.toLowerCase(), ports: normalizePorts(raw.ports, 'scope.ports') };
    }
    case 'proc.spawn':
      return { commands: normalizeCommands(raw.commands, 'scope.commands') };
    case 'proc.signal':
      return { targets: normalizeSignalTargets(raw.targets, 'scope.targets') };
    case 'env.read':
    case 'env.write':
      return { keys: normalizeEnvKeys(raw.keys, 'scope.keys') };
    case 'cred.read':
    case 'cred.write':
      return { targets: normalizeCredTargets(raw.targets, 'scope.targets', ctx) };
    default:
      throw inputError(`未知能力 ${capability}`, 'capability');
  }
}

/** manifest 中的能力请求。reason 是画像卡与拒绝提示的唯一原文来源。 */
function normalizeRequest(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') throw inputError('能力请求必须是对象', 'capabilities.requests[]');
  const capability = raw.capability || raw.cap;
  if (!isCapability(capability)) throw inputError(`未知能力 ${capability}`, 'capabilities.requests[].cap');
  const reason = normalizeString(raw.reason, 'capabilities.requests[].reason');
  return {
    capability,
    scope: normalizeScope(capability, raw.scope, ctx),
    reason,
  };
}

/** 宿主授予项。默认授予集为空（deny-all）。 */
function normalizeGrant(raw, ctx = {}, index = 0) {
  if (!raw || typeof raw !== 'object') throw inputError('grant 必须是对象', `grants[${index}]`);
  const capability = raw.capability || raw.cap;
  if (!isCapability(capability)) throw inputError(`未知能力 ${capability}`, `grants[${index}].capability`);
  const scope = normalizeScope(capability, raw.scope, ctx);
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `grant-${index}-${capability}`;
  return {
    id,
    capability,
    scope,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    grantor: typeof raw.grantor === 'string' ? raw.grantor : 'policy',
    expiresAt: raw.expiresAt === undefined ? null : Number(raw.expiresAt),
    oneSeal: raw.oneSeal === true,
    sealTtlMs: raw.sealTtlMs === undefined ? null : Number(raw.sealTtlMs),
    enabled: raw.enabled !== false,
  };
}

function normalizePathForCompare(value) {
  return IS_WINDOWS ? value.toLowerCase() : value;
}

function pathPatternCovers(granted, requested) {
  const grant = normalizePathForCompare(granted);
  const request = normalizePathForCompare(requested);
  if (grant === request) return true;
  if (!hasGlob(request)) return globToRegExp(grant).test(request);
  if (!hasGlob(grant)) return false;
  const grantDirectory = grant.endsWith('/**') ? grant.slice(0, -3) : null;
  if (!grantDirectory || hasGlob(grantDirectory)) return false;
  const requestPrefix = staticPrefix(request);
  return requestPrefix === grantDirectory || requestPrefix.startsWith(`${grantDirectory}/`);
}

function hostPatternCovers(granted, requested) {
  const grantHost = granted.slice(0, granted.lastIndexOf(':'));
  const grantPort = granted.slice(granted.lastIndexOf(':') + 1);
  const requestHost = requested.slice(0, requested.lastIndexOf(':'));
  const requestPort = requested.slice(requested.lastIndexOf(':') + 1);
  if (grantPort !== requestPort) return false;
  if (grantHost === requestHost) return true;
  if (grantHost.startsWith('*.')) {
    const base = grantHost.slice(1);
    return requestHost.endsWith(base) && requestHost.length > base.length;
  }
  return false;
}

function keyPatternCovers(granted, requested) {
  const grant = granted === '*';
  if (grant) return true;
  if (granted === requested) return true;
  return granted.endsWith('*') && requested.startsWith(granted.slice(0, -1));
}

function commandCovers(granted, requested) {
  if (granted === requested) return true;
  // 允许以基名授权，但仅当授权项本身不含路径分隔符。
  if (!granted.includes('/') && !granted.includes('\\')) {
    const base = requested.split(/[\\/]/).pop();
    return base === granted;
  }
  return false;
}

function credTargetCovers(granted, requested) {
  if (granted.startsWith('env:') || requested.startsWith('env:')) {
    if (!granted.startsWith('env:') || !requested.startsWith('env:')) return false;
    return keyPatternCovers(granted.slice(4), requested.slice(4));
  }
  if (granted.startsWith('keychain:') || requested.startsWith('keychain:')) {
    if (!granted.startsWith('keychain:') || !requested.startsWith('keychain:')) return false;
    const grant = granted.slice('keychain:'.length);
    const request = requested.slice('keychain:'.length);
    return grant === request || (grant.endsWith('*') && request.startsWith(grant.slice(0, -1)));
  }
  return pathPatternCovers(granted, requested);
}

/**
 * 判断 grantedScope 是否覆盖 requestedScope。
 * 覆盖是逐项子集关系：请求中的每一个具体目标都必须落在授权内。
 */
function scopeCovers(capability, granted, requested) {
  switch (capability) {
    case 'fs.read':
    case 'fs.write':
    case 'fs.delete':
      return requested.paths.every((path) => granted.paths.some((grant) => pathPatternCovers(grant, path)));
    case 'net.outbound':
      return requested.hosts.every((host) => granted.hosts.some((grant) => hostPatternCovers(grant, host)));
    case 'net.listen': {
      const addressOk = granted.address === '0.0.0.0' || granted.address === '::' || granted.address === requested.address;
      if (!addressOk) return false;
      return requested.ports.every((port) => granted.ports.includes(port));
    }
    case 'proc.spawn':
      return requested.commands.every((command) => granted.commands.some((grant) => commandCovers(grant, command)));
    case 'proc.signal':
      return requested.targets.every((target) => granted.targets.includes(target));
    case 'env.read':
    case 'env.write':
      return requested.keys.every((key) => granted.keys.some((grant) => keyPatternCovers(grant, key)));
    case 'cred.read':
    case 'cred.write':
      return requested.targets.every((target) => granted.targets.some((grant) => credTargetCovers(grant, target)));
    default:
      return false;
  }
}

/** 在 manifest 声明里找到覆盖本次请求的条目；找不到即“未声明”。 */
function findDeclaredRequest(requests, capability, scope) {
  return requests.find((request) => request.capability === capability && scopeCovers(capability, request.scope, scope)) || null;
}

function describeScope(capability, scope) {
  switch (capability) {
    case 'fs.read':
    case 'fs.write':
    case 'fs.delete':
      return scope.paths.join(', ');
    case 'net.outbound':
      return scope.hosts.join(', ');
    case 'net.listen':
      return `${scope.address}:${scope.ports.join('/')}`;
    case 'proc.spawn':
      return scope.commands.join(', ');
    case 'proc.signal':
      return scope.targets.join(', ');
    case 'env.read':
    case 'env.write':
      return scope.keys.join(', ');
    case 'cred.read':
    case 'cred.write':
      return scope.targets.join(', ');
    default:
      return '';
  }
}

/** 把具体的 fs 路径升级为凭证能力；这是“凭证访问单独授权”的硬规则。 */
function credentialCapabilityForPath(path, baseCapability) {
  if (!isCredentialPath(path)) return baseCapability;
  return baseCapability === 'fs.write' || baseCapability === 'fs.delete' ? 'cred.write' : 'cred.read';
}

function credentialCapabilityForKey(key, action = 'read') {
  if (!isSensitiveEnvKey(key)) return action === 'write' ? 'env.write' : 'env.read';
  return action === 'write' ? 'cred.write' : 'cred.read';
}

module.exports = {
  CAPABILITY_GROUPS,
  ALL_CAPABILITIES,
  HIGH_RISK_CAPABILITIES,
  isCapability,
  groupOf,
  normalizeScope,
  normalizeRequest,
  normalizeGrant,
  scopeCovers,
  findDeclaredRequest,
  describeScope,
  pathPatternCovers,
  hostPatternCovers,
  keyPatternCovers,
  credentialCapabilityForPath,
  credentialCapabilityForKey,
  // 与 derive 同口径：判定用真实路径，导出给宿主的也必须是真实路径，
  // 否则宿主拿去做二次判断，会和守卫链得出不同结论。
  resolvePath: (value, ctx) => realpathSafe(expandPath(value, ctx)),
};
