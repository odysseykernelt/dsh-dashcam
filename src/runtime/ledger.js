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
const REAL_READ_SYNC = fs.readSync;
const REAL_MKDIR_SYNC = fs.mkdirSync;
const REAL_READ_FILE_SYNC = fs.readFileSync;
const REAL_EXISTS_SYNC = fs.existsSync;
const REAL_STAT_SYNC = fs.statSync;
const REAL_FSTAT_SYNC = fs.fstatSync;
const REAL_TRUNCATE_SYNC = fs.truncateSync;
const REAL_FSYNC_SYNC = fs.fsyncSync;
const REAL_RENAME_SYNC = fs.renameSync;

/**
 * 进程内同一路径共享的账本状态（H6）。
 * 准入、注册、运行时各自 new 一个 Ledger 是常态；若每个实例都自带
 * size/seq/lastHash 基准，第二个实例 append 时磁盘已被第一个推进，
 * 会被误判成「并发写入」而永久卡死。seq/lastHash/size 收进共享状态后，
 * 进程内多实例天然一致；跨进程追加仍会被发现——本进程没写过的字节
 * 必然让磁盘大于共享基准（构造时抛错，活跃实例 append 时抛错）。
 */
const SHARED_LEDGER_STATE = new Map();

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

/**
 * v4 = v2 + profiled + manifestHash（归属标注，可不含 mac）。
 * 行车记录仪的核心取证维度是「这条活动有没有契约管着」：profiled=false 表示
 * 记录产生于零契约模式（宿主没给这个插件任何声明清单）；manifestHash 是声明
 * 清单（requests）的稳定哈希——有契约时事后能对出「当时到底声明了什么」，
 * 无契约时为 null，本身就是「没契约」的证明。
 */
const FIELDS_V4 = Object.freeze([...FIELDS_V2, 'profiled', 'manifestHash']);
/** v4 + mac：与 v3 一样，macKey 存在时 mac 必须在。 */
const FIELDS_V4_MAC = Object.freeze([...FIELDS_V4, 'mac']);

/** 兼容导出：默认按最新版本。 */
const FIELDS = FIELDS_V4;

function hmacSha256(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/** 定长常量比较：长度不同直接 false，长度相同再走 timingSafeEqual。 */
function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function recordVersion(parsed) {
  if (parsed && parsed.v === 4) return 4;
  if (parsed && parsed.v === 3) return 3;
  if (parsed && parsed.v === 2) return 2;
  return 1;
}

function buildRecord(record, seq, prevHash, ts, macKey) {
  const base = {
    v: 4,
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
    // 归属标注（v4）：这条活动发生时插件是否在契约之下、契约清单是什么。
    // 缺省即「无契约」——这对零契约模式是如实记录，不是缺字段。
    profiled: record.profiled === true,
    manifestHash: typeof record.manifestHash === 'string' ? record.manifestHash : null,
    // 会话归属（2.2.0 可选字段）：活动发生在哪个宿主对话窗口（宿主适配层从
    // tools/pre-execute 的 exec.agent.session.id 取）。老账本无此字段——verify
    // 只查必填清单，不拒额外字段；哈希按整行重算，带不带 session 都能过验。
    ...(typeof record.session === 'string' && record.session ? { session: record.session } : {}),
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
  const fields = version === 4
    ? (macKey ? FIELDS_V4_MAC : FIELDS_V4)
    : (version === 3 ? FIELDS_V3 : (version === 2 ? FIELDS_V2 : FIELDS_V1));
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
    REAL_MKDIR_SYNC(path.dirname(this.file), { recursive: true });
    // 单写者契约：账本用 seq 续号，跨进程并发追加会产生重复 seq，
    // 结果是「自己写的账本自己验不过」。用文件大小做低成本并发检测。
    const diskSize = REAL_EXISTS_SYNC(this.file) ? REAL_STAT_SYNC(this.file).size : 0;
    let state = SHARED_LEDGER_STATE.get(this.file);
    if (!state) {
      state = { seq: 0, lastHash: 'GENESIS', size: diskSize, written: false };
      SHARED_LEDGER_STATE.set(this.file, state);
      // N1：本进程第一次认识这个账本。如果它最近 5 秒内刚被写过，多半是
      // 另一个宿主实例还开着同一个文件——单写者契约下两个进程迟早打架
      //（活跃实例 append 时抛「并发写入」）。这里提前点名，不做静默对齐。
      if (diskSize > 0) {
        try {
          const mtimeMs = REAL_STAT_SYNC(this.file).mtime.getTime();
          if (Date.now() - mtimeMs < 5000) {
            console.warn(
              `[dsh-dashcam] 账本 ${this.file} 在最近 5 秒内被外部修改过：`
              + '可能存在另一个写入者进程（Ledger 单写者契约下双方会互相失败）。'
              + '多实例请用分实例路径（.dsh-ledger-<profile>.jsonl 或 config.ledgerPath）',
            );
          }
        } catch {
          // 文件恰好消失：按无预警处理，后续 append 自然会暴露问题。
        }
      }
    } else if (diskSize !== state.size) {
      // 进程内共享基准不会落后于自己写过的字节：磁盘不一致说明有 Ledger
      // 之外的写入者（外部进程追加，或文件被截断/重建）。构造即对齐到磁盘
      // 现状——审计必须能打开账本跑 verify，不能在门口就被挡死；但外部
      // 写入必须可见（macKey 缺席时哈希链可被重算，可见性是最后的线索）。
      // 活跃实例（不重新构造）在 append 时仍会精确抛「并发写入」。
      // B1：磁盘比基准小不是普通的外部写入——前缀被砍掉的哈希链依然自洽，
      // verify 发现不了回滚，告警是唯一的线索，必须与追加写区分口径。
      if (state.written && diskSize < state.size) {
        console.warn(
          `[dsh-dashcam] ledger_rollback：账本比进程内基准小（期望 ${state.size} 字节，实际 ${diskSize} 字节，${this.file}）。文件可能被截断或整体回滚，被砍掉的内容无法由 verify() 证明。`,
        );
      } else if (state.written && diskSize > state.size) {
        console.warn(
          `[dsh-dashcam] 账本在 Ledger 实例之外被写入：期望 ${state.size} 字节，实际 ${diskSize} 字节（${this.file}）。verify() 可定位被动的行。`,
        );
      }
      state = { seq: 0, lastHash: 'GENESIS', size: diskSize, written: false };
      SHARED_LEDGER_STATE.set(this.file, state);
    }
    this.state = state;
    this._recover();
  }

  /** 进程内共享基准的只读视图（兼容旧代码对实例属性的读取）。 */
  get seq() { return this.state.seq; }

  get lastHash() { return this.state.lastHash; }

  get size() { return this.state.size; }

  _recover() {
    if (!REAL_EXISTS_SYNC(this.file)) return;
    const statBefore = REAL_STAT_SYNC(this.file);
    if (statBefore.size === 0) return;
    // N5：构造器只需要「从哪条完整行之后续写」，不需要全部历史——只读
    // 文件尾部窗口（默认 64KB），账本越长省得越多。窗口里找不到任何换行
    // 就翻倍再读（单行超长的极端账本），封顶 4MB。seq 单调递增，最后一条
    // 完整行必然是最大 seq；被篡改的历史由 verify() 负责精确报告。
    // 必须用 openSync + readSync + closeSync：readFileSync 在 bridge 补丁表里
    //（宿主进程内构造新实例会经自身守卫），readSync 与 open/write/close
    // 同级，不属于被包装的原语。
    let windowBytes = 64 * 1024;
    let buf = null;
    let start = 0;
    for (;;) {
      start = Math.max(0, statBefore.size - windowBytes);
      const len = statBefore.size - start;
      buf = Buffer.alloc(len);
      const fd = REAL_OPEN_SYNC(this.file, 'r');
      try {
        let readTotal = 0;
        while (readTotal < len) {
          const n = REAL_READ_SYNC(fd, buf, readTotal, len - readTotal, start + readTotal);
          if (n <= 0) break;
          readTotal += n;
        }
      } finally {
        REAL_CLOSE_SYNC(fd);
      }
      if (start === 0 || buf.includes(0x0a) || windowBytes >= 4 * 1024 * 1024) break;
      windowBytes *= 2;
    }
    // 半行恢复（H6）：宿主崩溃会让最后一行只剩半截（没有换行结尾）。
    // 直接续写会把残骸和新行焊成一段坏 JSON，seq 也对不上；截到最后一个
    // 换行再落盘，哈希链从最后一条完整行无损续写。换行字节（0x0a）不会
    // 出现在 UTF-8 多字节序列内部，缓冲区级 lastIndexOf(0x0a) 即字节级
    // 截断点；truncate 的参数是字节数，直接用窗口内偏移换算绝对字节位。
    const raw = buf.toString('utf8');
    let tailText = raw;
    if (raw.charCodeAt(raw.length - 1) !== 0x0a) {
      const newlineIndex = buf.lastIndexOf(0x0a);
      // B1：整个文件连一个换行都没有时，「截到最后一个换行」等于把账本清零。
      // 清零不可接受——拒绝打开，让宿主显式处置（人工取证或删除重建），
      // 而不是在构造器里静默销毁审计记录。
      if (newlineIndex === -1) {
        throw new Error(
          `账本损坏：${this.file} 只有残缺的半行（无任何完整记录），已拒绝打开以避免整文件清零。请人工确认后删除或归档该文件`,
        );
      }
      // N1：truncate 前后各取样一次 size+mtime。两次取样之间磁盘变了，
      // 说明有写入者正在写这半行——此时截断等于「修复动作自己在删别人的
      // 数据」，宁可拒绝打开，让宿主先停掉另一个写入者。
      const keep = start + newlineIndex + 1;
      const afterRead = REAL_STAT_SYNC(this.file);
      if (afterRead.size !== statBefore.size
        || afterRead.mtime.getTime() !== statBefore.mtime.getTime()) {
        throw new Error(
          `账本 ${this.file} 尾部存在活动写入（读取期间 size/mtime 发生变化），`
          + '已拒绝截断半行：先停掉其他写入者进程，或使用分实例账本路径',
        );
      }
      const fd = REAL_OPEN_SYNC(this.file, 'r+');
      try {
        REAL_TRUNCATE_SYNC(fd, keep);
        REAL_FSYNC_SYNC(fd);
      } finally {
        REAL_CLOSE_SYNC(fd);
      }
      this.state.size = keep;
      tailText = raw.slice(0, newlineIndex + 1);
    }
    const lines = tailText.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (Number.isInteger(parsed.seq) && parsed.seq > this.state.seq && typeof parsed.hash === 'string') {
          this.state.seq = parsed.seq;
          this.state.lastHash = parsed.hash;
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
    const seq = this.state.seq + 1;
    const entry = buildRecord(record, seq, this.state.lastHash, record.ts || this.now(), this.macKey);
    const payload = Buffer.from(`${stableStringify(entry)}\n`, 'utf8');
    const fd = REAL_OPEN_SYNC(this.file, 'a');
    let expected = null;
    let concurrent = false;
    try {
      const actual = REAL_FSTAT_SYNC(fd).size;
      // state.size === null 表示「上一次写失败、真实大小未知」：以磁盘为准重新对齐，
      // 而不是把磁盘故障当成并发写入报出去。
      if (this.state.size !== null && actual !== this.state.size) {
        concurrent = true;
        throw new Error(
          `检测到并发写入：账本期望 ${this.state.size} 字节，实际 ${actual} 字节。Ledger 只支持单写者`,
        );
      }
      this.state.size = actual;
      let offset = 0;
      while (offset < payload.length) {
        offset += REAL_WRITE_SYNC(fd, payload, offset, payload.length - offset);
      }
      expected = actual + payload.length;
    } catch (error) {
      // 部分写入（磁盘满等）会让文件尾部残留半行：直接把基准对齐到当前大小，
      // 下一次 append 就会把残骸和新行焊成坏 JSON（H6）。写入起点是 state.size，
      // 截回它即恢复到最后一条完整行的结尾——seq/lastHash 尚未推进，链可无损续写。
      // "检测到并发"这条不能对齐——那等于接受别人写的字节，下一次 append 就会接在它后面。
      if (!concurrent) {
        try {
          const actualNow = REAL_FSTAT_SYNC(fd).size;
          if (actualNow > this.state.size) {
            REAL_TRUNCATE_SYNC(fd, this.state.size);
            REAL_FSYNC_SYNC(fd);
          }
        } catch {
          this.state.size = null;
        }
      }
      throw error;
    } finally {
      REAL_CLOSE_SYNC(fd);
    }
    this.state.seq = seq;
    this.state.lastHash = entry.hash;
    this.state.size = expected;
    this.state.written = true;
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

  /**
   * N5：轮转当前段——现有账本改名归档，本路径重新从 GENESIS 开始。
   * 前提是当前段完整可验：验不过就拒绝轮转（封存坏账是人工决定，
   * 不是程序决定）。返回归档摘要（首尾 hash、行数、归档路径），调用方
   * 负责在新段里落一条 segment-rotate 链接记录——账本没有 plugin 身份，
   * 不替任何人签名。
   */
  rotate() {
    const report = this.verify({});
    if (!report.ok) {
      throw new Error(
        `账本存在 ${report.errors.length} 处校验失败，拒绝轮转：先人工取证（verify-ledger），再决定归档或删除`,
      );
    }
    const records = this.records();
    if (records.length === 0) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivedPath = `${String(this.file).replace(/\.jsonl$/i, '')}.${stamp}.jsonl`;
    REAL_RENAME_SYNC(this.file, archivedPath);
    // 归档后本路径重开：重置共享基准，下一个 append 从 GENESIS 起链。
    // 共享状态按路径键控，这里整体换新，避免残留旧段的 seq/size/lastHash。
    const fresh = { seq: 0, lastHash: 'GENESIS', size: 0, written: false };
    SHARED_LEDGER_STATE.set(this.file, fresh);
    this.state = fresh;
    return {
      archivedPath,
      records: records.length,
      lastSeq: records[records.length - 1].seq,
      firstHash: records[0].hash,
      lastHash: records[records.length - 1].hash,
    };
  }

  /**
   * 逐行校验哈希链与 mac。
   *
   * @param {{anchor?: {count:number, head:string, mac:string}}} options
   *   传入外部锚点时额外检测「尾部被截断 / 追加」——纯哈希链发现不了这一类。
   */
  verify({ anchor = null } = {}) {
    // B1：账本不存在不能默认成「空账本=验证通过」——ok:true 会把「从未记账」
    // 与「记账且完好」混为一谈，宿主据此放行等于 fail-open。缺文件明确报错。
    if (!REAL_EXISTS_SYNC(this.file)) {
      return {
        ok: false,
        count: 0,
        head: 'GENESIS',
        errors: [{ line: 0, code: 'ledger_missing', detail: `账本文件不存在（${this.file}）：没有可验证的审计记录` }],
      };
    }
    const lines = REAL_READ_FILE_SYNC(this.file, 'utf8').split(/\r?\n/).filter(Boolean);
    let expectedPrev = 'GENESIS';
    const errors = [];
    // 是否已经出现过带 mac 的行。出现之后再冒出低版本行，就是「降版本绕过 mac」。
    // 判据是 mac 字段本身而非版本号：v4 无密钥时同样没有 mac，不能凭 v>=3
    // 就要求密钥——那会把无密钥的 v4 账本误报成 mac_key_missing。
    let sawMacRecord = false;

    lines.forEach((line, index) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errors.push({ line: index + 1, code: 'json_invalid', detail: error.message });
        return;
      }
      const version = recordVersion(parsed);
      if (sawMacRecord && version < 3) {
        errors.push({
          line: index + 1,
          code: 'version_downgrade',
          detail: '带 mac 的记录之后出现低版本行：疑似降版本以绕过 mac',
        });
      }
      if (parsed && typeof parsed.mac === 'string') sawMacRecord = true;
      const result = verifyLine(parsed, index + 1, expectedPrev, this.macKey);
      if (!result.ok) {
        for (const error of result.errors) errors.push({ line: index + 1, ...error });
      }
      if (parsed && parsed.hash) expectedPrev = parsed.hash;
    });

    // 账本自称 v3（有 mac 字段）却没给密钥：这时 mac 根本没被校验过，
    // 不能让 verify 返回 ok 造成「已验签」的错觉。
    if (sawMacRecord && !this.macKey) {
      errors.push({
        line: 0,
        code: 'mac_key_missing',
        detail: '账本包含带 mac 的记录，但未提供 macKey：mac 未被校验，不能当作完整审计',
      });
    }

    const head = lastHashOf(lines);
    if (anchor) {
      if (!this.macKey) {
        errors.push({
          line: 0,
          code: 'mac_key_missing',
          detail: '校验外部锚点需要 macKey：没有密钥的 head 谁都能算',
        });
      } else if (typeof anchor.mac !== 'string') {
        errors.push({ line: 0, code: 'anchor_invalid', detail: '锚点缺少 mac' });
      } else if (!safeEqualHex(hmacSha256(this.macKey, `${anchor.count}:${anchor.head}`), anchor.mac)) {
        errors.push({ line: 0, code: 'anchor_mac_mismatch', detail: '锚点 mac 不匹配：不是本密钥签发的锚点' });
      } else if (Number(anchor.count) !== lines.length) {
        errors.push({
          line: 0,
          code: 'anchor_count_mismatch',
          detail: `锚点记录 ${anchor.count} 行，实际 ${lines.length} 行（尾部被截断或追加）`,
        });
      } else if (anchor.head !== head) {
        errors.push({ line: 0, code: 'anchor_head_mismatch', detail: '锚点 head 与实际末行不一致' });
      }
    }

    return {
      ok: errors.length === 0,
      count: lines.length,
      head,
      errors,
    };
  }

  /**
   * 产出可外发的锚点：记录数 + 末行 hash + 两者被密钥签过的 mac。
   *
   * 为什么必须有：哈希链能发现「改中间行」，但发现不了「砍掉尾巴」——
   * 剩下的前缀依然是一条自洽的链。只有把锚点存到账本之外（另一台机器、
   * 另一个文件、日志系统），截断才会暴露。没有 macKey 时返回 null：
   * 无密钥的 head 谁都能算，拿它当锚点等于没锚。
   */
  anchor() {
    if (!this.macKey) return null;
    const lines = REAL_EXISTS_SYNC(this.file)
      ? REAL_READ_FILE_SYNC(this.file, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
    const head = lastHashOf(lines);
    const count = lines.length;
    return { count, head, mac: hmacSha256(this.macKey, `${count}:${head}`) };
  }
}

module.exports = {
  Ledger,
  FIELDS,
  FIELDS_V1,
  FIELDS_V2,
  FIELDS_V3,
  FIELDS_V4,
  FIELDS_V4_MAC,
  verifyLine,
  recordVersion,
  hmacSha256,
  safeEqualHex,
};
