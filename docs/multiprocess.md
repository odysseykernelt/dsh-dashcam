# dsh-covenant 多进程运行时原型 · 设计文档

> 状态：**设计稿（未实现）**，作为后续实现依据。
> 对齐口径：`docs/SPEC.md`（下文简称 SPEC，引用其章节号）。术语以 SPEC 为唯一口径，冲突时以 SPEC 为准。
> 本文不写实现代码，只写接口签名与消息 JSON 示例。

---

## 1. 目标与不变量

**一句话定性**：把信任边界从「同进程 monkey-patch」搬家到「进程边界 + 窄 RPC」——插件代码进子进程，宿主通过一条只认结构化消息的 RPC 通道替它执行 IO，子进程里不再存在可被插件直接触碰的原生 `fs` / `net` / `proc`。

三条不变量（继承并强化 SPEC §1）：

1. **子进程不持有任何原生能力句柄**。插件能拿到的只有「远程调用桩」（RPC stub），桩背后没有宿主侧的 fd、Socket、`child_process` 句柄、`process.binding` 引用、`Ledger` 实例或 `guard` 引用。子进程内存里没有任何可以直接落盘/联网/起进程的入口。
2. **每次能力调用都过宿主 guard**。桩把一次调用翻译成一条 `request` 消息，宿主收到后必须走完整守卫链（`derive → blacklist/integrity → Two-Key → One-Seal`，SPEC §6），`guard.enforce` 通过之后才由宿主侧执行器真正执行 IO。判定与执行同属宿主进程，中间不存在插件可插入的执行流。
3. **审计只在宿主写**。`Ledger` 只存在于宿主进程，`append` 只发生在宿主判定路径上（SPEC §6.2）。子进程既不持有 `Ledger` 引用，也不产生任何账本写行为；账本的单写者契约（`ledger.js` 顶部注释）在单宿主进程内自然保持。

配套语义不变量（沿用 SPEC §1）：

- **默认拒绝**：子进程默认授予集为空，桩仍可发请求，但宿主按 deny-all 判定（SPEC §1.1）。
- **审计先于执行**：`guard.enforce` 内部的 `Ledger.append` 在副作用发生前完成，写失败按失败关闭拒绝（SPEC §1.4）。多进程下「先于执行」=「先于宿主执行器真正调用原生 fs/net/proc」。
- **拒绝可解释**：拒绝原因原样经 `response.error.reason` 回传子进程，宿主不做二次包装（SPEC §1.3）。

---

## 2. 架构图（ASCII）

```
┌─────────────────────────────── 宿主进程 (Host) ───────────────────────────────┐
│                                                                                │
│  ┌─────────────┐   装载/注册/调用/卸载（LocalHost 改造）                        │
│  │ LocalHost   │ ───────────────┐                                               │
│  └─────────────┘                │ fork + 建 RPC                                │
│                                 ▼                                               │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │ RPC Server（宿主侧，新增）                                            │      │
│  │  · schema 校验（op/payload/id 白名单与类型）                          │      │
│  │  · 消息上限 / 序列化校验 / 禁止 eval                                   │      │
│  │  · id 关联（pending 表、重复/乱序/未知 id 拒绝）                       │      │
│  └───────────────┬─────────────────────────────────────────────────────┘      │
│                  │  op + payload（结构化数据，无函数/Buffer）                    │
│                  ▼                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │ 能力执行器 CapabilityExecutor（宿主侧，新增，复用 handles/* 语义）      │      │
│  │   guard.enforce(op, payload)  ──→  写 Ledger  ──→  真正调原生 fs/net/proc  │
│  └───────────────┬─────────────────────────────────────────────────────┘      │
│                  │                                                             │
│  ┌───────────────┴───────────────┐   ┌──────────────┐  ┌───────────────────┐  │
│  │ guards.js（不变，全部留在宿主） │   │ ledger.js    │  │ derive.js（不变）  │  │
│  │  Two-Key / One-Seal / 黑名单   │   │ JSONL 哈希链  │  │ 能力推导          │  │
│  └───────────────────────────────┘   └──────────────┘  └───────────────────┘  │
│                                                                                │
└───────────────────────────────┬────────────────────────────────────────────────┘
                                 │  进程间通道：child_process IPC（结构化克隆）
                                 │  只传 JSON 可表达的结构化数据
                                 ▼
┌─────────────────────────────── 子进程 (Plugin Worker) ─────────────────────────┐
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │ RPC Stub（子进程侧，新增；由 inject.js 思路改造而来）                  │      │
│  │  require('fs') / require('node:fs') / require('fs/promises')          │      │
│  │  require('child_process') / require('net') / require('http'...)  → 桩  │      │
│  │  桩方法 = 发 { id, kind:'request', op, payload }，await 对应 response   │      │
│  └───────────────────────────────┬─────────────────────────────────────┘      │
│                                  │ 无原生 fs/net/proc 可达                      │
│                                  ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │ 插件入口 + 依赖（插件自己的 JS，含 node_modules）                       │      │
│  │  能做的：纯计算、调用桩（= 经宿主 guard 的能力调用）                     │      │
│  └─────────────────────────────────────────────────────────────────────┘      │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

组件归属一览：

| 组件 | 归属进程 | 多进程下角色 |
| --- | --- | --- |
| `guards.js`（守卫链） | 宿主 | 不变，判定唯一发生地 |
| `ledger.js` | 宿主 | 不变，审计唯一写者 |
| `derive.js` | 宿主 | 不变，`op+payload → capability+scope` |
| `handles/*` 语义 | 宿主侧=执行器；子进程侧=桩的方法清单 | 封闭面（closed set）两边复用 |
| `inject.js` 思路 | 子进程 bootstrap | 从「可选 handles 重定向」升级为「child 模式的强制前置」 |
| `bridge.js`（monkey-patch） | **退役**（child 路径不需要） | 纯翻译函数（`firstCommand` 等）保留复用 |
| `local-host.js` | 宿主 | 改造：register=fork+建通道，invoke=控制消息转发，uninstall=回收子进程 |
| RPC Server / RPC Stub | 宿主 / 子进程 | 新增 |

---

## 3. 与现状的差异表（逐文件去留）

| 文件 | 现状角色（SPEC 依据） | 多进程模型下的去留与变化 |
| --- | --- | --- |
| `src/runtime/bridge.js` | 同进程 patch `fs/net/proc/env/worker/glob/fetch`，把原生调用翻译成 operation 后进守卫链（SPEC §6） | **退役**：child 路径里子进程没有原生模块可 patch，宿主执行 IO 走执行器、不经过 patch。**保留复用**其纯翻译函数：`firstCommand`（`proc.spawn` 命令口径）、`toPathString`、`capabilityNeedsForOpen`（flags→能力面）、`KNOWN_GAPS` 里「TOCTOU / vm / 原生扩展」三条描述继续作为多进程动机引用。 |
| `src/runtime/handles/fs.js` `net.js` `proc.js` | 封闭能力句柄，每次调用过 guard，只认路径不认 fd，对象冻结（SPEC §6.3） | **语义保留、形态拆分**：封闭方法清单（closed set）成为「RPC 桩在子进程暴露的方法白名单」；宿主侧把 `guard.enforce` 后的原生调用收敛成一个 `CapabilityExecutor`。`open()` 返回受限 FileHandle、`net` 不提供 `listen` 等封闭性约束逐条保留。 |
| `src/runtime/handles/inject.js` | `Module._load` 重定向 `require('fs') → 能力句柄`，`policy.sandbox.mode='handles'` 显式选项（SPEC §6.4） | **机制保留、位置与强制级别改变**：搬到**子进程 bootstrap**，且从「可选」变为「child 模式强制前置」。重定向目标从「宿主侧句柄」换成「RPC 桩」。同进程单条重定向的约束变成「每子进程一条」。 |
| `src/runtime/guards.js` | 守卫链：`derive → 黑名单/完整性 → Two-Key → One-Seal → Ledger`（SPEC §6） | **几乎不变，全部留在宿主**。`guard.enforce/enforceBatch/check` 原样作为执行器入口。差异：`installNativeHooks/beginObserve/endObserve` 的「同进程装载窗口」语义在 child 模式**不再适用**（装载发生在子进程，宿主观察不到子进程内存调用），装载窗口改为「子进程 bootstrap 期间只装桩、不提前放行」。 |
| `src/runtime/ledger.js` | JSONL 哈希链 + 可选 HMAC，单写者（SPEC §6.2） | **不变，只在宿主写**。子进程无 `Ledger` 引用；`macKey` 依旧只存在于宿主内存。 |
| `src/host/local-host.js` | 装 → 注册（require+装 Bridge）→ 调用 → 卸载 四段（SPEC §7 loadability 的执行宿主） | **改造**：`register` 从「本进程 `compileEntry` + 装 Bridge」改为「`fork` 子进程 + 建 RPC 通道 + 引导桩」；`invoke` 从「本进程 `module.invoke()`」改为「发控制消息 `op:'invoke'` 到子进程、等回执」；`uninstall` 增加「杀子进程 / 回收孤儿 / 关通道」。门禁流水线（SPEC §7）与 `install/admit` 不变。 |

**一句话总结差异**：判定与审计模块（guards/ledger/derive）原地不动、只搬家到宿主侧执行；「如何给插件一个能力面」从「patch 原生模块（bridge）或给封闭句柄（handles）」变成「给一个会发消息的桩（stub）」。

---

## 4. RPC 协议要点

通道 = `child_process.fork` 自带的 IPC（`process.send` / `child.on('message')`，结构化克隆序列化）。**只传 JSON 可表达的结构化数据**：允许 string / number / boolean / null / 普通对象 / 数组；**禁止函数、禁止 `Buffer`/`TypedArray`、禁止类实例、禁止带 `toJSON` 副作用的对象**（二进制统一走 base64 字符串，见 §7）。

### 4.1 三种消息形状

**请求（子进程 → 宿主，一次能力调用）**

```json
{ "id": 42, "kind": "request", "op": "fs.read", "payload": { "path": "cache.json" } }
```

**响应（宿主 → 子进程，一次请求的结果）**

```json
{ "id": 42, "kind": "response", "ok": true,  "value": "{\"a\":1}" }
{ "id": 42, "kind": "response", "ok": false, "value": null, "error": { "code": "scope_mismatch", "reason": "未覆盖 /etc/passwd 的读取" } }
```

**控制消息（双向，生命周期 / 调用 / 就绪）**

```json
{ "kind": "control", "op": "invoke",   "id": 7, "action": "ping", "args": [] }   // 宿主 → 子进程：调插件
{ "kind": "control", "op": "invoke-result", "id": 7, "ok": true, "value": { "pong": true } } // 子进程 → 宿主
{ "kind": "control", "op": "ping",     "id": 8 }                                  // 宿主 → 子进程：健康检查
{ "kind": "control", "op": "pong",     "id": 8 }                                  // 子进程 → 宿主
{ "kind": "control", "op": "ready" }                                              // 子进程 → 宿主：bootstrap 完成
{ "kind": "control", "op": "shutdown" }                                           // 宿主 → 子进程：请求退出
```

`op` 取值与 SPEC §3 能力分类对齐：`fs.read` / `fs.write` / `fs.delete`、`net.outbound` / `net.listen`、`proc.spawn` / `proc.signal`、`env.read` / `env.write`、`cred.read` / `cred.write`。每个 `op` 有其 `payload` schema（例如 `fs.read { path: string }`、`net.outbound { host: string, port: number }`、`proc.spawn { command: string }`），schema 在宿主侧硬编码，未知 `op` 一律拒绝。

### 4.2 id 关联

- `id` 是**子进程内单调递增的正整数**，由桩分配；`response` 原样回显。
- 桩维护 `pending: Map<id, {resolve, reject, op, timer}>`，收到 `response` 时按 `id` 取出 settle。
- 宿主校验：`id` 非正整数、重复（已 pending）、未登记过的 id 出现在 `response` 里 → 视为协议违例，丢弃并计数。
- 每条 request 携带超时（`policy.limits.ipcTimeoutMs`，新增，见 §7/§12），超时 `reject` 为 `ipc_timeout`，并从 `pending` 移除；迟到的 `response` 因 id 已注销而被宿主/桩丢弃。

### 4.3 错误码

复用 `CovenantDenied.ruleId` 现有码（SPEC §5/§6）：`not_declared`、`legacy`、`derive_failed`、`scope_mismatch`、`not_granted`、`one_seal_exhausted`、`integrity_compromised`、`blacklisted`、`ledger`、`fd_recheck`、`batch_too_large`。

新增 IPC 层错误码（与「能力判定失败」区分开，判定失败用原 ruleId，通道失败用 `ipc_*`）：

| 码 | 含义 |
| --- | --- |
| `schema_invalid` | op 未知，或 payload 不满足该 op 的 schema（缺字段/类型错/多余敏感字段） |
| `message_too_large` | 单条消息序列化后超过上限（`policy.limits.maxMessageBytes`） |
| `serialization_error` | 消息含函数/Buffer/不可结构化克隆的对象，或 `toJSON` 抛错 |
| `ipc_timeout` | 请求超时未收到响应 |
| `ipc_closed` | 通道在 pending 期间关闭 |
| `capability_not_supported` | op 合法但本宿主执行器未实现（例如 `net.listen` 未纳入第一刀） |

### 4.4 边界硬规则

- **只传结构化数据，不传函数 / Buffer**：桩在 `process.send` 前做一次「结构化可表达」校验，任何非 JSON 值直接 `reject('serialization_error')`，不发消息。
- **不传宿主内部对象**：`response.value` 只允许纯数据（字符串/数字/布尔/普通对象数组）。宿主执行器返回的原生对象（`FileHandle`、`Socket`、`ChildProcess`、`Stats`）一律**降级成纯数据摘要**（如 `stat` 只回 `{size, mtimeMs, isFile...}`），绝不把对象引用发回子进程——这正是不变量 1 在协议层的落点。
- **禁止 eval**：`op` 只取白名单枚举，不接受任意字符串当「命令」解释；`invoke.action` 只取插件已注册的 action 名，宿主不把它当代码执行。

---

## 5. 安全模型

### 5.1 子进程能做什么 / 不能做什么

**能做**：纯计算；调用桩（每条都经宿主 guard）；读取宿主经 `response.value` 回传的纯数据；运行自己的 JS / `vm` / `Worker` / 原生扩展（`worker_threads` 与 `.node` 在子进程内仍可加载）。

**不能做**：直接落盘 / 联网 / 起进程 / 读环境变量 / 读凭证 / 杀进程（这些入口在子进程里不存在，`require('fs')` 拿到桩）；触碰宿主的 `Ledger`、`guard`、open fd、macKey；跨进程改写宿主内存。

### 5.2 宿主如何授权（判定先于执行）

宿主 RPC 收到 `request` 后的固定顺序（与 SPEC §6 守卫链一一对应）：

1. **schema 校验**：op 在白名单、payload 满足 schema、消息 ≤ 上限、id 合法。任一不过 → 直接回 `error`，不进入守卫链。
2. **`guard.enforce(op, payload)`**：走 `derive → 黑名单/完整性 → Two-Key → One-Seal`，并**在 `enforce` 内部写 Ledger**（allow 或 deny 都记账）。
3. **执行**：`enforce` 通过（`allowed:true`）后，执行器才调用对应原生 API（`fs.readFile` / `net.connect` / `spawn` …）。
4. **回传**：把原生结果降级为纯数据，塞进 `response.value`；执行器抛错（含 `CovenantDenied`）时把错误码+原文塞进 `response.error`，`ok:false`。

关键点：**判定与执行之间没有插件可插入的窗口**（§6 表格详述），审计写发生在执行前（SPEC §1.4 不变式保持）。

### 5.3 IPC 是一块新攻击面

进程边界把「插件能触碰什么」收敛到了「这条通道上的字节」，因此通道本身必须被当作**不可信输入**处理：

- **schema 校验**：每个 `op` 都有硬编码 payload schema；未知字段、缺字段、类型不符即拒绝，不做宽容容错。
- **消息上限**：`maxMessageBytes`（默认建议 8 MiB，进 `policy.limits`）；超限直接 `message_too_large`，不回读、不回显内容。
- **禁止 eval**：`op`/`action` 只做枚举匹配，不做任何「字符串当代码」的解释；宿主不执行子进程发来的任何代码或路径拼接命令。
- **超时与背压**：pending 请求数上限 + 单条超时，防止子进程用海量请求拖垮宿主事件循环（DoS）。
- **协议违例即失联**：连续 schema 违例超过阈值 → 宿主判定子进程失控，`kill` 并记 `ruleId='ipc_protocol_violation'` 的 deny。

---

## 6. 三个残余如何被解决（对应表格）

| 现有残余（SPEC §11 / bridge `KNOWN_GAPS`） | 同进程模型的根因 | 多进程模型的解法 | 是否彻底 |
| --- | --- | --- | --- |
| **① TOCTOU**：判定（realpath）与 IO 之间的窗口（SPEC §4.1.1、§11） | 判定与 IO 之间插件代码可插入、或另一执行流替换链接 | 判定（`guard.enforce`）与真正 IO（执行器调原生）**同处宿主进程、同一段同步执行**；子进程只能发消息，无法在两个动作之间改文件系统。执行器仍可复用现有 `recheckOpenedFd`（open 后 `fstat`+`realpath` 复核，SPEC §6）把窗口压到 open 返回之后 | 残留：宿主自身被并发改目录、或**另一个合法进程**换链接（见 §10 开放问题） |
| **② 原生扩展 / `vm` / `Worker` 内部逃逸**（SPEC §6、§11） | 同进程无第二道墙，逃逸即碰到宿主对象图 | 逃逸发生在**子进程**，最多拿到子进程自己的内存与 OS 能力，**碰不到宿主的 open fd / Ledger / guard / macKey**。`Module._load` 重定向在插件加载前安装，`require('fs')` 只给桩 | 残留：`process.binding` / `.node` / 直接 syscall 仍以**同 OS 用户**访问磁盘/网络，进程边界不阻断，需 OS 沙箱（seccomp/job object/独立用户/文件系统命名空间）兜底 |
| **③ 补丁永远补不全**（SPEC §6 `coverage().knownGaps`） | 覆盖是「枚举 patch 的真子集」，漏一个入口就是裸的 | 子进程里**根本没有原生 `fs/net/proc` 可调**，桩是白名单闭集（closed set），未列出的方法不存在，无需 `knownGaps` | 彻底（在「桩不暴露原生」这一前提下） |

---

## 7. 新的代价与失败模式

- **性能**：每次能力调用 = 一次 IPC 往返（结构化克隆序列化 + 进程间拷贝）。高频小 IO（如逐行读、`stat` 遍历）开销放大；流式/大文件无法高效表达；二进制 `Buffer` 需 base64（体积 +33%）。缓解：批量 RPC（§10）、宿主侧对纯读做少量缓存——但缓存会引入新的一致性语义，不能默认开。
- **IPC 无响应**：子进程发请求后宿主挂起/崩溃 → 请求永远 pending。必须有 `ipcTimeoutMs` + 失败关闭（超时按拒绝处理，不留半放行状态）。
- **子进程崩溃**：`child.on('exit')` 时，宿主必须：(a) 拒绝该子进程全部 pending 请求（`ipc_closed`）；(b) 回收执行器已开但未归还的资源（fd/Socket/子进程）；(c) 处理「账本已写 allow、副作用没做完」的中间态——审计如实记录一条 `ruleId='worker_exit'` 的 deny，标记非正常退出。
- **孤儿进程**：宿主崩溃 → 子进程变孤儿继续跑。需要：进程组 / 父进程死亡检测（`parentPort` 关闭、心跳超时自退）、宿主启动时对遗留子进程做清理。
- **数据外带（授权内的读 + 授权内的网）**：进程边界**不阻止**「授权内 `fs.read` 读到敏感文件 + 授权内 `net.outbound` 发出去」的组合——这是授权组合意义上的外带，与同进程模型等价。但多进程下所有读到的数据都要经 `response.value` 回传，数据流更集中、**更可审计**（可在执行器对「读回传 + 出站」的关联做度量，见 §10 审计粒度）。真正的限制仍是「不该给 `fs.read` 就别给」。
- **环境变量 / cwd 缺失**：子进程没有直接 `process.env`，插件读环境变量也必须走 `env.read` 桩——存量插件若直接摸 `process.env` 会拿到受限视图或 undefined，属行为变化（§8 迁移需处理）。

---

## 8. 迁移路径

目标：从「`global` 同进程默认」过渡到「`child` 子进程沙箱」，`global` 保留为快路径/兼容模式。

`policy.sandbox.mode` 由现有二值扩展为三值（SPEC §6.4 现有 `global` | `handles`）：

```jsonc
{ "sandbox": { "mode": "global"   } }   // 现状默认：原生 fs + Bridge 补丁守卫（同进程快路径）
{ "sandbox": { "mode": "handles"  } }   // 现状：require('fs') → 封闭句柄（同进程）
{ "sandbox": { "mode": "child"    } }   // 新增：fork 子进程 + 窄 RPC（信任边界搬家）
```

三阶段过渡：

1. **`child` 作为显式 opt-in**（与现在 `handles` 一样非默认）：宿主显式传 `sandbox:{mode:'child'}` 才 fork。`global`/`handles` 行为不变，零回归。
2. **按插件属性分派默认值**：新插件（有 `covenant` 字段、`kind=covenant`）默认 `child`；legacy / 已验证 / 性能敏感的插件仍回落 `global`。`activate()` 与 `LocalHost` 默认保持一致（避免 SPEC §6.4 强调的「门禁阶段与运行时行为分叉」）。
3. **长期默认 `child`**：`global` 仅保留给「已被签名信任 + 性能敏感 + 用户显式豁免」的插件，作为快路径。

**兼容性语义**：

- `child` 模式下，插件 `require('fs')` 仍拿到一个「有 `readFile/readFileSync/…` 同名方法」的对象（桩尽量镜像句柄的方法面），存量代码改造成本低；但 `readFileSync` 等**同步面在异步 IPC 下无法实现**（§10），必须显式退化或拒绝，不能静默返回假结果。
- 每个子进程只跑一个插件（对应「LocalHost 一次只装载一个插件」的现有约束，`local-host.js` 顶部注释）。

---

## 9. 最小第一刀（vertical slice）

只做 `fs.read` + `ping` + `invoke`，验证「子进程 → 桩 → RPC → 宿主 guard → 执行 → 回传」整条链路。

**范围**：

- **op**：仅 `fs.read`（`payload:{path:string}`，返回 UTF-8 文本字符串）。
- **控制**：`ready` / `ping` / `pong` / `invoke` / `invoke-result` / `shutdown`。
- **宿主侧**：RPC Server（schema 校验 + id 关联 + 超时）+ `CapabilityExecutor.fs.read`（`guard.enforce('fs.read',{path})` → `fs.readFile` 返回字符串）。
- **子进程侧**：bootstrap 先装 `Module._load` 重定向（`require('fs') → 桩`），桩暴露 `readFile`（异步，经 RPC）；插件入口照常 `require('fs')` 就能走桩。

**验收标准（可测）**：

1. 子进程内 `require('node:fs') === require('fs') === 桩`，且桩上**不存在** `readFileSync`（未列入第一刀）与 `openSync`，调用即 `TypeError`。
2. 插件 `fs.readFile('cache.json')` 能读到内容，且宿主 `Ledger` 新增一条 `decision:'allow', ruleId:'two-key', capability:'fs.read'` 记录（证明判定发生在宿主）。
3. 读一个**未声明/未授予**的路径（如 `/etc/passwd`）：子进程收到 `response.ok:false`，`error.code` ∈ `{not_declared, scope_mismatch}`，宿主 `Ledger` 有一条对应 `deny`；子进程**拿不到文件内容**。
4. `ping`：宿主发控制消息，子进程回 `pong`，端到端往返 < 超时阈值。
5. `invoke`：宿主 `invoke(pluginId,'ping')` 经控制消息到达子进程、执行插件 `invoke`、结果经 `invoke-result` 回宿主（`LocalHost.invoke` 返回与同进程模式一致）。
6. 子进程 `process.exit(7)` 或宿主 `kill`：宿主 `child.on('exit')` 触发，pending 请求全部 `ipc_closed`，宿主进程不崩溃。
7. 向宿主发 `{id:'x', kind:'request', op:'fs.read', payload:{path:1}}`（id 非整数、payload 类型错）：宿主拒绝并计 `schema_invalid`，不进入守卫链、不写 allow 账本。

---

## 10. 开放问题（≥ 4）

1. **同步 fs 在异步 IPC 下无法支持**：`readFileSync` / `statSync` / `writeFileSync` 需要同步阻塞返回，而 `child_process` IPC 是异步的。可选方案（`Atomics.wait` + `SharedArrayBuffer` 做同步等待、或宿主用 `worker_threads`+`MessageChannel` 提供同步桥）都会引入新复杂度与资源占用；也可能**干脆声明 child 模式不提供 sync 面**，要求插件改写。取舍待定。
2. **子进程资源上限怎么定**：fork 出的子进程与宿主同 OS 用户，CPU/内存/fd/再 fork 的进程数如何精确限流？Node 层无原生手段，需 cgroup（Linux）/ Job Object（Windows）/ 独立用户。第一刀不做，但需定出「第一刀接受的默认上限」与「超限动作」（kill + 记账）。
3. **审计粒度**：子进程内的纯计算不产生账本，审计只覆盖「能力调用」而非「插件行为全景」；「授权内读 + 授权内出站」的外带组合只能靠跨请求关联度量才能发现。是维持「每能力调用一条」（与现状一致），还是引入「会话级批量记账」（复用 SPEC §6.0.1 的 `enforceBatch` 口径）？粒度与账本体积的取舍待定。
4. **批量化（RPC 合并）**：多次小 IO 合并成一次 RPC 能压往返，但会破坏「每次调用都过 guard、判定与执行一一对应」的原子性——`enforceBatch` 在 RPC 下如何表达、是否允许「一次请求含 N 个目标、N 个目标一次判定但分开执行」？需要重新定义边界，避免开一条「合并后绕过逐条判定」的口子。
5. **流式 IO 与 Buffer 回传**：`createReadStream` / 大文件 / 二进制在「只传结构化数据、不传 Buffer」约束下如何表达？分块回传（多条 response 续同一个 id）还是 base64 一次性回传？fd 不能给子进程（不变量 1），所以「宿主开流、子进程拉块」的协议要额外设计。
6. **进程级逃逸的诚实残留**：`process.binding` / 原生扩展 / 直接 syscall 在子进程内仍可能以同 OS 用户访问磁盘/网络（§6 表②「残留」列）。是否把「OS 沙箱」纳入本原型的边界，还是明确标注为「下一步、需宿主平台配合」？

---

## 附：新增 `policy.limits` 键（建议）

对齐 SPEC §12 的 `policy.limits` 扩展（实现时随 §8 迁移一起落）：

| 键 | 建议默认 | 作用 |
| --- | --- | --- |
| `ipcTimeoutMs` | `10000` | 单条 request 的响应超时；超时按 `ipc_timeout` 失败关闭 |
| `maxMessageBytes` | `8 * 1024 * 1024` | 单条 IPC 消息序列化上限 |
| `maxPendingRequests` | `1024` | 单子进程未决请求数上限（背压/防 DoS） |
| `maxProtocolViolations` | `16` | schema/协议违例累计阈值，超限 kill 子进程 |

---

*本文档是对 `docs/SPEC.md` 的扩展设计，不修改 SPEC；术语与章节引用以 SPEC 为准。*
