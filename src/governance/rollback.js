'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = ['rule', 'module', 'contract'];

/**
 * 三级回滚：规则级（单条检测规则）、模块级（某个能力模块/守卫）、
 * 契约级（插件回到上一份签名契约）。每次变更前快照，回滚取上一版。
 */
class RollbackManager {
  constructor({ file = null } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.snapshots = new Map();
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [key, value] of Object.entries(raw.snapshots || {})) this.snapshots.set(key, value);
      } catch {
        // 损坏的快照文件不阻断启动，按空历史处理。
      }
    }
  }

  _key(level, key) {
    if (!LEVELS.includes(level)) throw new Error(`未知回滚层级：${level}`);
    if (!key) throw new Error('回滚 key 不能为空');
    return `${level}:${key}`;
  }

  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const snapshots = Object.fromEntries(this.snapshots.entries());
    fs.writeFileSync(this.file, JSON.stringify({ snapshots }, null, 2), 'utf8');
  }

  snapshot({ level, key, value, meta = null }) {
    const storageKey = this._key(level, key);
    const history = this.snapshots.get(storageKey) || [];
    history.push({ value: JSON.parse(JSON.stringify(value === undefined ? null : value)), meta, at: new Date().toISOString() });
    this.snapshots.set(storageKey, history);
    this._persist();
    return history.length - 1;
  }

  current(level, key) {
    const history = this.snapshots.get(this._key(level, key)) || [];
    return history.length ? history[history.length - 1].value : null;
  }

  history(level, key) {
    return this.snapshots.get(this._key(level, key)) || [];
  }

  rollback({ level, key }) {
    const history = this.snapshots.get(this._key(level, key)) || [];
    if (history.length < 2) return null;
    history.pop();
    this._persist();
    return history[history.length - 1].value;
  }
}

module.exports = { RollbackManager, LEVELS };
