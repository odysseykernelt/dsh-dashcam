# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub's private vulnerability reporting on this repository:
**Security tab → Report a vulnerability** (https://github.com/odysseykernelt/dsh-dashcam/security/advisories/new).

You can also reach the maintainer via a Discussion in the *Ideas* category if the issue is not sensitive. Please include: affected version, reproduction steps, and — if possible — a ledger excerpt or gate report demonstrating the issue.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.12.x | yes |
| < 1.12 | no (see the 1.11.0 rename migration notes in the README) |

## Known boundaries (please read before relying on this project)

dsh-dashcam is a judgment chain and audit ledger, **not a sandbox**. The built-in Bridge is a patch-based in-process guard with explicit known gaps:

- Native addons, `worker_threads`, `vm`-generated code, and direct syscalls are out of reach of Node-level interception.
- Function references cached/captured by a plugin before the Bridge is installed are not protected.
- Static scanning results are "scan results", not security proofs — see `bridge.coverage()` (`guarded` list + `knownGaps`).
- The load window for legacy plugins is a deliberate, one-time trust concession; see the README section **Security boundaries**.

`bridge.coverage().knownGaps` is the authoritative list — treat it as an upper bound of the capability surface, not noise. We make no claim of "full protection"; the ledger's job is to make what happened verifiable after the fact.
