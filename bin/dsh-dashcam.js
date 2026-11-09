#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
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
const { summarizeIngress, findIngressMatches } = require('../src/runtime/ingress');
const { buildBehaviorReport, buildDeclarationDraft } = require('../src/governance/behavior');
const { createPluginRuntime } = require('../src/index');
const { normalizeGrant } = require('../src/contract/capabilities');
const { stableStringify, sha256: sha256Hex } = require('../src/util/stable');

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

/**
 * N5 --redact-paths：分享账本前的路径脱敏。把 home 前缀（含正反斜杠两种
 * 形态）折叠成 $HOME，深度遍历 scope 与 reason 里的一切字符串。
 * 归属字段（plugin/pluginVersion/profiled/manifestHash）原样保留——
 * 「谁干的」是取证核心维度，脱敏不能把责任主体一起抹掉。
 * 输出是新链：逐条重算 seq/prevHash/hash（不带 mac）——脱敏改了内容，
 * 旧 hash 必然对不上，与其留一份验不过的副本，不如诚实地立一条新链。
 */
function redactValue(value, pairs, counter) {
  if (typeof value === 'string') {
    let result = value;
    for (const [from, to] of pairs) {
      if (!result.includes(from)) continue;
      counter.n += result.split(from).length - 1;
      result = result.split(from).join(to);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, pairs, counter));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = redactValue(value[key], pairs, counter);
    return copy;
  }
  return value;
}

function redactLedger(inputPath, outputPath) {
  const home = os.homedir().replace(/[\\/]+$/, '');
  const pairs = home
    ? [[home, '$HOME'], [home.replace(/\\/g, '/'), '$HOME']]
    : [];
  const counter = { n: 0 };
  const source = new Ledger(inputPath);
  const records = source.records();
  const target = new Ledger(outputPath);
  for (const record of records) {
    const { hash, mac, prevHash, ...keep } = record;
    const redacted = {
      ...keep,
      scope: redactValue(keep.scope || null, pairs, counter),
      reason: typeof keep.reason === 'string' ? redactValue(keep.reason, pairs, counter) : keep.reason,
    };
    target.append(redacted);
  }
  return { records: records.length, homeFolded: home ? '$HOME' : null, replacements: counter.n };
}

/**
 * 先校验、再统计：在一个校验不过的账本上算指标，等于给篡改后的数据背书。
 * 返回 null 表示已打印错误并设置非零退出码。
 */
function loadVerifiedLedger(ledgerPath, flags) {
  const resolvedMac = resolveLedgerMacKey({
    ledgerMacKeyFile: flags['mac-key-file'] || null,
    ledgerMacKeyEnv: flags['mac-key-env'] || null,
  });
  const ledger = new Ledger(ledgerPath, { macKey: resolvedMac.key });
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
    return null;
  }
  return ledger;
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
      'dsh-dashcam CLI',
      '  keygen <outDir>',
      '  sign <pluginDir> --plugin <id> --version <v> --publisher-key <pem> --publisher-key-id <id> --reviewer-key <pem> --reviewer-key-id <id>',
      '  verify <pluginDir> --trust <trust.json>',
      '  verify-ledger <ledger.jsonl> [--mac-key <key> | --mac-key-file <path> | --mac-key-env <NAME>] [--anchor anchor.json]',
      '  rotate <ledger.jsonl> [--max-bytes <N>] [--mac-key-file <path> | --mac-key-env <NAME>]',
      '  redact <ledger.jsonl> --out <file.jsonl> [--mac-key-file <path> | --mac-key-env <NAME>]',
      '  behavior <ledger.jsonl> [--manifest <pluginDir>] [--mac-key-file <path> | --mac-key-env <NAME>]',
      '  draft <ledger.jsonl> [--manifest <pluginDir>] [--mac-key-file <path> | --mac-key-env <NAME>]',
      '  bench [--n <iterations>]',
      '  gates <pluginDir> [--channel consumer|enterprise] [--policy policy.json] [--trust trust.json] [--skip-signature] [--host]',
      '  portrait <pluginDir> [--channel consumer|enterprise] [--policy policy.json] [--trust trust.json]',
      '  autopsy <pluginDir> [--profile profile.json] [--patch patch.json] [--policy policy.json] [--no-signature]',
      '  metrics <ledger.jsonl> [--events events.json]',
      '  ingress <ledger.jsonl> [--session <id>] [--find <text>] [--mac-key-file <path>]',
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

  if (command === 'verify-ledger') {
    // 独立验链：脱离宿主进程复核账本——逐行重算哈希链 + mac 校验 + 可选外部锚点。
    // 行车记录仪的产物是账本，复核就不应该依赖装着它的那个宿主还活着。
    const ledgerPath = path.resolve(rest[1]);
    if (!fs.existsSync(ledgerPath)) {
      process.stderr.write(`账本不存在：${ledgerPath}\n`);
      process.exitCode = 1;
      return;
    }
    let resolvedMac;
    try {
      resolvedMac = resolveLedgerMacKey({
        ledgerMacKey: typeof flags['mac-key'] === 'string' ? flags['mac-key'] : null,
        ledgerMacKeyFile: flags['mac-key-file'] || null,
        ledgerMacKeyEnv: flags['mac-key-env'] || null,
      });
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const ledger = new Ledger(ledgerPath, { macKey: resolvedMac.key });
    const report = ledger.verify(flags.anchor ? { anchor: readJson(flags.anchor) } : {});
    const records = ledger.records();
    const last = records[records.length - 1] || null;
    output({
      ok: report.ok,
      file: ledgerPath,
      records: report.count,
      lastSeq: last && Number.isInteger(last.seq) ? last.seq : null,
      head: report.head,
      macVerified: Boolean(resolvedMac.key),
      errors: report.errors,
    });
    if (!report.ok) {
      process.stderr.write(`账本校验失败（${report.errors.length} 处）：\n`);
      for (const error of report.errors.slice(0, 5)) {
        process.stderr.write(`  line ${error.line} ${error.code} — ${error.detail}\n`);
      }
      if (report.errors.some((error) => error.code === 'mac_key_missing')) {
        process.stderr.write('提示：该账本带 mac。请用 --mac-key <key> / --mac-key-file <path> / --mac-key-env <NAME> 提供密钥。\n');
      }
      process.exitCode = 1;
    }
    return;
  }

  if (command === 'rotate') {
    // N5：账本轮转。当前段改名归档（旧段保留、不删不改），新段第一行写
    // 上一段的首尾 hash——跨段也能锚定。--max-bytes 只做门槛判断：
    // 体积没超就不动账本（轮转是维护动作，不是自动行为）。
    const ledgerPath = path.resolve(rest[1]);
    if (!fs.existsSync(ledgerPath)) {
      process.stderr.write(`账本不存在：${ledgerPath}\n`);
      process.exitCode = 1;
      return;
    }
    const limit = Number(flags['max-bytes']);
    const size = fs.statSync(ledgerPath).size;
    if (Number.isFinite(limit) && limit > 0 && size <= limit) {
      output({ rotated: false, file: ledgerPath, size, maxBytes: limit, reason: '体积未超上限，未轮转' });
      return;
    }
    const ledger = loadVerifiedLedger(ledgerPath, flags);
    if (!ledger) return;
    const result = ledger.rotate();
    if (!result) {
      output({ rotated: false, file: ledgerPath, reason: '空账本，无需轮转' });
      return;
    }
    // 新段链接记录：归档文件只记 basename——新账本不该带着旧段的绝对路径。
    const link = ledger.append({
      plugin: 'dsh-dashcam',
      pluginVersion: require('../package.json').version,
      capability: 'telemetry',
      action: 'segment-rotate',
      scope: {
        archived: path.basename(result.archivedPath),
        records: result.records,
        lastSeq: result.lastSeq,
        prevSegmentFirstHash: result.firstHash,
        prevSegmentLastHash: result.lastHash,
      },
      decision: 'allow',
      ruleId: 'rotate',
      reason: '账本轮转：新段从此开始；上一段首尾 hash 见 scope，验链时可用作跨段锚点',
      intercepted: false,
      profiled: false,
      manifestHash: null,
    });
    output({
      rotated: true,
      file: ledgerPath,
      archived: result.archivedPath,
      records: result.records,
      lastSeq: result.lastSeq,
      prevSegmentFirstHash: result.firstHash,
      prevSegmentLastHash: result.lastHash,
      linkSeq: link.seq,
    });
    return;
  }

  if (command === 'redact') {
    // N5：分享账本前的路径脱敏（home 前缀折叠成 $HOME）。源账本必须先验过：
    // 在校验不过的账本上脱敏，等于帮篡改者洗数据。
    const input = path.resolve(rest[1]);
    if (!fs.existsSync(input)) {
      process.stderr.write(`账本不存在：${input}\n`);
      process.exitCode = 1;
      return;
    }
    const ledger = loadVerifiedLedger(input, flags);
    if (!ledger) return;
    const out = path.resolve(flags.out || `${input}.redacted.jsonl`);
    const summary = redactLedger(input, out);
    output({ redacted: true, input, out, ...summary });
    return;
  }

  if (command === 'gates') {
    const pluginDir = path.resolve(rest[1]);
    const policy = flags.policy ? readJson(flags.policy) : loadPolicy({});
    const trustJson = flags.trust ? readJson(flags.trust) : null;
    const trust = trustJson ? createTrust(trustJson.keys || trustJson) : null;
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
    // N2：信任根整体哈希随报告落盘——「这份报告是按哪份信任表验的」可核对，
    // keyId 之外再给 SPKI 指纹（归一化时已算进 keys），对的是密钥材料本身。
    if (trustJson) {
      result.trustRoot = {
        file: path.basename(flags.trust),
        hash: sha256Hex(stableStringify(trustJson)),
        keys: (trust.keys || []).map((key) => ({ keyId: key.keyId, fingerprint: key.fingerprint, status: key.status })),
      };
    }
    output(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'behavior') {
    // 行为画像报告：把账本记录按插件聚合成「实际读了什么/连了哪里/跑了什么」。
    // 与 portrait（声明侧画像）互补——一个来自 manifest，一个来自账本。
    const ledger = loadVerifiedLedger(rest[1], flags);
    if (!ledger) return;
    let manifest = null;
    if (flags.manifest) {
      const loaded = loadManifest(path.resolve(flags.manifest));
      manifest = loaded.manifest;
      if (!manifest) {
        process.stderr.write(`无法读取清单：${flags.manifest}（${loaded.errors.map((error) => error.message).join('；')}）\n`);
        process.exitCode = 1;
        return;
      }
    }
    output(buildBehaviorReport(ledger.records(), { manifest }));
    return;
  }

  if (command === 'draft') {
    // 声明草案：从账本观测反推 config.requests / manifest.dashcam.requests。
    // 服务于「零契约先跑一段，攒够观测再升 enforce」的迁移路径——
    // 让人改两行，而不是对着能力表凭空写。
    const ledger = loadVerifiedLedger(rest[1], flags);
    if (!ledger) return;
    let manifest = null;
    if (flags.manifest) {
      const loaded = loadManifest(path.resolve(flags.manifest));
      manifest = loaded.manifest;
      if (!manifest) {
        process.stderr.write(`无法读取清单：${flags.manifest}（${loaded.errors.map((error) => error.message).join('；')}）\n`);
        process.exitCode = 1;
        return;
      }
    }
    output(buildDeclarationDraft(ledger.records(), { manifest }));
    return;
  }

  if (command === 'bench') {
    // N6：bridge 开销微基准。同一进程先跑裸 fs（Hook 未装），再装 Hook 跑同一
    // 组调用，差值就是「被记录」的每次调用代价。guarded 档包含守卫判定与
    // 账本逐条落盘——这是行车记录仪的真实开销，不藏。
    const iterations = Math.max(1, Number(flags.n) || 10000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bench-'));
    const target = path.join(dir, 'payload.bin');
    fs.writeFileSync(target, Buffer.alloc(64, 0x61));
    const ledgerPath = path.join(dir, 'bench-ledger.jsonl');
    const ops = [
      { op: 'fs.statSync', run: () => fs.statSync(target) },
      { op: 'fs.openSync', run: () => { const fd = fs.openSync(target, 'r'); fs.closeSync(fd); } },
      { op: 'fs.readFileSync', run: () => fs.readFileSync(target) },
      { op: 'fs.existsSync', run: () => fs.existsSync(target) },
    ];
    const measure = (phase) => ops.map(({ op, run }) => {
      const start = process.hrtime.bigint();
      for (let i = 0; i < iterations; i += 1) run();
      const perCallUs = Number(process.hrtime.bigint() - start) / 1000 / iterations;
      return { op, phase, perCallUs: Math.round(perCallUs * 1000) / 1000 };
    });
    const unpatched = measure('unpatched');
    // 授权范围钉在基准文件本身：判定走 allow + 逐条记账，量的是完整链路。
    // bridge 的 guardPath 走 guard.enforce，manifest 与 grant 缺一不可——
    // 声明与授予同范围，确保每次调用都走「声明 × 授予 × 记账」全链路。
    const benchManifest = {
      id: 'dsh-dashcam-bench',
      version: '0.0.0',
      kind: 'dashcam',
      dashcam: {
        requests: [{ capability: 'fs.read', scope: { paths: [target] }, reason: 'bench 基准授权范围' }],
      },
    };
    const runtime = createPluginRuntime({
      manifest: benchManifest,
      ledgerPath,
      patchBuiltins: true,
      autoSweep: false,
      grants: [normalizeGrant({ capability: 'fs.read', scope: { paths: [target] }, reason: 'bench' })],
    });
    let guarded;
    try {
      guarded = measure('guarded');
    } finally {
      runtime.dispose();
    }
    // 卸载 Hook 后再读账本：确认 guarded 档确实逐条落了账。
    let recorded = null;
    try {
      const benchLedger = new Ledger(ledgerPath);
      recorded = benchLedger.records().length;
    } catch {
      recorded = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    output({
      iterations,
      note: 'guarded 含守卫判定与账本逐条落盘；unpatched 为同进程 Hook 安装前的裸 fs。'
        + 'overhead = guarded − unpatched，即每次调用被记录的额外代价（微秒）。',
      results: ops.map(({ op }, index) => ({
        op,
        unpatchedUsPerCall: unpatched[index].perCallUs,
        guardedUsPerCall: guarded[index].perCallUs,
        overheadUsPerCall: Math.round((guarded[index].perCallUs - unpatched[index].perCallUs) * 1000) / 1000,
      })),
      ledgerRecords: recorded,
    });
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
    const ledger = loadVerifiedLedger(rest[1], flags);
    if (!ledger) return;
    const records = ledger.records();
    const events = flags.events ? readJson(flags.events) : [];
    output({
      total: computeMetrics({ ledgerRecords: records, installEvents: events }),
      monthly: monthlyMetrics({ ledgerRecords: records, installEvents: events }),
    });
    return;
  }

  if (command === 'ingress') {
    const ledger = loadVerifiedLedger(rest[1], flags);
    if (!ledger) return;
    const all = ledger.records().filter((record) => record.capability === 'llm.ingress');
    const scoped = flags.session
      ? all.filter((record) => record.scope && record.scope.sessionId === flags.session)
      : all;
    const summary = summarizeIngress(scoped);
    if (flags.find) {
      const needle = String(flags.find);
      output({
        summary,
        find: {
          needle,
          matches: findIngressMatches(scoped, needle),
          // 覆盖范围必须写在输出里：没搜到 ≠ 没发生。
          coverage: '仅检索已采样消息的 head；未采样消息不覆盖',
        },
      });
      return;
    }
    output({ summary });
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
