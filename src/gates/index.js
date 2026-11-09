'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gateError } = require('../errors');
const { loadPolicy } = require('../policy');
const { validateCharter, evaluateAdmission } = require('../contract/charter');
const { isQuarantined } = require('../contract/manifest');
const { verifyBundle } = require('../signing/bundle');
const { createStage, addLabel, finishStage, buildReport } = require('./report');
const { checkStructure } = require('./structure');
const { checkSafety } = require('./safety');
const { checkLoadability } = require('./loadability');

/**
 * 只有“恶意脚本/越界写入”类问题才阻断安装。
 * 其余问题（未签名、缺 Charter、静态扫描异常、装不起来）一律降级为安全画像标签。
 */
const MALICIOUS_CODES = new Set([
  'patch_path_outside',
  'patch_target_outside',
  'patch_extension_invalid',
  'lifecycle_script_rejected',
  'script_not_allowlisted',
  'install_script_not_allowlisted',
  'entry_outside_plugin',
]);

function readRawPluginId(pluginDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8'));
    return typeof raw.id === 'string' ? raw.id : null;
  } catch {
    return null;
  }
}

/**
 * 安装流水线（非侵入式）：
 * 应急黑名单（独立通道，仍然阻断）→ 验签 → 结构 → 契约/Charter → Sieve → 安全 → 可装载性。
 * 除黑名单与恶意脚本外，所有阶段都继续执行并输出画像标签，不再短路拒装。
 * 企业通道或显式 enforcement.mode=required 时保留阻断语义。
 */
async function runInstallPipeline({
  pluginDir,
  channel = 'consumer',
  policy: policyInput = {},
  trust = null,
  blacklist = null,
  host = null,
  pluginId = null,
  invocation = 'ping',
  expectedInvocation,
  skipSignature = false,
  contractProbe = null,
  logger = null,
} = {}) {
  const policy = loadPolicy(policyInput, { pluginRoot: path.resolve(pluginDir) });
  const strict = channel === 'enterprise' || (policy.enforcement && policy.enforcement.mode === 'required');
  const stages = [];
  const rawId = readRawPluginId(pluginDir);

  // 应急下架是独立黑名单通道：它是唯一“与契约无关”的硬阻断。
  const blacklistStage = createStage('blacklist');
  if (blacklist && rawId && blacklist.isBlocked(rawId)) {
    blacklistStage.errors.push(gateError('blacklist', 'blacklisted', `插件 ${rawId} 在应急黑名单中`, {
      field: 'id',
      file: 'manifest.json',
    }));
  }
  stages.push(finishStage(blacklistStage));
  if (blacklistStage.errors.length > 0) {
    const report = buildReport({ plugin: rawId, channel, stages });
    return { ...report, manifest: null, scan: null, signature: null, phases: null, contractChecked: false };
  }

  // 验签：默认只输出 Untrusted 标签，不阻断；strict 模式才拒装。
  let signatureResult = null;
  const signatureStage = createStage('signature');
  if (!skipSignature) {
    if (!trust) {
      const missing = gateError('signature', 'trust_missing', '未提供信任表，无法验签', { field: 'trust' });
      addLabel(signatureStage, {
        code: missing.code, label: 'Untrusted', reason: missing.message, field: 'trust',
      });
      if (strict) signatureStage.errors.push(missing);
    } else {
      signatureResult = verifyBundle({ pluginDir, trust });
      if (signatureResult.ok) {
        addLabel(signatureStage, { code: 'signature_verified', label: 'Verified', reason: '发布者与审核者签名均已验证' });
      } else {
        for (const error of signatureResult.errors) {
          const item = {
            gate: 'signature',
            code: error.code,
            message: error.message,
            field: error.field || null,
            file: error.file || null,
            line: error.line || null,
            phase: error.stage,
          };
          addLabel(signatureStage, {
            code: error.code,
            label: 'Untrusted',
            reason: error.message,
            field: item.field,
            file: item.file,
            line: item.line,
            phase: item.phase,
          });
          if (strict) signatureStage.errors.push(item);
        }
      }
    }
  } else {
    signatureStage.status = 'skip';
    // N3：跳过验签 ≠ 验过不可信。两者结果都放行，但含义不同——
    // 「跳过」是调用方主动放弃核验，状态未知；「Untrusted」是核验了且没通过。
    // 混用同一个 label 会让 --skip-signature 替真问题背锅。
    addLabel(signatureStage, {
      code: 'signature_skipped', label: 'SignatureSkipped', reason: '调用方跳过验签，签名状态未知',
    });
  }
  stages.push(finishStage(signatureStage));

  // 结构门禁：恶意脚本类阻断，其余转标签继续。
  const structureResult = checkStructure(pluginDir, { policy });
  const structureStage = structureResult.stage;
  const malicious = structureStage.errors.filter((error) => MALICIOUS_CODES.has(error.code));
  const advisory = structureStage.errors.filter((error) => !MALICIOUS_CODES.has(error.code));
  structureStage.errors = malicious;
  for (const error of advisory) {
    addLabel(structureStage, {
      code: error.code,
      label: 'Broken',
      reason: error.message,
      field: error.field,
      file: error.file,
      line: error.line,
    });
  }
  stages.push(finishStage(structureStage));
  if (malicious.length > 0 || !structureResult.manifest) {
    if (logger) logger(malicious.length > 0 ? '结构门禁发现恶意脚本，阻断安装' : '结构门禁未能解析 manifest，仅输出标签');
    const report = buildReport({ plugin: rawId, channel, stages });
    return {
      ...report,
      manifest: structureResult.manifest,
      scan: null,
      signature: signatureResult,
      phases: null,
      contractChecked: false,
    };
  }
  const manifest = structureResult.manifest;

  // 契约与 Charter：缺字段在 strict 模式拒装，默认只打标签。
  const contractStage = createStage('contract');
  if (manifest.kind === 'dashcam') {
    const charterErrors = validateCharter(manifest.dashcam.content, { file: 'manifest.json' });
    for (const error of charterErrors) {
      const item = { ...error, gate: 'contract' };
      if (strict) contractStage.errors.push(item);
      addLabel(contractStage, {
        code: error.code,
        label: 'Untrusted',
        reason: error.message,
        field: error.field,
        file: error.file,
      });
    }
  }
  stages.push(finishStage(contractStage));
  if (typeof contractProbe === 'function') contractProbe(manifest);
  const contractChecked = true;

  // Sieve 准入：advisory 下每个拒绝原因都变成画像标签。
  const sieveStage = createStage('sieve');
  const admission = evaluateAdmission(manifest, { channel, policy });
  for (const reason of admission.reasons) {
    const item = gateError('sieve', reason.code, reason.reason, {
      field: reason.field,
      file: 'manifest.json',
    });
    if (strict) sieveStage.errors.push(item);
    addLabel(sieveStage, {
      code: reason.code,
      label: reason.code.startsWith('legacy') || manifest.quarantine ? 'Quarantined' : 'Untrusted',
      reason: reason.reason,
      field: reason.field,
      file: 'manifest.json',
    });
  }
  if (manifest.quarantine || (admission.charter && admission.admitted === false && manifest.kind === 'legacy')) {
    addLabel(sieveStage, {
      code: 'quarantined',
      label: 'Quarantined',
      reason: 'legacy / quarantine 插件：没有可核对的能力声明，运行时按 deny-all 隔离',
      field: 'dashcam',
      file: 'manifest.json',
    });
  }
  stages.push(finishStage(sieveStage));

  // 安全门禁：静态扫描结果一律作为 ReviewRequired 标签，不阻断。
  const safetyResult = checkSafety(pluginDir, { policy, manifest });
  const safetyStage = safetyResult.stage;
  for (const error of safetyStage.errors) {
    addLabel(safetyStage, {
      code: error.code,
      label: 'ReviewRequired',
      reason: error.message,
      field: error.field,
      file: error.file,
      line: error.line,
    });
  }
  if (safetyResult.scan && safetyResult.scan.manualReviewRequired
    && !safetyStage.errors.some((error) => error.code === 'credential_manual_review_required')) {
    addLabel(safetyStage, {
      code: 'manual_review_required',
      label: 'ReviewRequired',
      reason: '扫描发现需要人工复核的能力面',
    });
  }
  // M11（1.10.9）：不再清空 safetyStage.errors——此前错误转完标签就抹掉，
  // 报告里 stage.errors 空空如也（证据丢失），strict 模式的 blockedSoFar 也因此
  // 看不到安全门禁的阻断项。现在保留错误：报告可追溯，strict 模式下安全门禁
  // 有错即跳过 loadability（不执行未过审的插件代码）；advisory 模式行为不变
  // （只打标签不阻断，标签逻辑在上方循环里已经完成）。
  stages.push(finishStage(safetyStage));

  let phases = null;
  // strict 模式下，前置门禁只要有一条阻断，就不该再执行插件代码：
  // loadability 会真的 require + invoke，等于让没通过验签的包先跑起来。
  const blockedSoFar = stages.some((stage) => stage.errors && stage.errors.length > 0);
  if (host && strict && blockedSoFar) {
    const skippedStage = createStage('loadability');
    addLabel(skippedStage, {
      code: 'loadability_skipped',
      label: 'Broken',
      reason: '前置门禁未通过：跳过可装载性验证，不执行插件代码',
    });
    stages.push(finishStage(skippedStage));
  } else if (host) {
    const loadStage = createStage('loadability');
    if (host.enforcing && !host.trust && trust) host.trust = trust;
    const loadabilityResult = await checkLoadability({
      pluginDir,
      host,
      pluginId: pluginId || manifest.id,
      action: invocation,
      expected: expectedInvocation,
      policy,
    });
    phases = loadabilityResult.phases;
    for (const error of loadabilityResult.stage.errors) {
      addLabel(loadStage, {
        code: error.code,
        label: 'Broken',
        reason: error.message,
        field: error.field,
        file: error.file,
        line: error.line,
        phase: error.phase,
      });
    }
    loadStage.errors = [];
    stages.push(finishStage(loadStage));
  } else {
    const skipped = createStage('loadability');
    skipped.status = 'skip';
    stages.push(skipped);
  }

  const report = buildReport({ plugin: manifest.id, channel, stages });
  return {
    ...report,
    manifest,
    scan: safetyResult.scan,
    signature: signatureResult,
    phases,
    contractChecked,
    admission,
    quarantine: isQuarantined(manifest),
  };
}

module.exports = { runInstallPipeline, readRawPluginId, MALICIOUS_CODES };
