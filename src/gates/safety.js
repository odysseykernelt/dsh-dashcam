'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gateError } = require('../errors');
const { hostPatternCovers } = require('../contract/capabilities');
const { isSensitiveEnvKey } = require('../util/paths');
const { createStage, finishStage } = require('./report');

const SCAN_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.sh', '.ps1', '.bat', '.cmd']);
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

const CODE_RULES = [
  { capability: 'fs.read', re: /\b(readFile(?:Sync)?|createReadStream|readdir(?:Sync)?|stat(?:Sync)?|lstat(?:Sync)?|access(?:Sync)?|existsSync)\s*\(/ },
  { capability: 'fs.write', re: /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|copyFile(?:Sync)?|rename(?:Sync)?|truncate(?:Sync)?)\s*\(/ },
  { capability: 'fs.delete', re: /\b(unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?)\s*\(/ },
  { capability: 'net.outbound', re: /\b(http|https)\.(request|get)\s*\(|\bnet\.(connect|createConnection)\s*\(|\btls\.connect\s*\(|\bdns\.(lookup|resolve)\s*\(|\bfetch\s*\(/ },
  { capability: 'net.listen', re: /\bcreateServer\s*\(|\.listen\s*\(/ },
  { capability: 'proc.spawn', re: /\bchild_process\b|\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|(^|[^.\w])exec(?:Sync)?\s*\(/ },
  { capability: 'proc.signal', re: /\bprocess\.kill\s*\(/ },
];

const CREDENTIAL_LITERAL = /(?:\.ssh|\.aws|\.gnupg|\.kube|id_rsa|id_ed25519|\.netrc|\.npmrc|credentials|keychain|keytar|\.pem|\.key\b)|(?:^|[\\/"'`])\.env(?:\.|$|[\\/"'`])/i;
const CREDENTIAL_ENV = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g;
const HOST_LITERAL = /https?:\/\/([a-z0-9.-]+)(?::(\d+))?/gi;

function walk(directory, { includeNodeModules = false } = {}) {
  const results = [];
  if (!fs.existsSync(directory)) return results;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name) && !(includeNodeModules && entry.name === 'node_modules')) continue;
      results.push(...walk(path.join(directory, entry.name), { includeNodeModules }));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.join(directory, entry.name));
    }
  }
  return results;
}

function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function pushFinding(findings, file, line, capability, text) {
  const key = `${file}:${line}:${capability}`;
  if (findings.some((finding) => finding.key === key)) return;
  findings.push({ key, capability, file, line, snippet: text.trim().slice(0, 160) });
}

/**
 * 静态扫描：把代码里出现的能力面与 manifest 声明比对。
 * 这是“扫描结果”，不是“安全证明”；动态 require、压缩代码与原生模块都可能漏扫。
 */
function scanPlugin(pluginDir, { policy = {}, manifest = null } = {}) {
  const root = path.resolve(pluginDir);
  const findings = [];
  const hosts = [];
  const files = walk(root, { includeNodeModules: Boolean(policy.scan && policy.scan.includeNodeModules) });
  let filesScanned = 0;

  for (const absoluteFile of files) {
    const relativeFile = path.relative(root, absoluteFile).replace(/\\/g, '/');
    if (relativeFile === 'manifest.json' || relativeFile === 'signatures.json') continue;
    let content;
    try {
      const stat = fs.statSync(absoluteFile);
      if (stat.size > 1024 * 1024) continue;
      content = fs.readFileSync(absoluteFile, 'utf8');
    } catch {
      continue;
    }
    filesScanned += 1;
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.trim() || isComment(line)) return;
      const lineNumber = index + 1;
      const isWrite = /\b(writeFile(?:Sync)?|appendFile(?:Sync)?|createWriteStream|mkdir(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?)\s*\(/.test(line);
      for (const rule of CODE_RULES) {
        if (rule.re.test(line)) pushFinding(findings, relativeFile, lineNumber, rule.capability, line);
      }
      if (CREDENTIAL_LITERAL.test(line)) {
        pushFinding(findings, relativeFile, lineNumber, isWrite ? 'cred.write' : 'cred.read', line);
      }
      const envMatches = [...line.matchAll(CREDENTIAL_ENV)];
      const sensitiveKeys = envMatches
        .map((match) => match[1] || match[2])
        .filter((key) => key && isSensitiveEnvKey(key));
      for (const key of sensitiveKeys) {
        const assignment = new RegExp(`process\\.env(?:\\.${key}|\\[['"]${key}['"]\\])\\s*=(?!=)`).test(line);
        pushFinding(findings, relativeFile, lineNumber, assignment ? 'cred.write' : 'cred.read', line);
      }
      if (/process\.env/.test(line) && sensitiveKeys.length === 0) {
        const assignment = /process\.env(?:\.\w+|\[[^\]]+\])\s*=(?!=)/.test(line);
        pushFinding(findings, relativeFile, lineNumber, assignment ? 'env.write' : 'env.read', line);
      }
      for (const match of line.matchAll(HOST_LITERAL)) {
        const protocol = match[0].toLowerCase().startsWith('https://') ? 443 : 80;
        const host = match[1].toLowerCase();
        const port = match[2] ? Number(match[2]) : protocol;
        const key = `${relativeFile}:${lineNumber}:${host}:${port}`;
        if (!hosts.some((item) => item.key === key)) {
          hosts.push({ key, host, port, file: relativeFile, line: lineNumber, snippet: line.trim().slice(0, 160) });
        }
      }
      if (/https?:\/\/\$\{/.test(line)) {
        pushFinding(findings, relativeFile, lineNumber, 'net.outbound', line);
      }
    });
  }

  const declared = (manifest && manifest.covenant && manifest.covenant.requests) || [];
  const declaredCapabilities = new Set(declared.map((request) => request.capability));
  const errors = [];

  for (const finding of findings) {
    if (!declaredCapabilities.has(finding.capability)) {
      errors.push(gateError('safety', 'undeclared_capability', `代码使用 ${finding.capability}，但 manifest 未声明`, {
        file: finding.file,
        line: finding.line,
        field: 'covenant.capabilities.requests',
      }));
    }
  }

  const netDeclared = declared.filter((request) => request.capability === 'net.outbound');
  for (const host of hosts) {
    const declaredCover = netDeclared.some((request) => request.scope.hosts.some((pattern) => hostPatternCovers(pattern, `${host.host}:${host.port}`)));
    if (!declaredCover) {
      errors.push(gateError('safety', 'undeclared_egress_host', `出站主机 ${host.host}:${host.port} 未声明`, {
        file: host.file,
        line: host.line,
        field: 'covenant.capabilities.requests',
      }));
    }
    const allowlist = policy.egressAllowlist;
    if (Array.isArray(allowlist)) {
      const allowed = allowlist.some((pattern) => {
        try {
          return hostPatternCovers(pattern.toLowerCase(), `${host.host}:${host.port}`);
        } catch {
          return false;
        }
      });
      if (!allowed) {
        errors.push(gateError('safety', 'host_not_allowlisted', `出站主机 ${host.host}:${host.port} 不在 allowlist`, {
          file: host.file,
          line: host.line,
          field: 'policy.egressAllowlist',
        }));
      }
    }
  }

  const credentialFindings = findings.filter((finding) => finding.capability === 'cred.read' || finding.capability === 'cred.write');
  const review = policy.credentialReview || {};
  const approvedPlugin = Array.isArray(review.approvedPlugins) && manifest && review.approvedPlugins.includes(manifest.id);
  const approvedTargets = Array.isArray(review.approvedTargets) ? review.approvedTargets : [];
  const unapproved = credentialFindings.filter((finding) => !approvedPlugin
    && !approvedTargets.some((target) => finding.snippet.includes(target)));
  if (unapproved.length > 0) {
    for (const finding of unapproved) {
      errors.push(gateError('safety', 'credential_manual_review_required', '检测到凭证访问，必须人工复核后才能放行', {
        file: finding.file,
        line: finding.line,
        field: 'covenant.capabilities.requests',
      }));
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    scan: {
      filesScanned,
      findings,
      hosts,
      capabilities: [...new Set(findings.map((finding) => finding.capability))].sort(),
      credentialFindings,
      manualReviewRequired: credentialFindings.length > 0,
      egressAllowlistConfigured: Array.isArray(policy.egressAllowlist),
    },
  };
}

function checkSafety(pluginDir, { policy = {}, manifest } = {}) {
  const stage = createStage('safety');
  const result = scanPlugin(pluginDir, { policy, manifest });
  stage.errors.push(...result.errors);
  return { stage: finishStage(stage), scan: result.scan };
}

module.exports = { SCAN_EXTENSIONS, scanPlugin, checkSafety, walk };
