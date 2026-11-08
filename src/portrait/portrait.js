'use strict';

const { CAPABILITY_GROUPS, HIGH_RISK_CAPABILITIES, groupOf } = require('../contract/capabilities');
const { isQuarantined } = require('../contract/manifest');

const CAVEAT = '未扫到 ≠ 安全：静态扫描无法覆盖动态 require、原生模块与运行时生成代码。';

function emptyCounts() {
  return Object.fromEntries(Object.keys(CAPABILITY_GROUPS).map((group) => [group, 0]));
}

function collectItems(manifest, scan) {
  const requests = (manifest && manifest.dashcam && manifest.dashcam.requests) || [];
  const items = requests.map((request) => ({
    capability: request.capability,
    group: groupOf(request.capability),
    reason: request.reason,
    highRisk: HIGH_RISK_CAPABILITIES.has(request.capability),
    checked: false,
    source: 'manifest',
  }));
  // 数据源 = manifest 请求 + 安全门禁扫描结果。扫描到但未声明的能力同样要
  // 展示出来，否则“少声明”就能把高风险项藏起来。
  const seen = new Set(items.map((item) => item.capability));
  for (const finding of (scan && scan.findings) || []) {
    if (seen.has(finding.capability)) continue;
    seen.add(finding.capability);
    items.push({
      capability: finding.capability,
      group: groupOf(finding.capability),
      reason: `扫描发现：${finding.file}:${finding.line}`,
      highRisk: HIGH_RISK_CAPABILITIES.has(finding.capability),
      checked: false,
      source: 'scan',
    });
  }
  return items;
}

function chooseTier(items, scan) {
  if (items.some((item) => item.highRisk) || (scan && scan.manualReviewRequired)) return 'high';
  if (items.length > 4 || items.some((item) => item.capability === 'net.outbound' || item.capability === 'net.listen')) {
    return 'medium';
  }
  return 'low';
}

/**
 * 画像卡：首屏只给分组数量与高风险项数，避免用户被细节淹没；
 * 任何高风险项必须红显并强制确认。
 */
function buildPortrait({ manifest, scan = null, rejection = null, labels = [] } = {}) {
  const items = collectItems(manifest, scan);
  const groupCounts = emptyCounts();
  for (const item of items) groupCounts[item.group] += 1;
  const highRiskItems = items.filter((item) => item.highRisk);
  const tier = chooseTier(items, scan);
  const securityLabels = [...new Set((labels || []).map((item) => item.label).filter(Boolean))];

  const groups = Object.keys(CAPABILITY_GROUPS)
    .map((group) => ({
      group,
      count: groupCounts[group],
      items: items.filter((item) => item.group === group),
    }))
    .filter((group) => group.count > 0);

  return {
    plugin: manifest ? manifest.id : null,
    tier,
    // 隔离档统一按 contract/manifest 的 isQuarantined 判定，避免两套写法漂移。
    quarantine: isQuarantined(manifest),
    securityLabels,
    labels: labels || [],
    firstScreen: {
      groupCounts,
      groupCount: groups.length,
      highRiskCount: highRiskItems.length,
      labelCount: securityLabels.length,
      caveat: CAVEAT,
    },
    groups,
    highRiskItems,
    items,
    rejectionReason: rejection && rejection.reason ? rejection.reason : null,
    manualReviewRequired: Boolean(scan && scan.manualReviewRequired),
  };
}

function renderPortrait(portrait) {
  const lines = [];
  const groupText = Object.entries(portrait.firstScreen.groupCounts)
    .filter(([, count]) => count > 0)
    .map(([group, count]) => `${group}×${count}`)
    .join('  ');
  lines.push(`能力画像：${groupText || '无声明'}`);
  lines.push(`高风险项：${portrait.firstScreen.highRiskCount}`);
  if (portrait.securityLabels && portrait.securityLabels.length > 0) {
    lines.push(`安全标签：${portrait.securityLabels.join(' / ')}`);
  }
  if (portrait.quarantine) {
    lines.push('隔离档：无 dashcam 声明，运行时 deny-all');
  }
  lines.push(portrait.firstScreen.caveat);
  lines.push('');

  if (portrait.tier === 'low') {
    lines.push(`低风险：已折叠 ${portrait.items.length} 项`);
  } else {
    for (const group of portrait.groups) {
      lines.push(`[${group.group}]`);
      for (const item of group.items) {
        if (portrait.tier === 'high' && item.highRisk) {
          lines.push(`  [!] ${item.capability} — ${item.reason}（需强制确认）`);
        } else {
          lines.push(`  [ ] ${item.capability} — ${item.reason}`);
        }
      }
    }
  }

  if (portrait.rejectionReason) {
    lines.push('');
    lines.push(`拒绝原因：${portrait.rejectionReason}`);
  }
  return lines.join('\n');
}

module.exports = { buildPortrait, renderPortrait, CAVEAT };
