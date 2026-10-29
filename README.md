# dsh-covenant

DeepSeek Harness 的插件契约与运行时治理插件。它把“插件能做什么”从口头约定变成可校验的契约：
manifest 声明、宿主授予、运行时拦截、审计账本、安装门禁、双重签名、能力画像、离线诊断与合规准入。

零第三方依赖，Node.js >= 20（CommonJS）。

## 快速开始

```bash
npm test          # 全量用例：契约、运行时、绕过、门禁、签名、画像、诊断、治理、审计、准入
node bin/dsh-covenant.js help
```

## 核心模型

```
manifest 声明 ─┐
               ├─ Two-Key（交集）─→ 守卫链 ─→ 放行 / 拒绝 ─→ Ledger（哈希链）
宿主授予   ─────┘                      ↑
                                  One-Seal / 黑名单 / 完整性
```

- **默认 deny-all**：宿主 `grants` 默认为空。
- **非侵入式防护**：`policy.enforcement.mode` 默认 `advisory`——门禁先装，再输出安全画像标签
  （`Untrusted` / `Quarantined` / `ReviewRequired` / `Broken` / `Verified`）；只有恶意脚本与应急黑名单才阻断安装。
  `mode: 'required'` 或企业通道恢复“拒绝安装”语义。
- **legacy 默认配置**：没有 `covenant` 字段不拒绝解析，自动生成 `{ level: 'legacy', quarantine: true }`；
  没有声明就没有能力（Two-Key 交集为空），企业通道仍然拒绝。
- **能力面**：`fs.*`、`net.outbound`、`net.listen`、`proc.spawn`、`proc.signal`、`env.*`、`cred.*`。凭证路径与环境变量自动升级为 `cred.*`。
- **scope**：路径 glob、`host:port`、环境变量前缀通配、命令基名、端口子集、signal 目标白名单。完整语义见 [docs/SPEC.md](docs/SPEC.md)。
- **审计**：JSONL 追加 + SHA-256 哈希链，字段固定，可逐行离线重算；
  `intercepted=true` 单独记录“实际拦截的未声明 API 调用”，`Ledger.interceptions()` 可直接取出。

## 目录

```
src/
  contract/   能力分类、manifest 解析、Two-Key、Charter/Sieve
  runtime/    推导、守卫链、One-Seal、Ledger、Bridge
  handles/    能力句柄（封闭的 fs facade）
  gates/      结构、安全、可装载性、安装流水线
  signing/    Ed25519 双签、信任表
  portrait/   能力画像卡（三档）
  autopsy/    离线诊断（六段）+ bundle patch 组合
  governance/ 三级回滚、黑名单、月度度量、熔断
  host/       LocalHost：装 → 注册 → 调用 → 卸载
bin/          CLI
docs/         规范、上线节奏、合规
examples/     正例包、反例包、演示策略
test/         契约、运行时、绕过、门禁、签名、画像、诊断、治理、审计、准入
```

## 宿主集成

```js
const { activate } = require('dsh-covenant');

const plugin = activate({
  manifest,                 // 已解析的 manifest
  grants,                   // 宿主授予项；默认空 = deny-all
  policy,                   // 见 src/policy.js 默认策略
  ledgerPath: '.dsh-ledger.jsonl',
  pluginRoot: '/path/to/plugin',
  registerPreExecute: (check) => host.use(check),  // 宿主 pre-execute 钩子
});

// 卸载
plugin.deactivate();
```

`activate` 会在守卫入口安装原生模块 Hook（看护进程内 `fs/net/child_process/env` 调用）并注册 pre-execute 判定函数。
如果宿主只想要判定、不想打补丁，传 `patchBuiltins: false`。

## CLI

```bash
# 生成发布者/审核者密钥与信任表
node bin/dsh-covenant.js keygen ./keys

# 双签（发布者 + 审核者）
node bin/dsh-covenant.js sign ./plugin --plugin com.example.plugin --version 1.0.0 \
  --publisher-key keys/publisher.private.pem --publisher-key-id publisher-2026a \
  --reviewer-key  keys/reviewer.private.pem  --reviewer-key-id  reviewer-2026a

# 验签（重建清单 → keyId → 发布者 → 审核者）
node bin/dsh-covenant.js verify ./plugin --trust keys/trust.json

# 安装门禁（黑名单 → 验签 → 结构 → 契约 → Sieve → 安全 → 可装载性）
node bin/dsh-covenant.js gates ./plugin --trust keys/trust.json --host --policy examples/demo-policy.json
node bin/dsh-covenant.js gates examples/negative-plugin --skip-signature   # 反例包：恶意脚本被阻断（ok=false）

# 能力画像 / 离线诊断 / 度量 / 黑名单 / 熔断
node bin/dsh-covenant.js portrait ./plugin
node bin/dsh-covenant.js autopsy ./plugin --profile profile.json --patch patch.json
node bin/dsh-covenant.js metrics .dsh-ledger.jsonl --events events.json
node bin/dsh-covenant.js blacklist blacklist.json add com.example.evil 紧急下架
node bin/dsh-covenant.js rollout metrics.json
```

失败报告精确到字段与文件行，例如：

```
[structure] manifest.json field=patches[0].path — patch 路径越出插件目录
[safety] index.js:14 field=covenant.capabilities.requests — 代码使用 net.outbound，但 manifest 未声明
```

## 示例包

- [examples/compliant-plugin](examples/compliant-plugin)：声明 fs/net/env，Charter 完整，可过全部门禁（配合 `examples/demo-policy.json` 的授予集）。
- [examples/negative-plugin](examples/negative-plugin)：越界 patch、空 reason、非白名单安装脚本、未声明 `proc.spawn` / `cred.read` / `net.outbound`。用于验证契约层与门禁。

正例包的完整流程：

```bash
node bin/dsh-covenant.js keygen ./keys
node bin/dsh-covenant.js sign examples/compliant-plugin --plugin com.example.compliant --version 1.0.0 \
  --publisher-key keys/publisher.private.pem --publisher-key-id publisher-2026a \
  --reviewer-key keys/reviewer.private.pem --reviewer-key-id reviewer-2026a
node bin/dsh-covenant.js gates examples/compliant-plugin --trust keys/trust.json \
  --host --policy examples/demo-policy.json
```

## 安全边界（必读）

Bridge 保护的是**安装后**的进程内调用，不是沙箱。覆盖是补丁式的：`bridge.coverage()` 会返回
`guarded` 清单和 `knownGaps`，请把后者当成能力清单的上界，而不是噪音。

```js
const report = bridge.coverage();
// { entries: 110, guarded: ['fs.open', 'fs.openSync', 'net.Socket#connect', ...],
//   knownGaps: ['worker_threads / vm / 原生扩展', 'Bridge 安装前打开的文件描述符', ...] }
```

- 插件在 Bridge 安装前缓存/解构的函数引用不受保护；宿主应在安装 Bridge 后只通过受控入口调用插件。
- 原生扩展、`worker_threads`、`vm` 生成代码、直接系统调用不在 Node 层拦截范围。
- 静态扫描给出的是“扫描结果”，不是安全证明；画像卡固定展示 `未扫到 ≠ 安全`。
- 完整性校验能发现“已包装函数被替换”，不能发现“从未包装的入口”。
- **句柄准入即关口**：`open` 通过后 fd 级调用直通；因此不要以为“包了 readFileSync 就守住了读文件”。
- **装载窗口只记账不阻断**：`require` 期间插件的顶层调用会被写进 Ledger（`intercepted=true`），但不会被打断。
  这是为了不让 legacy 插件整批装不上；代价是“装的时候已经发生的读取收不回来”。

## 能力句柄：把补丁换成小世界（1.2.0 实验）

Bridge 只能做到「我想到的都包了」。想真正做到「没声明就做不到」，得反过来：不给插件全局 API，只给它一个受限对象。

```js
const { createCapabilityHandles } = require('dsh-covenant');

const handles = createCapabilityHandles({ guard });
await handles.fs.promises.readFile('cache.json');   // 过守卫链
handles.fs.readSync;                                 // undefined：这个方法不存在
handles.fs.coverage();                               // { closed: true, methods: [...] }
```

- 方法集合是手写闭集，没有 `knownGaps` —— 不存在就是不存在。
- 只接受路径，不接受 fd；`open()` 返回受限 `FileHandle`，没有 `fd` 属性。
- `flags` 决定能力面（`r+` 要读+写），`copyFile` / `rename` 同时判定读写。
- 对象冻结，插件改不掉守卫。

现在只覆盖 `fs`。`net` / `proc` 按同一模式扩展：一个方法一次 `guard.enforce`。

## 能力注入：让 require('fs') 直接返回句柄（1.5.0）

句柄再好，插件不用也没用。但封闭面天生不完整——`openSync`、`fs.promises.open`、`watch`、`globSync`
在句柄里都没有，默认开它会直接把存量插件打成 `TypeError`。所以 `LocalHost` 与 `activate()` 都默认
`sandbox.mode = 'global'`，只靠 Bridge 守卫；`handles` 是宿主显式选择的沙箱模式：

```js
// global（默认）：插件代码完全不用改
const fs = require('node:fs');
fs.readFileSync('cache.json');   // 原生 fs → 过 Bridge 守卫链
fs.openSync('cache.json', 'r');  // 同样可用

// handles（显式开启，需要插件使用 ctx.handles）
fs.readSync(fd, ...);            // TypeError: 这个方法不存在
```

- 装载期间安装 `Module._load` 重定向，`fs` / `node:fs` / `fs/promises` 都换成句柄。
- **只对插件目录下的模块生效**，宿主的 `require('fs')` 不受影响；插件自带 `node_modules` 依赖也在 pluginRoot 之内，同样被重定向。
- 顺序有讲究：Bridge 先装（它自己要用原生 fs），重定向后装，否则会递归。
- `sandbox.mode = 'handles'` 是显式沙箱开关：拿封闭面，要求插件走 `ctx.handles`。
- 默认值必须保可用性：不开 `handles`，存量插件零改动即可运行。

## 为什么是非侵入式

安装门禁的职责不是“替用户决定装不装”，而是**把风险讲清楚，并把执行点留在宿主**：

- 门禁先装、再标注：未签名 / 缺 Charter / 静态扫描异常 / 装不起来，分别输出
  `Untrusted` / `ReviewRequired` / `Broken` 标签，画像卡首屏可见，不再用“拒装”掩盖信息。
- 只有**恶意脚本**（越界 patch、非白名单安装脚本、entry 越界）与**应急黑名单**才阻断；
  它们不是“配置不合规”，而是明确的攻击面。
- 真正的边界在运行时：`LocalHost.install` 自己跑完整门禁，`guard.installNativeHooks()` 把
  `fs/net/child_process` 的实际调用接进同一条 Two-Key 守卫链，未声明调用记 `intercepted=true`。
- 声明（declaration）只是**能力请求**，不是合规姿态；宿主授予（grant）才是唯一的钥匙。

## 文档

- [docs/SPEC.md](docs/SPEC.md)：能力分类、scope 语义、Two-Key、Ledger、门禁、签名、画像、Autopsy。
- [docs/ROLLOUT.md](docs/ROLLOUT.md)：六阶段上线、熔断阈值、三级回滚、双钥轮换、应急下架、月度度量、
  以及**上线前的宿主责任清单**（TOCTOU / 原生扩展 / 账本可写性 / 密钥托管 / 沙箱模式，逐项可勾）。
- [docs/COMPLIANCE.md](docs/COMPLIANCE.md)：Charter 字段、默认值、Sieve 判定与通道策略。
- [docs/multiprocess.md](docs/multiprocess.md)：多进程运行时原型的设计文档（目标/架构/迁移路径/开放问题）。

## 1.11.0 新增（多进程运行时原型 · 垂直切片）

一个**能跑通的最小闭环**，验证「把插件关进子进程、宿主替它做 IO」这条链路：

- `src/runtime/ipc/protocol.js`：RPC 消息 schema 与校验（请求/响应/控制三种形状，畸形输入返回 false 不抛）。
- `src/runtime/ipc/child.js`：子进程桥 + 能力客户端桩（**不 require 任何原生能力模块**，只能走 RPC）。
- `src/host/child-host.js`：宿主侧 `ChildHost`——`fork` 子进程，收到 `fs.read` 后先 `guard.enforce` 再执行真实 IO。
- `examples/child-plugin.js`：示例插件（跑在子进程里）。

切片只实现 `fs.read` / `fs.write` / `ping` + `invoke`，已验证：

```text
授权内读取成功（IO 发生在宿主）✅
越界读取被宿主拒绝且账本留痕 ✅
子进程崩溃时 invoke 以错误收场而非悬挂 ✅
```

**这不是迁移**，只是原型。真正落地要解决的硬问题见 [docs/multiprocess.md](docs/multiprocess.md) 的开放问题（sync fs 无法跨异步 IPC、判定与执行分家、IPC 新攻击面、性能）。
- 用例数 159 → 178。

## 1.10.2 设计微调 + 一致性修复

- **`sandbox.mode` 默认 `global`**：封闭句柄面不完整（`openSync` / `fs.promises.open` / `watch` /
  `globSync` 都不在句柄里，`openSync` 因必须返回 fd 无法兼容），默认开 `handles` 会打断存量插件。
  现在两条路径（`LocalHost` 与 `activate()`）都默认 `global`，`handles` 是显式选项。
- **`minMacKeyBytes` 下限提到 32**：`policy.limits` 不再允许把 HMAC-SHA256 强度关掉；
  低层 `resolveLedgerMacKey(minBytes)` 仍可自定义。
- **P1 修复**：`createPluginRuntime` 现在以 `policy.sandbox.mode` 为唯一真相，并兼容
  `sandbox: 'handles'`（字符串）与 `sandbox: { mode: 'handles' }`（对象）两种写法。此前对象写法
  会因 truthy 被静默忽略、实际跑在 global。
- **P2 修正文档**：`node_modules` 依赖在 `pluginRoot` 之内，**会被**重定向（旧文档说不会）。
- **P3/P4**：更新过期的 `activate` 注释；默认用例不再显式传 `sandbox`。
- 用例数 158 → 159。

## 1.10.1 修复（第二轮三视角审查）

- **H-1 `fetchTimeoutMs` 真的生效了**：`createCapabilityHandles` 以前把 `limits` 收了却不往下传，
  宿主设 3 秒、实际 30 秒。现在一路传到 net 句柄，并有走 `LocalHost → ctx.handles.net` 的集成用例。
- **M-1 计数器提前占位**：`activate()` 以前先注册回调再 `+1`，回调抛错时 Hook 已装但计数为 0，
  下一次激活会叠加。现在失败会回滚计数并 `dispose()`。
- **M-3 limits 校验**：`batchTargets: 'abc'` 会让上限比较恒为 false（静默失效）；现在
  `resolveLimits`/`loadPolicy` 直接拒绝非整数/越界值。`fetchTimeoutMs: 0` 是合法值。
- **M-4 `coverage().installed`**：`strictPatch` 拒绝装载后不再留下"指向已卸载 Bridge"的假象。
- **L-1 账本写失败的归因**：部分写入后把基准对齐到真实大小，磁盘错误不再被报成"并发写入"；
  真正的并发检测保持原样（不会被重对齐吞掉）。
- 用例数 153 → 158。

## 1.10.0 新增（可配置上限）

写死的常量全部抽进 `policy.limits`，默认值不变：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `batchTargets` | 10000 | 单次 `enforceBatch` 目标上限 |
| `globBatchSize` | 256 | 异步 glob 分块大小 |
| `fetchTimeoutMs` | 30000 | 出网 `fetch` 默认超时（0 = 不注入） |
| `integrityEvery` | 64 | 每 N 次判定抽样完整性校验（0 = 关闭） |
| `minMacKeyBytes` | 32 | `macKey` 最小字节数 |

外加一个可选强约束 `policy.enforcement.strictPatch`：默认 `false`（补丁不完整只记账 +
`coverage().unpatched` 暴露），打开后升级为`拒绝装载`。这是"非侵入式"与"fail-closed"
之间唯一留给宿主的开关。

```js
new LocalHost({ policy: { limits: { fetchTimeoutMs: 5000 }, enforcement: { strictPatch: true } } });
```

- 用例数 146 → 153。

## 1.9.0 修复（三视角审查）

一次红队 / 架构 / 边界的三视角审查，确认 3 条必改、6 条建议，全部修完：

- **H1 补丁失败不再静默**：`patchMethod` 装不上时记入 `unpatched`，`coverage()` 给出
  `{unpatched, complete}`，并写一条 `ruleId='bridge_incomplete'` 账本。此前某个入口 patch 失败，
  它就是裸的，而 `installed` 仍是 true。
- **H2 完整性校验接线**：`createGuardChain({integrityEvery})`（默认 64）在判定循环里抽样
  `verifyIntegrity()`。此前这套机制**只被测试调用过**——声称的防篡改在生产路径上不存在。
- **H3 Windows 大小写**：模块重定向的父模块判定改为大小写不敏感（仅 win32）。
  此前 `pluginRoot` 大小写与实际不一致会让 `require('fs')` 静默拿回原生 fs。
- **M1 fetch 默认超时**：句柄的 `fetch` 在调用方未给 `signal` 时注入 30s 超时
  （Node 原生 fetch 没有默认 timeout）。
- **M2 glob cwd 不再静默忽略**：认不出的 `cwd` 类型现在直接拒绝，而不是退回
  `process.cwd()` 让判定对象和真实遍历对象错位。（Node 自身的 `fs.glob` 目前只接受 string cwd，
  URL 分支是防御性的。）
- **M3 未知协议给出明确拒绝**：以前会回落到 http 模块，抛的是 Node 的
  `ERR_INVALID_PROTOCOL`（错误信息误导）；现在直接说明「不支持该协议」。**实测并未真的发出
  跨协议请求**，所以这条从"协议混淆"降级为"错误契约"问题。
- **M4 单运行时**：`activate()` 拒绝第二个活动运行时（原生 Hook 会叠加、内层账本会漏记）。
- **M5 账本单写者检测**：并发追加会报错，而不是写出重复 `seq` 让账本自己验不过。
- **M6 失陷可见**：`coverage().compromised` 暴露完整性状态。
- **L1/L2**：批量判定加上限（10k 目标）、ESM 入口给出明确错误。
- 用例数 135 → 146。

## 1.8.0 新增（把「一条记录代表 N 个目标」这件事做完整）

- **glob 账本聚合**：`fs.glob` / `globSync` / `fs.promises.glob` 不再一个结果一条账本。
  100 个匹配 = **1 条** `two-key-batch` 记录（判定仍然逐个做）。异步迭代器按 256 条分块，**判完再交付**。
- **worker 的 eval 不再把源码写进账本**：`new Worker(code, {eval:true})` 的 command 现在是
  `worker:eval:<源码 sha256 前 12 位>`——可去重、可对账，但源码不落盘。
- **批量记录的审计口径修正**：混合能力的批次不再记成单一能力（否则 `cred.read` 会被藏进 `fs.read`），
  记 `capability:'mixed'` 且 `scope.capabilities` 列出全部；observe 窗口内的越界也不再被记成 allow。
- **MAC 密钥托管**：`resolveLedgerMacKey()` 支持「值 > 文件 > 环境变量」，短于 32 字节直接拒绝，
  显式指定却取不到一律失败关闭；`LocalHost.redact()` 给出不含密钥的摘要。
- **CLI `metrics` 先校验再统计**：账本校验不过（含 `mac_key_missing`）直接非零退出，
  并提示 `--mac-key-file` / `--mac-key-env`；支持 `--anchor <file>`。
- 度量口径：新增 `batchRecords` / `batchedTargets` / `effectiveRequests` / `targetInterceptionRate`
  等并列字段，旧字段语义不变（记录数 vs 目标数，两套读数并存）。
- 用例数 114 → 135（新增 glob / worker / mac-custody / 批量守卫 / 度量 / 不变量六组）。

## 1.7.0 修复（mac 完整性三处硬伤）

- **无密钥校验不再静默通过**：账本含 v3 行但 `verify()` 没拿到 `macKey` 时返回
  `mac_key_missing`。之前这种情况 `ok === true`，等于把「没验 mac」说成「验过了」。
- **禁止降版本**：v3 之后出现 v1/v2 行 → `version_downgrade`，堵住「追加一条无 mac 的低版本行」。
- **新增外部锚点**：`ledger.anchor()` / `verify({ anchor })`。哈希链发现不了尾部截断——
  砍掉最后几行，剩下的前缀依然自洽；锚点是唯一能发现它的东西。
- **`fs.promises.link` 补上读权限**：`fs.link` 上轮已修，promises 版本漏了，硬链接逃逸还在。
- **fd 复核改用原生 realpath**：异步 `open` 的回调里 `callDepth` 已归零，用被包装的
  `fs.realpathSync` 会重新进守卫链——多写一条账本，且「只写」的 open 会被自己判成越权。
- 用例数 108 → 114（新增 `test/ledger-mac.test.js` 五条 + 硬链接用例一条）。

## 1.6.0 新增（封闭世界补完 + 路径硬化）

- **net / proc 能力句柄**：`createCapabilityHandles` 现在返回 `{ fs, net, proc }`。
  `net` 只做出站（`fetch` / `request` / `get` / `connect` / `createConnection`），端口必填、Unix socket 直接拒绝；
  `proc` 给 `spawn/exec/fork/kill`，命令名口径复用 `bridge.firstCommand`，不另写一份解析。
- **符号链接逃逸已堵**：判定对象改成 **OS 真正会操作的真实路径**（`realpathSafe`），
  `$PLUGIN/**` 里的链接再也不能把判定带出范围。凭证升级同样按真实路径判——把 `id_rsa` 链成 `notes.txt` 不再能降级。
- **pluginRoot 先规范化成真实根**：否则 macOS 的 `/var → /private/var` 会让所有 `$PLUGIN` 授予失效。
- **硬链接补洞**：`link` / `linkSync` 现在同时要求 `args[0]` 的 `fs.read`——否则「把外部文件 link 进插件目录再当普通文件读」就能绕开。
- **`resolvePath` 与 derive 同口径**：导出给宿主的也是真实路径，避免宿主二次判断得出不同结论。
- **隔离档判定统一** `isQuarantined()`：`portrait` / `activate` / 门禁报告不再各写一套。
- 用例数 84 → 104（新增 `net-proc-handle` / `symlink` / `portrait-labels` 三组；其中 3 条因 Windows 无符号链接权限显式 skip）。

## 1.5.0 新增（能力注入）

- **`require('fs')` 可选返回能力句柄**：`sandbox.mode='handles'`（显式开启）时按 `pluginRoot` 范围重定向
  `fs` / `node:fs` / `fs/promises`；默认 `global`，用原生 fs + Bridge 守卫，存量插件零改动。
- **句柄补 `constants`**：只是一堆数字，不构成能力面，放行能显著降低改造量。
- **两条路径默认一致**：`activate()` 与 `LocalHost` 都默认 `global`，不会出现「门禁一套、运行时另一套」。
- **度量分开统计**：新增 `undeclaredInterceptions` / `undeclaredInterceptionRate` 与
  `grantDenials` / `grantDenialRate`——「插件越界」和「宿主没发钥匙」不该混在一个拦截率里。
- 用例数 77 → 84（新增 `test/sandbox.test.js` 七条）。

## 1.4.0 修复（装载窗口与账本兼容）

- **装载窗口不再真空**：Hook 提到 `require` 之前安装，窗口内走 observe——判定与记账照做，只是不阻断。
  窗口关闭后立即恢复 fail-closed。新增 `guard.beginObserve()` / `endObserve()` / `isObserving()` 与 `stats.observed`。
- **入口加载不再污染账本**：宿主先读源码，再在窗口内 `_compile`，加载器自身的读文件不会被记成插件行为。
- **`admitting` 改为私有字段**：之前它是公开属性，调用方写一行就能跳过全部门禁。
- **strict 模式不执行插件代码**：前置门禁阻断时跳过 `loadability`，输出 `loadability_skipped`。
- **Ledger v1 兼容**：`verify()` 按 `v` 选字段集，历史账本继续可验；v1 记录被塞入 `intercepted` 会被 hash 抓住。
- **`guard.coverage()` / `LocalHost.coverage()`**：宿主可以直接拿到当前受控入口清单。
- 用例数 69 → 77（新增 `test/observe.test.js` 六条与两条 v1 账本用例）。

## 1.3.0 新增（非侵入式防护）

- **manifest**：无 `covenant` 不再报错，生成默认 `{ level: 'legacy', quarantine: true }`；新增 `isQuarantined()`。
- **守卫入口 Hook**：`guard.installNativeHooks()` / `uninstallNativeHooks()`；`createGuardChain({ nativeHooks: true })`
  可在入口直接安装，`LocalHost` 与 `activate` 都走这条路径。
- **门禁标签化**：`report.labels` / `securityLabels` / `labelLines`，阶段状态新增 `warn`；
  只有 `MALICIOUS_CODES` 与黑名单阻断，`ok = 无阻断`。
- **Ledger v2**：新增固定字段 `intercepted`，`Ledger.interceptions()` 输出“实际拦截的未声明 API 调用”。
- **默认策略**：`enforcement = { mode: 'advisory', allowLegacy: false, requireSignature: false }`；
  `required` / 企业通道仍保留拒装语义。
- 用例数 67 → 69（`audit` 新增 intercepted 与入口 Hook 用例）。

## 1.2.0 新增

- **能力句柄（实验）**：`createCapabilityHandles({ guard })` 给出封闭的 `fs` facade——未列出的方法不存在，
  不接受 fd 参数，`open()` 返回无 `fd` 的受限句柄，对象冻结。这是「换一个小世界」路线：
  新插件给句柄，Bridge 只作旧代码的兼容层。`handle.coverage()` 与 `bridge.coverage()` 可直接对照。
- `open` 的 flags 判定抽到 `capabilityNeedsForOpen`，Bridge 与句柄共用一套口径。
- 用例数 61 → 67（新增 `test/handle.test.js`）。

## 1.1.0 变更（破坏性，1.3.0 起默认值已翻转为 advisory）

- **默认不可装载**：`policy.enforcement.mode` 默认 `required`，`legacy` 插件在任何通道都装不上，`activate()` 直接拒绝。
  升级方式：显式设置 `policy.enforcement = { mode: 'advisory' }` 恢复旧行为（应记一条规则级回滚）。
  > 1.3.0 已把默认值改为 `advisory`，本节仅保留历史记录。
- **准入内建于宿主**：`LocalHost.install` 自己跑完整门禁流水线，没有跳过参数；准入结论写 Ledger（`ruleId=admission`）。
  构造 `LocalHost` 时需要传 `trust`，否则准入失败。
  > 1.3.0 起没有信任表只输出 `Untrusted` 标签，`install` 仍会成功；`required` 模式下才需要 `trust`。
- **`env.write` 敏感键升级为 `cred.write`**：覆写 `*_KEY` / `*_TOKEN` 一类变量必须单独授权。
- **审计归因修正**：`allow` 记录的 `reason` 来自真正覆盖本次请求的声明，不再是同能力的第一个声明。
- **One-Seal 两阶段**：`reserve → commit`，Ledger 写失败时 `release`，不再白烧一次性授权。
- **Bridge 补齐入口**：`open` / `openSync` / `opendir` / `realpath` / `truncate` / `chmod` / `chown` / `utimes` / `mkdtemp` /
  `symlink` / `link`、`net.Socket#connect`、`dns.promises`；新增 `bridge.coverage()` 自检。
  注意 `mkdtemp` 现在算 `fs.write`，宿主/测试需要在安装 Bridge 之前建好临时目录。
- **`Ledger.verify()`** 在尾行损坏时报告 `json_invalid` 并返回 `head=null`，不再抛异常。
- 用例数 44 → 61（新增 `test/audit.test.js`、`test/mandate.test.js`）。

## 许可

MIT
