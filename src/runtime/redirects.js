'use strict';

/**
 * fetch 的重定向复判。
 *
 * 原生 fetch 默认 `redirect: 'follow'`，跟随后的每一跳由 undici 直接发出，不再经过
 * 守卫链。于是「声明了 api.example.com」的插件可以让对端 302 到 169.254.169.254，
 * 拿到内网响应——判定只看第一跳，等于没判定。
 *
 * 这里把重定向收回守卫手里：每一跳按 Location 重新判定，跳数封顶，协议收紧到
 * http/https。遇到「拿不到可复放 body」的情况（Request 实例 + 307/308）就把 3xx
 * 原样交回调用方，绝不绕过守卫自己发出去。
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function isRedirect(status) {
  return REDIRECT_STATUSES.has(Number(status));
}

function isRequestInstance(value) {
  return typeof Request === 'function' && value instanceof Request;
}

function urlStringOf(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return null;
}

function readLocation(response) {
  const headers = response && response.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  try {
    return headers.get('location');
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {Function} options.nativeFetch   创建时钉住的原生 fetch
 * @param {Function} options.resolveTarget 把 input（字符串/URL/Request）翻译成判定目标
 * @param {Function} options.guardTarget   对目标执行守卫；拒绝时抛 CovenantDenied
 * @param {*}        options.input
 * @param {object}   [options.init]
 * @param {number}   [options.maxRedirects]
 */
async function fetchWithRevalidation({
  nativeFetch, resolveTarget, guardTarget, input, init, maxRedirects = MAX_REDIRECTS,
}) {
  if (typeof nativeFetch !== 'function') throw new Error('当前运行时没有原生 fetch');

  let currentInput = input;
  let currentInit = init;

  for (let hop = 0; ; hop += 1) {
    guardTarget(resolveTarget(currentInput));
    // 调用方显式写的其它选项保留，只覆盖 redirect：跟随权必须在守卫手里。
    const response = await nativeFetch(currentInput, { ...(currentInit || {}), redirect: 'manual' });
    if (!isRedirect(response.status)) return response;
    // 跳数封顶：把最后一跳的 3xx 交回调用方，而不是继续放行。
    if (hop >= maxRedirects) return response;

    const location = readLocation(response);
    if (!location) return response;

    // 相对 Location 必须以当前请求的绝对 URL 为基准；解析不出绝对地址就交回调用方。
    const base = response.url || urlStringOf(currentInput);
    if (!base) return response;
    let nextUrl;
    try {
      nextUrl = new URL(location, base);
    } catch {
      return response;
    }
    if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') return response;

    const method = String(
      (currentInit && currentInit.method)
      || (currentInput && currentInput.method)
      || 'GET',
    ).toUpperCase();
    // 303 一律改 GET；301/302 只对 POST 改 GET；307/308 保持方法与 body。
    const toGet = response.status === 303
      || ((response.status === 301 || response.status === 302) && method === 'POST');
    // Request 实例的 body 不可重放：需要保方法时直接交回调用方。
    if (!toGet && isRequestInstance(currentInput)) return response;

    const nextInit = { ...(currentInit || {}) };
    if (toGet) {
      nextInit.method = 'GET';
      delete nextInit.body;
    }
    currentInput = nextUrl.href;
    currentInit = nextInit;
  }
}

module.exports = { fetchWithRevalidation, isRedirect, MAX_REDIRECTS };
