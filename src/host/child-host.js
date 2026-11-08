'use strict';

const { fork } = require('node:child_process');
const fs = require('node:fs');
const { makeRequest, makeResponse, isValidRequest, isValidResponse, messageSizeBytes } = require('../runtime/ipc/protocol');

/** maxMessageBytes / ipcTimeoutMs 非法时的回落值（与 policy.js DEFAULT_LIMITS 一致）。 */
const DEFAULT_MAX_MESSAGE_BYTES = 1_048_576;
const DEFAULT_IPC_TIMEOUT_MS = 5_000;

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
  /**
   * @param {object} options
   * @param {number} [options.ipcTimeoutMs] invoke 超时（M5，policy.limits.ipcTimeoutMs
   *   的正式入口）；0 = 不限时。旧参数名 invokeTimeoutMs 仍被接受，ipcTimeoutMs 优先。
   * @param {number} [options.maxMessageBytes] 单条 IPC 消息字节上限（M4），
   *   入向超限丢弃、出向超限降级为小体积错误响应（见 _reply/_onMessage）。
   */
  constructor({ guard, childEntry, invokeTimeoutMs = DEFAULT_IPC_TIMEOUT_MS, ipcTimeoutMs, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES }) {
    if (!guard || typeof guard.enforce !== 'function') throw new Error('ChildHost 需要 guard');
    if (!childEntry) throw new Error('ChildHost 需要 childEntry（子进程引导脚本绝对路径）');
    this.guard = guard;
    this.childEntry = childEntry;
    // M5：ipcTimeoutMs 是 policy.limits 的正式名字；invokeTimeoutMs 是旧参数名，
    // 保持兼容。0 = 不限时；负数/非法回落默认——fail-closed 的默认是「有限时」。
    const timeout = Number.isFinite(ipcTimeoutMs) ? ipcTimeoutMs : invokeTimeoutMs;
    this.ipcTimeoutMs = Number.isFinite(timeout) && timeout >= 0 ? timeout : DEFAULT_IPC_TIMEOUT_MS;
    // M4：消息上限非法（非正数/非有限）回落默认，不接受「配坏了就取消上限」。
    this.maxMessageBytes = Number.isFinite(maxMessageBytes) && maxMessageBytes >= 1
      ? Math.floor(maxMessageBytes)
      : DEFAULT_MAX_MESSAGE_BYTES;
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
    // M4：入向消息超限直接丢弃（fail-closed，与畸形消息同口径）——IPC 是不可信
    // 输入，超大消息可能被用来让宿主分配大量内存。
    const size = messageSizeBytes(msg);
    if (size > this.maxMessageBytes) {
      console.warn(`[dsh-dashcam] 丢弃超大 IPC 消息（${size} > ${this.maxMessageBytes} 字节）`);
      return;
    }
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
    // 路径参数只接受 string/Buffer/URL（M2）：数字是 fd 语义（readFileSync(0)
    // 读宿主 stdin），判定层会按 invalid_path_type 直接拒绝——这里不做
    // String() 兜底，也不允许任何绕过守卫直达 readFileSync 的路径。
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
      const response = makeResponse(id, ok, value, error);
      // M4：出向响应超限不能整条丢弃——子进程会永久挂起等这条响应。
      // 降级为一条小体积错误响应，让等待方立刻失败。
      if (messageSizeBytes(response) > this.maxMessageBytes) {
        this.child.send(makeResponse(id, false, null, {
          code: 'response_too_large',
          message: `响应超过 maxMessageBytes（${this.maxMessageBytes} 字节）`,
        }));
        return;
      }
      this.child.send(response);
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
    const request = makeRequest(id, 'invoke', payload);
    // M4：请求超限在发送前就失败，不进入 pending——否则要等超时才暴露。
    if (messageSizeBytes(request) > this.maxMessageBytes) {
      throw Object.assign(
        new Error(`invoke 载荷超过 maxMessageBytes（${this.maxMessageBytes} 字节）`),
        { code: 'message_too_large' },
      );
    }
    return new Promise((resolve, reject) => {
      // M5：ipcTimeoutMs 0 = 不限时（显式逃生开关，默认 5000ms）。
      const timer = this.ipcTimeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`invoke 超时（${this.ipcTimeoutMs}ms）`));
      }, this.ipcTimeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.child.send(request);
    });
  }

  stop() {
    if (this.child) this.child.kill();
    this._failAll(new Error('ChildHost 已停止'));
  }
}

module.exports = { ChildHost };
