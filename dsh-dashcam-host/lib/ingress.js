// ingress 审计接线：把 DSH 的「发往模型的请求」与「进入会话的输入」摘要进账本。
//
// 事件名已按本机安装的 DSH（resources/app.asar）核对：
//   - 请求出口：`llm/stream` waterfall，载荷就是完整的请求对象
//     `{ provider, model, messages, tools, sessionId, signal }`（dsh-llm 的
//     `streamWithRegistration` 里调用 `ctx.waterfall(this, 'llm/stream', options, ...)`）。
//     `agent/request` 虽然还在，但源码注释明确「cannot change request messages」，
//     且发生在 messages 派生之前，不能用于取证。
//   - 消息入口：`session/event` 里的 `user/message`（与幽灵报告读取的会话日志同源）。
//     `agent/inbox/spliced` 是投递事件，条目可能随后被取消；`user/message` 是
//     真正进面的消息，更适合当 inbound 基准。
//
// 设计边界：
//   - 只记元数据（role / len / head80 / sha256 / 附件身份），不落正文；
//   - 不做判定、不拦截、不抛错：任何记录异常都不影响请求；
//   - 两个事件名都可用 config.ingress.requestEvent / inboundEvent 覆盖；
//     接不上时由宿主写 telemetry/ingress-mount 说明监听了什么，不静默关闭。
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const dashcam = require('../../src/index.js');

const DEFAULT_REQUEST_EVENT = 'llm/stream';
const DEFAULT_INBOUND_EVENT = 'session/event';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pickSessionId(payload) {
  if (!payload || typeof payload !== 'object') return 'unknown';
  return payload.sessionId
    || payload.sessionID
    || payload.id
    || (payload.session && payload.session.id)
    || (payload.header && payload.header.id)
    || 'unknown';
}

function pickMessages(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.messages,
    payload.request && payload.request.messages,
    payload.conversation && payload.conversation.messages,
    payload.payload && payload.payload.messages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function pickTools(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [
    payload.tools,
    payload.request && payload.request.tools,
    payload.payload && payload.payload.tools,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      // 工具定义也可能很长：只记数量与整体指纹，不逐条落账。
      return { count: candidate.length, hash: `sha256:${sha256(JSON.stringify(candidate))}` };
    }
  }
  return null;
}

/** 把 LLM 请求归一化成 recorder 需要的最小形状；形状不认识就返回 null。 */
export function normalizeRequestPayload(payload) {
  const messages = pickMessages(payload);
  if (!messages) return null;
  return {
    sessionId: pickSessionId(payload),
    requestId: payload.requestId || payload.requestID || null,
    provider: payload.provider || payload.providerId || null,
    model: payload.model || payload.modelId || null,
    messages,
    tools: pickTools(payload),
    coverage: payload.coverage || null,
  };
}

/**
 * 会话事件 → 入站条目。只认 `user/message`，其余事件（tool/result、
 * developer/message、assistant/message）不是「用户进来的输入」。
 */
export function normalizeSessionEvent(session, event) {
  if (!event || typeof event !== 'object' || event.type !== 'user/message') return null;
  const message = event.data;
  if (!message || typeof message !== 'object') return null;
  const content = message.content !== undefined ? message.content : message.text;
  if (content === undefined || content === null) return null;
  return {
    sessionId: pickSessionId(session),
    messageId: message.id || message.messageId || null,
    kind: (message.source && message.source.kind) || message.kind || 'user',
    content,
  };
}

/** 兼容自定义 inboundEvent：载荷可能是单条、数组，或 { entries: [...] }。 */
export function normalizeInboundPayload(payload) {
  if (!payload) return [];
  const entries = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload.entries) ? payload.entries : [payload]);
  // 事件载荷通常在顶层带 sessionId，条目里不一定有：先继承顶层，再让条目覆盖。
  const parentSessionId = pickSessionId(payload);
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const message = entry.message && typeof entry.message === 'object' ? entry.message : entry;
      const content = message.content !== undefined ? message.content : message.text;
      if (content === undefined || content === null) return null;
      if (typeof content === 'string' && content.length === 0) return null;
      const entrySessionId = pickSessionId(entry);
      const messageSessionId = pickSessionId(message);
      return {
        sessionId: entrySessionId !== 'unknown'
          ? entrySessionId
          : (messageSessionId !== 'unknown' ? messageSessionId : parentSessionId),
        messageId: message.id || message.messageId || entry.messageId || null,
        kind: (message.source && message.source.kind)
          || (entry.source && entry.source.kind)
          || message.kind
          || 'user',
        content,
      };
    })
    .filter(Boolean);
}

/**
 * 挂载 ingress 记录器并订阅请求/入站事件。
 * 返回 { enabled, dispose, recorder, requestEvent, inboundEvent }。
 */
export function attachIngress(ctx, {
  ledger,
  policy = {},
  plugin = 'dsh-dashcam-host',
  pluginVersion = null,
  config = {},
  log = console.warn,
} = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  if (settings.enabled === false || !ledger) {
    return {
      enabled: false,
      requestEvent: null,
      inboundEvent: null,
      recorder: null,
      dispose() {},
    };
  }

  const recorder = dashcam.createIngressRecorder({
    ledger,
    policy,
    plugin,
    pluginVersion,
    log: (message) => log(message),
  });
  const requestEvent = settings.requestEvent || DEFAULT_REQUEST_EVENT;
  const inboundEvent = settings.inboundEvent || DEFAULT_INBOUND_EVENT;

  // waterfall 监听器必须返回 next()；记录本身同步完成，不 await 流。
  const onRequest = (payload, next) => {
    try {
      const normalized = normalizeRequestPayload(payload);
      if (normalized) {
        recorder.recordRequest(normalized);
        // 每次请求成功后顺带补写失败队列；失败队列本身也有上限，不会无限涨。
        recorder.flush();
      } else {
        log(`[dsh-dashcam] ingress：${requestEvent} 载荷里没有 messages 数组，已跳过`);
      }
    } catch (error) {
      log(`[dsh-dashcam] ingress 请求事件异常（已忽略）：${error.message}`);
    }
    return typeof next === 'function' ? next() : undefined;
  };

  // `session/event` 的签名是 (session, event)；自定义事件仍按单参处理。
  const onInbound = (first, second) => {
    try {
      const entries = second && typeof second === 'object' && typeof second.type === 'string'
        ? [normalizeSessionEvent(first, second)].filter(Boolean)
        : normalizeInboundPayload(first);
      for (const entry of entries) recorder.recordInbound(entry);
    } catch (error) {
      log(`[dsh-dashcam] ingress 入站事件异常（已忽略）：${error.message}`);
    }
  };

  ctx.on(requestEvent, onRequest);
  ctx.on(inboundEvent, onInbound);

  return {
    enabled: true,
    recorder,
    requestEvent,
    inboundEvent,
    dispose() {
      try {
        if (typeof ctx.off === 'function') {
          ctx.off(requestEvent, onRequest);
          ctx.off(inboundEvent, onInbound);
        }
      } catch {
        // 卸载失败不影响 deactivate
      }
      recorder.dispose();
    },
  };
}
