'use strict';

/** 信任表中的 key 可以同时承担发布者与审核者角色。 */
function normalizeKey(entry) {
  const roles = Array.isArray(entry.roles) ? entry.roles : [entry.role].filter(Boolean);
  return {
    keyId: entry.keyId,
    roles,
    publicKey: entry.publicKey,
    status: entry.status || 'active',
    notAfter: entry.notAfter || null,
  };
}

function createTrust(keys = []) {
  return { keys: keys.map(normalizeKey) };
}

function findKey(trust, keyId, role, now = Date.now()) {
  if (!trust || !Array.isArray(trust.keys)) return null;
  return trust.keys.find((key) => (
    key.keyId === keyId
    && key.roles.includes(role)
    && key.status !== 'revoked'
    && (key.notAfter === null || key.notAfter === undefined || key.notAfter > now)
  )) || null;
}

function upsertKey(trust, entry) {
  const key = normalizeKey(entry);
  if (trust.keys.some((item) => item.keyId === key.keyId)) {
    throw new Error(`keyId 已存在：${key.keyId}`);
  }
  trust.keys.push(key);
  return key;
}

/**
 * 密钥轮换：新钥加入后旧钥保持可用（双公钥并行），
 * 直到显式 retire。验证逻辑接受 active / next / retired。
 */
function rotateKey(trust, entry) {
  return upsertKey(trust, { ...entry, status: entry.status || 'active' });
}

function retireKey(trust, keyId) {
  const key = trust.keys.find((item) => item.keyId === keyId);
  if (!key) throw new Error(`keyId 不存在：${keyId}`);
  key.status = 'retired';
  return key;
}

function revokeKey(trust, keyId) {
  const key = trust.keys.find((item) => item.keyId === keyId);
  if (!key) throw new Error(`keyId 不存在：${keyId}`);
  key.status = 'revoked';
  return key;
}

function keysForRole(trust, role) {
  if (!trust || !Array.isArray(trust.keys)) return [];
  return trust.keys.filter((key) => key.roles.includes(role) && key.status !== 'revoked');
}

module.exports = { createTrust, findKey, upsertKey, rotateKey, retireKey, revokeKey, keysForRole, normalizeKey };
