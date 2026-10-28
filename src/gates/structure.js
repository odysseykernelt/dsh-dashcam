'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gateError } = require('../errors');
const { loadManifest } = require('../contract/manifest');
const { isInside } = require('../util/paths');
const { createStage, finishStage } = require('./report');

const LIFECYCLE_SCRIPTS = ['preinstall', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];

function scriptAllowed(command, allowlist) {
  return allowlist.some((pattern) => (pattern instanceof RegExp ? pattern.test(command) : pattern === command));
}

/**
 * 结构门禁：只检查“包本身是否可解析、可安装”，不做能力判断。
 * 失败信息必须带字段与文件行。
 */
function checkStructure(pluginDir, { policy = {} } = {}) {
  const stage = createStage('structure');
  const root = path.resolve(pluginDir);
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    stage.errors.push(gateError('structure', 'plugin_dir_missing', '插件目录不存在', { file: root }));
    return { stage: finishStage(stage), manifest: null };
  }
  if (!fs.existsSync(manifestFile)) {
    stage.errors.push(gateError('structure', 'manifest_missing', '缺少 manifest.json', { file: 'manifest.json' }));
    return { stage: finishStage(stage), manifest: null };
  }

  const { manifest, errors } = loadManifest(root);
  for (const error of errors) stage.errors.push({ ...error, gate: 'structure' });
  if (!manifest) return { stage: finishStage(stage), manifest: null };

  const entryPath = path.resolve(root, manifest.entry || '');
  if (!manifest.entry) {
    stage.errors.push(gateError('structure', 'entry_missing', 'manifest.entry 为空', {
      field: 'entry',
      file: 'manifest.json',
    }));
  } else if (!isInside(root, entryPath)) {
    stage.errors.push(gateError('structure', 'entry_outside_plugin', 'entry 越出插件目录', {
      field: 'entry',
      file: 'manifest.json',
    }));
  } else if (!fs.existsSync(entryPath)) {
    stage.errors.push(gateError('structure', 'entry_not_found', `入口文件不存在：${manifest.entry}`, {
      field: 'entry',
      file: manifest.entry,
      line: 1,
    }));
  }

  const extensions = policy.patchExtensions || ['.js', '.json', '.patch', '.diff'];
  for (const [index, patch] of manifest.patches.entries()) {
    const field = `patches[${index}]`;
    if (!patch || typeof patch !== 'object') {
      stage.errors.push(gateError('structure', 'patch_invalid', 'patch 必须是对象', {
        field,
        file: 'manifest.json',
      }));
      continue;
    }
    const patchPath = typeof patch.path === 'string' ? patch.path.trim() : '';
    if (!patchPath) {
      stage.errors.push(gateError('structure', 'patch_path_missing', 'patch.path 不能为空', {
        field: `${field}.path`,
        file: 'manifest.json',
      }));
      continue;
    }
    const resolved = path.resolve(root, patchPath);
    if (!isInside(root, resolved)) {
      stage.errors.push(gateError('structure', 'patch_path_outside', 'patch 路径越出插件目录', {
        field: `${field}.path`,
        file: 'manifest.json',
      }));
      continue;
    }
    if (!extensions.includes(path.extname(resolved).toLowerCase())) {
      stage.errors.push(gateError('structure', 'patch_extension_invalid', `patch 扩展名不在白名单：${path.extname(resolved)}`, {
        field: `${field}.path`,
        file: 'manifest.json',
      }));
    }
    if (!fs.existsSync(resolved)) {
      stage.errors.push(gateError('structure', 'patch_not_found', `patch 文件不存在：${patchPath}`, {
        field: `${field}.path`,
        file: patchPath,
        line: 1,
      }));
    }
    const reason = typeof patch.reason === 'string' ? patch.reason.trim() : '';
    if (!reason) {
      stage.errors.push(gateError('structure', 'patch_reason_empty', 'patch.reason 不能为空', {
        field: `${field}.reason`,
        file: 'manifest.json',
      }));
    }
    if (patch.target) {
      const target = path.resolve(root, String(patch.target));
      const roots = policy.patchTargetRoots;
      const allowedTarget = isInside(root, target)
        || (Array.isArray(roots) && roots.some((allowedRoot) => isInside(allowedRoot, target)));
      if (!allowedTarget) {
        stage.errors.push(gateError('structure', 'patch_target_outside', 'patch.target 不在允许的宿主路径内', {
          field: `${field}.target`,
          file: 'manifest.json',
        }));
      }
    }
  }

  const allowlist = policy.installScriptAllowlist || [];
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (LIFECYCLE_SCRIPTS.includes(name)) {
      stage.errors.push(gateError('structure', 'lifecycle_script_rejected', `禁止生命周期脚本 ${name}`, {
        field: `scripts.${name}`,
        file: 'manifest.json',
      }));
      continue;
    }
    if (name !== 'install') {
      stage.errors.push(gateError('structure', 'script_not_allowlisted', `脚本 ${name} 不在白名单`, {
        field: `scripts.${name}`,
        file: 'manifest.json',
      }));
      continue;
    }
    if (typeof command !== 'string' || !scriptAllowed(command.trim(), allowlist)) {
      stage.errors.push(gateError('structure', 'install_script_not_allowlisted', `安装脚本不在白名单：${command}`, {
        field: 'scripts.install',
        file: 'manifest.json',
      }));
    }
  }

  return { stage: finishStage(stage), manifest };
}

module.exports = { checkStructure, LIFECYCLE_SCRIPTS };
