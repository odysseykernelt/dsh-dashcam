'use strict';

/**
 * One-Seal：一次性 grant 的存放与清扫。
 *
 * 生命周期：issue → available → reserve → reserved → commit → 删除
 *                            └──────── release ←──────┘
 *
 * 为什么不是「授权后直接 consume」：Ledger 写失败按 fail-closed 拒绝执行，
 * 若先 consume 再写审计，一次磁盘抖动就会永久烧掉一次性授权——安全上没损失，
 * 可用性上是错误的损失。所以拆成两阶段。
 */
class OneSealStore {
  constructor({ ttlMs = 60_000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.seals = new Map();
    this.timer = null;
    this.swept = 0;
  }

  issue(grant) {
    if (!grant || grant.oneSeal !== true) {
      throw new Error('OneSealStore.issue 只接受 oneSeal=true 的 grant');
    }
    const issuedAt = this.now();
    const ttl = Number.isFinite(grant.sealTtlMs) && grant.sealTtlMs > 0 ? grant.sealTtlMs : this.ttlMs;
    const expiresAt = Math.min(grant.expiresAt || Number.MAX_SAFE_INTEGER, issuedAt + ttl);
    const entry = {
      grantId: grant.id,
      issuedAt,
      expiresAt,
      state: 'available',
      reservedAt: null,
    };
    this.seals.set(grant.id, entry);
    return { ...entry };
  }

  isAvailable(grantId, at = this.now()) {
    const entry = this.seals.get(grantId);
    if (!entry) return false;
    if (entry.state !== 'available') return false;
    return entry.expiresAt > at;
  }

  /** 占位：返回后必须 commit 或 release，否则等 sweep 过期回收。 */
  reserve(grantId, at = this.now()) {
    const entry = this.seals.get(grantId);
    if (!entry) throw sealError(`一次性 grant 不存在或已使用：${grantId}`);
    if (entry.state === 'reserved') throw sealError(`一次性 grant 正在执行中：${grantId}`);
    if (entry.state !== 'available' || entry.expiresAt <= at) {
      this.seals.delete(grantId);
      throw sealError(`一次性 grant 已过期或已使用：${grantId}`);
    }
    entry.state = 'reserved';
    entry.reservedAt = at;
    return { ...entry };
  }

  /** 落账成功后提交：删除条目，第二次必然失败。 */
  commit(grantId) {
    const entry = this.seals.get(grantId);
    if (!entry || entry.state !== 'reserved') {
      throw sealError(`一次性 grant 未处于 reserved 状态：${grantId}`);
    }
    this.seals.delete(grantId);
    return { ...entry };
  }

  /** 落账失败后释放：回到 available，不算用掉。 */
  release(grantId) {
    const entry = this.seals.get(grantId);
    if (!entry || entry.state !== 'reserved') return null;
    entry.state = 'available';
    entry.reservedAt = null;
    return { ...entry };
  }

  /** 兼容旧接口：reserve + commit。 */
  consume(grantId, at = this.now()) {
    this.reserve(grantId, at);
    return this.commit(grantId);
  }

  sweep(at = this.now()) {
    let removed = 0;
    for (const [grantId, entry] of this.seals.entries()) {
      if (entry.expiresAt <= at) {
        this.seals.delete(grantId);
        removed += 1;
      }
    }
    this.swept += removed;
    return removed;
  }

  startAutoSweep(intervalMs = 30_000) {
    this.stop();
    this.timer = setInterval(() => this.sweep(), intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  size() {
    return this.seals.size;
  }
}

function sealError(message) {
  const error = new Error(message);
  error.code = 'ONE_SEAL_EXHAUSTED';
  return error;
}

module.exports = { OneSealStore };
