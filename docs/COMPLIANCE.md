# dsh-covenant 合规：Charter 与 Sieve

## 1. Charter 字段

`manifest.covenant.content` 必须是对象，包含以下五个字段，缺一不可：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `rating` | `general` / `teen` / `mature` / `restricted` | 内容分级，风险从低到高 |
| `scenes` | 字符串数组 | 适用场景，如 `chat`、`hud`、`coding` |
| `commercialUse` | `allowed` / `noncommercial` / `prohibited` | 商用边界 |
| `sourceFingerprint` | `sha256:<32-64 位 hex>` | 源码指纹，用于溯源 |
| `enterpriseExcluded` | 布尔 | 发布者主动声明排除企业通道 |

### 默认值（最保守）

未填字段不会“按宽松处理”，而是按最保守值运行：

```js
{ rating: 'restricted', scenes: [], commercialUse: 'prohibited',
  sourceFingerprint: null, enterpriseExcluded: true }
```

注意：

- 默认 `advisory` 模式下，缺失字段输出 `Untrusted` 画像标签并继续安装；`required` / 企业通道才把
  `charter_field_missing` 升级为拒装。
- 默认值用于展示与 legacy 插件的运行时画像，不构成能力授予。

## 2. 字段校验

`validateCharter` 在契约门禁执行，逐字段报告：

| 错误码 | 条件 |
| --- | --- |
| `charter_missing` | `covenant.content` 缺失或不是对象 |
| `charter_field_missing` | 任一必填字段为 `undefined` / `null` |
| `charter_rating_invalid` | `rating` 不在枚举内 |
| `charter_scenes_invalid` | `scenes` 不是数组 |
| `charter_commercial_invalid` | `commercialUse` 不在枚举内 |
| `charter_fingerprint_invalid` | `sourceFingerprint` 不是 `sha256:<hex>` |
| `charter_enterprise_invalid` | `enterpriseExcluded` 不是布尔 |

所有错误都带 `field`（如 `covenant.content.rating`）与 `file`（`manifest.json`）。

## 3. Sieve 准入

`evaluateAdmission(manifest, {channel, policy})` 的判定顺序：

1. **legacy**：企业通道直接拒绝（`legacy_enterprise_excluded`）。消费通道按 `policy.enforcement` 判定：
   默认 `advisory` → 放行并记为 `Quarantined` 标签（警告 `legacy_conservative_defaults`）；
   `required` 且 `allowLegacy=false` → 拒绝（`legacy_not_admitted`）；
   `allowLegacy: true` → 放行并记 `legacy_allowlisted_by_host`。
2. **Charter 缺失**：默认输出 `Untrusted` 标签；`required` 拒绝（`charter_missing`）。
3. **缺字段**：逐字段报告（`charter_field_missing`），默认标签、`required` 拒绝，不再继续后续判定。
4. **分级**：`RATING_RANK[rating] > RATING_RANK[channel.maxRating]` → `rating_blocked`。
5. **场景**：任一 `scenes` 命中 `channel.blockedScenes` → `scene_blocked`（`reason` 即场景名）。
6. **商用**：`commercialUse` 不在 `channel.commercialUse` → `commercial_blocked`。
7. **企业排除**：企业通道下 `enterpriseExcluded=true` → `enterprise_excluded`。
8. **企业出站**：企业通道要求显式 allowlist，未配置 → `egress_allowlist_not_configured`。

全部通过才 `admitted=true`。返回结构：

```js
{ admitted, charter, reasons: [{code, field, reason}], warnings: [{code, reason}] }
```

`reason` 直接来自策略或字段值，不包装、不改写。

## 4. 通道策略默认值

| 通道 | `maxRating` | `commercialUse` | 额外要求 |
| --- | --- | --- | --- |
| `consumer` | `mature` | `allowed` / `noncommercial` | 无 |
| `enterprise` | `teen` | `allowed` | `requireEgressAllowlist: true` |

策略可在 `policy.channels.<channel>` 覆盖，但企业通道的 allowlist 要求不建议关闭。
企业通道是**单独开关**：只有显式传 `channel: 'enterprise'` 才启用上述规则。

### 执行模式

```js
policy.enforcement = { mode: 'advisory', allowLegacy: false, requireSignature: false }
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `mode` | `advisory` | 默认先装再标注；`required` 把门禁结论升级为拒装（企业通道始终 required） |
| `allowLegacy` | `false` | `required` 模式下放行 legacy 的显式逃生阀；放行写 `ruleId=admission` 的 Ledger |
| `requireSignature` | `false` | 默认验签失败只输出 `Untrusted`；打开后无签名/验签失败即拒装 |

执行点在加载器：`LocalHost.install` 自己跑完整门禁流水线，`install(pluginDir)` 没有
“跳过准入”的参数。`advisory` 下准入结论与安全标签都写 Ledger / 挂在该插件上；只有
`report.blocked`（恶意脚本或黑名单）才真正拒绝。

## 5. 与元数据覆盖率的关系

月度度量中的 `metadataCoverage` 统计 10 个字段（`id`、`name`、`version`、`entry`、`covenant` + 五个 Charter 字段）
在 manifest 中的存在比例。覆盖率用于观察生态元数据质量，不作为单个插件的准入依据；
单个插件的准入只认 `validateCharter` 与 Sieve 的结果。

## 6. 常见反例

| 反例 | 结果 |
| --- | --- |
| 只写 `rating`，不写其他字段 | 默认：`Untrusted` 标签；`required`：`charter_field_missing` × 4，拒装 |
| `scenes: "chat"`（字符串） | `charter_scenes_invalid`：默认标签，`required` 拒装 |
| `sourceFingerprint: "abc"` | `charter_fingerprint_invalid`：默认标签，`required` 拒装 |
| 企业通道提交 `rating: mature` | `rating_blocked`（企业上限 `teen`），拒装 |
| 企业通道提交 `commercialUse: noncommercial` | `commercial_blocked`，拒装 |
| 未配置 `egressAllowlist` 就走企业通道 | `egress_allowlist_not_configured`，拒装 |
| 无 `covenant` 字段 | legacy：默认 `{level:'legacy',quarantine:true}`；advisory 消费通道可装并标 `Quarantined`；`required` 拒装；企业通道恒拒 |
