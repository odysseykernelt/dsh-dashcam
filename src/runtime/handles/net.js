'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { parseRequestTarget } = require('../derive');
const { fetchWithRevalidation } = require('../redirects');
const { resolveLimits } = require('../../policy');

/**
 * 网络能力句柄：把「能连到哪里」收成一个冻结对象。
 *
 * 与 fs 句柄同一套封闭性约定：
 *  1. 方法集合是手写闭集，未列出的入口**不存在**；
 *  2. 判定发生在**调用时**：host / port 每次现算，创建句柄时不判定、不缓存；
 *  3. 原生模块只出现在闭包里，插件拿不到 http / https / net 本身；
 *  4. 只做出站。listen 不在能力面上——服务端监听是另一条授权线，
 *     句柄不提供任何「顺带」打开端口的入口。
 */
const DEFAULT_PORTS = Object.freeze({ 'http:': 80, 'https:': 443 });

/**
 * fetch 的默认超时来源。Node 原生 fetch 没有默认 timeout：对端不回包就永久挂起，
 * 而句柄是唯一的出网入口，挂起等于把调用方拖死。调用方显式传 signal 时以它为准。
 * 具体数值走 policy.limits.fetchTimeoutMs（0 = 不注入）。
 */

/**
 * host 统一小写：derive.js 拼 scope 时本来就会小写，
 * 句柄先归一化，保证 Bridge、句柄、账本三处看到同一个字符串。
 * URL.hostname 已对 DNS 名做过小写处理，这里主要兜住对象形式里手写的 host。
 */
function normalizeHost(value) {
  return String(value || '').toLowerCase();
}

function defaultPortFor(protocol) {
  return DEFAULT_PORTS[String(protocol || '').toLowerCase()] || null;
}

/**
 * 把「请求型」入参（fetch / http(s).request / get）翻译成判定目标。
 * 复用 derive.parseRequestTarget：字符串、URL 对象、options 对象三种形态与
 * Bridge 同源，免得句柄和 Bridge 长出两套端口缺省规则。
 */
function requestTarget(args, fallbackProtocol) {
  const target = parseRequestTarget(args, fallbackProtocol);
  const protocol = String(target.protocol || fallbackProtocol).toLowerCase();
  const port = target.port === null || target.port === undefined ? defaultPortFor(protocol) : Number(target.port);
  if (!Number.isInteger(port)) {
    throw new Error(`net 句柄无法确定端口：${target.host}（协议 ${protocol || '未知'} 没有默认端口）`);
  }
  return { host: normalizeHost(target.host), port, protocol };
}

/**
 * 把「套接字型」入参（net.connect / createConnection）翻译成判定目标。
 * 端口必填：node 允许省略端口去连 Unix socket / 具名管道，那类目标无法用
 * host:port 定性，句柄直接拒绝，而不是猜一个 0 号端口放行。
 */
function socketTarget(args) {
  const first = args[0];
  if (typeof first === 'number') {
    return socketPair(first, typeof args[1] === 'string' ? args[1] : 'localhost');
  }
  if (typeof first === 'string') {
    throw new Error('net 句柄只接受 TCP 端口，不接受 Unix socket 路径或管道名');
  }
  if (first && typeof first === 'object') {
    if (first.path !== undefined) {
      throw new Error('net 句柄只接受 TCP 端口，不接受 Unix socket 路径或管道名');
    }
    return socketPair(first.port, first.host || first.hostname || 'localhost');
  }
  throw new Error('net 句柄要求显式端口：connect / createConnection 不接受缺省端口');
}

function socketPair(rawPort, rawHost) {
  const port = Number(rawPort);
  if (rawPort === undefined || rawPort === null || !Number.isInteger(port)) {
    throw new Error(`net 句柄要求显式整数端口，收到 ${String(rawPort)}`);
  }
  return { host: normalizeHost(rawHost), port };
}

function createNetHandle({ guard, limits = null } = {}) {
  if (!guard || typeof guard.enforce !== 'function') {
    throw new Error('createNetHandle 需要 guard');
  }
  const fetchTimeoutMs = Number.isFinite(limits && limits.fetchTimeoutMs)
    ? limits.fetchTimeoutMs
    : resolveLimits().fetchTimeoutMs;

  // 创建时钉住原生入口：插件之后替换 http.request / globalThis.fetch
  // 也改不了句柄实际调用的函数（与 fs 句柄的做法一致）。
  const nativeRequest = { 'http:': http.request, 'https:': https.request };
  const nativeGet = { 'http:': http.get, 'https:': https.get };
  const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
  const nativeConnect = net.connect;
  const nativeCreateConnection = net.createConnection;

  function guardOutbound(target) {
    guard.enforce('net.outbound', { host: target.host, port: target.port });
  }

  function makeRequestLike(table, fallbackProtocol) {
    return function capabilityRequest(...args) {
      const target = requestTarget(args, fallbackProtocol);
      guardOutbound(target);
      // 判定通过后才选模块：句柄只有一个 request，http/https 由 URL 决定。
      // 只认表里有的协议。以前会回落到 fallbackProtocol，于是 ftp://h:21 这种
      // 有显式端口、能过判定的目标会被悄悄当成 http 请求打到 21 端口——协议被换掉了。
      const implementation = table[target.protocol];
      if (typeof implementation !== 'function') {
        throw new Error(`net 句柄不支持协议 ${target.protocol}：拒绝降级成 ${fallbackProtocol} 发出去`);
      }
      return implementation(...args);
    };
  }

  function makeConnector(original) {
    return function capabilityConnect(...args) {
      const target = socketTarget(args);
      guardOutbound(target);
      return original.call(net, ...args);
    };
  }

  async function fetch(input, init) {
    if (!nativeFetch) throw new Error('当前运行时没有原生 fetch');
    const options = { ...(init || {}) };
    if (!options.signal && fetchTimeoutMs > 0 && typeof AbortSignal !== 'undefined'
      && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(fetchTimeoutMs);
    }
    return fetchWithRevalidation({
      nativeFetch,
      input,
      init: options,
      // Request 对象：唯一可信的判定依据是它已经解析好的绝对 URL。
      resolveTarget(value) {
        if (typeof value === 'string' || value instanceof URL) {
          return requestTarget([value], 'https:');
        }
        if (value && typeof value === 'object' && typeof value.url === 'string') {
          return requestTarget([value.url], 'https:');
        }
        throw new Error('net 句柄的 fetch 只接受字符串 / URL / Request 对象');
      },
      guardTarget: guardOutbound,
    });
  }

  const handle = {
    fetch,
    request: makeRequestLike(nativeRequest, 'http:'),
    get: makeRequestLike(nativeGet, 'http:'),
    connect: makeConnector(nativeConnect),
    createConnection: makeConnector(nativeCreateConnection),
  };

  Object.defineProperty(handle, 'coverage', {
    value: () => ({
      kind: 'net-handle',
      closed: true,
      methods: Object.keys(handle).sort(),
      note: '句柄只做出站：每次调用现场判定 host:port，不提供 listen，原生模块不暴露。',
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(handle);
}

module.exports = { createNetHandle };
