'use strict';

const crypto = require('node:crypto');

/**
 * 稳定序列化：对象键排序，保证同一内容得到同一字节串。
 * 用于哈希链与签名载荷，避免因键顺序变化导致校验失败。
 */
function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sha256Base64(input) {
  return crypto.createHash('sha256').update(input).digest('base64');
}

module.exports = { stableStringify, sha256, sha256Base64 };
