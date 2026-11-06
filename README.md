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

## 极速安装（DSH 桌面宿主）

DSH 按 profile 装载插件：`~/.dsh/profiles/desktop/package.json` 的 `dependencies` 决定装什么、
`dsh.profile.bundles` 决定启用谁；bundle 自带的 `cordis.patch.yml` 负责把插件插进宿主配置树。
按这个机制把判定链挂进去只需四步：

1. **挂载**：profile 的 `package.json` 加依赖 `"dsh-covenant-host": "link:<工作区>/dsh-covenant-host"`，
   并把 `dsh-covenant-host` 追加进 `dsh.profile.bundles`。
2. **安装**：在 profile 目录跑一次 `pnpm install`（用宿主自带运行时的 node/pnpm）。
3. **重启** DeepSeek Harness；日志出现 `[dsh-covenant] 判定链已挂载` 即为成功
   （日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs`）。
4. **卸载**：摘掉依赖与 bundle、还原 `cordis.patch.yml`，再跑一次 `pnpm install`，重启生效。

工作区根目录的 `install-to-host.ps1` / `uninstall-from-host.ps1` 把上述步骤连同时间戳备份/还原
自动化；日常安装走脚本，手工四步只适合一次性验证。

适配包默认 `patchBuiltins: false`：宿主是 Electron 主进程，Bridge 是进程级补丁，直接装上会接管
应用自身的 fs/net，所以默认只注册 pre-execute 判定函数。需要真实拦截时在 cordis 配置里显式
`patchBuiltins: true`（语义见上文「宿主集成」）。

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
- **装载窗口是残余风险，不是优点**：`require` 期间插件顶层代码的越界调用会被改写为放行并按 `deny` 记账
  （`intercepted=true`），但不会被打断——这是为 legacy 插件保留的一次性信任让步，装的时候已经发生的读取收不回来；
  未签名 consumer 默认放行的组合下，等于新插件的顶层代码有一次越权机会。可用
  `policy.enforcement.observeLoadWindow = false` 关闭（装载期越界直接拒绝装载）；`strictPatch = true`
  时窗口强制关闭且不可用配置重开；装载结束若有越界放行，会打 warning 告警（`stats.observed > 0`）。

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

## 能力注入：让 require('fs') 可选返回句柄（1.5.0）

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
