# dsh-covenant-host

把 [dsh-covenant](../dsh-covenant) 的判定链接入 DeepSeek Harness（cordos 宿主）。

- 入口：DSH 核心的 `tools/pre-execute` waterfall（`(exec, next)` 签名；放行必须 `return next()`）。
- 默认 **advisory**：映射到的调用逐条走 `guard.check` 记账（含 deny 明细）但放行；
  `enforce: true` 后判定不允许即拦截。
- 定位边界：判定链是**入口策略门**（拦工具参数），工具执行后的真实副作用由
  `patchBuiltins: true`（Bridge，默认关闭）看护进程内调用。

## 配置键（cordis 插件 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enforce` | `false` | `true` 时判定不允许即拦截；授权见「Two-Key」 |
| `enforceUnmapped` | `false` | F6：enforce 默认只覆盖映射表；开此键后未映射工具也按 fail-closed 拒绝（总闸口径）。computer-use / workflow / subagent / MCP 均在映射表外，需靠它兜底 |
| `commandlineArchive` | `'hash'` | F4：`'hash'`（默认）只存整条命令的 SHA-256 + 长度，不含明文；`'full'` 落打码后文本（Bearer / `sk-` / `ghp_` / `password=` 等替换为 `***`，best-effort） |
| `ledgerPath` | `~/.dsh/dsh-covenant/ledger.jsonl` | 账本文件路径；测试 profile 必须独立（如 `ledger-covenant-test.jsonl`） |
| `ledgerMacKey` / `ledgerMacKeyFile` / `ledgerMacKeyEnv` | 空 | F1/1.10.11 D4：账本 HMAC 密钥（≥32 字节）。**启用前必读下节** |
| `patchBuiltins` | `false` | 进程内 Bridge 补丁；Electron 主进程开启会接管应用自身 fs/net，慎开 |
| `requests` / `grants` | `[]` | Two-Key：能力声明（对象数组，写成字符串会在 mount 时 fail-fast） |

## 工具映射表（1.10.12）

公开名先剥 `ops_` 前缀再按裸名匹配（`ops_bash → bash`）：

| 工具（裸名） | 判定 |
| --- | --- |
| `pwsh` / `bash` / `sh` / `zsh` / `cmd` | `proc.spawn`（**首词**口径）+ 命令行哈希存档；`script_path` 整串 |
| `read` / `read_file` / `read_files` / `read_table` / `read_docx` / `read_pdf` / `read_image` / `inspect_local_file` | `fs.read` 逐 path（凭证路径自动升级 `cred.read`） |
| `glob` / `grep` | `fs.read`；path 是目录时判 `dir/**`（F3）；缺 path 落 `unjudgeable` 遥测 |
| `stat` / `diff` | `fs.read`；目录同上转子树形态 |
| `write` / `write_file` / `edit` / `edit_file` / `replace` | `fs.write`（`dryRun: true` 降级 `fs.read`）；replace 基目录转子树形态 |
| `copy` | `fs.read`(源) + `fs.write`(目标)；目标为已存在目录时判 `to/**` |
| `move` | `fs.read` + `fs.delete`(源) + `fs.write`(目标) |
| `remove` | `fs.delete` |
| `batch` | `operations[]` 逐条展开（同 copy/move/remove 口径，上限 512）；缺 operations 落 `unjudgeable` |
| `web_fetch` / `fetch` | `net.outbound`（host:port） |
| `discover_tools` / `result` | 不映射不遥测（无副作用） |
| 其余 | 放行 + `telemetry/unmapped-tool`（同名只记一次；`enforceUnmapped` 下拒绝） |

无法判定的调用（batch 缺 operations、glob 缺 path、copy/move 缺 to）：
advisory 落 `telemetry/unjudgeable-tool`（allow）放行；enforce 落 deny 账后拒绝（F2：审计先于执行）。

## MAC 启用与账本迁移（F1，1.10.12 起有防呆）

**不要在既有 v2 账本上原地开 MAC。** 生产账本（190 行）全是 v2 无 mac 记录，
开启后 `Ledger.verify()` 会把全部历史判成 `mac_missing`、`ok=false`，
而 covenant 的 metrics 先校验后统计，直接非零退出。宿主已加防呆：
配置了 MAC 密钥且账本存在无 mac 历史行 → **拒绝挂载**并打印迁移步骤。

迁移步骤（换新账本 + 归档，不要原地开关）：

1. 归档旧账：`mv ~/.dsh/dsh-covenant/ledger.jsonl ~/.dsh/dsh-covenant/ledger-v2-archive.jsonl`
   （文件名标注 v2-无-mac，勿再追加）。
2. 保持 `ledgerMacKey`（或 `ledgerMacKeyFile` / `ledgerMacKeyEnv`）配置，重启 DSH——
   判定链会在新文件上从 v3 起账，mount 记录即带 mac。
3. 归档文件如需核对，用无密钥 `new Ledger(path).verify()`：`ok=false / mac_missing`
   是预期结果（历史本就无 mac），不代表账本损坏。
4. 密钥管理：≥32 字节随机串；不进仓库。推荐 `ledgerMacKeyFile` 指向权限受控的文件，
   或 `ledgerMacKeyEnv: 'DSH_COVENANT_MAC_KEY'`。

存档哈希说明：命令行存档的 `commandLineHash` 是**原文**的 SHA-256（非打码后文本），
用于离线对账时验证「账上哈希 == 实际执行过的命令」，不含明文。

## 已知边界

- **F5（口径）**：telemetry 附加记录计入 metrics 的 allow/deny 口径（metrics 在核心侧，
  未排除 aux 记录）——下轮核心改动时统一处理；本版只保证被拒调用的存档记 deny。
- 命令判定口径 = 首词；`bash -c "…"` 套娃内部副作用不在入口门覆盖范围。
- `replace` 以基目录为审计粒度，glob 命中的实际文件不逐个展开。
- `dir/**` 授权不含 `dir` 本身是 SPEC 契约（docs/SPEC.md 77）；宿主对目录语义判定
  对象转子树形态来对齐，授权仍建议同时给 `dir` 与 `dir/**`。
- `patchBuiltins: true` 与宿主入口门叠加时，目录探测会产生额外 fs 记录；建议二选一。

## 验证

```powershell
npm run smoke   # 75 项断言，全过
# 主仓库回归：cd ../dsh-covenant; npm test   # 234 例，0 fail
```

部署确认（F8）：重启 DSH 桌面后，账本首条应为
`pluginVersion: "1.10.12"` + `action: "mount"`、`scope.mode` 与配置一致。
