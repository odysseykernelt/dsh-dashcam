# dsh-dashcam-host

**English** | [中文](README.zh-CN.md)

![version](https://img.shields.io/badge/version-1.14.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D%2020-green) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

Wires the judgment chain of [dsh-dashcam](../README.md) into DeepSeek Harness (the cordos host). This directory merged into the main repository as of 1.10.12 (git subtree, history fully preserved).

- Entry point: the DSH core's `tools/pre-execute` waterfall (`(exec, next)` signature; passing through must `return next()`).
- Defaults to **advisory**: mapped calls each go through `guard.check` for bookkeeping (including deny details) but are allowed through; with `enforce: true`, a failed judgment blocks the call.
- Scope boundary: the judgment chain is an **entry policy gate** (it judges tool arguments); the real side effects after tool execution are covered by `patchBuiltins: true` (the Bridge, off by default), which guards in-process calls.

## Config keys (cordis plugin config)

| Key | Default | Description |
| --- | --- | --- |
| `enforce` | `false` | With `true`, a failed judgment blocks the call; authorization see "Two-Key" |
| `enforceUnmapped` | `false` | F6: enforce by default only covers the mapping table; with this key on, unmapped tools are rejected **on every call** fail-closed (1.10.13 recheck P1: interception is not affected by telemetry dedupe). computer-use / workflow / subagent / MCP are all outside the mapping table and rely on this key as the fallback |
| `unmappedAllowlist` | `[]` | L6 (1.10.13): the exemption list for enforceUnmapped, supporting exact names and prefix wildcards (`mcp__demo__*` / `memory_*`). **Must be configured before enabling enforceUnmapped** — otherwise the host/MCP tools `compress` / `workflow` / `subagent` / `send_meme` / `present` / `memory_*` / `mcp__*` will all be blocked. A non-array value (e.g. accidentally a comma-separated string) **fails fast and refuses the mount** (R3, 1.10.14) instead of silently treating it as an empty array and blocking everything |
| `commandlineArchive` | `'hash'` | F4: `'hash'` (default) stores only the SHA-256 + length of the whole command, no plaintext; `'full'` stores masked text (Bearer / `sk-` / `ghp_` / `password=` etc. replaced with `***`, best-effort). Effective per-mount (L2); multiple mounts don't cross-talk |
| `ledgerPath` | `~/.dsh/dsh-dashcam/ledger.jsonl` | Ledger file path; test profiles must be isolated (e.g. `ledger-dashcam-test.jsonl`) |
| `ledgerMacKey` / `ledgerMacKeyFile` / `ledgerMacKeyEnv` | empty | F1/1.10.11 D4: ledger HMAC key (>= 32 bytes). **Read the next section before enabling** |
| `patchBuiltins` | `false` | In-process Bridge patch; enabling it in the Electron main process takes over the app's own fs/net — be careful |
| `ingress` | `{}` (enabled by default) | 1.12.0: metadata audit of LLM requests / inbound messages. See the section below |
| `panel` | `{}` (enabled by default) | 1.13.0: browser panel (Agent Dashcam). `{ enabled: false }` disables the `/api/dsh-dashcam/*` routes. See the section below |
| `requests` / `grants` | `[]` | Two-Key: capability declarations (object arrays; strings fail fast at mount time) |

### ingress audit (1.12.0)

Summarizes "the messages sent to the model" and "the inputs that actually entered the session" into the ledger, to answer "did this message come in, or was it fabricated?".
Metadata only, no message bodies; no judgment, no blocking; recording failures are fail-open.

| Sub-key | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | When disabled, writes a `telemetry/ingress-disabled` record instead of vanishing silently |
| `requestEvent` | `llm/stream` | Request egress waterfall (`streamWithRegistration` of `dsh-llm`); the payload is the full request. Verified against the local `resources/app.asar` |
| `inboundEvent` | `session/event` | Only takes `event.type === 'user/message'`, same source as session logs. Verified against the local asar |
| `headBytes` | `80` | Keep the first N bytes of each message; `0` = only length and sha256 |
| `maxSample` | `32` | Maximum number of new-message samples carried per request record |
| `maxLineBytes` | `8192` | Size cap per record; samples are trimmed first, then coverage |
| `inboundWindow` | `500` | Inbound matching window kept per session |
| `inboundTtlMs` | `3600000` | Lifetime of the inbound matching window |
| `maskSecrets` | `true` | Mask heads (Bearer / `sk-` / `ghp_` / `password=`, best-effort) |
| `whitelistKinds` | `runtime-context` etc. | `source.kind` values not required to appear in inbound; **by kind, not by role** |

Test: "absent in inbound + present in request" = injection; "absent in inbound + absent in request" = model-fabricated (**no alert**, must be guarded by a test case).
`llm.anomaly` records only; `decision` stays `allow` and `intercepted` stays `false`.

Known boundaries: locally we can only see the messages the client sent out. Server-side prefixes appended after the client are not covered;
`ingress --find` searches only sampled heads — a failed search does not mean it didn't happen.
The wiring point must be **after the messages are final** (hooking before any trim / rewrite / template expansion will mismatch inbound fingerprints,
producing `added_user_without_inbound` false positives).

## Browser panel (Agent Dashcam, 1.14.0)

A read-only dashboard injected into DSH Web (same origin for desktop and web): a floating **REC badge** in the bottom-right corner
(elapsed recording time ticks live), draggable to reposition (hold and drag; position is remembered in localStorage), click or `Ctrl+Shift+D`
to open the popup panel. Three views, all consuming the real ledger:

- **Live recording**: metric cards (uptime = since the judgment chain mounted / judged calls / files changed / anomalies),
  live event stream (incremental polling; event rows and the status window both cap at 400 entries — an ever-growing DOM would drag down long-open sessions),
  current step, and judgment-chain status (mode / bypass hits / unmapped calls / version / session / model / interception ratio).
- **Replay**: a timeline canvas for any recording segment (type ticks + playhead + hover tooltips), play/pause/1×·10×·60×,
  linked event list, event details (path / command / decision / rule). Space toggles playback, ←/→ step through events, Esc closes the panel.
  Segments over 2000 entries are explicitly labeled "truncated".
- **Recording history**: aggregated into segments by "gap between adjacent records > 15 minutes" (`S-xxxx`), with search + status filter;
  click a segment to enter its replay.

Panel semantics (corrected in the 1.14.0 recheck):

- **The anomaly card counts only real anomalies**: `intercepted=true` or an ingress anomaly. Under advisory,
  `decision=deny` without interception is a **bypass hit** (guards.js semantics: bypasses still land a deny entry),
  shown separately as gray rows — otherwise advisory mode would keep the red warning permanently lit and it would lose its meaning. The "anomalies" column of recording segments uses the same scope.
- **Mapped/unmapped counted separately**: `judgments` only covers the five capability categories inside the mapping table;
  MCP / workflow / subagent and other out-of-table tools go through `telemetry/unmapped-tool` and are shown separately as "unmapped calls" —
  otherwise MCP-heavy sessions would show "tool calls" as a constant 0.
- **The records cursor drops no records**: `lastSeq` takes only the seq of the last record actually returned (previously the max over the whole
  file, so when the first screen was truncated by limit, the cursor jumped straight to the file tail and middle records were lost forever);
  beyond the limit it returns `truncated: true`.
- **Tail-parse cache**: status/records share a 10s cache keyed on size+mtime (like history),
  so polling no longer re-reads and re-parses a 4MB ledger every 2–3 seconds.

Implementation (same approach as dsh-deepseek-tan-pet):

- Host half [lib/panel.js](lib/panel.js): three routes `GET /api/dsh-dashcam/status|records|history`,
  loopback Host validation, `no-store`, optional-safe (a missing webServer only loses the panel; the judgment chain and ledger are unaffected).
- Browser half `lib/client.js` (assembled from `src/client/` by `npm run build`):
  wrapped in `window.__ModuleLoader__.load`; `package.json`'s `dsh.client` declares injection into
  `ui-renderer / ui-slots / shortcuts`; the panel mounts directly on `document.body` (iframes 404 under
  dsh-app://), positioned only with right/bottom; singleton + generation guards against cascades.
- **Redaction scope**: only coarse-grained facts are exposed (paths / command first word / host / counts / decision / reason);
  the `llm.request` sample (message head samples) and hash-chain fields (hash/prevHash/mac) are not exposed;
  `llm.inbound` exposes only a head truncated to 48 bytes. History clustering reads fully with a 10s cache.

After changing the frontend: run `npm run build` to regenerate `lib/client.js`, then restart DSH (the currently running desktop
process still loads the old bundle).

## Tool mapping table (1.10.13)

The public name has its `ops_` prefix stripped first, then matched by bare name (`ops_bash → bash`):

| Tool (bare name) | Judgment |
| --- | --- |
| `pwsh` / `bash` / `sh` / `zsh` / `cmd` | `proc.spawn` (**first word** scope) + commandline hash archive; `script_path` judged as the whole string |
| `read` / `read_file` / `read_files` / `read_table` / `read_docx` / `read_pdf` / `read_image` / `inspect_local_file` | `fs.read` per path (credential paths auto-escalate to `cred.read`) |
| `glob` / `grep` | `fs.read`; when path is a directory, judged as `dir/**` (F3); missing path falls to `unjudgeable` telemetry |
| `stat` / `diff` | `fs.read`; directories likewise turn into subtree form |
| `write` / `write_file` / `edit` / `edit_file` / `replace` | `fs.write` (`dryRun: true` downgrades to `fs.read`); replace judged at base directory as subtree form |
| `copy` | `fs.read`(source) + `fs.write`(destination); when the destination is an existing directory, judged as `to/**` |
| `move` | `fs.read`(source) + **`fs.delete`(source: for directories, both node + subtree, M1)** + `fs.write`(destination) |
| `remove` | `fs.delete`; when the target is a directory, **both node + subtree are judged** (M1) |
| `batch` | expanded per entry of `operations[]` (same scope as copy/move/remove, cap 512); missing operations falls to `unjudgeable` |
| `web_fetch` / `fetch` | `net.outbound` (host:port) |
| `discover_tools` / `result` | not mapped, not telemetered (no side effects) |
| everything else | allowed + `telemetry/unmapped-tool` (the console callout and allow telemetry are recorded once per name); under `enforceUnmapped` **every call** is rejected and **every one lands a deny entry** (R2, 1.10.14: audit does not dedupe); entries hit by `unmappedAllowlist` are exempted and allowed |

Unjudgeable calls (batch missing operations, glob missing path, copy/move missing to):
advisory records `telemetry/unjudgeable-tool` (allow) and passes; enforce lands a deny entry then rejects (F2: audit precedes execution).

**M1 (1.10.13) authorization scope for directory deletion**: `remove(directory)` / `move(directory, …)` deletes
**the node itself + the whole subtree**, judged as two entries — the node (`fs.delete{dir}`, requiring explicit authorization of dir itself)
and the subtree (`fs.delete{dir/**}`); under enforce both must pass — granting only `dir/**` does not allow it, consistent with the SPEC's
"`dir/**` does not include dir itself"; to delete a directory node, authorize both `dir` and `dir/**`.

## MAC enablement and ledger migration (F1, guardrails since 1.10.12)

**Do not enable MAC in place on an existing v2 ledger.** The production ledger (190 lines) is all v2 records without mac;
once enabled, `Ledger.verify()` would judge all history as `mac_missing` with `ok=false`, and dashcam's metrics verify
before computing, exiting non-zero immediately. The host now has a guardrail: with a MAC key configured and the ledger containing
mac-less history rows → **refuses the mount** and prints the migration steps. A refused mount leaves a side log next to the ledger
(`<ledgerPath>.guard.log`, L3 — the desktop build cannot see stdout, but you can check afterwards); an unset environment variable
pointed to by `ledgerMacKeyEnv` reports `stage=mac-env-missing` (L1, distinct message, not masquerading as "can't enable in place").

Migration steps (use a new ledger + archive; do not toggle in place):

1. Archive the old ledger: `mv ~/.dsh/dsh-dashcam/ledger.jsonl ~/.dsh/dsh-dashcam/ledger-v2-archive.jsonl`
   (the filename marks v2-without-mac; do not append to it again).
2. Keep the `ledgerMacKey` (or `ledgerMacKeyFile` / `ledgerMacKeyEnv`) config and restart DSH —
   the judgment chain starts a v3 ledger on the new file, and the mount record carries a mac.
3. If the archive needs auditing, use a keyless `new Ledger(path).verify()`: `ok=false / mac_missing` is the expected result
   (history genuinely has no mac) and does not indicate corruption.
4. Key management: a random string >= 32 bytes; never commit it to the repository. Recommended: point `ledgerMacKeyFile`
   at a permission-controlled file, or use `ledgerMacKeyEnv: 'DSH_DASHCAM_MAC_KEY'`.

Archive hash note: the commandline archive's `commandLineHash` is the SHA-256 of the **original text** (not the masked text),
used for offline reconciliation to verify "the hash on the ledger == the command actually executed"; it contains no plaintext.

## Known boundaries

- **F5 (semantics, closed)**: telemetry-side records no longer count toward the metrics judgment scope — since core
  dsh-dashcam 1.10.12, `computeMetrics` / `monthlyMetrics` only accept records with
  `capability !== 'telemetry'`; telemetry counts are reported side by side as `telemetryRecords` /
  `telemetryDenies` (see core docs/ROLLOUT.md section 6). This host's side records
  (mount / unmapped-tool / unjudgeable-tool / commandline-audit) have their capability
  fixed at `telemetry` — do not change it.
- Command judgment scope = first word; side effects nested inside `bash -c "…"` are not covered by the entry gate.
- `replace` audits at base-directory granularity; the actual files matched by the glob are not expanded individually.
- `dir/**` grants not including `dir` itself is the SPEC contract (docs/SPEC.md 77); the host maps **read-only / subtree-write**
  semantics to `dir/**` for alignment, while **destructive deletion keeps the node judgment** (M1).
- **L4 (TOCTOU)**: directory probes cache **positive results** with a 30s TTL and **do not cache negative results** (R1, 1.10.14:
  a negative cache would let a deletion within the 30s "file→directory" window skip the subtree judgment and bypass M1 — fail-open, now fixed;
  positive caching is the reverse — a directory swapped to a file still gets an extra subtree judgment, which is fail-closed and acceptable).
  A race window between judgment and tool execution remains; the entry gate does not promise atomicity — real interception relies on the Bridge.
- With `patchBuiltins: true` stacked on the host entry gate, directory probes produce extra fs records; pick one or the other.

## Verification

```powershell
npm run smoke   # 96 + 15 + 43 assertions, all passing (including panel routes/redaction/clustering/cursor semantics)
npm run build   # regenerate lib/client.js (required after changing src/client)
# Main repo regression: cd ..; npm test   # 241 tests, 0 fail
```

Deployment confirmation (F8): after restarting the DSH desktop build, new mount records in the ledger should show
`pluginVersion: "1.14.0"` with `scope.mode` matching the config, the REC badge in the bottom-right corner,
and `Ctrl+Shift+D` opens the panel; **on the deployment side, stay in advisory observation for now —
don't rush to enable enforce / enforceUnmapped** (configure unmappedAllowlist per the table above before enabling enforceUnmapped).
