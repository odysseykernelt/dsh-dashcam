'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';

// 在 Bridge 打补丁之前抓一份原生 realpath。
// 判定路径时不能直接读 fs.realpathSync：Bridge 安装后它是被包装过的函数，
// 而且包装器上没有 .native。守卫 → 判定 → realpath → Hook → 守卫 会互相递归。
// 与 ledger.js 捕获原生原语的动机相同：判定基础设施不能依赖被自己监控的入口。
const NATIVE_REALPATH_SYNC = typeof fs.realpathSync.native === 'function'
  ? fs.realpathSync.native
  : fs.realpathSync;

// 父目录回溯的层数上限：防御异常深的路径，避免无界循环。
const MAX_REALPATH_ASCENT = 64;

/** 统一为 POSIX 风格路径，便于跨平台比较（仅用于判断，不用于实际 IO）。 */
function normalizePath(input) {
  return path.resolve(input).replace(/\\/g, '/');
}

/** 把 $PLUGIN、$HOME、~ 展开为绝对路径，并统一分隔符。 */
function expandPath(input, { pluginRoot = process.cwd(), home = os.homedir() } = {}) {
  // 根必须先规范化成真实路径。判定改用真实路径之后，如果 pluginRoot 本身是符号链接
  // （macOS 的 /var → /private/var 就是），授权按词法根展开、请求按真实根判定，
  // 两边永远对不上——等于把所有 $PLUGIN 授予一次性作废。这里把口径统一。
  const root = realpathSafe(pluginRoot);
  const homeDir = realpathSafe(home);
  let value = String(input);
  value = value.replace(/^\$\{?PLUGIN\}?/, () => root);
  value = value.replace(/^\$\{?HOME\}?/, () => homeDir);
  if (value === '~') value = homeDir;
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = homeDir + value.slice(1);
  if (!path.isAbsolute(value)) value = path.resolve(root, value);
  return normalizePath(value);
}

function hasGlob(input) {
  return /[*?]/.test(input);
}

/** 取到第一个通配符之前的静态前缀。 */
function staticPrefix(input) {
  const index = input.search(/[*?]/);
  const raw = index === -1 ? input : input.slice(0, index);
  return raw.replace(/[\\/]+$/, '');
}

/** 把 glob 转成正则；** 匹配任意层级，* 不跨目录。 */
function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$+?.()|{}[]'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, IS_WINDOWS ? 'i' : '');
}

function isInside(parent, child) {
  const base = normalizePath(parent).replace(/\/$/, '');
  const target = normalizePath(child);
  return target === base || target.startsWith(`${base}/`);
}

function toPosixRelative(from, to) {
  return path.relative(from, to).replace(/\\/g, '/');
}

/** 用捕获到的原生 realpath 解析；任何失败都返回 null，由调用方决定退化方式。 */
function tryRealpath(target) {
  try {
    return NATIVE_REALPATH_SYNC(target);
  } catch {
    return null;
  }
}

/**
 * 把路径解析成「OS 真正会操作的真实路径」。**只用于判定，不要用于实际 IO。**
 *
 * 为什么必须要有它：原有 scope 判定是纯词法的。插件目录里放一个符号链接指向目录外的
 * 文件时，词法路径仍然落在 `$PLUGIN/**` 之内、判定通过，但真正被读写的是范围外的目标。
 * 判定对象必须是 OS 最终落到的那个路径，否则符号链接就是一道后门。
 *
 * 语义：
 *   1. 先用 fs.realpathSync.native 尝试解析；
 *   2. 路径还不存在（写/新建场景的 ENOENT）时，退化为「对父目录做 realpath，再拼上
 *      basename」；父目录也可能不存在，因此向上递归，直到找到第一个存在的祖先；
 *   3. 一律失败就退回规范化后的原始路径。
 *
 * 本函数不抛异常：判定阶段拿不到真实路径时，让它按词法路径继续判（由既有规则兜底），
 * 也比让工具函数把整条守卫链炸掉要好。
 */
function realpathSafe(input) {
  let lexical;
  try {
    lexical = normalizePath(input);
  } catch {
    // 入参不是可用路径（undefined、非法类型等）：不抛异常，原样交回字符串形式。
    return String(input);
  }

  const direct = tryRealpath(lexical);
  if (direct) return normalizePath(direct);

  // 路径不存在：从最深一级往上找第一个能被 realpath 解析的祖先，
  // 再把中间缺失的各级名字原样拼回去。
  let current = lexical;
  const missingParts = [];
  for (let depth = 0; depth < MAX_REALPATH_ASCENT; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current) break; // 已到根，没有可解析的祖先
    missingParts.unshift(path.basename(current));
    const resolvedParent = tryRealpath(parent);
    if (resolvedParent) return normalizePath(path.join(resolvedParent, ...missingParts));
    current = parent;
  }
  return lexical;
}

/**
 * 判断某个绝对路径是否属于凭证类敏感位置。
 *
 * 注意：`~/.dsh`（宿主自身的账本/配置目录）暂不列入——其中既有敏感的 ledger /
 * 密钥文件，也有非敏感的运行产物，整目录一刀切会误伤；待口径确定后再补。
 */
function isCredentialPath(input) {
  const value = String(input).replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.config\/gcloud)(\/|$)/.test(value)) return true;
  // .git-credentials（M13）：git 的明文 PAT/密码存储，授予家目录读即可拿走
  // GitHub 凭证，必须触发 cred.read，不能混在普通 fs.read 里。
  if (/(^|\/)(id_rsa|id_ed25519|\.netrc|\.npmrc|credentials|\.git-credentials)(\/|$)/.test(value)) return true;
  // gh CLI 的 hosts.yml（M13）：GitHub CLI 把 OAuth token 明文存在这里。
  if (/(^|\/)\.config\/gh\/hosts\.yml$/.test(value)) return true;
  if (/(^|\/)\.env(\.[^/]+)?$/.test(value)) return true;
  if (/\.(pem|key|p12|pfx)$/.test(value)) return true;
  return false;
}

/** 环境变量名是否属于凭证/密钥类。 */
function isSensitiveEnvKey(key) {
  return /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|AUTH|API|SSH_|AWS_|GCP_|AZURE_)/i.test(key);
}

module.exports = {
  IS_WINDOWS,
  normalizePath,
  realpathSafe,
  expandPath,
  hasGlob,
  staticPrefix,
  globToRegExp,
  isInside,
  toPosixRelative,
  isCredentialPath,
  isSensitiveEnvKey,
};
