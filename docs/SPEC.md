# dsh-dashcam 契约规范（dsh-dashcam/1）

本文件定稿能力分类与 scope 语义。运行时、门禁、画像卡、诊断与合规全部以本规范为唯一口径；
任何实现与本文件冲突，以本文件为准。

## 1. 不变量

1. **默认拒绝**：宿主默认授予集为空（deny-all）。插件不声明 = 不能做；宿主不授予 = 不能做。
2. **Two-Key**：`manifest 声明 ∩ 宿主授予` 同时覆盖请求范围才放行，其余一律拒绝。
3. **拒绝可解释**：每次判定都写入 Ledger，`reason` 原文来自 manifest 的 `reason` 字段或判定码，不做二次包装。
4. **审计先于执行**：判定与 Ledger 写入在副作用发生前完成；Ledger 写失败按拒绝处理（失败关闭）。
5. **legacy 隔离**：没有 `dashcam` 字段的插件不拒绝解析，而是生成默认配置
   `{ level: 'legacy', quarantine: true }`；运行时没有声明就没有能力（Two-Key 交集为空），企业通道仍然拒绝。
6. **非侵入式默认**：`policy.enforcement.mode` 默认 `advisory`——门禁先装、再输出安全画像标签
   （`Untrusted` / `Quarantined` / `ReviewRequired` / `Broken` / `Verified`），
   只有恶意脚本与应急黑名单才阻断安装。`mode=required` 或企业通道才恢复拒装语义。
7. **审计可归因**：`allow` 记录的 `reason` 取自**真正覆盖本次请求**的那条声明（`declaredReason`），
   不是同能力的第一个声明；被拦截的未声明调用在 Ledger 中标记 `intercepted=true`。

## 2. manifest

```json
{
  "id": "com.example.plugin",
  "name": "Example",
  "version": "1.0.0",
  "entry": "index.js",
  "contributes": { "registrations": [{ "type": "command", "id": "example.ping" }] },
  "patches": [{ "path": "patches/fix.patch", "reason": "修复已知崩溃" }],
  "scripts": { "install": "node ./scripts/install.js" },
  "uninstall": { "reversePatches": ["patches/fix.patch"] },
  "dashcam": {
    "spec": "dsh-dashcam/1",
    "capabilities": {
      "requests": [
        { "capability": "fs.read", "scope": { "paths": ["$PLUGIN/**"] }, "reason": "读取自身代码与缓存" }
      ]
    },
    "content": {
      "rating": "general",
      "scenes": ["chat"],
      "commercialUse": "allowed",
      "sourceFingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "enterpriseExcluded": false
    }
  }
}
```

- 必填：`id`、`name`、`version`、`entry`。`entry` 不得越出插件目录。
- `dashcam.spec` 必须是 `dsh-dashcam/1`。
- `dashcam.capabilities.requests` 必须是数组，每一项都必须带非空 `reason`。
- `dashcam.content` 为 Charter，见 [COMPLIANCE.md](./COMPLIANCE.md)。
- 有 `dashcam` ⇒ `kind=dashcam`；无 `dashcam` ⇒ `kind=legacy`，并自动补默认配置
  `{ level: 'legacy', quarantine: true }`。解析层不因缺少契约而报错。

## 3. 能力分类

| 组 | 能力 | scope 形状 | 说明 |
| --- | --- | --- | --- |
| fs | `fs.read` / `fs.write` / `fs.delete` | `{ paths: string[] }` | 绝对路径或带 glob 的路径 |
| net | `net.outbound` | `{ hosts: string[] }` | 必须是 `host:port`，端口显式 |
| net | `net.listen` | `{ address: string, ports: number[] }` | 缺省 `127.0.0.1` |
| proc | `proc.spawn` | `{ commands: string[] }` | 命令精确匹配或基名匹配 |
| proc | `proc.signal` | `{ targets: string[] }` | `self` / `children` / `pid:<n>` |
| env | `env.read` / `env.write` | `{ keys: string[] }` | 环境变量名，允许末尾 `*` |
| cred | `cred.read` / `cred.write` | `{ targets: string[] }` | 文件路径 / `env:KEY` / `keychain:NAME` |

高风险能力（画像卡红显并强制确认）：`cred.read`、`cred.write`、`proc.spawn`、`proc.signal`、`net.listen`、`fs.delete`。

## 4. scope 语义

### 4.1 路径（fs / cred 文件目标）

- 支持 `$PLUGIN`、`$HOME`、`~` 展开；相对路径按插件目录解析；统一为 POSIX 风格用于比较。
- `*` 不跨目录，`**` 跨任意层级。
- `dir/**` 只覆盖 `dir/` **之下**的条目，不覆盖 `dir` 本身。需要操作目录本身时同时声明 `dir`。
- 授予覆盖请求：授予为 `**` 结尾且其静态前缀包含请求前缀，或 glob 正则直接匹配。
- Windows 下路径比较大小写不敏感。

### 4.1.1 真实路径判定（硬规则）

判定对象是 **OS 真正会操作的那个路径**，不是词法路径：

- `fs.*` 与 `cred.*` 的 scope 在 `derive` 阶段经 `realpathSafe` 解析：先 `realpathSync.native`，
  目标不存在时退化为「父目录真实路径 + basename」并向上回溯（上限 64 层），全程不抛异常。
- 目的：插件目录里放一个指向外部的符号链接，词法路径仍在 `$PLUGIN/**` 内，但实际读写的是范围外文件。
  判定落在字符串上，链接就是判定与 IO 之间的后门。
- 凭证升级同样看真实路径：把 `id_rsa` 链成 `notes.txt` 不能把 `cred.read` 降级成 `fs.read`。
- `$PLUGIN` / `$HOME` 展开时会先把根规范化成真实路径。否则根本身是链接时（macOS `/var`），
  授予按词法根展开、请求按真实根判定，两边永远对不上，等于作废所有授予。
- **硬链接是另一回事**：`link` / `linkSync` 的 `args[0]` 是已存在文件，必须同时具备 `fs.read`，
  否则「先把外部文件 link 进插件目录，再当普通文件读」是一条 realpath 帮不上忙的逃逸路径。
- 残留风险（不隐藏）：判定与真实 IO 之间仍有 TOCTOU 窗口；彻底根治需要在 `open` 后用
  `fstat` / `O_NOFOLLOW` 按 fd 复核。

### 4.2 主机（net.outbound）

- 必须写成 `host:port`，不接受省略端口的声明（防止跨协议越权）。
- `*.example.com:443` 只匹配子域，不匹配 `example.com:443`；端口必须一致。
- 禁止 `*`、`*:*`、`*example.com` 等宽通配。
- IPv6 用 `[::1]:443` 形式。

### 4.3 监听（net.listen）

- `address` 为 `0.0.0.0` 或 `::` 时覆盖任意本地地址；否则必须完全一致。
- 端口按子集判断。

### 4.4 进程（proc.spawn / proc.signal）

- `proc.spawn` 命令精确匹配；授予项若不含路径分隔符，可按基名匹配（如 `node` 覆盖 `/usr/local/bin/node`）。
- `proc.signal` 只接受 `self`、`children`、`pid:<n>`，不支持 `*`。

### 4.5 环境变量（env）

- 键名必须匹配 `[A-Za-z_][A-Za-z0-9_]*`，仅允许末尾 `*` 作前缀通配。
- 命中敏感命名（`KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`CREDENTIAL`/`PRIVATE`/`AUTH`/`API` 等）自动升级为 `cred.read` / `cred.write`，必须单独声明与授权。

### 4.6 凭证升级（硬规则）

- 路径命中 `.ssh`、`.aws`、`.gnupg`、`.kube`、`id_rsa`、`id_ed25519`、`.netrc`、`.npmrc`、`credentials`、`.env`、`*.pem`、`*.key`、`*.p12`、`*.pfx` 时：
  - 读 → `cred.read`
  - 写/删 → `cred.write`
- 声明 `fs.read` 不能替代 `cred.read`；这是独立授权面。

## 5. Two-Key 判定

判定顺序（短路）：

1. `manifest` 缺失 → `manifest_missing`
2. `kind=legacy` → `legacy`（运行时拒绝一切能力；隔离档在门禁阶段以 `Quarantined` 标签呈现，`required` / 企业通道才拒装）
3. manifest 无任何声明 → `not_declared`
4. 声明中无条目覆盖请求范围 → `not_declared`
5. 过滤启用且未过期的授予；无候选 → `not_granted`
6. 有候选但 scope 不覆盖 → `scope_mismatch`
7. scope 覆盖但都是一次性且已耗尽/过期 → `one_seal_exhausted`
8. 通过 → `allowed`，并优先选择 One-Seal 授予

运行时额外前置检查：完整性受损 → `integrity_compromised`；黑名单命中 → `blacklisted`。

## 6. 运行时守卫链

所有 `fs` / `net` / `proc` / `env` / 凭证访问收敛到 `guard.check`（或 `guard.enforce`）：

```
原生模块 Hook（守卫入口） → 推导能力（derive） → 黑名单/完整性 → 查授予（Two-Key） → One-Seal consume → 写 Ledger → 放行/拒绝
```

- **Hook 挂在守卫入口**：`guard.installNativeHooks()` 把 `fs` / `net` / `child_process` 等原生调用翻译成
  operation 后直接进入同一条守卫链；插件实际调用什么，就与 manifest 声明比对什么。
- **TOCTOU fd 复核**：`open` / `openSync` / `fsp.open` 拿到 fd 后立即 `fstat`（设备/fifo/socket 直接拒绝并关 fd），
  并重新 `realpath` 落点再过一次守卫链；判定到 IO 之间的路径替换窗口被压到 open 返回之后。
  残余风险（IO 期间的目录 rename）列入 `KNOWN_GAPS`，根治需宿主侧文件系统隔离。
- **glob / globSync**：路径在返回值里而不在参数里，包装器对每个返回条目（含 Dirent）按 `options.cwd`
  解析后逐个进守卫链，拒绝发生在消费者拿到路径之前。
- **worker_threads**：`Worker` 构造收敛到 `proc.spawn` 判定（command = 入口文件路径，按命令精确/基名口径匹配）；
  Worker 内部代码不经本进程 Hook，这是 Node 层上限。`vm` 与原生扩展无法这样处理，根治只有分进程或分 realm，
  保留在 `KNOWN_GAPS`。
- Bridge 只负责把 Node 调用翻译成 operation，判定只在守卫链内发生。
- Bridge 覆盖：`fs` / `fs.promises` 的读写删除、复制/重命名、**句柄获取（`open` / `openSync` / `opendir`）**、
  `realpath`、元数据写入（`truncate` / `chmod` / `chown` / `utimes` / `mkdtemp` / `symlink` / `link`）、
  `http/https`、`net.connect` / `net.createConnection` / **`net.Socket#connect`**、`tls.connect`、
  `dns` 与 `dns.promises`、`fetch`（**重定向逐跳复判**，见下）、`net.Server#listen`、`child_process`、`process.kill`、`process.env`。
- `fetch` 的每一跳都是独立判定：包装器强制 `redirect:'manual'`，按 `Location` 重新过
  守卫链，跳数封顶 5 跳，协议收紧到 `http`/`https`；拿不到可复放 body（`Request` + 307/308）
  时把 3xx 原样交回调用方，绝不由 Bridge 自己跟出去。否则「声明 api.example.com」的插件
  可以被对端 302 到 `169.254.169.254`，判定只看第一跳等于没判。
- 句柄获取即关口：`open` 通过后，fd 级 `readSync` / `writeSync` 直通——fd 无法映射回路径，这是设计而非遗漏。
- 覆盖是**补丁式**的：`bridge.coverage()` 返回 `guarded` 清单与 `knownGaps`，差集不隐藏。

**装不上也算覆盖缺口**：`patchMethod` 失败（属性被冻结、`configurable:false`、宿主 SDK 锁死）
会记入 `coverage().unpatched`，并写一条 `ruleId='bridge_incomplete'` 的账本记录。
`installed === true` 不代表每个入口都装上了；宿主应当检查 `coverage().complete`。

**完整性校验是抽样执行的**：`createGuardChain({integrityEvery})`（默认 64，0 关闭）在每 N 次判定时
调用一次 `verifyIntegrity()`。检测到替换后 `compromised` 置位，此后所有请求按
`integrity_compromised` 拒绝；状态可从 `coverage().compromised` 读取。
- 重入保护：Node 内置实现互相调用（如 `appendFileSync → writeFileSync`、`http.get → http.request`）在原始实现执行期间直通，避免重复判定与递归。**重入窗口只包住原生调用**，`deriveOperation` / `authorizeAccess` 的参数解析与判定始终在窗口外执行——否则参数上的 `toString` / `valueOf` 可以在窗口里回调 Bridge 做不受管的原生调用。
- 完整性校验：保存每个被包装函数的引用；发现被替换即标记 `compromised`，此后一切请求按 `integrity_compromised` 拒绝，并写 `tamper_detected` Ledger。

### 6.0.1 批量判定（enforceBatch）

一次 glob / 目录遍历可以产生上万个目标。一个目标一条账本，等于把审计文件撑爆
（1 万条 = 1 万次 open/write/close），而且这些记录本身没有任何额外信息量。

`guard.enforceBatch(operation, payloads)` 的口径是 **判定不合并、记账合并**：

- 每个 payload 仍然单独推导、单独过 Two-Key——判定质量不因为批量而降级；
- 全部通过时只写 **一条** `allow`：`ruleId='two-key-batch'`、`scope={batch:true,count:N}`；
- 任何一条被拒时写 **一条** `deny`：`scope={batch:true,count:K,sample:<第一个越界目标>}`，然后抛 `DashcamDenied`
  （`reason` 仍是原文，不做二次包装）。`count` 反映「检查到第几个就失败」，便于定位越界在序列里的位置。
- **不要与 One-Seal 混用**：批量内部仍会按目标逐个消费一次性授权。
- `fs.glob` / `fs.globSync` / `fs.promises.glob` 走这条路：结果先去重，再交给 `enforceBatch`。
  异步迭代器按 256 条一块判定、**判完再交付**（已交付的前几块是判过的；流式 API 只能到这个粒度）。
- 账本口径变化：一条批量记录代表 N 个目标。度量侧用 `scope.count` 还原影响面，不要把
  「记录数」直接当成「请求数」。

### 6.1 One-Seal

- `seal.issue(grant)` 登记一次性授予。生命周期为 `available → reserve → commit`（删除），
  审计写入失败时 `release` 回到 `available`——一次性授权不能因为磁盘抖动被白烧。
- `consume` 保留为 `reserve + commit` 的兼容入口，第二次必然失败。
- `ttlMs` 默认 60s；`sweep` 清理过期项；`startAutoSweep` 定时清扫（`unref`）。
- 授权阶段只检查可用性，真正执行前 consume。

### 6.2 Ledger

JSONL，逐行追加，字段固定（不允许自由扩展）：

| 字段 | 说明 |
| --- | --- |
| `v` | 记录版本，当前为 `2` |
| `seq` | 从 1 开始递增 |
| `ts` | ISO 时间 |
| `plugin` / `pluginVersion` | 插件标识 |
| `capability` | 能力名，无法推导时为 `unknown` |
| `action` | 原始动作（`fs.read`、`net.connect` 等） |
| `scope` | 规范化后的请求范围 |
| `decision` | `allow` / `deny` |
| `ruleId` | `two-key` 或拒绝码 |
| `reason` | 原文原因 |
| `intercepted` | 布尔：本次是否为“实际拦截的未声明 API 调用”（`legacy` / `not_declared` / `derive_failed`） |
| `prevHash` | 上一条 `hash`，首条为 `GENESIS` |
| `hash` | 对除 `hash` / `mac` 外字段做稳定序列化后的 SHA-256 |
| `mac` | v3 新增（可选）：`HMAC-SHA256(macKey, hash)`。纯哈希链的命门是「能写文件的人就能重算整条链」；启用 macKey 后，伪造/篡改/截断追加都需要密钥 |

`verify()` 逐行重算哈希链，报告 `json_invalid` / `field_missing` / `field_invalid` / `seq_mismatch` /
`prev_hash_mismatch` / `hash_mismatch` 及行号；启用 macKey 时同时校验每行 mac（常量时间比较），
追加报告 `mac_missing` / `mac_mismatch`。字段集按 `v` 选择：**v1 记录不要求 `intercepted`**，
v2 要求且必须是布尔值——升版本不能让历史账本变成“损坏”。
v1/v2 账本在无 macKey 时仍可验证；启用 macKey 后每行都必须带合法 mac，旧账本启用密钥需整体重新锚定。
密钥通过 `new Ledger(file, { macKey })` 或 `new LocalHost({ ledgerMacKey })` 注入，不落盘。

`capability='llm.ingress'` 的记录是**观测记录**，不属于 Two-Key 判定：`decision` 恒为 `allow`，
`intercepted` 恒为 `false`，`action` 为 `llm.request` / `llm.inbound` / `llm.anomaly`。
它们与判定记录共用同一条哈希链、同一套验签，但 `computeMetrics()` 将其排除在
`requests / allows / denies / interceptionRate` 之外，另列 `ingressRequests` / `ingressInbound` /
`ingressAnomalies`。异常不写 `deny`：观测层一旦会拦请求，第一次误报就会把用户挡在门外。

mac 的三条硬规则（v3 实现口径）：

1. **无密钥校验 v3 账本必须失败**（`mac_key_missing`）。文件自称 v3 却没验 mac 就返回 ok，
   等于把「没验」说成「验过了」。
2. **禁止降版本**：v3 记录之后再出现 v1/v2 行 → `version_downgrade`。否则追加一条无 mac 的
   低版本行就能绕过。升级前的历史行（位于首条 v3 之前）不受影响。
3. **尾部截断只能靠外部锚点发现**。`ledger.anchor()` 返回 `{count, head, mac}`，
   `verify({ anchor })` 比对 `anchor_count_mismatch` / `anchor_head_mismatch`。
   锚点必须存在账本之外才有意义；没有 `macKey` 时 `anchor()` 返回 `null`
   （无密钥的 head 谁都能算，拿它当锚点等于没锚）。

**密钥从哪来**：`resolveLedgerMacKey()`，优先级 **直接传值 > 文件 > 环境变量**（默认名
`DSH_DASHCAM_MAC_KEY`）。三条硬规则：

1. **显式给出却取不到，必须抛错**。指定了 `ledgerMacKeyFile` / `ledgerMacKeyEnv` 却读不到、读为空，
   一律失败关闭——绝不静默退化成「无密钥的 v2」，那正是「账本看着有 mac、其实没人验」的来源。
   只有「既没传值、也没指定来源、默认环境变量恰好为空」才判定为 `none`。
2. **密钥至少 32 字节**（`MIN_MAC_KEY_BYTES`）。短于该值直接拒绝，且错误消息只报长度、不回显密钥。
3. **密钥不进任何输出**：`LocalHost.redact()` 只返回 `{macEnabled, keyLength, source}`；
   账本、门禁报告、`coverage()`、错误消息里都不得出现密钥本身。

CLI 的 `metrics` 现在是「先校验、再统计」：校验不过（含 `mac_key_missing`）直接非零退出并提示
`--mac-key-file` / `--mac-key-env`，不再在校验不过的账本上算指标。
`interceptions()` 按 `intercepted=true` 给出
“实际拦截的未声明 API 调用”清单，供离线审计与月度度量共用。

### 6.3 能力句柄（capability handle）

Bridge 是补丁式的，覆盖永远是 Node API 的真子集。能力句柄走另一条路：**不给插件全局，只给它一个小世界。**

```js
const { createCapabilityHandles } = require('dsh-dashcam/core');
const handles = createCapabilityHandles({ guard });      // { fs }
await handles.fs.promises.readFile('cache.json');        // 每次调用都过守卫链
```

- 句柄是**封闭集合**：`handle.coverage().closed === true`，未列出的方法不存在（调用即 `TypeError`），因此不需要 `knownGaps`。
- 句柄**只接受路径**，不接受 fd。要 fd 请用 `open()`，它返回受限 `FileHandle`：没有 `fd` 属性，能力面收窄到「拿着这个描述符能做的事」。
- `open` 的 `flags` 决定能力面：`r` → `fs.read`；`r+` → 读 + 写；`w` / `a` / `wx` → `fs.write`。
- 双路径操作（`copyFile` / `rename`）同时判定读与写；`symlink` / `link` 判定目标路径的写。
- 句柄对象冻结，插件不能替换方法来绕过守卫。
- 与 Bridge 共用 `capabilityNeedsForOpen` 的 flags 口径，避免两套判定漂移。

推荐姿态：**新插件只给句柄，Bridge 只作旧代码的兼容层。** 两者并存时，句柄提供封闭面，Bridge 兜住仍然直连全局的代码。

**net 句柄（`createNetHandle`）**：方法闭集 `fetch` / `request` / `get` / `connect` / `createConnection`，
不提供 `listen`——服务端监听是另一条授权线，句柄不给「顺带」打开端口的入口。

- 判定目标是 `host:port`：`fetch` 接受 字符串 / `URL` / `Request`（只信它的 `.url`），
  `request` / `get` 复用 `derive.parseRequestTarget`，与 Bridge 同源，避免两套端口缺省规则。
- 端口必填（`connect` / `createConnection`）：缺省端口会被 Node 解释成 Unix socket / 具名管道，
  那类目标无法用 `host:port` 定性，句柄直接拒绝，而不是猜一个 0 号端口放行。
- host 统一小写；未知协议没有默认端口时抛错，不编造端口。
- `fetch` 与 Bridge 共用同一个复判器（`runtime/redirects.js`）：每一跳重新判定、跳数封顶、
  协议收紧。句柄是「封闭面」不是「免检面」，重定向不能从它这里溜出去。

**proc 句柄（`createProcHandle`）**：`spawn` / `spawnSync` / `exec` / `execSync` / `execFile` /
`execFileSync` / `fork` / `kill`。

- 命令名口径**直接复用** `bridge.firstCommand`，不另写解析：否则「句柄放行、Bridge 拒绝」这种错位迟早出现。
- `kill` 的目标映射与 Bridge 逐字一致：`process.pid → self`、`0 → children`、其它 `pid:<n>`。
- 进程创建与发信号是两条独立授权（`proc.spawn` / `proc.signal`），不合并。

### 6.4 能力注入（module redirect）

句柄只有在插件肯用它时才有用。但封闭面天生不完整（`openSync`、`fs.promises.open`、`watch`、`globSync`
都不在句柄里），默认开它会打断存量插件。因此两条路径都默认 `global`，`handles` 是显式选项：

- `policy.sandbox.mode = 'handles'`（**非默认，需显式配置**）时，装载期间安装 `Module._load` 重定向：
  `require('fs')` / `require('node:fs')` / `require('fs/promises')` 返回**能力句柄**，而不是原生模块。
- 插件代码不用改：它照旧 `require('node:fs')`，拿到的是封闭集合。用不到的方法（`readSync` 等）**不存在**，
  于是「越界」从「被 Hook 拦下」变成「根本没有这个入口」。但这要求插件只使用句柄内的方法，
  或用 `ctx.handles`——`openSync` 无法兼容（必须返回 fd），所以不能做默认值。
- **只对 `pluginRoot` 下的模块生效**：宿主的 `require('fs')` 不受影响；入口模块 parent 为 `null`，
  用 `redirect.enter()/exit()` 的装载窗口兜住；插件目录下的 `node_modules` 依赖也在 pluginRoot 内，同样被重定向。
- 顺序要求：Bridge 与 handles 模块必须已加载，重定向最后安装，否则它们自己会 require 到句柄而递归。
- `policy.sandbox.mode = 'global'`（**默认**）：插件拿原生 fs，由 Bridge 守卫事后拦截。
- `ctx.handles` **不受 `sandbox.mode` 影响，始终可用**：新插件可以直接走句柄；
  模式只决定 `require('fs')` 是否被重定向，决定「存量插件是否需要改代码」。
- `activate()` 与 `LocalHost` 默认一致（`global`），避免门禁阶段与运行时行为分叉；
  要封闭面请显式传 `sandbox: { mode: 'handles' }`。
- **`handles` 模式必须显式传 `pluginRoot`**（绝对路径、存在且为目录）：缺失时拒绝启动，
  不静默回落到 `process.cwd()`——否则模块重定向会把宿主自己的 `require('fs')` 一并换掉。
- **同一进程只允许一条重定向**：第二条 `install()` 直接抛错。两条会互相覆盖 `originalLoad`，
  卸载顺序一错就再也还原不回去；宁可报错，也不要静默错位。

## 7. 门禁流水线（非侵入式）

顺序固定：`blacklist → signature → structure → contract/charter → sieve → safety → loadability`。

默认 `enforcement.mode=advisory`：除应急黑名单与恶意脚本外，所有阶段都继续执行并输出安全画像标签，
**不拒绝安装**；`mode=required` 或企业通道才把各阶段结论升级为拒装。

| 阶段 | 默认（advisory） | strict（required / 企业） |
| --- | --- | --- |
| blacklist | 命中即阻断，`contractChecked=false` | 同左 |
| signature | 验签失败 / 无信任表 → `Untrusted` 标签 | 拒装 |
| structure | 恶意脚本类（patch 越界、扩展名非法、安装脚本不在白名单、entry 越界）阻断；其余 → `Broken` 标签 | 同左（恶意类始终阻断） |
| contract/charter | 缺字段 → `Untrusted` 标签 | 拒装 |
| sieve | 拒绝原因 → `Quarantined`（legacy）或 `Untrusted` 标签 | 拒装 |
| safety | 未声明能力、未 allowlist 出站、凭证访问 → `ReviewRequired` 标签 | 拒装 |
| loadability | `install → register → invoke → uninstall` 失败 → `Broken` 标签 | 拒装 |

- **strict 模式下前置门禁一旦阻断，就跳过 loadability**：它真的会 `require + invoke`，
  不该让没通过验签的包先跑起来。跳过时输出 `loadability_skipped` 标签。
- 结构门禁是唯一“结构类阻断”来源，阻断码见 `MALICIOUS_CODES`；manifest 无法解析时只输出标签。
- 每阶段状态：`pass` / `warn`（有标签）/ `fail`（有阻断）/ `skip`。
- 报告字段：`ok`（无阻断）、`blocked`、`errors`、`labels`、`securityLabels`、`labelLines`，
  单条错误含 `gate`、`code`、`message`、`field`、`file`、`line`、`phase`、`item`。

## 8. 签名与信任

`signatures.json`（`dsh-dashcam/signatures@1`）：

```json
{
  "format": "dsh-dashcam/signatures@1",
  "plugin": "com.example.plugin",
  "version": "1.0.0",
  "keyId": "publisher-2026a",
  "algorithm": "ed25519",
  "files": [{ "path": "index.js", "size": 735, "sha256": "…" }],
  "publisher": { "keyId": "publisher-2026a", "signature": "base64" },
  "reviewer": { "keyId": "reviewer-2026a", "signature": "base64" },
  "signedAt": "2026-10-27T00:00:00.000Z"
}
```

签名载荷 = 稳定序列化的 `{format, plugin, version, publisherKeyId, reviewerKeyId, algorithm, files, signedAt}`；
发布者与审核者各签一次。任何未列入清单的文件、被修改的文件都会在重建阶段失败。

客户端验签顺序（严格短路）：

1. **重建清单**：重算 `size` 与 `sha256`，比对文件集合（缺文件/多文件/变更）。
2. **校验 keyId**：`signatures.keyId` 必须等于发布者 keyId；发布者与审核者公钥必须存在于信任表且角色匹配。
3. **验发布者签名**。
4. **验审核签名**。

信任表每个 key 含 `keyId`、`roles`、`publicKey`、`status`。`active` / `next` / `retired` 可用于验签，`revoked` 一律拒绝。
`next` 与 `active` 并行存在即支持无中断轮换：新包用 `next` 签，旧包用 `retired` 仍可验。

## 9. 画像卡

- 数据源：manifest 请求 + 安全门禁扫描结果（扫描到但未声明的能力也要展示）。
- 三档：
  - **低**：折叠，仅提示数量。
  - **中**：展开，逐项勾选。
  - **高**：高风险项红显并强制确认。
- 首屏只显示分组数量、分组数与高风险项数，不铺开细节。
- 固定提示：`未扫到 ≠ 安全：静态扫描无法覆盖动态 require、原生模块与运行时生成代码。`
- 拒绝原因直接使用 `reason` 原文。

## 10. Autopsy（离线诊断）

六段：`existence → declaration → activation → registration → capability → uninstall`。

- `activation` 段离线组合 `profile` 与 `bundle patch`（`add` / `remove` / `replace`，点路径），不启动宿主。
- 输出 JSON 报告，含每段 `status`（`pass` / `warn` / `fail` / `skip`）与 `missing` 列表，明确指出缺哪一项。

## 11. 已知边界

- Bridge 保护的是**安装后**的进程内调用。插件在宿主安装 Bridge 之前拿到的函数引用（提前 `require` 并解构）不受保护；宿主应在加载插件后立即安装 Bridge，并只通过受控入口调用插件。
- 原生扩展（`.node`）、`worker_threads`、`vm` 内生成的代码、直接 syscall 不在 Node 层拦截范围内；安全门禁只能给出“扫描结果”，不构成安全证明。
- 完整性校验只能发现“被替换的函数”，不能发现“从未包装的入口”。
- 覆盖是枚举式的：`bridge.coverage().knownGaps` 列出未受控入口（http2、WebSocket、dgram、fd 级低层 API、
  未声明且非敏感的环境变量读取）。**“没被拦”不等于“安全”，只等于“没在清单里”。**
- **装载窗口（observe）**：Hook 在 `require` 之前就已安装，但窗口内只记账、不阻断
  （`guard.beginObserve()` / `endObserve()`）。理由是：窗口内一旦 fail-closed，任何 legacy 插件的
  第一次 `fs` 调用都会让安装失败，非侵入式就名存实亡。因此**装载期的越界调用会被记录（`intercepted=true`）
  但不会被打断**——这是如实记录的边界，不是没看见。
- 反过来，窗口关闭后同一调用立刻恢复 fail-closed；`stats.observed` 与 `interceptions()` 可区分两者。
- **TOCTOU**：判定用 `realpath`，从判定到真正 IO 之间仍有窗口（另一线程/进程可以换掉链接）。
  根治要在 `open` 之后按 fd 复核（`fstat` 比对 inode / `O_NOFOLLOW`），当前未做。
- **glob 类入口**（`fs.glob` / `globSync`）仍是缺口：路径在返回值里而不是参数里，参数级判定覆盖不到。
- **权限边界**：Bridge 与句柄都在 Node 层。`worker_threads`、`vm` 生成的代码、原生扩展、直接 syscall
  始终在 Hook 之外；唯一根治是分进程 / 分 realm。

## 12. 可配置上限（policy.limits）

这些值原先散落在各模块里写死，宿主只能改源码。现在统一走策略层，默认值不变。

| 键 | 默认 | 作用 | 调大的代价 |
| --- | --- | --- | --- |
| `batchTargets` | `10000` | 单次 `enforceBatch` 的目标数上限 | 同步逐条判定，会阻塞事件循环 |
| `globBatchSize` | `256` | 异步 glob 迭代器的分块大小（同步 glob 不分块） | 单条账本记录变大 |
| `fetchTimeoutMs` | `30000` | 出网 `fetch` 的默认超时；`0` = 不注入 | 对端挂起会拖死调用方 |
| `integrityEvery` | `64` | 每 N 次判定抽样做一次 `verifyIntegrity()`；`0` = 关闭 | 每次抽样都会遍历全部已包装入口 |
| `minMacKeyBytes` | `32` | `macKey` 的最小字节数 | 密钥熵下降，防篡改强度下降 |

另有一个**可选强约束**：`policy.enforcement.strictPatch`（默认 `false`）。

- `false`：Hook 装不完整时只记账（`ruleId='bridge_incomplete'`）+ 在 `coverage().unpatched` 暴露；
- `true`：装不完整直接**拒绝装载**（`LocalHost.register` 抛错）。

这是「非侵入式」与「fail-closed」之间唯一留给宿主的开关，默认取前者。

**limits 会被校验**：`resolveLimits()` 要求每个键是整数且不低于下界
（`batchTargets`/`globBatchSize`/`minMacKeyBytes` ≥ 1，`fetchTimeoutMs`/`integrityEvery` ≥ 0）。
非法值直接抛错——`batchTargets: 'abc'` 会让上限比较恒为 false，属静默 fail-open，必须尽早失败。

`coverage()` 增加 `installed` 字段：区分「Hook 从未安装」与「装了又被卸载」。
`strictPatch` 拒绝装载时会走 `uninstallNativeHooks()`，因此不会留下指向已卸载 Bridge 的 coverage。
