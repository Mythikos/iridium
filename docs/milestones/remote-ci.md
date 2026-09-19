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
