# dsh-dashcam-host

把 [dsh-dashcam](../README.md) 的判定链接入 DeepSeek Harness（cordos 宿主）。本目录自 1.10.12 起并入主仓库（git subtree，历史完整保留）。

- 入口：DSH 核心的 `tools/pre-execute` waterfall（`(exec, next)` 签名；放行必须 `return next()`）。
- 默认 **advisory**：映射到的调用逐条走 `guard.check` 记账（含 deny 明细）但放行；
  `enforce: true` 后判定不允许即拦截。
- 定位边界：判定链是**入口策略门**（拦工具参数），工具执行后的真实副作用由
  `patchBuiltins: true`（Bridge，默认关闭）看护进程内调用。

## 配置键（cordis 插件 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enforce` | `false` | `true` 时判定不允许即拦截；授权见「Two-Key」 |
| `enforceUnmapped` | `false` | F6：enforce 默认只覆盖映射表；开此键后未映射工具**每次调用**都按 fail-closed 拒绝（1.10.13 复核 P1：拦截不受遥测去重影响）。computer-use / workflow / subagent / MCP 均在映射表外，需靠它兜底 |
| `unmappedAllowlist` | `[]` | L6（1.10.13）：enforceUnmapped 的豁免清单，支持全名与前缀通配（`mcp__demo__*` / `memory_*`）。**开 enforceUnmapped 前必须先配**——否则 `compress` / `workflow` / `subagent` / `send_meme` / `present` / `memory_*` / `mcp__*` 这些宿主/MCP 工具会被全部打死。**非数组（如误写成逗号分隔字符串）fail-fast 拒绝挂载**（R3，1.10.14），不会静默按空数组拦掉全部 |
| `commandlineArchive` | `'hash'` | F4：`'hash'`（默认）只存整条命令的 SHA-256 + 长度，不含明文；`'full'` 落打码后文本（Bearer / `sk-` / `ghp_` / `password=` 等替换为 `***`，best-effort）。per-挂载生效（L2），多挂载不互串 |
| `ledgerPath` | `~/.dsh/dsh-dashcam/ledger.jsonl` | 账本文件路径；测试 profile 必须独立（如 `ledger-dashcam-test.jsonl`） |
| `ledgerMacKey` / `ledgerMacKeyFile` / `ledgerMacKeyEnv` | 空 | F1/1.10.11 D4：账本 HMAC 密钥（≥32 字节）。**启用前必读下节** |
| `patchBuiltins` | `false` | 进程内 Bridge 补丁；Electron 主进程开启会接管应用自身 fs/net，慎开 |
| `requests` / `grants` | `[]` | Two-Key：能力声明（对象数组，写成字符串会在 mount 时 fail-fast） |

## 工具映射表（1.10.13）

公开名先剥 `ops_` 前缀再按裸名匹配（`ops_bash → bash`）：

| 工具（裸名） | 判定 |
| --- | --- |
| `pwsh` / `bash` / `sh` / `zsh` / `cmd` | `proc.spawn`（**首词**口径）+ 命令行哈希存档；`script_path` 整串 |
| `read` / `read_file` / `read_files` / `read_table` / `read_docx` / `read_pdf` / `read_image` / `inspect_local_file` | `fs.read` 逐 path（凭证路径自动升级 `cred.read`） |
| `glob` / `grep` | `fs.read`；path 是目录时判 `dir/**`（F3）；缺 path 落 `unjudgeable` 遥测 |
| `stat` / `diff` | `fs.read`；目录同上转子树形态 |
| `write` / `write_file` / `edit` / `edit_file` / `replace` | `fs.write`（`dryRun: true` 降级 `fs.read`）；replace 基目录转子树形态 |
| `copy` | `fs.read`(源) + `fs.write`(目标)；目标为已存在目录时判 `to/**` |
| `move` | `fs.read`(源) + **`fs.delete`(源：目录时节点+子树两条，M1)** + `fs.write`(目标) |
| `remove` | `fs.delete`；目标是目录时 **节点 + 子树两条都判**（M1） |
| `batch` | `operations[]` 逐条展开（同 copy/move/remove 口径，上限 512）；缺 operations 落 `unjudgeable` |
| `web_fetch` / `fetch` | `net.outbound`（host:port） |
| `discover_tools` / `result` | 不映射不遥测（无副作用） |
| 其余 | 放行 + `telemetry/unmapped-tool`（console 点名与 allow 遥测同名只记一次）；`enforceUnmapped` 下**每次调用**拒绝且**每次都落 deny 账**（R2，1.10.14：审计不去重），`unmappedAllowlist` 命中的豁免放行 |

无法判定的调用（batch 缺 operations、glob 缺 path、copy/move 缺 to）：
advisory 落 `telemetry/unjudgeable-tool`（allow）放行；enforce 落 deny 账后拒绝（F2：审计先于执行）。

**M1（1.10.13）目录删除的授权口径**：`remove(目录)` / `move(目录, …)` 删的是
**节点本身 + 整棵子树**，按节点（`fs.delete{dir}`，需显式授权 dir 本身）与子树
（`fs.delete{dir/**}`）两条判定，enforce 下都要过——仅授 `dir/**` 不放行，
与 SPEC「`dir/**` 不含 dir 本身」一致；删除目录节点请同时授权 `dir` 与 `dir/**`。

## MAC 启用与账本迁移（F1，1.10.12 起有防呆）

**不要在既有 v2 账本上原地开 MAC。** 生产账本（190 行）全是 v2 无 mac 记录，
开启后 `Ledger.verify()` 会把全部历史判成 `mac_missing`、`ok=false`，
而 dashcam 的 metrics 先校验后统计，直接非零退出。宿主已加防呆：
配置了 MAC 密钥且账本存在无 mac 历史行 → **拒绝挂载**并打印迁移步骤。
拒绝挂载会在账本旁留 side 日志 `<ledgerPath>.guard.log`（L3，桌面版看不到
stdout 也能事后查）；`ledgerMacKeyEnv` 指向的环境变量未设置时报
`stage=mac-env-missing`（L1，独立文案，不冒充「不能原地启用」）。

迁移步骤（换新账本 + 归档，不要原地开关）：

1. 归档旧账：`mv ~/.dsh/dsh-dashcam/ledger.jsonl ~/.dsh/dsh-dashcam/ledger-v2-archive.jsonl`
   （文件名标注 v2-无-mac，勿再追加）。
2. 保持 `ledgerMacKey`（或 `ledgerMacKeyFile` / `ledgerMacKeyEnv`）配置，重启 DSH——
   判定链会在新文件上从 v3 起账，mount 记录即带 mac。
3. 归档文件如需核对，用无密钥 `new Ledger(path).verify()`：`ok=false / mac_missing`
   是预期结果（历史本就无 mac），不代表账本损坏。
4. 密钥管理：≥32 字节随机串；不进仓库。推荐 `ledgerMacKeyFile` 指向权限受控的文件，
   或 `ledgerMacKeyEnv: 'DSH_DASHCAM_MAC_KEY'`。

存档哈希说明：命令行存档的 `commandLineHash` 是**原文**的 SHA-256（非打码后文本），
用于离线对账时验证「账上哈希 == 实际执行过的命令」，不含明文。

## 已知边界

- **F5（口径，已闭合）**：telemetry 附加记录不再计入 metrics 的判定口径——核心
  dsh-dashcam 1.10.12 起 `computeMetrics` / `monthlyMetrics` 只收
  `capability !== 'telemetry'` 的记录，telemetry 数量另列 `telemetryRecords` /
  `telemetryDenies` 并列读数（见核心 docs/ROLLOUT.md 第 6 节）。本宿主附加记录
  （mount / unmapped-tool / unjudgeable-tool / commandline-audit）的 capability
  固定为 `telemetry`，勿改。
- 命令判定口径 = 首词；`bash -c "…"` 套娃内部副作用不在入口门覆盖范围。
- `replace` 以基目录为审计粒度，glob 命中的实际文件不逐个展开。
- `dir/**` 授权不含 `dir` 本身是 SPEC 契约（docs/SPEC.md 77）；宿主对**只读/子树写**
  语义转 `dir/**` 对齐，**破坏性删除保持节点判定**（M1）。
- **L4（TOCTOU）**：目录探测**正结果**带 30s TTL 缓存、**负结果不缓存**（R1，1.10.14：
  负缓存会让「文件→目录」30s 窗口内的删除跳过子树判定绕过 M1，属 fail-open，已修；
  正缓存方向相反——目录被换成文件后仍多判一条子树，是 fail-closed，可接受）。
  判定与工具执行之间仍存在竞态窗口，入口门不承诺原子性，真拦截靠 Bridge。
- `patchBuiltins: true` 与宿主入口门叠加时，目录探测会产生额外 fs 记录；建议二选一。

## 验证

```powershell
npm run smoke   # 96 项断言，全过
# 主仓库回归：cd ..; npm test   # 241 例，0 fail
```

部署确认（F8）：重启 DSH 桌面后，账本新 mount 记录应为
`pluginVersion: "1.10.14"`、`scope.mode` 与配置一致；**部署侧暂保持 advisory 观察，
勿急着开 enforce / enforceUnmapped**（开 enforceUnmapped 前先按上表配 unmappedAllowlist）。
