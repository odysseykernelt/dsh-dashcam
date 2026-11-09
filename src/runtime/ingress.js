'use strict';

const { sha256 } = require('../util/stable');

/**
 * ingress 审计：记录「发进模型的 messages」与「进入会话的用户输入」，并对账。
 *
 * 观测面与守卫链正交：这里不做 Two-Key 判定、不拦截、不抛错。记录失败只降级，
 * 绝不阻断请求（fail-open）。业务字段全部放进 Ledger 的 scope——账本顶层字段
 * 是固定的（见 runtime/ledger.js），新增顶层字段会被静默丢弃。
 *
 * 四象限判据（只在本模块内部使用，不外推）：
 *   inbound 有 + request 有 = 正常
 *   inbound 无 + request 有 = 注入
 *   inbound 有 + request 无 = 丢失
 *   inbound 无 + request 无 = 不存在（模型自造）——本模块不告警，这是显式设计
 */

const INGRESS_CAPABILITY = 'llm.ingress';

const DEFAULT_INGRESS = Object.freeze({
  headBytes: 80,
  maxSample: 32,
  maxLineBytes: 8192,
  inboundWindow: 500,
  inboundTtlMs: 3_600_000,
  maskSecrets: true,
  // 系统注入类：role 也是 user，但不需要在 inbound 里找到对应记录。
  // 按 source.kind 白名单，不能按 role——本事件会话 54 条 user 里只有 27 条是真人。
  whitelistKinds: Object.freeze([
    'runtime-context',
    'time-context',
    'compaction',
    'plugin:memory',
    'skill-catalog',
    'tool',
    'system',
  ]),
});

/** 与宿主 commandline 存档同型的打码；head 可能含密钥，best-effort。 */
function maskSecrets(text) {
  return String(text)
    .replace(/((?:authorization|proxy-authorization)["'=:\s]*bearer\s+)[^\s"']+/gi, '$1***')
    .replace(/((?:--)?(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|password|passwd|secret|passphrase)["'=:\s]+)[^\s"'&]+/gi, '$1***')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '***');
}

function asPositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveIngressSettings(raw = {}) {
  const merged = { ...DEFAULT_INGRESS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    headBytes: Number.isInteger(merged.headBytes) && merged.headBytes >= 0 ? merged.headBytes : DEFAULT_INGRESS.headBytes,
    maxSample: asPositiveInteger(merged.maxSample, DEFAULT_INGRESS.maxSample),
    maxLineBytes: asPositiveInteger(merged.maxLineBytes, DEFAULT_INGRESS.maxLineBytes),
    inboundWindow: asPositiveInteger(merged.inboundWindow, DEFAULT_INGRESS.inboundWindow),
    inboundTtlMs: Number.isInteger(merged.inboundTtlMs) && merged.inboundTtlMs >= 0
      ? merged.inboundTtlMs
      : DEFAULT_INGRESS.inboundTtlMs,
    maskSecrets: merged.maskSecrets !== false,
    whitelistKinds: new Set(
      Array.isArray(merged.whitelistKinds) ? merged.whitelistKinds.map(String) : DEFAULT_INGRESS.whitelistKinds,
    ),
  };
}

/** 附件只留身份哈希、MIME 与大小，不抓取/哈希 base64 正文（体积）。 */
function summarizeAttachment(part, type) {
  const source = part.source && typeof part.source === 'object' ? part.source : null;
  const identifier = part.fileId
    || part.file_id
    || part.id
    || part.sha256
    || part.url
    || (part.image_url && part.image_url.url)
    || (source && (source.url || source.path))
    || null;
  const mime = part.media_type
    || part.mimeType
    || (source && (source.media_type || source.mime_type))
    || null;
  let size = Number.isFinite(part.size) ? part.size : null;
  if (size === null && source && typeof source.data === 'string') size = source.data.length;
  return {
    kind: type,
    idHash: identifier ? `sha256:${sha256(String(identifier))}` : null,
    mime,
    size,
  };
}

function extractContent(content) {
  if (typeof content === 'string') return { text: content, parts: 1, attachments: [] };
  if (Array.isArray(content)) {
    let text = '';
    const attachments = [];
    for (const part of content) {
      if (typeof part === 'string') {
        text += part;
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') text += part.text;
      const type = typeof part.type === 'string' ? part.type : 'unknown';
      const looksLikeAttachment = type === 'image'
        || type === 'image_url'
        || type === 'file'
        || type === 'document'
        || Boolean(part.fileId || part.file_id || part.image_url);
      if (looksLikeAttachment && type !== 'text') attachments.push(summarizeAttachment(part, type));
    }
    return { text, parts: content.length, attachments };
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return { text: content.text, parts: 1, attachments: [] };
  }
  return { text: '', parts: 0, attachments: [] };
}

function normalizeMessage(message) {
  if (typeof message === 'string') {
    return { role: 'user', kind: 'user', text: message, parts: 1, attachments: [] };
  }
  if (!message || typeof message !== 'object') {
    return { role: 'unknown', kind: 'unknown', text: '', parts: 0, attachments: [] };
  }
  const role = typeof message.role === 'string' ? message.role : 'unknown';
  const kind = typeof message.kind === 'string'
    ? message.kind
    : (message.source && typeof message.source.kind === 'string' ? message.source.kind : 'unknown');
  const content = message.content !== undefined
    ? message.content
    : (message.text !== undefined ? message.text : '');
  return { role, kind, ...extractContent(content) };
}

/**
 * 消息指纹 = sha256(role \0 text \0 附件身份)。正文与附件身份都进哈希：
 * 只算正文时，「同一句配不同图」与「只有图没有字」会撞成同一个指纹。
 */
function digestOf(normalized) {
  const attachmentIds = (normalized.attachments || []).map((item) => item.idHash || '').join(',');
  return `sha256:${sha256(`${normalized.role}\u0000${normalized.text}\u0000${attachmentIds}`)}`;
}

function summarizeMessage(message, options = {}) {
  const settings = resolveIngressSettings(options);
  const normalized = normalizeMessage(message);
  const len = Buffer.byteLength(normalized.text, 'utf8');
  const summary = {
    role: normalized.role,
    kind: normalized.kind,
    len,
    sha256: digestOf(normalized),
    parts: normalized.parts,
  };
  if (settings.headBytes > 0 && normalized.text.length > 0) {
    const head = normalized.text.slice(0, settings.headBytes);
    summary.head = settings.maskSecrets ? maskSecrets(head) : head;
  }
  if (normalized.attachments.length > 0) summary.attachments = normalized.attachments;
  return summary;
}

function summarizeMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const summaries = list.map((message) => summarizeMessage(message, options));
  return {
    count: summaries.length,
    // 整体指纹：逐条指纹按顺序拼接后再哈希。同一份输入必须得到同一个值。
    hash: `sha256:${sha256(summaries.map((item) => item.sha256).join('|'))}`,
    summaries,
  };
}

function summaryKey(summary) {
  return `${summary.role}\u0000${summary.sha256}`;
}

/** LCS 的匹配标记；规模过大时返回 null，交给多重集回退。 */
function lcsMatchFlags(left, right) {
  const n = left.length;
  const m = right.length;
  if (n * m > 250_000) return null;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const matchedLeft = new Array(n).fill(false);
  const matchedRight = new Array(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      matchedLeft[i] = true;
      matchedRight[j] = true;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { matchedLeft, matchedRight };
}

function multisetFlags(left, right) {
  const pool = new Map();
  for (const key of left) pool.set(key, (pool.get(key) || 0) + 1);
  const matchedRight = right.map((key) => {
    const remaining = pool.get(key) || 0;
    if (remaining <= 0) return false;
    pool.set(key, remaining - 1);
    return true;
  });
  const matchedLeft = left.map((key) => {
    const remaining = pool.get(key) || 0;
    if (remaining <= 0) return false;
    pool.set(key, remaining - 1);
    return true;
  });
  return { matchedLeft, matchedRight };
}

/**
 * 与上一次请求的差异：先裁掉公共前后缀（多数会话是纯追加），再对中间段做 LCS。
 * changed 是启发式：按顺序把「移除」和「新增」中 role 相同的配成一对。
 */
function diffSummaries(previous = [], next = []) {
  const prevKeys = previous.map(summaryKey);
  const nextKeys = next.map(summaryKey);
  let start = 0;
  while (start < prevKeys.length && start < nextKeys.length && prevKeys[start] === nextKeys[start]) start += 1;
  let prevEnd = prevKeys.length;
  let nextEnd = nextKeys.length;
  while (prevEnd > start && nextEnd > start && prevKeys[prevEnd - 1] === nextKeys[nextEnd - 1]) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const leftKeys = prevKeys.slice(start, prevEnd);
  const rightKeys = nextKeys.slice(start, nextEnd);
  const flags = lcsMatchFlags(leftKeys, rightKeys) || multisetFlags(leftKeys, rightKeys);

  const removedIndices = [];
  const addedIndices = [];
  for (let i = 0; i < leftKeys.length; i += 1) {
    if (!flags.matchedLeft[i]) removedIndices.push(start + i);
  }
  for (let j = 0; j < rightKeys.length; j += 1) {
    if (!flags.matchedRight[j]) addedIndices.push(start + j);
  }

  let changed = 0;
  let ri = 0;
  let ai = 0;
  while (ri < removedIndices.length && ai < addedIndices.length) {
    if (previous[removedIndices[ri]].role === next[addedIndices[ai]].role) {
      changed += 1;
      ri += 1;
      ai += 1;
    } else {
      break;
    }
  }

  return {
    added: addedIndices.length - changed,
    removed: removedIndices.length - changed,
    changed,
    addedIndices,
    addedSamples: addedIndices.map((index) => next[index]),
  };
}

function appendableSample(samples, limit) {
  // 样本自带消息在请求里的绝对下标 i；不要用 slice 的位置覆盖它。
  return { list: samples.slice(0, limit), omitted: Math.max(0, samples.length - limit) };
}

function byteLengthOf(value) {
  return Buffer.byteLength(JSON.stringify(value === undefined ? null : value), 'utf8');
}

/** 超限先砍样本、再砍 coverage，最后标记 truncated；绝不因为一条消息把账本撑爆。 */
function fitScope(scope, maxLineBytes) {
  if (byteLengthOf(scope) <= maxLineBytes) return scope;
  let current = { ...scope };
  if (Array.isArray(current.sample)) {
    current = { ...current, sample: current.sample.slice(0, 8), truncated: true };
  }
  if (byteLengthOf(current) > maxLineBytes && Array.isArray(current.sample)) {
    current = {
      ...current,
      sample: current.sample.map((item) => ({ i: item.i, role: item.role, kind: item.kind, len: item.len, sha256: item.sha256 })),
    };
  }
  if (byteLengthOf(current) > maxLineBytes && current.coverage) {
    current = { ...current, coverage: null };
  }
  if (byteLengthOf(current) > maxLineBytes && Array.isArray(current.sample)) {
    current = { ...current, sample: [] };
  }
  return current;
}

/**
 * 记录器：每个 session 保存「上次请求的消息摘要」与「inbound 索引」，有界。
 * 只做内存与 Ledger 追加，不碰文件系统与网络。
 */
function createIngressRecorder({
  ledger,
  policy = {},
  plugin = 'dsh-dashcam',
  pluginVersion = null,
  now = () => new Date().toISOString(),
  log = () => {},
  maxSessions = 128,
} = {}) {
  const settings = resolveIngressSettings(policy && policy.ingress ? policy.ingress : policy);
  const sessions = new Map();
  const pending = [];

  function requiresMatch(kind) {
    return !settings.whitelistKinds.has(kind);
  }

  function getSession(sessionId) {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'unknown';
    let session = sessions.get(key);
    if (!session) {
      session = { lastSummaries: [], inbound: new Map(), inboundOrder: [], lastRequestAt: 0 };
      sessions.set(key, session);
      if (sessions.size > maxSessions) {
        const oldest = sessions.keys().next();
        if (!oldest.done) sessions.delete(oldest.value);
      }
    } else {
      // LRU 触碰：重新插入到队尾。
      sessions.delete(key);
      sessions.set(key, session);
    }
    return { key, session };
  }

  function pruneInbound(session, reference) {
    // 用调用方传进来的逻辑时钟算 TTL，而不是 Date.now()：测试/回放注入的
    // now() 才有一致的时间线，否则合成时间戳会被真实墙钟当场剪掉。
    const nowMs = Number.isFinite(reference) ? reference : Date.now();
    const cutoff = settings.inboundTtlMs > 0 ? nowMs - settings.inboundTtlMs : null;
    while (session.inboundOrder.length > settings.inboundWindow) {
      const oldest = session.inboundOrder.shift();
      session.inbound.delete(oldest);
    }
    if (cutoff === null) return;
    while (session.inboundOrder.length > 0) {
      const oldest = session.inboundOrder[0];
      const entry = session.inbound.get(oldest);
      if (!entry || entry.at >= cutoff) break;
      session.inboundOrder.shift();
      session.inbound.delete(oldest);
    }
  }

  function write(record) {
    const entry = {
      plugin,
      pluginVersion,
      capability: INGRESS_CAPABILITY,
      decision: 'allow',
      intercepted: false,
      ...record,
    };
    // 预留 512 字节给 v/seq/ts/plugin/prevHash/hash 等外层字段，
    // 让「单行上限」接近真实行体积而不是只约束 scope。
    entry.scope = fitScope(entry.scope || {}, Math.max(256, settings.maxLineBytes - 512));
    try {
      ledger.append(entry);
    } catch (error) {
      // fail-open：请求路径不能因为审计落盘失败而失败。保留最近 256 条，
      // 由下一次成功写入前（或 dispose 前）的 flush 尝试补写。
      pending.push({ entry, error: error.message });
      while (pending.length > 256) pending.shift();
      log(`[dsh-dashcam] ingress 记录写入失败（已降级）：${error.message}`);
    }
  }

  function flush() {
    if (!ledger || pending.length === 0) return { flushed: 0, failed: 0 };
    const queued = pending.splice(0, pending.length);
    let flushed = 0;
    let failed = 0;
    for (const item of queued) {
      try {
        ledger.append(item.entry);
        flushed += 1;
      } catch (error) {
        failed += 1;
        pending.push({ entry: item.entry, error: error.message });
      }
    }
    return { flushed, failed };
  }

  return {
    settings,

    /**
     * 入站登记。kind 缺省按 'user'（保守：要求它在后续请求里出现）。
     * `content` 优先于 `text`：附件（图片/文件）也要进指纹，不能只看文本。
     * 内容只用于算指纹与 head，不落正文。
     */
    recordInbound({ sessionId, messageId = null, kind = 'user', text = '', content, ts = null } = {}) {
      try {
        const { key, session } = getSession(sessionId);
        const source = content !== undefined ? content : text;
        const summary = summarizeMessage({ role: 'user', kind, content: source }, settings);
        // 既没有文本也没有任何 part 的空输入不记账（避免把空事件刷进链）。
        if (summary.len === 0 && summary.parts === 0) {
          return { recorded: false, reason: 'empty' };
        }
        const at = Date.parse(ts || now()) || Date.now();

        // 同一 messageId 的内容变了：旧摘要不能继续留在匹配表里，否则下一轮
        // 会既报 inbound_changed、又在请求里按旧指纹对不上。
        const previous = messageId
          ? Array.from(session.inbound.values()).find((entry) => entry.messageId === messageId)
          : null;
        if (previous && previous.sha256 !== summary.sha256) {
          session.inbound.delete(previous.sha256);
          session.inboundOrder = session.inboundOrder.filter((sha) => sha !== previous.sha256);
          write({
            ts: now(),
            action: 'llm.anomaly',
            ruleId: 'ingress-anomaly',
            reason: '同一 messageId 的入站内容发生变化',
            scope: {
              sessionId: key,
              requestId: null,
              kind: 'inbound_changed',
              count: 1,
              sample: [{
                messageId,
                role: summary.role,
                kind: summary.kind,
                len: summary.len,
                sha256: summary.sha256,
                head: summary.head,
                previousSha256: previous.sha256,
              }],
            },
          });
        }

        const entry = {
          ...summary,
          messageId,
          kind,
          at,
          matched: false,
          reported: false,
        };
        session.inbound.set(summary.sha256, entry);
        if (!session.inboundOrder.includes(summary.sha256)) session.inboundOrder.push(summary.sha256);
        pruneInbound(session, at);
        write({
          ts: now(),
          action: 'llm.inbound',
          ruleId: 'ingress-inbound',
          reason: '入站消息摘要（仅元数据；正文不落账）',
          scope: {
            sessionId: key,
            messageId,
            kind,
            len: summary.len,
            head: summary.head,
            sha256: summary.sha256,
            headBytes: settings.headBytes,
          },
        });
        return { recorded: true, sha256: summary.sha256 };
      } catch (error) {
        log(`[dsh-dashcam] ingress 入站记录异常：${error.message}`);
        return { recorded: false, error: error.message };
      }
    },

    /**
     * 请求摘要 + 对账。返回值只用于测试/宿主日志，调用方不依赖它做控制流。
     * 首个请求建立基线：历史消息全部是「新增」，但没有 inbound 记录可比，
     * 此时不告警（否则任何中途接入的宿主第一次请求都会满屏误报）。
     */
    recordRequest({
      sessionId,
      requestId = null,
      provider = null,
      model = null,
      messages = [],
      tools = null,
      coverage = null,
      ts = null,
    } = {}) {
      try {
        const { key, session } = getSession(sessionId);
        const summarized = summarizeMessages(messages, settings);
        const diff = diffSummaries(session.lastSummaries, summarized.summaries);
        const addedWithIndex = diff.addedIndices.map((index) => ({ i: index, ...summarized.summaries[index] }));
        const baseline = session.lastSummaries.length === 0;
        const anomalies = [];

        for (const sample of addedWithIndex) {
          // 只有 user 角色才可能是「进来的输入」；assistant / tool / system 是请求里
          // 新生成的回合内容，不该拿去 inbound 里找对应记录（否则每轮都误报注入）。
          if (sample.role !== 'user' || !requiresMatch(sample.kind)) continue;
          const hit = session.inbound.get(sample.sha256);
          if (hit) {
            hit.matched = true;
            continue;
          }
          if (!baseline) anomalies.push({ kind: 'added_user_without_inbound', sample });
        }

        // 上一请求之前就存在、且直到本请求仍未被任何请求携带的 inbound：
        // 「客户端发了但没带上」。首次请求不判（基线未知）。
        if (!baseline) {
          for (const [sha, entry] of session.inbound) {
            if (entry.matched || entry.reported || !requiresMatch(entry.kind)) continue;
            if (entry.at <= session.lastRequestAt) {
              anomalies.push({ kind: 'dropped_inbound', sample: entry });
              entry.reported = true;
            }
          }
        }

        const addedWithoutInbound = anomalies.filter((item) => item.kind === 'added_user_without_inbound').length;
        const packed = appendableSample(addedWithIndex, settings.maxSample);
        const toolSummary = tools && typeof tools === 'object'
          ? {
            count: Array.isArray(tools) ? tools.length : Number(tools.count) || 0,
            hash: tools.hash || (Array.isArray(tools) ? `sha256:${sha256(JSON.stringify(tools))}` : null),
          }
          : null;

        write({
          ts: ts || now(),
          action: 'llm.request',
          ruleId: 'ingress-request',
          reason: 'LLM 请求消息摘要（仅元数据；正文不落账）',
          scope: {
            sessionId: key,
            requestId,
            provider,
            model,
            headBytes: settings.headBytes,
            baseline,
            tools: toolSummary,
            messages: {
              count: summarized.count,
              hash: summarized.hash,
              delta: {
                added: diff.added,
                removed: diff.removed,
                changed: diff.changed,
                addedUserWithoutInbound: addedWithoutInbound,
              },
            },
            sample: packed.list,
            omitted: packed.omitted,
            coverage: coverage && typeof coverage === 'object'
              ? { known: coverage.known ?? null, unknown: coverage.unknown ?? null }
              : null,
          },
        });

        for (const anomaly of anomalies) {
          write({
            ts: ts || now(),
            action: 'llm.anomaly',
            ruleId: 'ingress-anomaly',
            reason: anomaly.kind === 'added_user_without_inbound'
              ? '请求新增 user 消息在 inbound 中无对应记录'
              : '入站消息在后续请求中始终未被携带',
            scope: {
              sessionId: key,
              requestId,
              kind: anomaly.kind,
              count: 1,
              sample: [{
                i: anomaly.sample.i ?? null,
                role: anomaly.sample.role,
                kind: anomaly.sample.kind,
                len: anomaly.sample.len,
                sha256: anomaly.sample.sha256,
                head: anomaly.sample.head,
              }],
            },
          });
        }

        session.lastSummaries = summarized.summaries;
        session.lastRequestAt = Date.parse(ts || now()) || Date.now();
        return {
          recorded: true,
          baseline,
          count: summarized.count,
          hash: summarized.hash,
          delta: {
            added: diff.added,
            removed: diff.removed,
            changed: diff.changed,
            addedUserWithoutInbound: addedWithoutInbound,
          },
          anomalies: anomalies.map((item) => ({ kind: item.kind, sha256: item.sample.sha256 })),
        };
      } catch (error) {
        log(`[dsh-dashcam] ingress 请求记录异常：${error.message}`);
        return { recorded: false, error: error.message };
      }
    },

    flush,

    dispose() {
      sessions.clear();
      pending.length = 0;
    },
  };
}

/**
 * 离线检索：这段文字有没有出现在任何已采样的消息头里。
 * 只搜 head，不搜正文——未采样消息不在覆盖范围，输出必须写明这一点。
 */
function findIngressMatches(records, needle) {
  const target = String(needle || '');
  if (target.length === 0) return [];
  const lowered = target.toLowerCase();
  const matches = [];
  for (const record of records || []) {
    if (!record || record.capability !== INGRESS_CAPABILITY) continue;
    const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
    const samples = Array.isArray(scope.sample) ? scope.sample : [];
    for (const sample of samples) {
      if (!sample || typeof sample.head !== 'string') continue;
      if (!sample.head.toLowerCase().includes(lowered)) continue;
      matches.push({
        ts: record.ts,
        action: record.action,
        sessionId: scope.sessionId || null,
        requestId: scope.requestId || null,
        role: sample.role || null,
        kind: sample.kind || null,
        len: sample.len ?? null,
        sha256: sample.sha256 || null,
        head: sample.head,
      });
    }
  }
  return matches;
}

/** CLI 汇总：只看 ingress 记录，不影响 metrics 的判定口径。 */
function summarizeIngress(records) {
  const summary = {
    requests: 0,
    inbound: 0,
    anomalies: 0,
    anomalyKinds: {},
    baselineRequests: 0,
    sessions: new Set(),
  };
  for (const record of records || []) {
    if (!record || record.capability !== INGRESS_CAPABILITY) continue;
    const scope = record.scope && typeof record.scope === 'object' ? record.scope : {};
    if (scope.sessionId) summary.sessions.add(scope.sessionId);
    if (record.action === 'llm.request') {
      summary.requests += 1;
      if (scope.baseline === true) summary.baselineRequests += 1;
    } else if (record.action === 'llm.inbound') {
      summary.inbound += 1;
    } else if (record.action === 'llm.anomaly') {
      summary.anomalies += 1;
      const kind = String(scope.kind || 'unknown');
      summary.anomalyKinds[kind] = (summary.anomalyKinds[kind] || 0) + 1;
    }
  }
  return {
    requests: summary.requests,
    inbound: summary.inbound,
    anomalies: summary.anomalies,
    anomalyKinds: summary.anomalyKinds,
    baselineRequests: summary.baselineRequests,
    sessionCount: summary.sessions.size,
  };
}

module.exports = {
  INGRESS_CAPABILITY,
  DEFAULT_INGRESS,
  resolveIngressSettings,
  maskSecrets,
  normalizeMessage,
  summarizeMessage,
  summarizeMessages,
  diffSummaries,
  createIngressRecorder,
  findIngressMatches,
  summarizeIngress,
};
