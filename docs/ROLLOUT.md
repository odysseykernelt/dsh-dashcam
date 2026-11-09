# dsh-dashcam 上线节奏与治理

本文件按骨架第 8、9 节定稿上线顺序、熔断条件、回滚层级、密钥轮换、应急下架与月度度量。
不排日期，只定义“进入下一步的条件”和“退回上一档的条件”。

## 1. 六阶段

顺序由 `src/governance/rollout.js` 的 `STAGES` 固化：

| # | 阶段 | 内容 | 进入下一阶段的条件 |
| --- | --- | --- | --- |
| 0 | `contract-two-key` | 契约层 + Two-Key，默认 deny-all；门禁默认 `advisory`，输出安全标签 | 反例包（[examples/negative-plugin](../examples/negative-plugin)）的恶意脚本被阻断；正例包按声明放行；legacy 以 `Quarantined` 运行且无任何能力 |
| 1 | `bridge-ledger` | Bridge + Ledger + One-Seal | 绕过测试集清零：直调 Node API、第三方库、patch 注入、网络/env |
| 2 | `structure-signature` | 结构门禁 + 签名 | 阻断类用例先跑通（越界 patch、非白名单安装脚本一律拒装）；未签名/篡改包稳定输出 `Untrusted` 标签 |
| 3 | `safety-loadability` | 安全门禁 + 可装载性门禁 | 灰度期间误杀率与放弃率均在阈值内 |
| 4 | `portrait-autopsy` | 画像卡 + Autopsy 接入安装流程 | 首屏信息、三档交互、拒绝原因展示均通过评审 |
| 5 | `charter-sieve` | Charter + Sieve，企业通道单独开关 | 企业通道元数据覆盖率达标，且企业排除规则可审计 |

阶段推进用 `RolloutController.advance()`；需要人工确认时保持 `autoAdvance=false`。

## 2. 熔断

`checkCircuitBreaker(metrics, thresholds)` 对三项指标做硬判定，任一超阈值即 `action=rollback`：

| 指标 | 默认阈值 | 含义 |
| --- | --- | --- |
| `falseKillRate` | `0.02` | 误杀率：被拒但事后确认应放行的比例 |
| `abandonmentRate` | `0.05` | 放弃率：安装流程被用户/上游中止的比例 |
| `silentFailureRate` | `0.01` | 静默失效率：守卫或 Ledger 未按预期生效的比例 |

`RolloutController.evaluate(metrics)` 在违例时把 `stageIndex` 回退一档并返回 `from` / `to` / `violations`；
未违例且 `autoAdvance=true` 时前进一档，否则 `hold`。

阈值可按通道在 `policy.circuitBreaker` 中覆盖，但不得高于默认值太多；调整必须留痕。

## 3. 三级回滚

`RollbackManager` 支持三个层级，语义不同，互不替代：

| 层级 | 粒度 | 典型用法 |
| --- | --- | --- |
| `rule` | 单条门禁规则 / 阈值 | 某条静态扫描规则误杀，回退该规则到上一版 |
| `module` | 一个模块（如 `net-guard`、`bridge`） | Bridge 新版本引入回归，整模块回退 |
| `contract` | 单个插件的契约版本 | 某插件升级后越权，回退到上一版 manifest 与签名包 |

- `snapshot({level,key,value})` 记录版本；`rollback({level,key})` 返回上一版；`history` 保留变更轨迹。
- 契约级回滚必须同时回退签名包与授予集，避免“旧代码 + 新授权”的组合。
- 回滚本身写 Ledger（`ruleId=rollback`），便于事后复盘。

## 4. 密钥双钥并行轮换

信任表 key 状态：`active`（当前主用）、`next`（下一把，已发布）、`retired`（已退役但仍可验旧包）、`revoked`（立即失效）。

轮换步骤（不中断验签）：

1. 生成新密钥，以 `next` 状态加入信任表，客户端先行分发。
2. 新包改用 `next` 私钥签名；旧包继续用 `active` 验证。
3. 确认客户端全部拿到新信任表后，把旧 key 置为 `retired`，新 key 置为 `active`。
4. 旧包全部过期或重签后，可移除 `retired` key。

任何一步都不得删除仍在服务期内的公钥；`revoked` 只用于泄漏或误签。

## 5. 应急下架

黑名单是**独立通道**，不依赖签名、不依赖契约校验，位于安装流水线第一段：

- 存储：独立 JSON 文件（`Blacklist`），可离线分发；条目 `{plugin, reason, until?}`。
- 命中即拒绝，`contractChecked=false`；`until` 到期自动放行。
- CLI：`dsh-dashcam blacklist <file> add|remove|list ...`。
- 运行时：`createGuardChain({blacklist})` 在每个请求前检查，命中返回 `blacklisted`，并写 Ledger。

应急下架优先于一切“补签名/补声明”的修复路径；恢复上架必须重新走完整门禁。

## 6. 月度度量

`computeMetrics` / `monthlyMetrics` 从 Ledger 与安装事件离线重算，口径固定：

| 指标 | 公式 | 说明 |
| --- | --- | --- |
| 拦截率 `interceptionRate` | `deny / (allow + deny)` | 守卫链拦截比例 |
| 误杀率 `falseKillRate` | `overrides / deny` | 人工复核推翻的拒绝占比 |
| 静默失效率 `silentFailureRate` | `guardErrors / (allow + deny)`，无记录时 `guardErrors / guardErrors` | 守卫异常、Ledger 写失败等 |
| 未声明拦截率 `undeclaredInterceptionRate` | `intercepted / (allow + deny)` | 插件调用了 manifest 没声明的 API，属于越界 |
| 授权缺口率 `grantDenialRate` | `(not_granted + scope_mismatch) / deny` | 声明了但宿主没发钥匙，该改策略而不是改插件 |
| 放弃率 `abandonmentRate` | `abort / (attempt + abort)` | `attempt` 只记未被中止的安装，分母需含 `abort` |
| 元数据覆盖率 `metadataCoverage` | `present / required` | 10 个必填元数据字段 × manifest 数 |

**telemetry 附加记录排除（1.10.12）**：宿主适配层（dsh-dashcam-host）会把非判定的附加
审计记录直接 append 进账本（mount / unmapped-tool / unjudgeable-tool / proc.commandline
存档），capability 固定为 `telemetry`。它们不是 Two-Key 判定：判定读数（上表全部
allow/deny 口径指标）只收 `capability !== 'telemetry'` 的记录；telemetry 数量与其中
deny 条数另列并列读数 `telemetryRecords` / `telemetryDenies`，可见性不丢。
`records()` / `verify()` 等离线审计仍看全量行，不受口径影响。

**ingress 观测记录排除（1.12.0）**：`capability='llm.ingress'` 的 `llm.request` / `llm.inbound` /
`llm.anomaly` 同样是观测而非判定，判定读数一并排除；另列 `ingressRequests` / `ingressInbound` /
`ingressAnomalies` / `ingressAnomalyRate`。没有 ingress 记录的旧账本上这些读数恒为 0。
异常记录不写 `deny`，因此不会抬高拦截率，也不会触发 `falseKillRate` / `abandonmentRate`。
`interceptionRate` 的告警阈值不因 ingress 调整；ingress 异常率是独立观察项，不参与
`checkCircuitBreaker` 的自动回滚判定。

`monthlyMetrics` 按 `ts` / `at` 的 `YYYY-MM` 分组，输出每月完整指标。

## 7. 执行点在宿主

准入不是商店的职责，是**加载器**的职责。这一条比任何门禁规则都重要，所以单独成节：

- 非侵入式不是“放过插件”，而是把执行点从安装时移到运行时：门禁先装、再输出安全画像标签
  （`Untrusted` / `Quarantined` / `ReviewRequired` / `Broken` / `Verified`），
  真正的能力边界由 `LocalHost.install` / `activate()` 里的 Two-Key 与 Ledger 守住。
- 只有恶意脚本（越界 patch、非白名单安装脚本、entry 越界）与应急黑名单才阻断安装；
  其余问题必须在画像卡上可见，不能悄悄降级。
- 企业通道或显式 `enforcement.mode=required` 恢复拒装语义；想放宽只能改策略并留痕，
  不得在调用方传参跳过准入。
- 灰度期若误杀率超阈值，正确的动作是**回退到 `advisory` 并记一条规则级回滚**，
  而不是悄悄放宽某个白名单——后者会让「执行点在宿主」这个前提失效，且不留痕迹。

## 8. 上线前必须告知宿主（部署责任清单）

前七节讲「库能保证什么」。这一节讲**库保证不了、必须由部署方兜住**的部分——它们不是待修的
bug，而是这类「进程内治理」方案的物理边界。上线前逐项确认；缺哪项，就在插件画像卡上明示，
不要让它看起来像已经解决。

| # | 边界 | 为什么库管不了 | 宿主必须做什么 | 验收方式 |
| --- | --- | --- | --- | --- |
| 1 | 目录级 TOCTOU（链接替换、父目录 rename） | `open` 之后只能拿到 `fstat` 的类型和**当前路径**的 realpath，拿不到 fd 指向的 inode 路径 | 插件工作目录独立（父目录不与他人共享可写）；最小权限账号；必要时容器 + 只读挂载 | 用攻击脚本试：判定通过后、IO 之前 rename 父目录——当前会漏，属已知，必须靠文件系统隔离 |
| 2 | `vm` / 原生扩展（`.node`）/ Worker 内部 | 同一进程内没有第二道墙；Worker 的模块表是新的 | 高风险插件放独立进程或独立 realm；企业通道直接拒收含原生扩展的包 | 安全门禁 `scan.findings` 出现 `native_module` 的必须走隔离，不能只贴标签 |
| 3 | 账本可写性 | HMAC 只保证「无密钥者伪造不了」；进程账号若对账本目录有写权限，可以直接截断 | 账本放独立存储（append-only 挂载 / 外部日志系统）；定期 `anchor()` 外发 | 用运行账号试删账本，应当失败；`metrics --anchor <锚点文件>` 应通过 |
| 4 | `macKey` 托管 | 密钥进了仓库/镜像/日志，等于没有密钥 | KMS 或编排层注入（`DSH_DASHCAM_MAC_KEY` / `--mac-key-file`）；谁能读写进运维文档；轮换按「新账本 + 旧账本重新锚定」做 | `redact()` 只露 `{macEnabled,keyLength,source}`；密钥在仓库与日志里 grep 不到 |
| 5 | 沙箱模式 | 默认 `global` 只靠 Hook 事后拦；`handles` 需要插件改用 `ctx.handles`（`openSync` 等无法兼容） | 高敏插件显式 `sandbox.mode='handles'`；存量保持默认 `global`，零改动 | `host.coverage().sandbox.kind` 与策略一致：`global` → `none`，`handles` → `module-redirect` |

**上线检查清单**（逐项打勾；缺项要在画像卡上标 `ReviewRequired`，不要标 `Verified`）：

- [ ] 插件工作目录独立，父目录对其他账号不可写
- [ ] 账本目录对运行账号只可追加、不可删除/重写（或已定期外发锚点）
- [ ] `macKey` 不落仓库、不进镜像、不出现在任何日志
- [ ] 含原生扩展或用 `vm` 的插件已隔离到独立进程，或已拒收
- [ ] 存量 `global` 沙箱插件已登记为技术债
- [ ] 跑过 `metrics --anchor` 并保留过锚点文件

**已知不可测项**：Windows 上创建文件符号链接需要管理员权限或开发者模式，无权限时
`test/symlink.test.js` 的 3 条用例会**显式 skip**。**skip 不等于通过**——在没有符号链接权限的
CI 上，那条逃逸路径只有目录联接（junction）用例覆盖着，人工复核时要记得这个差集。

## 9. 合入与灰度要求

- 每阶段合入前必须跑通 `npm test`（含绕过测试集与准入用例：audit / mandate）。
- 阶段 2、3 的阻断类规则先行：宁可在灰度前多拒，灰度只调误杀，不放松阻断。
- 灰度期只调整 `policy`（allowlist、阈值、凭证复核名单），不改契约语义；语义变更必须走规范评审。
- 每次回退与阈值调整都写 Ledger，并纳入当月度量复盘。
