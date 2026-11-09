# dashcam 新增记录方案：ingress 审计

> 目标：下一次出现「来源不明的用户消息」时，能在一行账本里分清它是**进来的**还是**编出来的**。
> 本文只写记录方案与落点，不改动现有 Two-Key 判定语义。

---

## 0. 结论先行

现有 dashcam 的观测面是**本机执行面**：工具调用、文件、进程、网络。幽灵消息没有产生任何这类动作，
所以账本干净是正常的。缺的不是拦截，是**请求出口（egress）与消息入口（inbound）的两条元数据流**。

本方案新增三类记录，全部落在同一条哈希链上：

| action | 作用 | 回答的问题 |
| --- | --- | --- |
| `llm.request` | 每次发往模型的请求：消息条数、整体指纹、与上次的差异、新增消息摘要 | 这次请求里**有没有**这条消息？它和上次比多了什么？ |
| `llm.inbound` | 每条真正进入会话的输入：来源 kind、长度、sha256、前 N 字 | 这条消息**走过**客户端入口吗？ |
| `llm.anomaly` | 两侧对账失败：请求里新增了 user 消息，但 inbound 找不到 | 有东西**绕过**消息通道进了上下文吗？ |

判据是四象限，不是单侧推断：

| inbound 有 | request 有 | 结论 |
| --- | --- | --- |
| ✓ | ✓ | 正常 |
| ✗ | ✓ | **注入**（或某层改了请求） |
| ✓ | ✗ | 丢失（客户端发了但没带上） |
| ✗ | ✗ | 不存在——**本次幽灵事件就落在这一格**（模型自造） |

第四象限天然不会报「注入」，这正是原报告第一轮判错方向的原因。它必须写成显式用例，而不是靠人记得。

---

## 1. 与现有机制的硬约束（先对齐，再设计）

### 1.1 Ledger 字段是固定的

[ledger.js](../../src/runtime/ledger.js) 的 `buildRecord()` 只写固定字段：
`v / seq / ts / plugin / pluginVersion / capability / action / scope / decision / ruleId / reason / intercepted / prevHash / hash / mac`。
`append()` 收到多余顶层字段会**直接丢弃**；`decision` 只接受 `allow | deny`，否则抛错。

因此新记录必须遵守：

- 全部业务字段放进 `scope`（对象），不新增顶层字段；
- 观测记录一律 `decision: 'allow'`、`intercepted: false`；
- 异常不是拦截：`ruleId: 'ingress-anomaly'`，但不写 `deny`、不写 `intercepted`；
- 继续走 `Ledger.append()`，自动继承 `seq / prevHash / mac`，离线 `verify()` 不改一行。

### 1.2 metrics 只排除 `telemetry`

[metrics.js](../../src/governance/metrics.js) 的 `isTelemetryRecord()` 只认
`capability === 'telemetry'`。新增 `llm.ingress` 若不改口径，每次请求都会进 `requests / allows`，
把拦截率与月度曲线整体稀释。

方案：把「观测类」从单一 `telemetry` 扩成集合，并新增并列读数（见 §3.3）。
**核心与宿主必须同版本上线**——宿主 `require('../../dsh-dashcam/src/index.js')`，本来就是锁步引用。

### 1.3 宿主已有「附加记录」通道

[dsh-dashcam-host/lib/index.js](../../dsh-dashcam-host/lib/index.js) 的 `appendAuxRecord()` 已证明：
非判定记录可以直接 `ledger.append()`，写失败只告警、不阻断。
`mount` / `unmapped-tool` / `unjudgeable-tool` / `proc.commandline` 都走这条路。
ingress 记录复用同一通道，不新开写入口。

### 1.4 挂载点

宿主当前只订阅 `tools/pre-execute`。ingress 需要挂在**provider 被调用之前、messages 数组定型之后**。

已按本机 DSH 安装（`resources/app.asar`，2026-11-08）核对，落点如下：

- **请求出口**：`llm/stream` waterfall。`dsh-llm` 在 `streamWithRegistration` 里调用
  `ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared))`，
  `options` 就是完整请求（`provider / model / messages / tools / sessionId / signal`）。
  监听器必须 `return next()`，否则请求被截断。
- **不采用 `agent/request`**：源码注释明确「cannot change request messages」，
  且发生在 messages 派生之前，不能用于取证。
- **消息入口**：`session/event` 的 `user/message`（签名 `(session, event)`，
  `event.data.source.kind` 可用），与幽灵报告读取的会话日志同源。
- **不采用 `agent/inbox/spliced`**：它是投递事件，条目可能随后被取消；
  `user/message` 才是真正进面的 durable 事实。

两个事件名都可用 `config.ingress.requestEvent / inboundEvent` 覆盖。
**接不上必须可见**：挂载/关闭都写 `telemetry/ingress-mount | ingress-disabled`，
写明监听了什么，不静默关闭（P7 的教训：桌面版看不到 stdout）。

---

## 2. 记录格式

### 2.1 `llm.request`（每次请求一条）

```json
{
  "capability": "llm.ingress",
  "action": "llm.request",
  "decision": "allow",
  "ruleId": "ingress-request",
  "reason": "LLM 请求消息摘要（仅元数据；正文不落账）",
  "intercepted": false,
  "scope": {
    "sessionId": "<sessionId>",
    "requestId": "req-...",
    "provider": "<provider>",
    "model": "<model>",
    "headBytes": 80,
    "tools": { "count": 18, "hash": "sha256:..." },
    "messages": {
      "count": 42,
      "hash": "sha256:...",
      "delta": { "added": 2, "removed": 0, "changed": 0, "addedUserWithoutInbound": 1 }
    },
    "sample": [
      {
        "i": 41,
        "role": "user",
        "kind": "user",
        "len": 21,
        "head": "（示例：一条用户指令，原文已略）",
        "sha256": "sha256:...",
        "parts": 1,
        "attachments": [{ "kind": "image", "idHash": "sha256:...", "size": 231044 }]
      },
      {
        "i": 42,
        "role": "user",
        "kind": "runtime-context",
        "len": 10830,
        "head": "（记忆快照，前 80 字）",
        "sha256": "sha256:...",
        "parts": 1
      }
    ],
    "omitted": 0,
    "coverage": { "known": 41322, "unknown": 0 }
  }
}
```

字段口径：

- **`messages.hash`**：按顺序对每条 `sha256(role + "\u0000" + text)`，再对拼接结果求一次 sha256。
  同一份输入两次请求指纹必须相同；改一个字节就变。
- **`delta`**：与**同 session 上一次请求**比较，按 `(role, sha256)` 序列做 LCS；
  只记计数 + 新增样本，不记全量差异。
- **`sample`**：只放新增/变更的消息（首请求放前 N 条），上限 `maxSample`（默认 32）。
  全量消息只贡献 hash，不逐条落账。
- **`kind`**：消息来源 `source.kind`（`user` / `runtime-context` / `time-context` /
  `compaction` / `plugin:memory` / `skill-catalog` / `tool` / 未知按 `unknown`）。
  **白名单按 kind 而不是 role**——本事件会话里 54 条 user 消息中只有 27 条是真人，
  按 role 白名单第一分钟就会误报。
- **`attachments`**：只记图片/文件的身份哈希与大小，不抓取内容。
  幽灵事件里「让看几张图但一张没来」，这一列是唯一能当场看出来的字段。
- **`coverage`**：provider 自报的 `known / unknown`，**只作辅助信号**。
  provider 自己算错时 `unknown=0` 也不能证明清白，判据仍是 §2.3 的差集。

### 2.2 `llm.inbound`（每条入站一条）

```json
{
  "capability": "llm.ingress",
  "action": "llm.inbound",
  "decision": "allow",
  "ruleId": "ingress-inbound",
  "intercepted": false,
  "scope": {
    "sessionId": "<sessionId>",
    "messageId": "...",
    "kind": "user",
    "len": 21,
    "head": "（示例：一条用户指令，原文已略）",
    "sha256": "sha256:..."
  }
}
```

- 来源事件：`session/event` 的 `user/message`（已按本机 DSH 核对）；**不扫正文**，
  只取 `source.kind / id / content 长度 / sha256 / 附件身份`。
  `agent/inbox/spliced` 是投递事件、条目可被取消，不作为 inbound 基准。
- 只对 `kind` 不在白名单里的消息要求「必须出现在请求里」；系统注入类只登记、不参与告警。
- 每 session 内存索引有界（默认最近 500 条 / 1 小时），不落第二份完整对话。

### 2.3 `llm.anomaly`（对账失败一条）

```json
{
  "capability": "llm.ingress",
  "action": "llm.anomaly",
  "decision": "allow",
  "ruleId": "ingress-anomaly",
  "reason": "请求新增 user 消息在 inbound 中无对应记录",
  "intercepted": false,
  "scope": {
    "sessionId": "<sessionId>",
    "requestId": "req-...",
    "kind": "added_user_without_inbound",
    "count": 1,
    "sample": [{ "role": "user", "len": 6231, "sha256": "sha256:...", "head": "（示例：一段无来源的改版需求文本，原文已略）" }]
  }
}
```

异常类型：

| kind | 触发 | 处置 |
| --- | --- | --- |
| `added_user_without_inbound` | 请求新增 user 消息，inbound 无匹配 | 记录 + console 告警；**不拦截** |
| `dropped_inbound` | inbound 有 user 消息，后续请求始终没带上 | 记录（另一类 bug） |
| `inbound_changed` | 同一 messageId 的 sha256 变了 | 记录 |

匹配顺序：`sha256` 精确 → `messageId` → `(role, len)` 弱匹配（命中也标 `weak: true`）。
**`llm.anomaly` 永远不写 `deny`**：观测层一旦会拦请求，第一次误报就会把用户挡在门外，
而本方案的第一目标是「有据可查」，不是「自动执法」。

---

## 3. 代码落点

### 3.1 核心新增 `src/runtime/ingress.js`

纯函数 + 一个有状态记录器，不依赖 Bridge、不做 IO：

```js
// 纯函数（可直接单测）
summarizeMessage(message, { headBytes, maskSecrets })
summarizeMessages(messages, { headBytes, maxSample, maskSecrets })
  // → { count, hash, summaries, omitted }
diffSummaries(previous, next)
  // → { added, removed, changed, addedSamples }

// 记录器
createIngressRecorder({ ledger, policy, now, log })
  .recordInbound({ sessionId, messageId, kind, text, ts })
  .recordRequest({ sessionId, requestId, provider, model, messages, tools, coverage })
  .dispose()
```

要点：

- 每个 session 保存 `lastSummaries` 与 `inboundIndex`，有界 LRU，`dispose()` 清空。
- 每条消息的 sha256 用 `WeakMap<message, hash>` 缓存：前缀缓存场景下多数消息对象不变，
  重复请求不重复哈希正文。
- `headBytes = 0` 时只写 `len / sha256`，不写 `head`；`maskSecrets` 复用宿主已有的
  `maskSecrets()`（Bearer / `sk-` / `ghp_` / `password=` 等），并保留残余风险说明。
- 单条记录体积上限 `maxLineBytes`（默认 8 KiB）：先砍 `sample`，再砍 `coverage`，
  最后写 `truncated: true`，绝不因为一条消息过大把账本撑爆。
- `ledger.append()` 包在 `try/catch` 里：失败进内存环形缓冲（默认 256 条）+ 写一次
  `<ledgerPath>.guard.log`，**任何情况下都不向请求路径抛错**（fail-open）。

### 3.2 核心导出与策略

- `src/index.js` 增加 `...require('./runtime/ingress')`。
- `src/policy.js` 增加 `DEFAULT_POLICY.ingress` 与 `resolveIngress()`：

| 键 | 默认 | 校验 |
| --- | --- | --- |
| `enabled` | `true` | 布尔 |
| `headBytes` | `80` | 整数 0–512（0 = 只存 hash/长度） |
| `maxSample` | `32` | 整数 1–512 |
| `maxLineBytes` | `8192` | 整数 ≥ 1024 |
| `inboundWindow` | `500` | 整数 ≥ 1 |
| `inboundTtlMs` | `3600000` | 整数 ≥ 0 |
| `maskSecrets` | `true` | 布尔 |
| `whitelistKinds` | `["runtime-context","time-context","compaction","plugin:memory","skill-catalog","tool","system"]` | 字符串数组 |

非法值直接抛错，理由与 `resolveLimits()` 相同：`headBytes: 'abc'` 这类值会让上限比较恒为 false，
属静默 fail-open。

### 3.3 metrics 口径

```js
const OBSERVATION_CAPABILITIES = new Set(['telemetry', 'llm.ingress']);
const isObservationRecord = (r) => OBSERVATION_CAPABILITIES.has(r && r.capability);
```

- `decisions` 过滤掉两类观测记录；现有 `requests / allows / denies / interceptionRate`
  对旧账本读数**不变**。
- 新增并列读数：`ingressRequests`、`ingressInbound`、`ingressAnomalies`、`ingressAnomalyRate`。
- `telemetryRecords / telemetryDenies` 语义保持只统计 `telemetry`，不被请求记录稀释。
- `interceptions()` 不变（ingress 的 `intercepted` 恒为 `false`）。

### 3.4 宿主新增 `dsh-dashcam-host/lib/ingress.js`

```js
export function attachIngress(ctx, { ledger, config, guardLog }) { ... return { dispose } }
```

- `lib/index.js` 在 `activate()` 成功后调用；`ctx.effect(() => dispose)`。
- 配置走宿主 `config.ingress`（与 `patchBuiltins` 同级），默认启用。
- 归一化 DSH 消息：`content` 为字符串或 parts 数组；文本取 `text`，图片/文件取
  `fileId / sha256 / size`，其余 part 只记 type。任何无法识别的形状都退化成
  `{ role, len, sha256 }`，不抛错。
- 事件缺失或签名不符：写 `telemetry/ingress-mount | ingress-disabled` 说明监听项，不静默关闭。

### 3.5 CLI

```powershell
# 先校验再读（与 metrics 同口径：mac_key_missing 直接非零退出）
node bin/dsh-dashcam.js ingress <ledger.jsonl> --session <id> [--mac-key-file <f>]

# 幽灵回归：这段文字有没有进过任何请求
node bin/dsh-dashcam.js ingress <ledger.jsonl> --find "状态栏"
```

输出：

- 请求数 / inbound 数 / 异常数；
- 每个异常的时间、session、requestId、`len`、`head`、`sha256`；
- `--find` 只在**已采样的 `head`** 里搜，明确标注「未采样消息不覆盖」，
  避免把「没搜到」说成「没发生」。

### 3.6 版本与文档

- 核心 `README.md` 增加「ingress 记录」小节与 1.12.0 条目；
- `docs/SPEC.md` §6.2 账本字段表补一句：`capability='llm.ingress'` 为观测记录，
  不参与 Two-Key，不产生 allow/deny 语义；
- `docs/ROLLOUT.md` 第 6 节补 metrics 新读数口径；
- 宿主 README 补 `config.ingress` 表与事件发现步骤。

---

## 4. 分阶段

| 阶段 | 内容 | 交付判据 |
| --- | --- | --- |
| **P0** | 核心 `ingress.js` + `llm.request`（hash + delta）+ 宿主 egress 接线 + metrics 口径 | 账本每次请求一行；同一输入指纹相同；`--find` 可用；旧账本 metrics 读数不变 |
| **P1** | `llm.inbound` + `llm.anomaly` + CLI 异常视图 | 正常轮 0 异常；模拟注入 1 条异常并指到 sha256 |
| **P2** | 契约化：`llm.request` 成为 manifest 可声明能力；`enforce` 下未声明是否拒绝（默认仍 advisory）；provider 响应元数据（requestId / usage / coverage） | 开关可回滚；关闭时留一条 `ingress-disabled` 记录 |
| **P3（可选）** | 响应侧元数据（输出 head/hash，不存推理全文），把「请求里没有、输出里有」的关联做成 `--find` 的一步 | 幽灵回归用例可全自动跑 |

先做 P0 的理由：`messages.hash + delta` 不依赖 inbound，单侧就能回答
「这次请求和上次比多了什么」。本次事件里若有它，17:45:59 就能看到「新增了一条 user 消息」，
而不是等用户反问「我真的发了吗」。

---

## 5. 验收用例（先写用例，再写实现）

1. **正常轮**：一人一句，`addedUserWithoutInbound = 0`，无 `llm.anomaly`。
2. **系统注入白名单**：`runtime-context` / `compaction` / `plugin:memory` / `skill-catalog`
   各加一条，异常数仍为 0；但它们在 `llm.request.sample` 里可见。
3. **模拟注入**：请求 messages 中插入一条 `role=user`、无 inbound 的消息 →
   恰好 1 条 `added_user_without_inbound`，`sample[0].sha256` 等于该条摘要。
4. **模型自造（本次事件的直接回归）**：请求 messages 始终不含某段文本，只有模型输出含它 →
   `llm.anomaly` **必须为 0**；`ingress --find` 在该账本上返回 0 条请求命中。
   这条是 P0 必测项，不能降级。
5. **写失败**：账本只读/磁盘满 → 请求照常完成，`guard.log` 有一条降级记录。
6. **指纹稳定**：同一 messages 两次请求 `messages.hash` 相同；改一个字符后不同。
7. **diff 正确**：新增 2、删除 1、修改 1 时三个计数准确；乱序不误判为全量变更。
8. **隐私开关**：`headBytes = 0` 时记录里没有 `head` 字段，任何消息正文都不落账。
9. **体积**：1000 条消息、单条 200 KB → 单行 ≤ `maxLineBytes`，`omitted / truncated` 有值。
10. **指标隔离**：混入 100 条 `llm.request` 后，`requests / interceptionRate` 与不含时完全一致，
    `ingressRequests = 100`。
11. **mac 兼容**：v3 账本（带 macKey）追加 ingress 记录后 `verify()` 仍 `ok`；
    无密钥校验 v3 仍报 `mac_key_missing`。
12. **会话缺失**：`sessionId` 为空时写 `"unknown"`，记录仍落账，不抛错。

---

## 6. 已知边界（不隐藏）

- **服务端前缀不在观测范围**：本方案记录的是**客户端发出去的** messages。
  如果 provider 层在客户端之后追加/改写前缀，本地 egress 与「模型自造」长得一样。
  `coverage.unknown` 只是辅助信号，不能当实锤；要钉死必须让 provider 暴露最终 messages
  或服务端前缀 hash（P2/P3）。
- **模型推理不可见**：dashcam 记录不到 reasoning 文本，只能证明「请求里没有 X」。
  「X 是编的」是**推论**，不是本工具的直接观测。
- **采样有损**：`sample` 只留新增/变更消息，`head` 只留前 N 字；
  `--find` 搜不到不等于没发生。这是体积与可诊断性的取舍，必须在输出里写明。
- **inbound 源依赖宿主事件**：`session/event` 的 `user/message` 已在本机 DSH 核对可用；
  若未来版本改签名，宿主会写 `telemetry/ingress-mount` 说明监听项，可改配置回退，
  不假装有对账。
- **head 可能含敏感内容**：默认 80 字节 + `maskSecrets` 是 best-effort；
  高敏环境应设 `headBytes: 0`。
- **不解决 `compress` 不校验区间**：那是工具侧输入校验问题，与本记录方案正交。
  建议单独修：`compress` 对未知消息编号必须报错，而不是盖章。

---

## 7. 实施状态（1.12.0，2026-11-08）

已落地：

- 核心 [ingress.js](../../src/runtime/ingress.js)：`summarizeMessage(s)` / `diffSummaries` /
  `createIngressRecorder` / `findIngressMatches` / `summarizeIngress`。
- 策略：`policy.ingress`（含 `enabled` 与 §3.2 的全部键），非法值 fail-fast。
- metrics：`llm.ingress` 与 `telemetry` 一并排除出判定口径，另列
  `ingressRecords / ingressRequests / ingressInbound / ingressAnomalies / ingressAnomalyRate`。
- 宿主：`lib/ingress.js` 订阅 `llm/stream`（请求，waterfall）与 `session/event`
  （入站，过滤 `user/message`），均可配置；挂载/关闭都写
  `telemetry/ingress-mount|ingress-disabled`，写明监听项。
- CLI：`dsh-dashcam ingress <ledger> [--session <id>] [--find <text>]`，先验签再统计。
- 用例：`test/ingress.test.js` 覆盖指纹稳定、附件身份、diff、白名单、注入、丢输入、
  第四象限回归、fail-open、体积上限、mac 验签、metrics 隔离、策略校验；
  宿主 `test/ingress-host.mjs` 覆盖事件接线与端到端落账。

实施中的三点修正：

1. 消息指纹额外包含**附件身份**（`role \0 text \0 附件 idHash`）。只算正文时，
   「同一句话配不同图」与「只有图没有字」会撞成同一个指纹——本事件的图片缺失正需要这一列。
2. `llm.request` 与异常记录多一个 `baseline` / 采样下标 `i`：前者用于「中途接入宿主时首请求不告警」，
   后者让样本能定位到请求里的真实消息位置，而不是样本数组里的偏移。
3. **对账只认 `role=user`**：assistant / tool / system 是请求里新生成的回合内容，
   不在 inbound 里找对应记录。1.12.0 首跑真实会话时，工具结果与模型回复被误报成
   `added_user_without_inbound`；修正后同类请求 0 异常，真正的无源 user 消息仍会报。
   用例见 `test/ingress.test.js`「助手/工具消息新增不算注入」。

事件名已在本机 DSH 安装中核对（`resources/app.asar`，2026-11-08）：
请求出口 `llm/stream`（waterfall，载荷为完整请求，必须 `return next()`），
入站 `session/event`（`(session, event)`，只取 `user/message`）。
两个键都可配置；本机核对依据见 §1.4。

---

## 8. 一句话

> 旧账本记的是「谁动了什么」；新增的这三类记录记的是「谁说了什么、以谁的身份进来的」。
> 它不能判断内容真假，但能让「不在请求里」这句话第一次有工具输出作为依据——
> 而不是只有记忆和推断。
