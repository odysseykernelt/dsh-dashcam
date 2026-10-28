'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify, sha256 } = require('../util/stable');

// 在任何 bridge 打补丁之前捕获真实函数，避免审计自身被守卫递归拦截。
// 注意：fs.appendFileSync 内部会再次调用 fs.writeFileSync，一旦后者被 bridge 包装
// 就会形成 守卫 → 写 Ledger → 写文件 → 守卫 的递归。因此这里只使用 open/write/close
// 这一组 bridge 不会包装的原语。
const REAL_OPEN_SYNC = fs.openSync;
const REAL_WRITE_SYNC = fs.writeSync;
const REAL_CLOSE_SYNC = fs.closeSync;
const REAL_MKDIR_SYNC = fs.mkdirSync;
const REAL_READ_FILE_SYNC = fs.readFileSync;
const REAL_EXISTS_SYNC = fs.existsSync;

// v1 没有 intercepted。既然升到 v2，就必须让 v1 的历史账本继续可验证：
// 哈希链的价值在于「昨天的记录今天还能重算」，不能一升级就把旧账判成损坏。
const FIELDS_V1 = Object.freeze([
  'v',
  'seq',
  'ts',
  'plugin',
  'pluginVersion',
  'capability',
  'action',
  'scope',
  'decision',
  'ruleId',
  'reason',
  'prevHash',
  'hash',
]);

const FIELDS_V2 = Object.freeze([
  'v',
  'seq',
  'ts',
  'plugin',
  'pluginVersion',
  'capability',
  'action',
  'scope',
  'decision',
  'ruleId',
  'reason',
  'intercepted',
  'prevHash',
  'hash',
]);

/**
 * v3 = v2 + mac。纯哈希链的命门是「能写文件的人就能重算整条链」；
 * HMAC-SHA256 把「改账本」变成「需要密钥」：没有 macKey 就伪造不出能过验的行。
 * mac 绑的是该行 hash（hash 已含 prevHash），所以一条 mac 同时锁住本行与整条前缀链。
 */
const FIELDS_V3 = Object.freeze([...FIELDS_V2, 'mac']);

/** 兼容导出：默认按最新版本。 */
const FIELDS = FIELDS_V3;

function hmacSha256(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

function recordVersion(parsed) {
  if (parsed && parsed.v === 3) return 3;
  if (parsed && parsed.v === 2) return 2;
  return 1;
}

function buildRecord(record, seq, prevHash, ts, macKey) {
  const base = {
    v: macKey ? 3 : 2,
    seq,
    ts,
    plugin: record.plugin,
    pluginVersion: record.pluginVersion || null,
    capability: record.capability || 'unknown',
    action: record.action || 'unknown',
    scope: record.scope || null,
    decision: record.decision,
    ruleId: record.ruleId || 'unknown',
    reason: record.reason || '',
    // 记录“实际拦截的未声明 API 调用”。拦截与普通拒绝分开统计，
    // 便于事后区分「未声明越权」与「已声明但未授予」。
    intercepted: record.intercepted === true,
    prevHash,
  };
  base.hash = sha256(stableStringify(base));
  if (macKey) base.mac = hmacSha256(macKey, base.hash);
  return base;
}

function verifyLine(parsed, expectedSeq, expectedPrev, macKey) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, errors: [{ code: 'record_invalid', detail: '不是 JSON 对象' }] };
  }
  const version = recordVersion(parsed);
  const fields = version === 3 ? FIELDS_V3 : (version === 2 ? FIELDS_V2 : FIELDS_V1);
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(parsed, field)) {
      errors.push({ code: 'field_missing', detail: field });
    }
  }
  if (version >= 2 && typeof parsed.intercepted !== 'boolean') {
    errors.push({ code: 'field_invalid', detail: 'intercepted 必须是布尔值' });
  }
  if (parsed.seq !== expectedSeq) {
    errors.push({ code: 'seq_mismatch', detail: `期望 ${expectedSeq}，实际 ${parsed.seq}` });
  }
  if (parsed.prevHash !== expectedPrev) {
    errors.push({ code: 'prev_hash_mismatch', detail: `期望 ${expectedPrev}，实际 ${parsed.prevHash}` });
  }
  const copy = { ...parsed };
  delete copy.hash;
  delete copy.mac;
  const recomputed = sha256(stableStringify(copy));
  if (recomputed !== parsed.hash) {
    errors.push({ code: 'hash_mismatch', detail: `期望 ${recomputed}，实际 ${parsed.hash}` });
  }
  if (macKey) {
    if (typeof parsed.mac !== 'string') {
      errors.push({ code: 'mac_missing', detail: '启用 macKey 后每行都必须带 mac' });
    } else {
      const expectedMac = hmacSha256(macKey, String(parsed.hash));
      const left = Buffer.from(parsed.mac, 'utf8');
      const right = Buffer.from(expectedMac, 'utf8');
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        errors.push({ code: 'mac_mismatch', detail: 'mac 校验失败：记录被无密钥者篡改' });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 取最后一行的 hash。尾行损坏（半行写入、截断）时返回 null 而不是抛异常：
 * 这正是 verify 需要被调用的场合，不能反过来让诊断自己崩掉。
 */
function lastHashOf(lines) {
  if (lines.length === 0) return 'GENESIS';
  try {
    const parsed = JSON.parse(lines[lines.length - 1]);
    return parsed && typeof parsed.hash === 'string' ? parsed.hash : null;
  } catch {
    return null;
  }
}

/**
 * Ledger：JSONL 追加 + 哈希链 + 可选 HMAC。字段固定，拒绝自由扩展，
 * 保证离线审计能够逐行重算。
 *
 * macKey：HMAC-SHA256 密钥（字符串或 Buffer）。传入后新记录为 v3，
 * verify 要求每行 mac 合法——能写文件的人没有密钥就伪造不出能通过校验的行。
 * 不传则保持 v2 纯哈希链行为（向后兼容）。
 */
class Ledger {
  constructor(file, { now = () => new Date().toISOString(), macKey = null } = {}) {
    this.file = path.resolve(file);
    this.now = now;
    this.macKey = macKey || null;
    this.seq = 0;
    this.lastHash = 'GENESIS';
    REAL_MKDIR_SYNC(path.dirname(this.file), { recursive: true });
    this._recover();
  }

  _recover() {
    if (!REAL_EXISTS_SYNC(this.file)) return;
    const lines = REAL_READ_FILE_SYNC(this.file, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Number.isInteger(parsed.seq) && parsed.seq > this.seq && typeof parsed.hash === 'string') {
          this.seq = parsed.seq;
          this.lastHash = parsed.hash;
        }
      } catch {
        // 损坏行不阻断追加；verify 会精确报告损坏位置。
      }
    }
  }

  append(record) {
    if (!record || (record.decision !== 'allow' && record.decision !== 'deny')) {
      throw new Error('Ledger.append 需要 decision=allow|deny');
    }
    const seq = this.seq + 1;
    const entry = buildRecord(record, seq, this.lastHash, record.ts || this.now(), this.macKey);
    const payload = Buffer.from(`${stableStringify(entry)}\n`, 'utf8');
    const fd = REAL_OPEN_SYNC(this.file, 'a');
    try {
      let offset = 0;
      while (offset < payload.length) {
        offset += REAL_WRITE_SYNC(fd, payload, offset, payload.length - offset);
      }
    } finally {
      REAL_CLOSE_SYNC(fd);
    }
    this.seq = seq;
    this.lastHash = entry.hash;
    return entry;
  }

  records() {
    if (!REAL_EXISTS_SYNC(this.file)) return [];
    return REAL_READ_FILE_SYNC(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          return { __invalid: true, line: index + 1, error: error.message, raw: line };
        }
      });
  }

  tail(count = 10) {
    const all = this.records();
    return all.slice(Math.max(0, all.length - count));
  }

  /** 实际拦截的未声明 API 调用（离线审计与月度度量共用的口径）。 */
  interceptions() {
    return this.records().filter((record) => record && record.intercepted === true);
  }

  /** 逐行校验哈希链，返回第一处断裂位置与全部错误。 */
  verify() {
    const lines = REAL_EXISTS_SYNC(this.file)
      ? REAL_READ_FILE_SYNC(this.file, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
    let expectedPrev = 'GENESIS';
    const errors = [];
    lines.forEach((line, index) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errors.push({ line: index + 1, code: 'json_invalid', detail: error.message });
        return;
      }
      const result = verifyLine(parsed, index + 1, expectedPrev, this.macKey);
      if (!result.ok) {
        for (const error of result.errors) errors.push({ line: index + 1, ...error });
      }
      if (parsed && parsed.hash) expectedPrev = parsed.hash;
    });
    return {
      ok: errors.length === 0,
      count: lines.length,
      head: lastHashOf(lines),
      errors,
    };
  }
}

module.exports = { Ledger, FIELDS, FIELDS_V1, FIELDS_V2, FIELDS_V3, verifyLine, recordVersion, hmacSha256 };
