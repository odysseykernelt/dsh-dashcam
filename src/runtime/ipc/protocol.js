'use strict';

/**
 * IPC 协议层：消息 schema 与校验（纯函数、零依赖、CommonJS、Node >= 20）。
 *
 * 设计目标：
 *  - 不 spawn 任何进程，只描述并校验在 process.send / process.on('message')
 *    上传递的纯数据消息（可结构化克隆，不含函数 / Buffer）。
 *  - 校验函数是 IPC 的第一道防线：对畸形 / 恶意输入必须返回 false，绝不抛异常。
 *
 * 消息形状：
 *   请求（子进程 → 宿主）：{ id, kind: 'request', op, payload }
 *   响应（宿主 → 子进程）：{ id, kind: 'response', ok, value, error }
 *   控制（宿主 → 子进程）：{ id, kind: 'request', op: 'invoke', payload }（kind 仍为 request，op 区分控制）
 *   本模块校验前两种；控制消息的 op 固定为 CONTROL_OPS 中的 'invoke'。
 */

// 子进程可向宿主请求的能力（白名单）。
const OPS = Object.freeze(['fs.read', 'fs.write', 'net.outbound', 'ping']);

// 宿主发给子进程的控制操作（白名单）。
const CONTROL_OPS = Object.freeze(['invoke']);

/** 判断是否为对象类型（非 null）。仅用 typeof 保守判断。 */
function isObjectLike(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * 判断是否为「纯对象」：typeof 为 'object' 且非 null，且不是数组等其它内建类型。
 * 通过原型是否为 Object.prototype 或 null 判断；
 * 不用 Object.prototype.toString（可被 Symbol.toStringTag 伪造）。
 */
function isPlainObject(value) {
  if (!isObjectLike(value)) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** id 仅允许 string | number。 */
function isStringOrNumber(value) {
  return typeof value === 'string' || typeof value === 'number';
}

/**
 * 构造请求消息。payload 缺省（或为假值）时补成空对象。
 */
function makeRequest(id, op, payload) {
  return { id, kind: 'request', op, payload: payload || {} };
}

/**
 * 构造响应消息。ok 强转布尔；value 缺省为 null；error 缺省为 null。
 */
function makeResponse(id, ok, value, error) {
  return {
    id,
    kind: 'response',
    ok: !!ok,
    value: value === undefined ? null : value,
    error: error || null,
  };
}

/**
 * 严格校验请求。畸形 / 恶意输入一律返回 false，绝不抛异常。
 */
function isValidRequest(msg) {
  try {
    if (!isObjectLike(msg)) return false;
    if (msg.kind !== 'request') return false;
    if (!isStringOrNumber(msg.id)) return false;
    if (typeof msg.op !== 'string' || msg.op.length === 0) return false;
    if (msg.payload !== undefined && !isPlainObject(msg.payload)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验响应的 error 字段：null / undefined，或 { code: string }。
 */
function isValidError(error) {
  if (error === null || error === undefined) return true;
  if (!isPlainObject(error)) return false;
  return typeof error.code === 'string';
}

/**
 * 严格校验响应。畸形 / 恶意输入一律返回 false，绝不抛异常。
 */
function isValidResponse(msg) {
  try {
    if (!isObjectLike(msg)) return false;
    if (msg.kind !== 'response') return false;
    if (!isStringOrNumber(msg.id)) return false;
    if (typeof msg.ok !== 'boolean') return false;
    if (!isValidError(msg.error)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  OPS,
  CONTROL_OPS,
  makeRequest,
  makeResponse,
  isValidRequest,
  isValidResponse,
};
