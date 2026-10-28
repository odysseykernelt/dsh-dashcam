'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 应急黑名单：独立文件、独立通道，不依赖签名、不等待门禁结果。
 * 只要 plugin id 命中且未过期，安装与运行一律拒绝。
 */
class Blacklist {
  constructor({ file = null, entries = [] } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.entries = [];
    if (this.file && fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.entries = Array.isArray(raw.entries) ? raw.entries : [];
      } catch {
        this.entries = [];
      }
    }
    this.entries.push(...entries);
  }

  _persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ entries: this.entries }, null, 2), 'utf8');
  }

  add(plugin, { reason = '', until = null, addedBy = 'operator' } = {}) {
    if (!plugin) throw new Error('黑名单 plugin 不能为空');
    const existing = this.entries.find((entry) => entry.plugin === plugin);
    const entry = {
      plugin,
      reason,
      until,
      addedBy,
      addedAt: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, entry);
    else this.entries.push(entry);
    this._persist();
    return entry;
  }

  remove(plugin) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.plugin !== plugin);
    this._persist();
    return this.entries.length !== before;
  }

  isBlocked(plugin, now = Date.now()) {
    const entry = this.entries.find((item) => item.plugin === plugin);
    if (!entry) return false;
    if (entry.until === null || entry.until === undefined) return true;
    return new Date(entry.until).getTime() > now;
  }

  list(now = Date.now()) {
    return this.entries.filter((entry) => entry.until === null || entry.until === undefined || new Date(entry.until).getTime() > now);
  }
}

module.exports = { Blacklist };
