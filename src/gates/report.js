'use strict';

const { gateError } = require('../errors');

function createStage(name) {
  return { name, status: 'pending', errors: [], labels: [] };
}

/**
 * 非侵入式门禁：不通过安装来“惩罚”插件，而是输出安全画像标签。
 * label 是给用户看的分档（Untrusted / Quarantined / ReviewRequired / Broken / Verified），
 * code 保留原始判定码，便于追溯。
 */
function addLabel(stage, { code, label, reason, ...extra }) {
  stage.labels.push({ gate: stage.name, code, label, reason: reason || '', ...extra });
  return stage;
}

function finishStage(stage) {
  if (stage.status === 'skip') return stage;
  if (stage.errors.length > 0) stage.status = 'fail';
  else if (stage.labels.length > 0) stage.status = 'warn';
  else stage.status = 'pass';
  return stage;
}

function formatError(error) {
  const location = [error.file, error.line].filter((value) => value !== null && value !== undefined).join(':');
  const field = error.field ? ` field=${error.field}` : '';
  const phase = error.phase ? ` phase=${error.phase}` : '';
  return `[${error.gate}]${location ? ` ${location}` : ''}${field}${phase} — ${error.message}`;
}

function formatLabel(item) {
  const location = [item.file, item.line].filter((value) => value !== null && value !== undefined).join(':');
  const field = item.field ? ` field=${item.field}` : '';
  return `[${item.label}]${location ? ` ${location}` : ''}${field} — ${item.reason}`;
}

/** 报告统一入口：errors 只放阻断项，labels 放“可装但要提示”的画像标签。 */
function buildReport({ plugin = null, channel = 'consumer', stages = [], errors = [] } = {}) {
  const allErrors = [...errors];
  const allLabels = [];
  for (const stage of stages) {
    for (const error of stage.errors) allErrors.push({ gate: stage.name, ...error });
    for (const label of stage.labels || []) allLabels.push({ ...label });
  }
  return {
    ok: allErrors.length === 0,
    blocked: allErrors.length > 0,
    plugin,
    channel,
    stages: stages.map((stage) => ({
      name: stage.name,
      status: stage.status,
      errorCount: stage.errors.length,
      labelCount: (stage.labels || []).length,
      errors: stage.errors,
      labels: stage.labels || [],
    })),
    errors: allErrors,
    labels: allLabels,
    securityLabels: [...new Set(allLabels.map((item) => item.label))],
    formatted: allErrors.map(formatError),
    labelLines: allLabels.map(formatLabel),
  };
}

module.exports = { createStage, addLabel, finishStage, buildReport, formatError, formatLabel, gateError };
