'use strict';

const nodePath = require('node:path');
const { credentialCapabilityForPath } = require('../contract/capabilities');

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

/**
 * 把观测目标折叠成建议 scope：
 * - fs 读/写：折叠到目录（观测到哪个目录就建议哪个目录，不发明通配）；
 * - 凭证路径：经 credentialCapabilityForPath 升级为 cred.*，保留精确目标
 *   （凭证范围的放大必须由人来决定，工具不代劳）；
 * - fs.delete：保留精确路径——删除能力按目录授权等于把整个目录交给人家删；
 * - net：原样（观测到什么 host 写什么）；
 * - proc：取命令首词（commandCovers 本来就允许按基名授权）。
 */
function draftScopeFor(capability, targets) {
  if (capability === 'net.outbound') return { hosts: [...new Set(targets)] };
  if (capability === 'proc.spawn') {
    const words = targets.map((command) => String(command).trim().split(/\s+/)[0]).filter(Boolean);
    return { commands: [...new Set(words)] };
  }
  if (capability === 'fs.delete' || capability.startsWith('cred.')) {
    return capability.startsWith('cred.') ? { targets: [...new Set(targets)] } : { paths: [...new Set(targets)] };
  }
  const directories = [...new Set(targets.map((target) => nodePath.dirname(target)))];
  return { paths: directories };
}

/**
 * 声明草案（批次四）：给想从零契约升 enforce 的人。行车记录仪先跑一段，
 * 账本里已经有了「它实际用了什么」，这份草案把观测结果反推成
 * manifest.dashcam.requests / 宿主 config.requests 的形状——人改两行就能迁移，
 * 而不是从对着能力表凭空写。
 *
 * 诚实的边界写进输出里：草案只覆盖观测到的用法，没跑过的路径不会出现；
 * 它是建议，不是判定——入 manifest 前需人工收敛。
 *
 * @param {Array} records 账本记录（已验链的 Ledger.records() 产物）。
 * @param {{manifest?: object}} options 传入现有 manifest 时，已声明的精确能力
 *   不再重复建议（避免把已经在契约里的东西又推荐一遍）。
 */
function buildDeclarationDraft(records = [], { manifest = null } = {}) {
  const report = buildBehaviorReport(records, { manifest });
  // 覆盖判定按精确能力（fs.read ≠ fs.delete）：家族级会把「声明了 fs.read」
  // 放大成「fs 全家已声明」，删除这种高风险能力就被顺手盖掉了。
  const declaredCapabilities = new Set();
  for (const request of declaredRequestsOf(manifest)) {
    if (request && request.capability) declaredCapabilities.add(String(request.capability));
  }

  const plugins = report.plugins.map((section) => {
    const covered = section.plugin === (manifest && manifest.id)
      ? [...declaredCapabilities].sort()
      : [];
    const isCovered = (capability) => covered.includes(capability);
    const requests = [];
    const pushDraft = (baseCapability, targets) => {
      if (targets.length === 0) return;
      // 同一批观测目标按最终能力（fs/cred）分组：凭证路径单独授权是硬规则，
      // 草案里就要体现这个分组，而不是让人合并成一条 fs.read。
      const groups = new Map();
      for (const target of targets) {
        const capability = credentialCapabilityForPath(target, baseCapability);
        if (!groups.has(capability)) groups.set(capability, []);
        groups.get(capability).push(target);
      }
      for (const [capability, groupTargets] of groups) {
        // 已声明的精确能力不再建议；没声明的（含凭证升级出的 cred.*）仍要给出。
        if (isCovered(capability)) continue;
        requests.push({
          capability,
          scope: draftScopeFor(capability, groupTargets),
          reason: `由账本观测反推：${groupTargets.length} 个不同目标（示例：${String(groupTargets[0]).slice(0, 120)}）；需人工收敛`,
        });
      }
    };
    pushDraft('fs.read', section.observed.fsRead);
    pushDraft('fs.write', section.observed.fsWrite);
    pushDraft('fs.delete', section.observed.fsDelete);
    pushDraft('net.outbound', section.observed.hosts);
    pushDraft('proc.spawn', section.observed.commands);
    return {
      plugin: section.plugin,
      activity: section.activity.total,
      // 零契约（profiled=false）的插件才是草案的目标用户；已有契约的如实说明。
      zeroContract: section.contract.zeroContract,
      requests,
      coveredByManifest: covered,
    };
  });

  return {
    generatedFrom: 'ledger',
    note: '建议声明由账本行为反推，仅覆盖观测到的用法——没跑过的路径不会出现在这里。'
      + '这是建议不是判定，入 manifest / 宿主 config.requests 前需人工收敛。',
    plugins,
  };
}

module.exports = { buildBehaviorReport, buildDeclarationDraft };
