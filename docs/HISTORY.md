# 完整版本历史 · Full version history

> 本文件收录完整版本历史,含内部评审编号与原始措辞;面向用户的功能总览见 [README](../README.md)([中文](../README.zh-CN.md))。
> This file keeps the complete version history, including internal review notes and original wording. For a user-facing overview, see the [README](../README.md).

## 2.0.x: single-package distribution

2.0.0 moves the plugin identity to the package root, so one npm package installs the whole plugin (`dsh plugin --profile web add dsh-dashcam`); 1.x needed a second package for the host adapter. The 2.0.x line then fixed two client-loader defects, and 2.0.3 is metadata and documentation only.

| Version | Change |
| --- | --- |
| 2.0.0 | Plugin identity (`main` / `exports` / `dsh`) moves to the root package; the host adapter ships inside it as `dsh-dashcam-host/` |
| 2.0.1 | The nested host `package.json` stops restating the client declaration — a second `exports["./client"]` made the same bundle register twice |
| 2.0.2 | The client bundle registers under the **package name**; a mismatched id is treated as unregistered and the bundle runs a second time, which crashes DSH web boot with `duplicate factory registration` |
| 2.0.3 | **Metadata and documentation only** — npm description / keywords / install notes. No `src/` change; behaviour is identical to 2.0.2 |

Upgrading from 1.x: the ledger stays where it is (`~/.dsh/dsh-dashcam/ledger.jsonl`); if you installed with `pnpm link`, remove the link first — see the install section in the [README](../README.md).

## 1.12.0 New: ingress audit (LLM request vs. inbound message reconciliation)

The 1.11.0 observation surface is "local execution": tools, files, processes, network. A ghost message produces none of those actions, so a clean ledger is expected. 1.12.0 adds two more metadata streams, landing on the same hash chain:

| `action` | Records |
| --- | --- |
| `llm.request` | Per request: message count, overall fingerprint `messages.hash`, `added/removed/changed` vs. the previous request in the same session, samples of new messages (role / `source.kind` / length / head80 / sha256 / attachment identity), tool count and fingerprint |
| `llm.inbound` | Every input that actually enters the session: `messageId` / `source.kind` / length / sha256 / head80 |
| `llm.anomaly` | Reconciliation failures: `added_user_without_inbound` / `dropped_inbound`; records only, never blocks |

Key semantics:

- **Four-quadrant test**: only "no inbound + present in request" is injection; "absent on both sides" is model-fabricated and **does not alert**. The latter is exactly the cell where the ghost event fell — it must have an explicit regression test, not rely on someone remembering.
- **Whitelist by `source.kind`, not by role**: injected messages such as `runtime-context` / `compaction` / `plugin:memory` / `skill-catalog` also carry role `user`; a role-based whitelist would false-positive immediately.
- **Observation records are not judgments**: `capability='llm.ingress'` does not count toward `requests / allows / denies / interceptionRate`; it is reported separately as `ingressRequests` / `ingressInbound` / `ingressAnomalies`. `decision` is always `allow`; anomalies never write `deny` or `intercepted`.
- **Metadata only**: message bodies never land in the ledger; with `headBytes: 0` even the head is omitted. A single record is bounded by `maxLineBytes`.
- **fail-open**: recording failures go to the degraded queue + `.guard.log` only; requests are unaffected.
- **Wiring (verified against local DSH)**: requests hook the `llm/stream` waterfall (listeners must `return next()`); inbound comes from `user/message` on `session/event`. `agent/request` (cannot modify messages) and `agent/inbox/spliced` (delivery events whose entries can be cancelled) are not used.
- **First request builds the baseline**: when the host is attached mid-session, all historical messages count as "added" with no inbound to compare against, so the first request does not alert.
- **Known boundary**: local egress can only prove "does X exist in the messages the client sent out". Server-side prefixes appended after the client are out of observation scope; `coverage.unknown` is an auxiliary signal only, not proof.

## 1.11.0 Rename: dsh-covenant → dsh-dashcam

Starting from 1.11.0, this project is renamed **dsh-dashcam** (the product positioning narrows from "contract layer" to "plugin dashcam": capability declaration + runtime recording + verifiable ledger). The internal capability model name stays *dashcam (formerly the covenant capability model)*; the invariant semantics in `docs/SPEC.md` are unchanged.

**Migration checklist (upgrading from 1.10.x)**

| Item | Old | New |
|---|---|---|
| npm package name | `dsh-covenant` | `dsh-dashcam` (never published to npm, no dependency change needed) |
| CLI | `dsh-covenant` | `dsh-dashcam` (the old command remains in `package.json` `bin` as an alias pointing to the same script) |
| Host package | `dsh-covenant-host` | `dsh-dashcam-host` |
| Host config entry | `- id: dsh-covenant-host` | `- id: dsh-dashcam-host` (`config` content unchanged) |
| Default ledger path | `~/.dsh/dsh-covenant/ledger.jsonl` | `~/.dsh/dsh-dashcam/ledger.jsonl` |
| Signature format field | `dsh-covenant/signatures@1` | `dsh-dashcam/signatures@1` |
| Contract spec | `dsh-covenant/1` | `dsh-dashcam/1` |

- **Automatic ledger migration**: on the host's first startup, if the new path does not exist and the old one does, the old ledger (including `.guard.log`) is moved in place to the new directory and the log prints `账本迁移` ("ledger migrated"); profiles that explicitly configure `ledgerPath` are unaffected.
- **Signatures must be re-signed**: the `spec` / `FORMAT` fields changed, so signature bundles produced by 1.10.x fail verification under 1.11.0 (the signature fields are part of the contract; no dual-format compatibility).
- **History is not recomputed**: ledger content and the hash chain are preserved as-is; old values inside `pluginVersion` are kept as history only.

## 1.10.13 fixes (1.10.13 review batch R1–R3: directory probe negative cache / deny bookkeeping / allowlist fail-fast)

Residual items from `handoff/dsh-dashcam-review-1.10.13-2026-11-06.md` (host subdirectory only; core `src/` unchanged; host PLUGIN_VERSION → 1.10.14):

- **R1 (fail-open → fixed)**: the L4 directory probe cache used to cache both positive and negative results — "delete a file, swap it to a directory within 30s, then delete again" made `deleteRequests` judge only the node and skip the subtree judgment, so granting node-delete alone could delete the whole tree (bypassing M1). Now **only positive results (isDir=true) are cached**: negative results probe fresh every time; positive caching is fail-closed in the opposite direction (a directory swapped to a file still gets an extra subtree judgment), which is acceptable.
- **R2 (audit does not dedupe)**: `enforceUnmapped` rejections used to be deduped in telemetry into a single ledger entry — 3 interceptions produced 1 record and `telemetryDenies` undercounted. Now every rejection **always** appends an unmapped-tool deny record; the console callout and allow telemetry still record once per name.
- **R3 (fail-fast)**: when `unmappedAllowlist` was accidentally written as a comma-separated string, it silently became an empty array; enabling `enforceUnmapped` would then block every tool it meant to exempt, with no warning. Now a non-array rejects the mount outright with guidance on the array form.
- Smoke suite 91 → **96, all passing** (R1/R2/R3 each gained cases; the `file→dir` swap scenario verified the subtree judgment still applies).
- R4 (deployment): the desktop profile's host link switched to the in-repo copy in the same batch (see HANDOFF).

## 1.10.12 fixes (1.10.12 review F5 second half: metrics exclude telemetry-side records)

Leftover item (core side) from `handoff/dsh-dashcam-review-1.10.12-2026-11-06.md`. Until now, telemetry-side records appended directly via `ledger.append` by the host adapter (dsh-dashcam-host: mount / unmapped-tool / unjudgeable-tool / `proc.commandline` archive, capability fixed at `telemetry`) were counted in the metrics allow/deny totals — they are not Two-Key judgments, and they polluted three readings at once: the interception rate was diluted by half by commandline archives alone; under `enforceUnmapped`, the unmapped-tool telemetry's `deny + intercepted=true` was miscounted as "undeclared out-of-bounds interception"; and `grantDenialRate`'s denominator was inflated by telemetry denies. Now the judgment readings of `computeMetrics` / `monthlyMetrics` only accept records with `capability !== 'telemetry'`; telemetry counts and their deny count are reported side by side as `telemetryRecords` / `telemetryDenies` (visibility preserved); offline audits such as `records()` / `verify()` still read all lines. Ledgers without telemetry records read identically (7 new guard tests prove it; full regression 241 tests, 0 fail). Semantics documented in [ROLLOUT.md](ROLLOUT.md) section 6. The host adapter `dsh-dashcam-host` also merged into this repo as a git subtree starting this version (history fully preserved; see [dsh-dashcam-host/](../dsh-dashcam-host/README.md)), removing the dependency on a sibling workspace path.

## 1.10.11 fixes (batch P1–P9 from the two 1.10.10 review reports)

From `handoff/dsh-dashcam-review-1.10.10-2026-11-06.md` and
`handoff/dsh-dashcam-host-ops-mapping-1.10.10-2026-11-06.md`.
This version **only touches the host adapter** (`dsh-dashcam-host`); core `src/` unchanged; the 234-test regression is unaffected.

- **P1/P8 copy/move dual-endpoint judgment**: `ops_copy` / `ops_move` previously recorded only `fs.write` on the source path, with no judgment on the destination at all — under enforce, "source in-domain, destination out-of-domain" could move data out of the authorized domain. Now copy = `fs.read`(source) + `fs.write`(destination); move = `fs.read` + `fs.delete`(source) + `fs.write`(destination); `ops_remove` now records `fs.delete` (destructive actions no longer masquerade as writes).
- **P2 core tool `edit` unmapped**: `WRITE_TOOLS` gains `edit`; plugin file edits no longer escape the ledger.
- **P3 `ops_batch` fully invisible**: a single batch can plan/resume/run 512 copy/move/remove ops. Now each entry of `operations[]` is expanded and judged individually; under enforce the strictest outcome for the batch applies; a missing `operations[]` (resume/plan) or an over-limit batch makes sub-ops unjudgeable — advisory emits `unjudgeable` telemetry, enforce fails closed and rejects.
- **P4 `ops_read_files` recorded only the first path**: now each entry of `files[]` is judged and recorded; out-of-bounds reads of `files[1..]` (e.g. `.ssh/id_rsa`, auto-escalated to `cred.read`) no longer pass silently.
- **P5 `glob`/`grep` without path**: DSH defaults to the session cwd, which the host cannot obtain; rather than guessing a path and writing a fake ledger entry, these now fall to `unjudgeable` telemetry (advisory allows / enforce rejects) so the coverage gap stays visible.
- **P6 command judgment recognized only the first word**: `cd X && rm -f …` showed up in the ledger as just `cd`. A new `proc.commandline` audit record (truncated at 1024 chars + `sha256` of the full string) was added; the judgment scope remains the first word.
- **P7 unmapped telemetry only reached stdout**: the desktop build cannot see stdout, so a coverage gap effectively didn't exist. Unmapped tools and mount events (`telemetry/mount`) now land in the ledger together; same-name entries still record only once.
- **P9 `dryRun` recorded as a real write**: `write_file` / `edit_file` / `replace` with `dryRun: true` are downgraded to `fs.read`; the ledger no longer overstates side effects.
- **D4 ledger MAC key passthrough**: `config.ledgerMacKey` / `ledgerMacKeyFile` / `ledgerMacKeyEnv` pass straight through to dashcam (v3 ledger HMAC); an over-short key fails activate so the mount does not happen.
- **Test profile ledger isolation**: the `dashcam-test` profile's `ledgerPath` points at `ledger-dashcam-test.jsonl`; deny records during testing no longer mix into the production ledger.
- Regression: host smoke 28 → 57 checks, all passing (copy/move out-of-bounds interception, batch expansion and whole-batch rejection, per-path judgment, commandline archive, dryRun, MAC all covered).
- Known boundaries (unchanged): `replace` audits at base-directory granularity — glob-matched real files are not expanded individually; `bash -c "…"` nesting inside `ops_bash` still judges the first word only; the Bridge still defaults to `patchBuiltins: false`.

## 1.10.10 fixes (host mapping catches the ops_ prefix)

- **The `ops_*` prefix made the mapping table empty**: dsh-ops prefixes every tool's public name (`ops_bash` / `ops_read_files` / `ops_write_file` / `ops_copy` / `ops_move` / `ops_remove` …); the old mapping matched bare names and hit nothing — the shell's main channel never entered the ledger. Now the `ops_` prefix is stripped before matching bare names, so prefix combinations no longer need enumerating.
- **Unmapped tool telemetry**: tools not in the mapping table are allowed but called out (`console.info`, deduped by name), making coverage gaps visible and fixable instead of silently bypassed.
- Regression: host smoke expanded to 28 checks (`ops_bash` command/script_path forms, `files` arrays, glob/grep/stat/diff read-only scope, copy/move/remove bookkeeping).

## 1.10.9 fixes (batch P1 from the 1.10.8 review)

The 1.10.8 review report (2026-11-06) confirmed the fixes held and flagged one item on the P1 list untouched; this release closes it:

- **M1 socketPath dual-track unification**: `net.connect({ path })` / `net.connect('path')` (Unix sockets / named pipes) were rejected at the handle layer but folded into `{ host:'localhost', port:0 }` at the Bridge layer for a Two-Key judgment (potentially allowed by a host grant). The Bridge layer now rejects directly (ruleId `socket_path`, ledger first, then throw), matching the handle layer.
- **M4 maxMessageBytes**: the `ChildHost` bidirectional message limit lands (default 1 MiB, `policy.limits.maxMessageBytes`, floor 1024). Oversized inbound messages are dropped; oversized outbound responses degrade into a small `response_too_large` error response (avoiding a permanently hung child process); oversized invoke requests throw before sending (code `message_too_large`). `messageSizeBytes` returns Infinity for cyclic references (fail-closed).
- **M5 ipcTimeoutMs**: `ChildHost` accepts `ipcTimeoutMs` (0 = unlimited, negative falls back to the default 5000ms); the old parameter name `invokeTimeoutMs` remains compatible; `policy.limits.ipcTimeoutMs` is the official config entry.
- **M8 strictPatch wired into createPluginRuntime/activate**: previously only the LocalHost install path checked Hook coverage; the direct path installed Hooks but never verified them. Now with `policy.enforcement.strictPatch === true`, incomplete coverage → uninstall Hooks → refuse to load (`沙箱补丁不完整，按 strictPatch 拒绝装载：…`), matching LocalHost semantics.
- **M11 safetyStage.errors no longer wiped**: errors were discarded once converted to labels, losing evidence and hiding safety-gate blocks from strict mode's blockedSoFar. Errors now stay in `stage.errors` and `report.errors`; strict mode skips loadability based on them. `report.ok/blocked` semantics unchanged (safety by design "labels only, no blocking"; hard blocks only count non-safety gates).
- **M15 realpathSafe fail-closed**: non-ENOENT failures (EACCES/ELOOP/ENAMETOOLONG…) now return `null` instead of falling back to the lexical path (fail-open effectively gave symlink backdoors an ELOOP cover). Callers fail closed: derive rejects with `derive_failed`, the structure gate records `entry_realpath_failed`, `expandPath` throws at config time, `resolvePath` throws. ENOENT (pure non-existence) keeps the lexical fallback (legal for writes/creates).
- Regression: `test/review6-fixes.test.js` 8 cases (including platform-conditional assertions: long paths/symlink loops assert fail-closed only when they produce non-ENOENT on this machine). Full suite 234 tests / 230 passed / 0 fail / 4 symlink skips. The host's 13-item smoke script moved into `dsh-dashcam-host/test/smoke-host.mjs` (`npm run smoke`), and the host package got a git repository from this release (first commit).

## 1.10.8 fixes (two host-vs-core semantic gaps exposed by actually running the tests)

From `handoff/dsh-dashcam-test-1.10.7-2026-11-06.md`:

- **Host `config.requests` written as a string silently no-ops (issue 1, medium)**: the malformed syntax of `requests: [fs.read]` did not raise a config error; it surfaced later at runtime as `未声明的能力或范围：fs.read (...)` ("undeclared capability or scope"), disguising a config syntax problem as an undeclared capability. Root cause: `dashcam.activate()` consumes the manifest directly and never goes through `parseManifest`'s `normalizeRequest` — the host never validated before mounting. Fix: `dsh-dashcam-host` validates up front at mount time using `dashcam.normalizeRequest` + `normalizeGrant`, printing the full error (with a correct YAML example) and returning — fail-fast.
- **Under advisory, deny entries recorded `intercepted=true` in the ledger (issue 2, medium-low)**: in advisory mode the host lets `guard.check()` deny results through on its own, but the guard has no way of knowing, so the ledger accumulated contradictory records of `decision=deny / intercepted=true / actually allowed`. `Ledger.interceptions()` counted those as "actually intercepted", inflating metrics/portraits. Fix: `guard.check` gains `options.advisory: boolean` — when passed, deny ledger `decision` still records deny (the audit fact is preserved), but `intercepted` is always written false; the host's advisory mode explicitly passes `{ advisory: true }`. The allow path now also emits `intercepted: false` (the ledger had it but the denial object didn't — inconsistent).
- New `test/review5-fixes.test.js::R5-5` covers the advisory ledger semantics; full suite 226 tests (+1) / 222 passed / 0 fail / 4 symlink skips. Host smoke 10/10 PASS (fail-fast, advisory intercepted=false, enforce deny intercepted=true, interceptions() filtering).

## 1.10.7 fixes (residual batch from the 1.10.6 review)

The 1.10.6 review report (2026-11-06) confirmed the fixed items were solid with no regression, and flagged two unclosed items; this release closes both:

- **args injection via `shell:true` in the spawn family (review residual 1, P1)**: with `shell:true` the whole command line (first word + all args) gets re-interpreted by the shell; previously only `args[0]` was scanned for metacharacters — `execFile('git', ['status & echo pwned > PWN'], { shell: true })` passed the judgment layer (verified live during review). Now the first word and all string/array arguments are assembled into the full command line and scanned uniformly for metacharacters (ruleId `shell_metachar`, ledger first, then reject); clean args are unaffected and still fall to the existing first-word judgment.
  Regression: `test/review5-fixes.test.js` R5-1 / R5-2.
- **Function-valued options rejected outright (review residual 2, P2)**: `cp`'s `filter` callback and `createReadStream`'s custom `fs` implementation object are retained by reference and can execute plugin code inside the native re-entrancy window, where their out-of-bounds calls pass straight through with zero ledger traces (live-verified: out-of-bounds file write succeeded). Callbacks are a natural channel for capability smuggling, and "switch callbacks back to the judgment layer" is infeasible under native synchronous calls — so function-valued options (including first-level function properties of implementation objects) are rejected directly (ruleId `function_options`, ledger first, then throw), with errors guiding toward callback-free forms; reference-retained native types like `AbortSignal` are unaffected.
  Regression: `test/review5-fixes.test.js` R5-3 / R5-4.
- `knownGaps` pruned in sync: the entry "callbacks and implementation objects in options retained by reference" is removed with the fix above; the rest unchanged. Full `npm test`: 221 → 225 cases (4 new, 0 fail, 4 symlink-EPERM skips as usual).

## 1.10.6 fixes (security-review quick-wins batch)

The five medium "quick wins" from the 2026-11-05 security review, each mapped to its M number:

- **M12 retired keys still verified signatures**: `findKey` previously only excluded `revoked`, so keys set to `retired` by `retireKey` still passed publisher/reviewer verification — "rotation complete" existed in name only. Now only `status === 'active'` is accepted: within the rotation window old and new keys run in parallel (double-active) semantics unchanged; retire immediately invalidates. Regression: the rotation tests in `test/signatures.test.js` rewritten (post-retire old bundles rejected at the keyId stage; new bundles unaffected); `test/quick-wins.test.js` M12 tests `findKey`'s status whitelist directly.
- **M2 numeric path judged ≠ executed**: with `payload.path = 0` the guard judged the string `"0"` (`<root>/0` could be allowed by `$PLUGIN/**`) while the OS did `readFileSync(0)` reading the host's stdin. Path parameters now accept only string/Buffer/URL; other types are rejected at the judgment layer (ruleId `invalid_path_type`, no more `String(value)` fallback); the exact ruleId thrown by derive is passed through to the rejection result and ledger, and ChildHost's fs entry points reject before any real IO. The toString re-entrancy of attack 1.1 and the parameter-coercion scenario of review3 S0 are now closed earlier at the type gate (related tests rewritten for the new semantics).
- **M6 uninstall chain aborting halfway**: an error thrown by `redirect.uninstall()` skipped `bridge.uninstall()` / `seal.stop()` / the `active` cleanup, leaving old Hooks to judge the next plugin. The teardown chain is now per-step try/finally with `active` cleared first: no step may skip the remaining cleanups on failure; the first error still propagates to the caller (teardown failures must be visible). Regression: inject a throwing redirect; assert the bridge is still uninstalled, the seal still stops, and the host can re-register.
- **M13 credential blacklist gaps**: `~/.git-credentials` (git plaintext PATs/passwords) and `~/.config/gh/hosts.yml` (gh CLI plaintext tokens) were not in the credential path regexes — a home-directory read grant could walk off with GitHub credentials without triggering `cred.read`. Both patterns added (`~/.dsh` remains uncertain; only a comment in `paths.js`, no rule). Regression: reading those two paths escalates to a `cred.read` judgment and leaves a ledger trail.
- **M14 npm test script missing files**: the explicit list omitted `test/child-host.test.js`, `test/child.test.js`, and `test/protocol.test.js` — the multi-process runtime and IPC protocol were never being run. All added, plus a new `test/quick-wins.test.js`; a new self-check test enforces "script coverage count = number of `test/*.test.js` files on disk" (currently 33 = 33) to prevent future omissions.
- Full `npm test`: 215 → 221 cases (217 passed / 4 symlink-EPERM skips as usual / 0 fail); the quick-wins batch adds 6 cases and rewrites 3 existing ones (signatures rotation / attack 1.1 / review3 S0).

## 1.10.5 fixes (three-perspective review v2)

- **H1 re-entrancy window escape (verified high)**: class instances and plain objects with own enumerable `__proto__` properties can run plugin getters inside the native re-entrancy window (`callDepth > 0`), letting out-of-bounds IO in the getter pass straight through with zero ledger records. fs-family methods now do **whitelist extraction** on the options argument (an `FS_OPTIONS` table: each method keeps only the keys the native implementation actually reads); the extracted [[Get]] happens at `callDepth === 0` — getters on class instances/prototype chains fire outside the window, their side effects hit the guard chain as usual and get recorded; the write-back uses `defineProperty` into a null-prototype copy (no `__proto__` setter, closing the `Object.assign` prototype-swap mechanism). Remaining entry points are covered by `stripArgTraps` shallow-copying own enumerable keys; Buffer/TypedArray/URL/AbortSignal are still retained by reference.
  Regression: `attack-surface.test.js` attack 1.5 (class instance) / 1.6 (own `__proto__` + prototype-chain combo).
- **H2 load observe window fail-open**: new `policy.enforcement.observeLoadWindow` (default `true`, so legacy plugins don't die on install); set to `false` and out-of-bounds calls during load reject installation outright (fail-closed); `strictPatch = true` force-closes the window. If `stats.observed > 0` at the end of load, a warning fires — allow concessions must be visible. "Security boundaries (must-read)" now describes the load window as residual risk rather than a feature (the 1.4.0 section keeps the historical account).
- **H3 exec/execSync shell metacharacters**: shell-bound commands containing `;|&$\`>'`, newlines, and other metacharacters are rejected outright (ruleId `shell_metachar`, deny-ledger first, then throw); first-word judgment no longer under-covers the shell's re-interpretation; the spawn family with `shell: true` is judged the same, custom `shell` strings and forks on a non-current-Node `execPath` are always rejected. Use `execFile` with per-argument passing instead.
- **H4 `fs.promises.cp` missed patch**: the fsp section adds `cp` (dual-sided read+write judgment, same scope as `fs.cp`) plus missed items like `readlink` / `statfs`; a new "fs vs fsp coverage cross-check" test enforces that any method patched on fs with an existing same-name fsp API must also be controlled, preventing future omissions.
- **H5 activate failing halfway / dispose leaking Hooks**: when an install step of `createPluginRuntime` fails, already-installed items are uninstalled in reverse order before throwing, no more stacking on the Hook layer; `dispose()` and `deactivate()` converge onto one idempotent release path (Hooks truly tear down only when the reference count hits zero) — after a direct `dispose()`, `activate()` can run again; double release is a no-op.
- **H6 ledger half-line recovery + multi-instance false positives**: `_recover` truncates crash-leftover half-lines to the last newline and fsyncs to disk; the hash chain resumes losslessly from the last complete line; on partial append-write failure the write is truncated back to its start instead of welding debris and the new line into bad JSON. Multiple instances in one process share seq/lastHash/size baselines per ledger path, so admission/registration/runtime interleaved writes no longer false-positive "concurrent writes"; writers outside the Ledger (external processes writing directly) are still detected — append keeps erroring and a warning fires when a new instance is constructed.
- Regression tests add `test/review4-fixes.test.js` (H2–H6, 10 cases) plus attacks 1.5 / 1.6; case counts below.

## 1.10.4 malicious attack-surface cases (12 cases)

New `test/attack-surface.test.js`: not "proof of what we blocked", but running the real host lifecycle (`install → register → invoke → uninstall`) against four classes of dimensionality-reduction attacks — pin down what we can defend, and write what we can't into `knownGaps`.

- **Re-entrancy and prototype chains**: nested writes during `toString` evaluation are rejected (ledger records `not_declared` / `intercepted`), `pwned.txt` never lands; reads inside `Proxy` get traps are rejected too; stuffing `paths` / `capabilities` onto `Object.prototype` does not amplify the capability surface.
- **Loader escapes**: `process.getBuiltinModule('fs')`, `require('fs')` from a non-plugin parent module, deleting `require.cache` and re-requiring — all return **the same patched module object**; reads are still rejected; in handles mode the nonexistent `readSync` does not resurrect via cache clearing.
- **Async contexts**: `Worker` (eval) and `execSync` are rejected on creation without a declared `proc.spawn`; `new Function('return process')()` grabbing the global `process` is not an escape.
- **Measured gaps (written into `knownGaps`)**:
  - Timers/callbacks still in the event queue after uninstall — the Bridge has already restored native modules, the write **succeeds**;
  - Inside already-authorized `worker_threads` / child processes — separate realm/process, invisible to this process's Hooks.
- Case count 166 → 178, all green on the host's own Node 24.21.0.

## 1.10.3 fixes (third three-perspective review)

- **S0 re-entrancy window privilege escalation**: `patchMethod` used to wrap "judgment + native call" entirely inside `callDepth`, so a `toString` / `valueOf` on the arguments could call back into the Bridge during judgment and make **unmanaged** native calls (`fs.existsSync({toString(){ fs.readFileSync(/etc/passwd) }})` could read file contents with zero ledger records). The re-entrancy window now wraps only the native call; judgment and argument parsing always happen outside it.
- **S2 duplicate handle judgments**: handles must be created **before** the Bridge. In the wrong order the handle pins the wrapped functions, and a single `ctx.handles` call gets judged twice (two ledger records; `oneSeal` judges the second as exhausted).
- **S2 `sandbox` string form**: `{ sandbox: 'handles' }` was silently dropped, actually running global; it now maps to `{mode}`, and `mode` goes through whitelist validation — invalid values error out directly.
- **S2 half-mounted registration**: when `module.activate` throws, deactivate / redirect / Bridge / seal / `modules` / `active` roll back in order, so the host never gets stuck with "an active Bridge exists, every subsequent registration fails".
- **S3 `fetch` redirect SSRF**: the wrapper forces `redirect:'manual'`; every hop re-judges by `Location`, hops capped at 5, protocols tightened to http/https; when the body can't be replayed, 3xx responses are handed back to the caller — never followed automatically. The Bridge and the net handles share `runtime/redirects.js`.
- **S3 frontend XSS sink**: the cockpit templates route every plugin-controllable field through an `esc()` escaping exit.
- **IPv6 host assertion**: `host:port` splitting strips square brackets first; `[::1]:443` and `::1:443` compare as equivalent. (During the fix it surfaced that the new split function shared a name with the validator, making `normalizeHosts` return an object and port comparison fail — renamed to `splitHostPortPair` with a test locking it in.)
- Case count 159 → 166.

## 1.10.2 design tweaks + consistency fixes

- **`sandbox.mode` defaults to `global`**: the closed handle surface is incomplete (`openSync` / `fs.promises.open` / `watch` / `globSync` are all absent from handles; `openSync` can't be compatible because it must return an fd); enabling `handles` by default would break existing plugins. Now both paths (`LocalHost` and `activate()`) default to `global`, and `handles` is the explicit option.
- **`minMacKeyBytes` floor raised to 32**: `policy.limits` no longer allows weakening HMAC-SHA256; the low-level `resolveLedgerMacKey(minBytes)` remains customizable.
- **P1 fix**: `createPluginRuntime` now treats `policy.sandbox.mode` as the single source of truth and accepts both `sandbox: 'handles'` (string) and `sandbox: { mode: 'handles' }` (object). The object form used to be silently ignored as truthy while actually running global.
- **P2 documentation corrected**: `node_modules` dependencies are inside `pluginRoot` and **are** redirected (old docs said otherwise).
- **P3/P4**: updated a stale `activate` comment; default tests no longer pass `sandbox` explicitly.
- Case count 158 → 159.

## 1.10.1 fixes (second three-perspective review)

- **H-1 `fetchTimeoutMs` actually took effect**: `createCapabilityHandles` used to accept `limits` without passing it down — the host set 3 seconds and got 30. It now flows through to the net handles, with an integration test via `LocalHost → ctx.handles.net`.
- **M-1 counters reserved early**: `activate()` used to register the callback before incrementing; if the callback threw, the Hook was installed but the count was 0, and the next activation stacked. Failures now roll the count back and `dispose()`.
- **M-3 limits validation**: `batchTargets: 'abc'` made limit comparisons always false (silent no-op); now `resolveLimits`/`loadPolicy` reject non-integers/out-of-range values directly. `fetchTimeoutMs: 0` is a legal value.
- **M-4 `coverage().installed`**: after a `strictPatch` load rejection, it no longer leaves the illusion of "pointing at an uninstalled Bridge".
- **L-1 ledger write-failure attribution**: after a partial write, the baseline aligns to the real size, so disk errors are no longer reported as "concurrent writes"; genuine concurrency detection is unchanged (not swallowed by realignment).
- Case count 153 → 158.

## 1.10.0 new (configurable limits)

Hard-coded constants all move into `policy.limits` with unchanged defaults:

| Key | Default | Purpose |
| --- | --- | --- |
| `batchTargets` | 10000 | cap on targets per `enforceBatch` |
| `globBatchSize` | 256 | async glob chunk size |
| `fetchTimeoutMs` | 30000 | default timeout for outbound `fetch` (0 = not injected) |
| `integrityEvery` | 64 | sample an integrity check every N judgments (0 = off) |
| `minMacKeyBytes` | 32 | minimum bytes for `macKey` |

Plus one optional hard constraint, `policy.enforcement.strictPatch`: default `false` (incomplete patches are only recorded + exposed via `coverage().unpatched`); turned on it escalates to **refuse to load**. This is the only knob left to the host between "non-invasive" and "fail-closed".

```js
new LocalHost({ policy: { limits: { fetchTimeoutMs: 5000 }, enforcement: { strictPatch: true } } });
```

- Case count 146 → 153.

## 1.9.0 fixes (three-perspective review)

A red-team / architecture / boundaries review confirmed 3 must-fix and 6 recommended items, all fixed:

- **H1 patch failures no longer silent**: when `patchMethod` fails to install it is recorded in `unpatched`, `coverage()` reports `{unpatched, complete}`, and a `ruleId='bridge_incomplete'` ledger entry is written. Previously a failed entry point was simply naked while `installed` stayed true.
- **H2 integrity check wired in**: `createGuardChain({integrityEvery})` (default 64) samples `verifyIntegrity()` inside the judgment loop. Previously this mechanism **was only ever called by tests** — the claimed tamper protection did not exist on the production path.
- **H3 Windows casing**: module-redirect parent-module matching is now case-insensitive (win32 only). Previously a case mismatch between `pluginRoot` and reality let `require('fs')` silently return native fs.
- **M1 fetch default timeout**: handle `fetch` injects a 30s timeout when the caller provides no `signal` (Node's native fetch has no default timeout).
- **M2 glob cwd no longer silently ignored**: unrecognized `cwd` types are now rejected outright instead of falling back to `process.cwd()` and letting the judged and actually-traversed objects diverge. (Node's own `fs.glob` currently accepts only string cwd; the URL branch is defensive.)
- **M3 unknown protocols get a clear rejection**: previously it fell back to the http module and threw Node's `ERR_INVALID_PROTOCOL` (misleading); now it says plainly "protocol not supported". **Live testing confirmed no cross-protocol request was actually sent**, so this downgraded from "protocol confusion" to "wrong contract".
- **M4 single runtime**: `activate()` rejects a second active runtime (native Hooks would stack and the inner ledger would miss records).
- **M5 ledger single-writer detection**: concurrent appends error out instead of writing duplicate `seq` and failing their own verification.
- **M6 compromise visibility**: `coverage().compromised` exposes integrity state.
- **L1/L2**: batch judgments get a cap (10k targets); ESM entry points get a clear error.
- Case count 135 → 146.

## 1.8.0 new (completing "one record represents N targets")

- **Glob ledger aggregation**: `fs.glob` / `globSync` / `fs.promises.glob` no longer write one ledger entry per result. 100 matches = **1** `two-key-batch` record (judgments still happen per target). The async iterator chunks at 256 entries, **judging everything before delivering**.
- **Worker eval no longer writes source into the ledger**: `new Worker(code, {eval:true})`'s command is now `worker:eval:<first 12 hex of source sha256>` — dedupeable, auditable, but the source never lands on disk.
- **Audit semantics of batch records fixed**: mixed-capability batches no longer record as a single capability (otherwise `cred.read` could hide inside `fs.read`); they record `capability:'mixed'` with `scope.capabilities` listing everything; out-of-bounds inside the observe window is no longer recorded as allow.
- **MAC key custody**: `resolveLedgerMacKey()` supports "value > file > environment variable"; shorter than 32 bytes is rejected outright; explicitly specified but unresolvable always fails closed; `LocalHost.redact()` returns a key-free summary.
- **CLI `metrics` verifies before computing**: an unverifiable ledger (including `mac_key_missing`) exits non-zero and hints at `--mac-key-file` / `--mac-key-env`; supports `--anchor <file>`.
- Metric semantics: new side-by-side fields `batchRecords` / `batchedTargets` / `effectiveRequests` / `targetInterceptionRate` etc.; old field semantics unchanged (record count vs target count, both readings coexist).
- Case count 114 → 135 (six new groups: glob / worker / mac-custody / batch guard / metrics / invariants).

## 1.7.0 fixes (three hard bugs in mac integrity)

- **Keyless verification no longer silently passes**: a ledger containing v3 lines verified without a `macKey` returns `mac_key_missing`. Previously `ok === true` — calling "didn't verify the mac" "verified".
- **No version downgrades**: v1/v2 lines after v3 → `version_downgrade`, blocking "append one mac-less lower-version line".
- **New external anchor**: `ledger.anchor()` / `verify({ anchor })`. A hash chain cannot detect tail truncation — cut off the last few lines and the remaining prefix is still self-consistent; the anchor is the only thing that can catch it.
- **`fs.promises.link` gains the read check**: `fs.link` was fixed last round but the promises version was missed — the hard-link escape was still open.
- **fd re-check uses native realpath**: inside the async `open` callback `callDepth` is already 0; using the wrapped `fs.realpathSync` would re-enter the guard chain — one extra ledger entry, and a write-only `open` would judge itself out-of-bounds.
- Case count 108 → 114 (five new in `test/ledger-mac.test.js` + one hard-link case).

## 1.6.0 new (closed-world completion + path hardening)

- **net / proc capability handles**: `createCapabilityHandles` now returns `{ fs, net, proc }`. `net` is outbound-only (`fetch` / `request` / `get` / `connect` / `createConnection`), port required, Unix sockets rejected outright; `proc` provides `spawn/exec/fork/kill`, with command-name semantics reusing the Bridge's `bridge.firstCommand` — no second parser.
- **Symlink escape closed**: judgments now target **the real path the OS will actually operate on** (`realpathSafe`); links inside `$PLUGIN/**` can no longer carry the judgment out of scope. Credential escalation also judges by real path — chaining `id_rsa` into `notes.txt` no longer downgrades.
- **pluginRoot normalizes to a real root first**: otherwise macOS's `/var → /private/var` would invalidate every `$PLUGIN` grant.
- **Hard-link hole closed**: `link` / `linkSync` now also require `fs.read` on `args[0]` — otherwise "link an external file into the plugin directory and read it as a normal file" bypasses everything.
- **`resolvePath` matches derive**: what's exported to the host is also the real path, avoiding the host re-judging differently.
- **Quarantine judgment unified** as `isQuarantined()`: `portrait` / `activate` / gate reports no longer each implement their own.
- Case count 84 → 104 (new groups: `net-proc-handle` / `symlink` / `portrait-labels`; 3 explicitly skipped on Windows for lacking symlink permission).

## 1.5.0 new (capability injection)

- **`require('fs')` optionally returns capability handles**: with `sandbox.mode='handles'` (explicit opt-in), `fs` / `node:fs` / `fs/promises` are redirected scoped by `pluginRoot`; default `global` uses native fs + Bridge guard, so existing plugins need zero changes.
- **Handles gain `constants`**: just a bag of numbers, no capability surface; allowing it cuts migration cost significantly.
- **Both paths default identically**: `activate()` and `LocalHost` both default to `global`, so "gates one way, runtime another" cannot happen.
- **Metrics split**: new `undeclaredInterceptions` / `undeclaredInterceptionRate` and `grantDenials` / `grantDenialRate` — "the plugin went out of bounds" and "the host never issued a key" should not share one interception rate.
- Case count 77 → 84 (seven new in `test/sandbox.test.js`).

## 1.4.0 fixes (load window and ledger compatibility)

- **The load window is no longer a vacuum**: Hooks install before `require`; inside the window, observe mode — judgments and bookkeeping still happen, just no blocking. Fail-closed resumes immediately after the window closes. New `guard.beginObserve()` / `endObserve()` / `isObserving()` and `stats.observed`.
- **Entry loading no longer pollutes the ledger**: the host reads the source first, then `_compile`s inside the window; the loader's own file reads are not recorded as plugin behavior.
- **`admitting` becomes a private field**: it used to be a public property — one line from a caller could skip every gate.
- **Strict mode never executes plugin code**: when pre-gates block, `loadability` is skipped with `loadability_skipped`.
- **Ledger v1 compatibility**: `verify()` selects field sets by `v`; historical ledgers stay verifiable; v1 records stuffed with `intercepted` get caught by the hash.
- **`guard.coverage()` / `LocalHost.coverage()`**: the host can obtain the current list of controlled entry points directly.
- Case count 69 → 77 (six new in `test/observe.test.js` and two v1-ledger cases).

## 1.3.0 new (non-invasive protection)

- **manifest**: a missing `dashcam` no longer errors; a default `{ level: 'legacy', quarantine: true }` is generated; adds `isQuarantined()`.
- **Guard entrance Hooks**: `guard.installNativeHooks()` / `uninstallNativeHooks()`; `createGuardChain({ nativeHooks: true })` installs at the entrance directly, and both `LocalHost` and `activate` go this way.
- **Gates become labels**: `report.labels` / `securityLabels` / `labelLines`; stage states gain `warn`; only `MALICIOUS_CODES` and the blacklist block, `ok = no blocks`.
- **Ledger v2**: new fixed field `intercepted`; `Ledger.interceptions()` outputs "undeclared API calls actually intercepted".
- **Default policy**: `enforcement = { mode: 'advisory', allowLegacy: false, requireSignature: false }`; `required` / the enterprise channel keep refuse-to-install semantics.
- Case count 67 → 69 (`audit` gains intercepted and entrance-Hook cases).

## 1.2.0 new

- **Capability handles (experimental)**: `createCapabilityHandles({ guard })` provides a closed `fs` facade — methods not listed do not exist, fd arguments are not accepted, `open()` returns a restricted handle without `fd`, and the object is frozen. This is the "swap in a small world" route: new plugins get handles, and the Bridge serves only as a compatibility layer for old code. `handle.coverage()` and `bridge.coverage()` can be compared directly.
- `open`'s flags judgment is extracted to `capabilityNeedsForOpen`, shared by the Bridge and the handles.
- Case count 61 → 67 (new `test/handle.test.js`).

## 1.1.0 changes (breaking; the default flipped to advisory from 1.3.0)

- **Not loadable by default**: `policy.enforcement.mode` defaulted to `required`, so `legacy` plugins could not install on any channel and `activate()` rejected outright. Upgrade path: set `policy.enforcement = { mode: 'advisory' }` explicitly to restore the old behavior (record a rule-level rollback).
  > 1.3.0 changed the default to `advisory`; this section remains as history only.
- **Admission built into the host**: `LocalHost.install` ran the full gate pipeline itself with no skip parameters; admission verdicts were written to the Ledger (`ruleId=admission`). Constructing `LocalHost` required `trust`, otherwise admission failed.
  > Since 1.3.0, no trust table just yields an `Untrusted` label and `install` still succeeds; `trust` is only required in `required` mode.
- **`env.write` sensitive keys escalate to `cred.write`**: overwriting variables like `*_KEY` / `*_TOKEN` requires separate authorization.
- **Audit attribution fixed**: an `allow` record's `reason` comes from the declaration that actually covers the request, not the first declaration with the same capability.
- **One-Seal two phases**: `reserve → commit`; on Ledger write failure, `release`, so one-time authorizations are no longer burned.
- **Bridge entry completion**: `open` / `openSync` / `opendir` / `realpath` / `truncate` / `chmod` / `chown` / `utimes` / `mkdtemp` /
  `symlink` / `link`, `net.Socket#connect`, `dns.promises`; adds `bridge.coverage()` self-check.
  Note that `mkdtemp` now counts as `fs.write`, so hosts/tests should create temp directories before installing the Bridge.
- **`Ledger.verify()`** reports `json_invalid` and returns `head=null` on a corrupted tail line instead of throwing.
- Case count 44 → 61 (new `test/audit.test.js`, `test/mandate.test.js`).

## Version mapping (core ↔ host adapter) and a note on early authorship

The core package and the host adapter version independently — the adapter tracks host-side integration work:

| Core (`dsh-dashcam`) | Host adapter (`dsh-dashcam-host`) | Milestone |
| --- | --- | --- |
| 1.10.12 | 1.10.12 | host adapter merged into this repo as a git subtree |
| 1.11.0 | 1.11.0 | rename dsh-covenant → dsh-dashcam |
| 1.12.0 | 1.14.0 | core adds ingress audit; adapter adds ingress wiring and the Agent Dashcam panel |
| 2.0.0 – 2.0.3 | 1.14.0 (current) | single-package distribution; the 2.0.x fixes are client-loader defects, 2.0.3 is metadata only |

Since 2.0.0 the host adapter ships inside the root package and no longer has a release line of its own; the adapter version above is what `pluginVersion` records in the ledger.

Going forward, each release tag's annotation states the matching host adapter version.

Commits from the 1.6.0–1.10.x era use a placeholder identity (`dsh-covenant <dev@local>`); from the rename onward they use the GitHub noreply address. History is intentionally left unrewritten.
