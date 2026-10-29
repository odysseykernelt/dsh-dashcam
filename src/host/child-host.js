'use strict';

const { fork } = require('node:child_process');
const fs = require('node:fs');
const { makeRequest, makeResponse, isValidRequest, isValidResponse } = require('../runtime/ipc/protocol');

/**
 * ChildHost：多进程运行时的宿主侧。把插件关进子进程，宿主替它做 IO。
 *
 * 垂直切片只实现 fs.read / fs.write / ping 三个能力 + invoke 控制消息，
 * 用来验证「子进程碰不到原生能力、每次调用都过宿主 guard」这条链路。
 * net.outbound 在切片里明确返回 unsupported，不假装实现。
 *
 * 与 LocalHost 的根本区别：这里没有 bridge / 没有 observe 窗口 / 没有 in-process patch。
 * 授权（guard.enforce）与真实 IO 在宿主同一处完成，二者之间没有 TOCTOU 窗口。
 */
class ChildHost {
  constructor({ guard, childEntry, invokeTimeoutMs = 5000 }) {
    if (!guard || typeof guard.enforce !== 'function') throw new Error('ChildHost 需要 guard');
    if (!childEntry) throw new Error('ChildHost 需要 childEntry（子进程引导脚本绝对路径）');
    this.guard = guard;
    this.childEntry = childEntry;
    this.invokeTimeoutMs = invokeTimeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this._ready = null;
  }

  start() {
    this.child = fork(this.childEntry, [], { stdio: 'inherit' });
    // 握手：等子进程发出 { kind: 'ready' }，避免「消息比子进程的监听器先到」。
    this._ready = new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg && msg.kind === 'ready') {
          this.child.removeListener('message', onMessage);
          resolve();
        }
      };
      const onExit = (code) => reject(new Error(`子进程提前退出：${code}`));
      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
    });
    this.child.on('message', (msg) => this._onMessage(msg));
    this.child.on('exit', () => this._failAll(new Error('子进程已退出')));
    return this;
  }

  _onMessage(msg) {
    if (isValidRequest(msg)) this._handleRequest(msg);
    else if (isValidResponse(msg)) this._settle(msg.id, msg.ok, msg.value, msg.error);
    // 其它（含畸形）静默忽略：IPC 是不可信输入，不能因一条坏消息崩掉宿主。
  }

  _handleRequest(msg) {
    try {
      switch (msg.op) {
        case 'fs.read': {
          const value = this._fsRead(msg.payload);
          this._reply(msg.id, true, value);
          break;
        }
        case 'fs.readMany': {
          const value = this._fsReadMany(msg.payload);
          this._reply(msg.id, true, value);
          break;
        }
        case 'fs.write': {
          this._fsWrite(msg.payload);
          this._reply(msg.id, true, null);
          break;
        }
        case 'ping':
          this._reply(msg.id, true, 'pong');
          break;
        default:
          this._reply(msg.id, false, null, { code: 'unsupported_op', message: `切片未实现能力：${msg.op}` });
      }
    } catch (error) {
      this._reply(msg.id, false, null, {
        code: error.ruleId || error.code || 'op_failed',
        message: error.message,
      });
    }
  }

  _fsRead(payload) {
    const target = payload && payload.path;
    this.guard.enforce('fs.read', { path: target });
    return fs.readFileSync(target, 'utf8');
  }

  /**
   * 批量读：授权仍逐个按 fs.read 判定（enforceBatch：判定不合并、账本合并），
   * 通过后宿主逐个执行真实 IO。子进程拿不到 fd，也拿不到任何原生 fs。
   */
  _fsReadMany(payload) {
    const paths = payload && Array.isArray(payload.paths) ? payload.paths : [];
    const targets = paths.map((target) => ({ path: target }));
    this.guard.enforceBatch('fs.read', targets);
    return paths.map((target) => fs.readFileSync(target, 'utf8'));
  }

  _fsWrite(payload) {
    const target = payload && payload.path;
    const data = payload && payload.data;
    this.guard.enforce('fs.write', { path: target });
    fs.writeFileSync(target, String(data));
  }

  _reply(id, ok, value, error) {
    if (this.child && this.child.connected) {
      this.child.send(makeResponse(id, ok, value, error));
    }
  }

  _settle(id, ok, value, error) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(value);
    else entry.reject(Object.assign(new Error((error && error.message) || '远端错误'), { code: error && error.code }));
  }

  _failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  /** 让子进程跑一段逻辑，返回其结果。 */
  async invoke(payload) {
    await this._ready;
    if (!this.child || !this.child.connected) throw new Error('子进程不可用');
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`invoke 超时（${this.invokeTimeoutMs}ms）`));
      }, this.invokeTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send(makeRequest(id, 'invoke', payload));
    });
  }

  stop() {
    if (this.child) this.child.kill();
    this._failAll(new Error('ChildHost 已停止'));
  }
}

module.exports = { ChildHost };
