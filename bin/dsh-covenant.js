#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadPolicy } = require('../src/policy');
const { loadManifest } = require('../src/contract/manifest');
const { runInstallPipeline } = require('../src/gates/index');
const { scanPlugin } = require('../src/gates/safety');
const { verifyBundle, signBundle } = require('../src/signing/bundle');
const { createTrust } = require('../src/signing/trust');
const { buildPortrait, renderPortrait } = require('../src/portrait/portrait');
const { runAutopsy } = require('../src/autopsy/autopsy');
const { computeMetrics, monthlyMetrics } = require('../src/governance/metrics');
const { Blacklist } = require('../src/governance/blacklist');
const { checkCircuitBreaker } = require('../src/governance/rollout');
const { LocalHost, resolveLedgerMacKey } = require('../src/host/local-host');
const { Ledger } = require('../src/runtime/ledger');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const rest = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false;
      } else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          index += 1;
        } else {
          flags[key] = true;
        }
      }
    } else {
      rest.push(token);
    }
  }
  return { rest, flags };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function keygen(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const make = (name) => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    fs.writeFileSync(path.join(outDir, `${name}.private.pem`), privateKey);
    fs.writeFileSync(path.join(outDir, `${name}.public.pem`), publicKey);
    return publicKey;
  };
  const publisher = make('publisher');
  const reviewer = make('reviewer');
  const trust = createTrust([
    { keyId: 'publisher-2026a', role: 'publisher', publicKey: publisher, status: 'active' },
    { keyId: 'reviewer-2026a', role: 'reviewer', publicKey: reviewer, status: 'active' },
  ]);
  fs.writeFileSync(path.join(outDir, 'trust.json'), JSON.stringify(trust, null, 2));
  return { outDir, files: fs.readdirSync(outDir), trust };
}

async function main() {
  const { rest, flags } = parseArgs(process.argv.slice(2));
  const command = rest[0];
  if (!command || command === 'help' || flags.help) {
    process.stdout.write([
      'dsh-covenant CLI',
      '  keygen <outDir>',
      '  sign <pluginDir> --plugin <id> --version <v> --publisher-key <pem> --publisher-key-id <id> --reviewer-key <pem> --reviewer-key-id <id>',
      '  verify <pluginDir> --trust <trust.json>',
      '  gates <pluginDir> [--channel consumer|enterprise] [--policy policy.json] [--trust trust.json] [--skip-signature] [--host]',
      '  portrait <pluginDir> [--channel consumer|enterprise] [--policy policy.json] [--trust trust.json]',
      '  autopsy <pluginDir> [--profile profile.json] [--patch patch.json] [--policy policy.json] [--no-signature]',
      '  metrics <ledger.jsonl> [--events events.json]',
      '  blacklist <blacklist.json> add|remove|list [plugin] [reason]',
      '  rollout <metrics.json>',
    ].join('\n') + '\n');
    return;
  }

  if (command === 'keygen') {
    output(keygen(path.resolve(rest[1] || 'keys')));
    return;
  }

  if (command === 'sign') {
    const pluginDir = path.resolve(rest[1]);
    const signatures = signBundle({
      pluginDir,
      plugin: flags.plugin,
      version: flags.version,
      publisher: {
        keyId: flags['publisher-key-id'],
        privateKey: fs.readFileSync(flags['publisher-key'], 'utf8'),
      },
      reviewer: {
        keyId: flags['reviewer-key-id'],
        privateKey: fs.readFileSync(flags['reviewer-key'], 'utf8'),
      },
    });
    output(signatures);
    return;
  }

  if (command === 'verify') {
    const pluginDir = path.resolve(rest[1]);
    const trust = createTrust(readJson(flags.trust).keys || readJson(flags.trust));
    const result = verifyBundle({ pluginDir, trust });
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'gates') {
    const pluginDir = path.resolve(rest[1]);
    const policy = flags.policy ? readJson(flags.policy) : loadPolicy({});
    const trust = flags.trust ? createTrust(readJson(flags.trust).keys || readJson(flags.trust)) : null;
    const host = flags.host ? new LocalHost({ policy }) : null;
    const result = await runInstallPipeline({
      pluginDir,
      channel: flags.channel || 'consumer',
      policy,
      trust,
      host,
      invocation: flags.invocation || 'ping',
      skipSignature: flags['skip-signature'] === true || flags.signature === false,
    });
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'portrait') {
    const pluginDir = path.resolve(rest[1]);
    const policy = flags.policy ? loadPolicy(readJson(flags.policy)) : loadPolicy({});
    const trustJson = flags.trust ? readJson(flags.trust) : null;
    const trust = trustJson ? createTrust(trustJson.keys || trustJson) : null;
    const { manifest } = loadManifest(pluginDir);
    // 画像数据源 = manifest 请求 + 扫描结果 + 门禁安全标签。
    const report = await runInstallPipeline({
      pluginDir,
      channel: flags.channel || 'consumer',
      policy,
      trust,
      skipSignature: !trust,
    });
    const scanResult = report.scan || scanPlugin(pluginDir, { policy, manifest });
    const portrait = buildPortrait({
      manifest: report.manifest || manifest,
      scan: scanResult,
      labels: report.labels,
    });
    process.stdout.write(`${renderPortrait(portrait)}\n`);
    return;
  }

  if (command === 'autopsy') {
    const pluginDir = path.resolve(rest[1]);
    const policy = flags.policy ? readJson(flags.policy) : {};
    const profile = flags.profile ? readJson(flags.profile) : undefined;
    const bundlePatch = flags.patch ? readJson(flags.patch) : [];
    const report = runAutopsy({
      pluginDir,
      profile,
      bundlePatch,
      policy,
      requireSignature: flags.signature !== false,
    });
    output(report);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === 'metrics') {
    // 先校验、再统计：在一个校验不过的账本上算指标，等于给篡改后的数据背书。
    const resolvedMac = resolveLedgerMacKey({
      ledgerMacKeyFile: flags['mac-key-file'] || null,
      ledgerMacKeyEnv: flags['mac-key-env'] || null,
    });
    const ledger = new Ledger(rest[1], { macKey: resolvedMac.key });
    const verification = ledger.verify(flags.anchor ? { anchor: readJson(flags.anchor) } : {});
    if (!verification.ok) {
      process.stderr.write(`账本校验失败（${verification.errors.length} 处）：\n`);
      for (const error of verification.errors.slice(0, 5)) {
        process.stderr.write(`  line ${error.line} ${error.code} — ${error.detail}\n`);
      }
      if (verification.errors.some((error) => error.code === 'mac_key_missing')) {
        process.stderr.write('提示：该账本是 v3（带 mac）。请用 --mac-key-file <path> 或 --mac-key-env <NAME> 提供密钥。\n');
      }
      process.exitCode = 1;
      return;
    }
    const records = ledger.records();
    const events = flags.events ? readJson(flags.events) : [];
    output({
      total: computeMetrics({ ledgerRecords: records, installEvents: events }),
      monthly: monthlyMetrics({ ledgerRecords: records, installEvents: events }),
    });
    return;
  }

  if (command === 'blacklist') {
    const store = new Blacklist({ file: path.resolve(rest[1]) });
    const action = rest[2];
    if (action === 'add') output(store.add(rest[3], { reason: rest.slice(4).join(' ') }));
    else if (action === 'remove') output({ removed: store.remove(rest[3]) });
    else output({ entries: store.list() });
    return;
  }

  if (command === 'rollout') {
    output(checkCircuitBreaker(readJson(rest[1]), readJson(rest[1]).thresholds));
    return;
  }

  process.stderr.write(`未知命令：${command}\n`);
  process.exitCode = 1;
}

main().catch((error) => {
  // 配置类错误（密钥来源不对）只打一行消息：用户要的是「怎么修」，不是调用栈。
  const text = error && error.code === 'mac_key_invalid'
    ? `${error.message}\n`
    : `${error.stack || error.message}\n`;
  process.stderr.write(text);
  process.exitCode = 1;
});
