'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stableStringify } = require('../util/stable');
const { findKey } = require('./trust');

const SIGNATURE_FILE = 'signatures.json';
const FORMAT = 'dsh-dashcam/signatures@1';

function walkFiles(directory, base = directory) {
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === SIGNATURE_FILE || entry.name === '.git') continue;
    const absolute = path.join(directory, entry.name);
    // F2：symlink 的 Dirent.isFile() 为 false——以前它既不进清单、也不报「未签名」，
    // 而装载侧跟随符号链接，包内链接因此能指向包外任意文件而不被签名覆盖。
    // 规则收紧为：插件包不允许包含符号链接，签署与验签一律以真实文件为准。
    if (entry.isSymbolicLink()) {
      throw new Error(`插件包不允许包含符号链接：${path.relative(base, absolute)}`);
    }
    if (entry.isDirectory()) {
      results.push(...walkFiles(absolute, base));
    } else if (entry.isFile()) {
      results.push(absolute);
    } else {
      // fifo/socket/设备文件同样不是可签名的普通文件，静默跳过等于清单盲区。
      throw new Error(`插件包包含无法签名的特殊文件：${path.relative(base, absolute)}`);
    }
  }
  return results;
}

/** 重建文件清单：路径、大小、sha256。 */
function buildFileList(pluginDir) {
  const root = path.resolve(pluginDir);
  return walkFiles(root)
    .map((absolute) => {
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      const content = fs.readFileSync(absolute);
      return {
        path: relative,
        size: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function buildPayload({ plugin, version, publisherKeyId, reviewerKeyId, files, signedAt }) {
  return stableStringify({
    format: FORMAT,
    plugin,
    version,
    publisherKeyId,
    reviewerKeyId,
    algorithm: 'ed25519',
    files,
    signedAt,
  });
}

function signPayload(payload, privateKey) {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

function signBundle({
  pluginDir,
  plugin,
  version,
  publisher,
  reviewer,
  signedAt = new Date().toISOString(),
}) {
  if (!publisher || !publisher.keyId || !publisher.privateKey) throw new Error('缺少发布者私钥');
  if (!reviewer || !reviewer.keyId || !reviewer.privateKey) throw new Error('缺少审核者私钥');
  const files = buildFileList(pluginDir);
  const payload = buildPayload({
    plugin,
    version,
    publisherKeyId: publisher.keyId,
    reviewerKeyId: reviewer.keyId,
    files,
    signedAt,
  });
  const signatures = {
    format: FORMAT,
    plugin,
    version,
    keyId: publisher.keyId,
    algorithm: 'ed25519',
    files,
    publisher: {
      keyId: publisher.keyId,
      signature: signPayload(payload, publisher.privateKey),
    },
    reviewer: {
      keyId: reviewer.keyId,
      signature: signPayload(payload, reviewer.privateKey),
    },
    signedAt,
  };
  fs.writeFileSync(path.join(pluginDir, SIGNATURE_FILE), `${JSON.stringify(signatures, null, 2)}\n`, 'utf8');
  return signatures;
}

function signatureError(stage, code, message, extra = {}) {
  return { stage, code, message, ...extra };
}

function compareFileLists(expected, actual) {
  const errors = [];
  const expectedMap = new Map(expected.map((file) => [file.path, file]));
  const actualMap = new Map(actual.map((file) => [file.path, file]));
  for (const [filePath, file] of expectedMap) {
    const rebuilt = actualMap.get(filePath);
    if (!rebuilt) {
      errors.push(signatureError('manifest_rebuild', 'file_missing', `签名清单中的文件不存在：${filePath}`, { file: filePath }));
      continue;
    }
    if (rebuilt.size !== file.size) {
      errors.push(signatureError('manifest_rebuild', 'size_mismatch', `文件大小变化：${filePath}`, { file: filePath }));
    }
    if (rebuilt.sha256 !== file.sha256) {
      errors.push(signatureError('manifest_rebuild', 'hash_mismatch', `文件哈希变化：${filePath}`, { file: filePath }));
    }
  }
  for (const filePath of actualMap.keys()) {
    if (!expectedMap.has(filePath)) {
      errors.push(signatureError('manifest_rebuild', 'file_unexpected', `出现未签名文件：${filePath}`, { file: filePath }));
    }
  }
  return errors;
}

/**
 * 客户端验签顺序：重建清单 → 校验 keyId → 验发布者 → 验审核。
 * 任一步失败即整包拒装，调用方不得继续契约校验。
 */
function verifyBundle({ pluginDir, trust, requireReviewer = true }) {
  const signaturePath = path.join(pluginDir, SIGNATURE_FILE);
  if (!fs.existsSync(signaturePath)) {
    return {
      ok: false,
      stage: 'signature_file',
      errors: [signatureError('signature_file', 'signature_missing', '缺少 signatures.json', { file: SIGNATURE_FILE })],
      files: [],
    };
  }
  let signatures;
  try {
    signatures = JSON.parse(fs.readFileSync(signaturePath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      stage: 'signature_file',
      errors: [signatureError('signature_file', 'signature_invalid', `signatures.json 解析失败：${error.message}`, { file: SIGNATURE_FILE })],
      files: [],
    };
  }

  if (signatures.format !== FORMAT) {
    return {
      ok: false,
      stage: 'signature_file',
      errors: [signatureError('signature_file', 'format_unsupported', `不支持的签名格式 ${signatures.format}`, { file: SIGNATURE_FILE })],
      files: [],
    };
  }

  let files;
  try {
    files = buildFileList(pluginDir);
  } catch (error) {
    // buildFileList 只在遇到符号链接/特殊文件时抛错（F2）：按整包拒装处理，
    // 与「出现未签名文件」同一阶段，调用方不得继续契约校验。
    return {
      ok: false,
      stage: 'manifest_rebuild',
      errors: [signatureError('manifest_rebuild', 'invalid_bundle_entry', `重建文件清单失败：${error.message}`, {})],
      files: [],
    };
  }
  const rebuildErrors = compareFileLists(signatures.files || [], files);
  if (rebuildErrors.length > 0) {
    return { ok: false, stage: 'manifest_rebuild', errors: rebuildErrors, files, signatures };
  }

  const publisherKeyId = signatures.publisher && signatures.publisher.keyId;
  const reviewerKeyId = signatures.reviewer && signatures.reviewer.keyId;
  const keyErrors = [];
  if (!publisherKeyId || publisherKeyId !== signatures.keyId) {
    keyErrors.push(signatureError('keyid', 'publisher_keyid_mismatch', 'keyId 与发布者签名不一致', { field: 'keyId' }));
  }
  const publisherKey = findKey(trust, publisherKeyId, 'publisher');
  if (!publisherKey) {
    keyErrors.push(signatureError('keyid', 'publisher_key_unknown', `信任表缺少发布者公钥 ${publisherKeyId}`, { field: 'publisher.keyId' }));
  }
  let reviewerKey = null;
  if (requireReviewer) {
    if (!reviewerKeyId) {
      keyErrors.push(signatureError('keyid', 'reviewer_keyid_missing', '缺少审核者 keyId', { field: 'reviewer.keyId' }));
    } else {
      reviewerKey = findKey(trust, reviewerKeyId, 'reviewer');
      if (!reviewerKey) {
        keyErrors.push(signatureError('keyid', 'reviewer_key_unknown', `信任表缺少审核者公钥 ${reviewerKeyId}`, { field: 'reviewer.keyId' }));
      }
    }
  }
  if (keyErrors.length > 0) {
    return { ok: false, stage: 'keyid', errors: keyErrors, files, signatures };
  }

  const payload = buildPayload({
    plugin: signatures.plugin,
    version: signatures.version,
    publisherKeyId,
    reviewerKeyId,
    files: signatures.files,
    signedAt: signatures.signedAt,
  });

  try {
    const publisherOk = crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      publisherKey.publicKey,
      Buffer.from(signatures.publisher.signature, 'base64'),
    );
    if (!publisherOk) {
      return {
        ok: false,
        stage: 'publisher',
        errors: [signatureError('publisher', 'publisher_signature_invalid', '发布者签名验证失败', { field: 'publisher.signature' })],
        files,
        signatures,
      };
    }
  } catch (error) {
    return {
      ok: false,
      stage: 'publisher',
      errors: [signatureError('publisher', 'publisher_signature_error', `发布者签名校验异常：${error.message}`, { field: 'publisher.signature' })],
      files,
      signatures,
    };
  }

  if (requireReviewer) {
    try {
      const reviewerOk = crypto.verify(
        null,
        Buffer.from(payload, 'utf8'),
        reviewerKey.publicKey,
        Buffer.from(signatures.reviewer.signature, 'base64'),
      );
      if (!reviewerOk) {
        return {
          ok: false,
          stage: 'reviewer',
          errors: [signatureError('reviewer', 'reviewer_signature_invalid', '审核签名验证失败', { field: 'reviewer.signature' })],
          files,
          signatures,
        };
      }
    } catch (error) {
      return {
        ok: false,
        stage: 'reviewer',
        errors: [signatureError('reviewer', 'reviewer_signature_error', `审核签名校验异常：${error.message}`, { field: 'reviewer.signature' })],
        files,
        signatures,
      };
    }
  }

  return { ok: true, stage: 'ok', errors: [], files, signatures };
}

module.exports = {
  SIGNATURE_FILE,
  FORMAT,
  buildFileList,
  buildPayload,
  signBundle,
  verifyBundle,
  compareFileLists,
  signPayload,
};
