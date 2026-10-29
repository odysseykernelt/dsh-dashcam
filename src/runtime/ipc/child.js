'use strict';
// 本文件不得 require('node:fs') —— 子进程唯一的对外通道是 process.send。
// 也不得 require 任何原生能力模块（fs/net/http 等）：子进程能做的只有 RPC。

const { makeRequest, makeResponse, isValidResponse } = require('./protocol');

function startChildBridge({ onInvoke }) {
  if (typeof onInvoke !== 'function') {
    throw new TypeError('startChildBridge: onInvoke must be a function');
  }

  let nextId = 0;
  const pending = new Map();

  const request = (op, payload) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      process.send(makeRequest(id, op, payload));
    });
  };

  const client = Object.freeze({
    fs: Object.freeze({
      readFile: async (path) => request('fs.read', { path }),
      writeFile: async (path, data) => request('fs.write', { path, data }),
    }),
    net: Object.freeze({
      fetch: async (url) => request('net.outbound', { url }),
    }),
  });

  async function handleInvoke(id, payload) {
    try {
      const value = await onInvoke(payload, client);
      process.send(makeResponse(id, true, value, null));
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      process.send(makeResponse(id, false, null, {
        code: normalized.code || 'child_error',
        message: normalized.message,
      }));
    }
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') {
      return; // 非对象消息一律忽略，不抛
    }

    // 控制消息：宿主调用插件侧 onInvoke
    if (msg.kind === 'request' && msg.op === 'invoke' && msg.id !== undefined) {
      handleInvoke(msg.id, msg.payload);
      return;
    }

    // 响应消息：结算 pending 中对应的请求
    if (isValidResponse(msg)) {
      const entry = pending.get(msg.id);
      if (!entry) {
        return; // 未知 / 重复 id：忽略
      }
      pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.value);
      } else {
        const error = msg.error || {};
        const err = new Error(error.message || 'child request failed');
        if (error.code) {
          err.code = error.code;
        }
        entry.reject(err);
      }
      return;
    }

    // 畸形响应（isValidResponse false）：忽略，不 settle，不抛
  }

  process.on('message', handleMessage);

  return client;
}

module.exports = { startChildBridge };
