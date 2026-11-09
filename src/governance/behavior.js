'use strict';

// 行为画像报告（批次三·取证产物）：行车记录仪的产物是「实际做了什么」。
// 这份报告把账本记录按插件聚合——实际读过的路径、连过的主机、跑过的命令——
// 并在拿到声明清单（manifest）时给出「实际 vs 声明」的能力级 diff。
// 它只读账本，不碰文件系统：实际行为以账本为准，账本没记的这里不编。

function asList(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
  return [];
}

function newPluginEntry(plugin) {
  return {
    plugin,
    pluginVersion: null,
    manifestHash: null,
    // 出厂即零契约：只有见到 profiled=true 的记录才翻面。
    zeroContract: true,
    total: 0,
    allow: 0,
    deny: 0,
    intercepted: 0,
    firstTs: null,
    lastTs: null,
    capabilities: new Set(),
    fsRead: new Set(),
    fsWrite: new Set(),
    fsDelete: new Set(),
    hosts: new Set(),
    commands: new Set(),
  };
}

function declaredRequestsOf(manifest) {
  if (!manifest || !manifest.dashcam) return [];
  return manifest.dashcam.requests
    || (manifest.dashcam.capabilities && manifest.dashcam.capabilities.requests)
    || [];
}

/**
 * @param {Array} records 账本记录（已验链的 Ledger.records() 产物）。
 * @param {{manifest?: object}} options 传入插件 manifest 时输出 declarationDiff。
 *   注意 diff 是能力级的——scope 级「声明了哪条路径」的精确匹配是 Two-Key
 *   判定的事，这里只回答「实际用了哪些没声明的能力类别」。
 */
function buildBehaviorReport(records = [], { manifest = null } = {}) {
  const byPlugin = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const plugin = record.plugin || 'unknown';
    let entry = byPlugin.get(plugin);
    if (!entry) {
      entry = newPluginEntry(plugin);
      byPlugin.set(plugin, entry);
    }
    entry.total += 1;
    if (record.decision === 'allow') entry.allow += 1;
    else if (record.decision === 'deny') entry.deny += 1;
    if (record.intercepted === true) entry.intercepted += 1;
    if (record.profiled === true) entry.zeroContract = false;
    if (typeof record.manifestHash === 'string') entry.manifestHash = record.manifestHash;
    if (record.pluginVersion) entry.pluginVersion = record.pluginVersion;
    if (record.ts) {
      if (entry.firstTs === null || record.ts < entry.firstTs) entry.firstTs = record.ts;
      if (entry.lastTs === null || record.ts > entry.lastTs) entry.lastTs = record.ts;
    }
    if (record.capability && record.capability !== 'telemetry') {
      entry.capabilities.add(record.capability);
    }
    const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
    const action = String(record.action || '');
    for (const target of [...asList(scope.path), ...asList(scope.paths)]) {
      if (action.startsWith('fs.write')) entry.fsWrite.add(target);
      else if (action.startsWith('fs.delete')) entry.fsDelete.add(target);
      else if (action.startsWith('fs.')) entry.fsRead.add(target);
    }
    for (const host of [...asList(scope.host), ...asList(scope.hosts)]) entry.hosts.add(host);
    for (const command of [...asList(scope.command), ...asList(scope.commands)]) entry.commands.add(command);
  }

  // 声明 diff（家族级）：账本记录的 capability 是能力家族（fs/proc/net），
  // manifest 声明的是具体能力（fs.read/fs.write）——两边都折到「.」前的
  // 家族名再比。scope 级「声明了哪条路径」的精确匹配是 Two-Key 判定的事，
  // 这里只回答「实际用了哪些没声明的家族」。
  const declaredFamilies = new Set();
  for (const request of declaredRequestsOf(manifest)) {
    if (request && request.capability) {
      declaredFamilies.add(String(request.capability).split('.')[0]);
    }
  }

  const plugins = [...byPlugin.values()].map((entry) => {
    const sorted = (set) => [...set].sort();
    const actual = sorted(entry.capabilities);
    const section = {
      plugin: entry.plugin,
      pluginVersion: entry.pluginVersion,
      contract: {
        profiled: !entry.zeroContract,
        zeroContract: entry.zeroContract,
        manifestHash: entry.manifestHash,
      },
      activity: {
        total: entry.total,
        allow: entry.allow,
        deny: entry.deny,
        intercepted: entry.intercepted,
        firstTs: entry.firstTs,
        lastTs: entry.lastTs,
      },
      capabilities: actual,
      observed: {
        fsRead: sorted(entry.fsRead),
        fsWrite: sorted(entry.fsWrite),
        fsDelete: sorted(entry.fsDelete),
        hosts: sorted(entry.hosts),
        commands: sorted(entry.commands),
      },
    };
    if (manifest) {
      section.declarationDiff = {
        declared: [...declaredFamilies].sort(),
        undeclared: actual.filter((capability) => !declaredFamilies.has(capability)),
        declaredNotObserved: [...declaredFamilies].filter((family) => !actual.includes(family)).sort(),
      };
    }
    return section;
  });
  return { generatedFor: manifest ? (manifest.id || null) : null, plugins };
}

module.exports = { buildBehaviorReport };
