# Remote CI evidence

The remote is [Mythikos/iridium](https://github.com/Mythikos/iridium). M1 landed in
`29155191d4c116db1897fc083d9939e3ce588f30`; the initial repair baseline is
`782a106475bb08af0f0ebca555e725e9b6aedad3`. Failed runs remain intact on Actions.

## Initial runs

| Run | Commit | Result and follow-up |
|---|---|---|
| [CI 35466253594](https://github.com/Mythikos/iridium/actions/runs/35466253594) | `2915519` | Cancelled by the next main push; not green evidence. |
| [Release 35466253619](https://github.com/Mythikos/iridium/actions/runs/35466253619) | `2915519` | Failed. Commit `008080d` corrected the Changesets v2 action inputs and token input. |
| [CI 35469666785](https://github.com/Mythikos/iridium/actions/runs/35469666785) | `008080d` | Failed; retained. |
| [Release 35469666830](https://github.com/Mythikos/iridium/actions/runs/35469666830) | `008080d` | Failed; retained. |
| [CI 35472395357](https://github.com/Mythikos/iridium/actions/runs/35472395357) | `782a106` | Static, Linux/Windows units, Windows Electron and MySQL 9.7 chaos pass. Both integration engines time out in the fresh-capacity case (476 pass, one fails per engine). MySQL 8.4 chaos has 86 pass, two fail and 42 nightly-only skips. Linux Electron fails at npm's package-manager check. Web shards and macOS Electron time out waiting for readiness. Report merging fails because the hidden blob directory was not uploaded. |
| [Release 35472395379](https://github.com/Mythikos/iridium/actions/runs/35472395379) | `782a106` | Version automation fails because Actions cannot create PRs. Remove the job and main-push release trigger to follow the direct-main rule; consume the changeset locally for M1. |

The first workflow repair explicitly uploads hidden Vitest reports and refuses missing blobs,
uses the pinned pnpm Playwright command, gates web E2E at M4, and exposes server startup output.
It does not lower test budgets, coverage or mutation thresholds.

At initial inspection, `nightly.yml` had no runs. This is missing evidence, not green health.
Local failed-step downloads are retained under `reports/remote-ci/` (ignored build evidence).
macOS Electron and a fresh local registry audit remain outstanding as directed by the owner.

## First repair

Commit `6da12835fdaa1ccd41d4cbcf2bb74d9847d47fb9` starts
[CI 35475564326](https://github.com/Mythikos/iridium/actions/runs/35475564326) and the manually
dispatched [nightly 35475597877](https://github.com/Mythikos/iridium/actions/runs/35475597877).
Both unit report artifacts now exist. Linux Electron gets past dependency setup; native E2E
servers still use the container default `/data/attachments`, outside the runner's writable
workspace. The next repair gives every E2E lane isolated runner-owned storage and a fresh
keyring through one composite action, and applies the pnpm command correction to nightly too.

Both open NoteSession review findings are fixed: an injected five-second deadline retires the
old socket generation when its document CLOSE echo is missing, preserving the document and
undo history; grace-based retries use the exponential ladder with server grace as a minimum.
Six new cases cover deadline recovery/cancellation and repeated zero/nonzero grace. The full
client plus NoteClient cluster passes 166 checks locally, and client type checking passes.
The first test attempt used an invalid closing reason in one new fixture; its failed log is
retained beside the corrected result. The fresh-capacity case passes locally both with and
without CI coverage; failure-phase diagnostics are added to identify its Actions-only stall.

The two chaos failures also exposed portability assumptions in their oracles. Crash recovery now
observes abnormal process termination (SIGKILL on Unix) instead of requiring the final buffered log
to survive that kill. Backpressure uses a one-shot, explicitly released fault at the COMMIT boundary;
it no longer races 5,250 real updates against a five-second sleep. The independent writer still has
its two-second budget and must commit while the first writer is held. Queue limits, rejection,
pending edits, recovery and duplicate checks are unchanged. Local MySQL 8.4 runs pass the queue case
and both crash-boundary cases. Intermediate failures from the incomplete fault adapter and Windows'
signal-less exit representation are retained in the local logs. The full TypeScript build, 83 focused
unit checks and 57 registry/release guards pass.

The first nightly already records failures in Electron setup, fresh-capacity (also in flake-hunt and
Node 26), and the advisory MySQL innovation lane. That lane sets an ambient version override which
in-process fixtures do not inherit; its required-engine assertion also rejects the deliberately
unsupported engine. This is an unresolved advisory harness issue, not evidence that either supported
engine failed its version floor. Scheduled history is still absent; this first run is a manual dispatch.

## Second repair

Commit `97906b7fc3271a23f61ef5942ec455c3279db467` starts
[CI 35476893797](https://github.com/Mythikos/iridium/actions/runs/35476893797). The preceding CI run
was superseded and cancelled; its completed 8.4 integration output records 475 passes and two failures.
In addition to fresh-capacity, property seed `-1165222821`, path `169:8`, found that creating a note
from two U+FEFF characters returned 500. `normalizeSource` correctly removes one encoding BOM and
preserves the next character (08 §4), but the CRDT initializer's old BOM guard rejected that content.
The fix preserves the documented normalization rule and makes the guard check LF only. The retained
counterexample fails before the fix and passes through creation, compaction and reload afterward;
all 110 CRDT/Markdown unit checks and the full TypeScript build pass.

The second repair's macOS and Windows Electron jobs pass on Actions. Linux now reaches launch and
reports that the pinned Electron sandbox helper lacks root ownership and mode 4755. A shared action
installs that exact helper outside the writable checkout and exposes `CHROME_DEVEL_SANDBOX`, following
[Chromium's helper installation instructions](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/suid_sandbox_development.md).
Renderer sandboxing remains enabled. This does not supply the outstanding local macOS validation.

A temporary, manually dispatched `runner-diagnostics` workflow isolates the fresh-capacity child
lifecycle on Linux; it is a diagnostic and cannot stand in for a required matrix run.

## Third repair

Commit `85dbad83e125e6ba41af0b37bb9306cb8d247faa` starts
[CI 35477325274](https://github.com/Mythikos/iridium/actions/runs/35477325274) and
[diagnostic 35477333095](https://github.com/Mythikos/iridium/actions/runs/35477333095).
Static, both unit jobs, macOS Electron and Windows Electron pass. Linux's helper setup initially
captures Electron 44's lazy-download progress text along with the binary path; explicitly completing
the download before reading the path corrects the setup. The prior CI was superseded and remains
cancelled, with its completed failures preserved.

The diagnostic fails in cleanup after all capacity assertions finish, with the child still alive.
Hocuspocus 4.7.0 attempts normal unload after a failed load, but that document has not yet entered its
registry; the unpublished document's awareness timer survives. The pinned source and both runtime
patches now destroy that object on either load-hook failure. Both new lifecycle regressions fail
before the patch and pass afterward, including a successful retry of the same document name; all
five cleanup checks pass. The seven-task forced server build, full types and 53 release guards pass.
The focused fresh-capacity, awareness-identity and kernel smoke integration files also pass against
local MySQL 8.4 (three tests); their remote confirmation remains pending for this repair.
The patch was reconstructed from installed package bytes after an offline patch command found no
cached tarball. A frozen offline install verifies its updated SHA-256 lockfile references and applies
it without changing dependency versions. The initial Windows junction-permission failure and the
successful elevated offline retry are retained; this is not a registry audit.

Release preflight also canonicalizes the mixed-case GitHub owner into one lowercase OCI repository
for publishing, SBOM generation and digest-based scanning; its regression is in the release guards.
No version PR exists, and the release workflow has no version-PR job.

## Fourth repair and first nightly findings

Commit `8c6fb76193b033a3061123d602a1c506ca506c24` starts push CI `35478371568`, superseded
by explicit [M1 rehearsal 35478419591](https://github.com/Mythikos/iridium/actions/runs/35478419591).
[Diagnostic 35478400206](https://github.com/Mythikos/iridium/actions/runs/35478400206), job
`105991600542`, passes the real Linux fresh-capacity shutdown. The temporary diagnostic workflow
is removed after that proof. The rehearsal passes static, both unit jobs, Windows and macOS Electron.
Linux job `105991867020` shows that the release binary ignores `CHROME_DEVEL_SANDBOX` and still
looks beside Electron. Setup now links that expected path to the installed root-owned helper.

Manual CI rehearsals now have independent concurrency groups, so later main pushes cannot discard
their captured-commit evidence. Ordinary pushes still supersede earlier pushes.

Nightly `35475597877` completes `schemathesis-full` as a failure (job `105984200108`, artifact
`10594333947`). Admin case `SiiXiH` returns 500 for an initial vault member that does not exist;
outsider case `RPsTyK` returns 422 for the valid single query value `status=active`. Both regressions
fail locally before the fixes. Vault creation now locks and checks initial members, returns the
documented 404 and rolls back the entire creation and authorization-version changes; a follow-up
valid creation succeeds. The query codec accepts one or repeated enum values. All 11 response
integration tests pass locally; the generated contract adds the new 404 response.

Other full-profile findings remain open: a signed cursor cannot be synthesized as an arbitrary
schema-valid string (the server correctly returns `cursor_invalid`); admin fuzzing loses its fixture
login with HTTP 401 after stateful account mutations; and a request exceeding Node's parser header
limit receives Fastify's transport-level 431 JSON envelope, outside the declared ProblemDetails
envelope. These are recorded failures, not a passing full fuzz run. The light non-admin required
gate remains separate. The first nightly's remaining jobs are still running at this checkpoint.
