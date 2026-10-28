'use strict';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parsePath(pathValue) {
  if (typeof pathValue !== 'string' || !pathValue.trim()) throw new Error('patch.path 不能为空');
  return pathValue.split('.').filter(Boolean);
}

function getParent(document, parts) {
  let current = document;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (current[key] === undefined || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }
  return { parent: current, key: parts[parts.length - 1] };
}

/** 离线应用 bundle patch：仅支持 add / remove / replace，按点路径操作。 */
function applyBundlePatch(profile, operations = []) {
  const document = clone(profile || {});
  const applied = [];
  for (const [index, operation] of operations.entries()) {
    if (!operation || typeof operation !== 'object') throw new Error(`patch[${index}] 不是对象`);
    const parts = parsePath(operation.path);
    if (parts.length === 0) throw new Error(`patch[${index}].path 为空`);
    if (operation.op === 'add') {
      const { parent, key } = getParent(document, parts);
      if (Array.isArray(parent)) {
        if (key === '-') parent.push(clone(operation.value));
        else parent.splice(Number(key), 0, clone(operation.value));
      } else if (parent[key] === undefined) {
        parent[key] = clone(operation.value);
      } else if (Array.isArray(parent[key]) && Array.isArray(operation.value)) {
        parent[key].push(...clone(operation.value));
      } else {
        parent[key] = clone(operation.value);
      }
      applied.push({ op: 'add', path: operation.path });
    } else if (operation.op === 'replace') {
      const { parent, key } = getParent(document, parts);
      if (parent[key] === undefined) throw new Error(`patch[${index}] replace 目标不存在：${operation.path}`);
      parent[key] = clone(operation.value);
      applied.push({ op: 'replace', path: operation.path });
    } else if (operation.op === 'remove') {
      const { parent, key } = getParent(document, parts);
      if (parent[key] === undefined) throw new Error(`patch[${index}] remove 目标不存在：${operation.path}`);
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      applied.push({ op: 'remove', path: operation.path });
    } else {
      throw new Error(`patch[${index}].op 不支持：${operation.op}`);
    }
  }
  return { document, applied };
}

/** 组合 profile 与 bundle patch，判断插件是否被启用；全程不启动宿主。 */
function composeActivation(profile, bundlePatch, pluginId) {
  const { document, applied } = applyBundlePatch(profile, bundlePatch);
  const reasons = [];
  let enabled = false;

  if (Array.isArray(document.plugins)) {
    enabled = document.plugins.includes(pluginId);
    reasons.push(`profile.plugins 数组${enabled ? '包含' : '不包含'} ${pluginId}`);
  } else if (document.plugins && typeof document.plugins === 'object') {
    const entry = document.plugins[pluginId];
    enabled = entry === undefined ? false : entry !== false && entry.enabled !== false;
    reasons.push(`profile.plugins.${pluginId} ${entry === undefined ? '不存在' : `= ${JSON.stringify(entry)}`}`);
  }
  if (!enabled && document.modules && document.modules[pluginId]) {
    enabled = document.modules[pluginId].enabled !== false;
    reasons.push(`profile.modules.${pluginId}.enabled=${document.modules[pluginId].enabled}`);
  }
  if (!enabled) {
    const patched = applied.some((item) => item.path.includes(pluginId));
    enabled = patched;
    if (patched) reasons.push('bundle patch 添加了该插件');
  }

  return { profile: document, applied, enabled, reasons };
}

module.exports = { applyBundlePatch, composeActivation };
