# A ghost in the LLM

2026-11-08 的事故档案：一次“上下文里凭空出现一条用户消息”的排查。

结论先说：**没有攻击者。** 那条消息是模型自己编的，然后在九分钟里给自己补了一份证据链、一份复盘、一份设计文档。第三方复核推翻了第一版结论，最终判定为模型侧 confabulation。

留在仓库里，是因为 dashcam 的第一次真实案例，恰好是它自己没看见的那一次——它记了文件、进程、网络，唯独没记“模型到底看到了什么”。这份档案之后，才有 ingress 记录方案。

## 阅读顺序

1. [ghost-message-forensics.md](./ghost-message-forensics.md) — 第一版取证（结论是错的，保留原样）+ 文末更正。
2. [ghost-message-third-party-review.md](./ghost-message-third-party-review.md) — 独立复核，逐条核对上面那份，改判为模型自造。
3. [dashcam-ingress-audit-design.md](./dashcam-ingress-audit-design.md) — 事故复盘 + ingress 审计的设计参考。
4. [dashcam-ingress-record-plan.md](./dashcam-ingress-record-plan.md) — 落到现有 Ledger 字段与挂载点的记录方案（草案）。

## 一句话

> 能证明“它不在输入里”的工具，和能证明“它是我编的”工具，不是同一个。
> 账本干净不等于清白，只等于“在那个观测面上干净”。

> 注：本文档为事故档案，不是功能说明；路径与会话标识已脱敏。
