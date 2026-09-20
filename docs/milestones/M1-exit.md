# M1 exit record

M1 closes on 2026-09-20 (UTC) after M0's formal closure and marker `v0.0.0` at `3da2ab24fa42ff14353a10dd6943058a4c697667`.
The implementation, workspace version `0.1.0` and promoted upgrade fixture are committed at
`20494d32a1e1d84697c1a9dd35303caa1d9a297d`. This following record commit advances `CURRENT` to `M1`; hand-cut
`v0.1.0` targets this record commit. This is the two-commit landing sequence: the record names
its already-existing implementation parent, and the product tag identifies the record itself.
The original kernel landed in `29155191d4c116db1897fc083d9939e3ce588f30`.

## Required remote checks

| Required check | Check-run ID | Result |
|---|---|---|
| `static` | [106067930381](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106067930381) | Pass |
| `unit (ubuntu-latest)` | [106068100390](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100390) | Pass |
| `unit (windows-latest)` | [106068100394](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100394) | Pass |
| `integration (mysql:8.4.11)` | [106068100424](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100424) | Pass |
| `integration (mysql:9.7.2-oraclelinux9)` | [106068100460](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100460) | Pass |
| `chaos-core (mysql:8.4.11)` | [106068100434](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100434) | Pass |
| `chaos-core (mysql:9.7.2-oraclelinux9)` | [106068100498](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100498) | Pass |
| `e2e-electron (ubuntu-latest)` | [106068100471](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100471) | Pass |
| `e2e-electron (windows-latest)` | [106068100452](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100452) | Pass |
| `e2e-electron (macos-latest)` | [106068100410](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100410) | Pass |
| `mutation-scoped` | [106068100420](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106068100420) | Pass |
| `merge-reports` | [106071941895](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106071941895) | Pass |

All check IDs above come from GitHub's check-runs API. The database lanes ran on Actions with
MySQL 8.4.11 and 9.7.2, and Electron ran on actual Linux, Windows and macOS runners. Web E2E is
not due until M4. The full-scope nightly mutation campaign [106067832796](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832796) passes **74.78417266187051%**, with 4,158 detected of 5,560 valid mutants and zero pending. This incremental campaign retains the configured full mutate scope, executes a fresh 2,100-test baseline and reuses 8,982 of 10,607 prior mutant results. Reused results are not described as newly executed mutants. All 85 reported source contents match `20494d32a1e1d84697c1a9dd35303caa1d9a297d`. Artifact `10605050663` has digest `sha256:0cbb4ea51a09230cab594da0dd81d5313b0d5c6da41a8dd799587475024b047e`; report SHA-256 is `84ef180b3921e8e1421d78935b8ce57418b337a1d880b1baa225dadfa04f57dd`. The current main scoped check is separately identified by its job result; earlier failed or incomplete campaigns supply no score.

## Named exit proofs

| Named exit tests | Due lane | Remote proof |
|---|---|---|
| `admin.reset-password.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `audit.bounded-failures.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `audit.vocabulary.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `authz.archived-vault.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `healthz.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `metrics.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `notes.initialize.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `security.headers.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `shutdown.drain.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db.grants-provenance.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db.grants-readiness.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db.session-policy.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db.grants-provenance.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db.lock-timeout.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.awareness-windows.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `auth.user-agent.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.commit-reconcile.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `testkit.child-server.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `crdt.frame.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `projection.text-monotonic.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `kernel.smoke.integration` | `integration` (child mode) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.convergence.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.restart-no-duplication.integration` | `integration` (child mode) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.baseline-on-connect.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.owner-lease.unit` | `unit` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.owner-lease.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.second-process-refused.chaos` | `chaos-core` on both engines (CH-16, one iteration; nightly scope is recorded separately) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.viewer-enforcement.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.live-revocation.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.durable-ack.chaos` | `chaos-core` on both engines (20 kill iterations; nightly scope is recorded separately) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.graceful-shutdown.chaos` | `chaos-core` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.backpressure.chaos` | `chaos-core` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.admission-budget.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.unload-after-veto.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.awareness-identity.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.limits.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.lf-invariant.guard` | `static` + `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.content-invalid.chaos` | `chaos-core` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.initial-state-only-path.guard`, `collab.no-reinit.guard` | `static` (grep guards) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `routes.test-namespace-absent.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `persistence.model.prop` | `integration` on both engines, database property project (200 runs) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `convergence.model.prop` | `integration` on both engines, database property project | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `collab.clientid-stable.chaos` | `chaos-core` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `crdt.dominates.prop` | `unit` on Linux and Windows | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `authz.matrix.unit` | `unit` (100 % file coverage) | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `token.effective-permissions.prop` | `unit` on Linux and Windows | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `security.csrf.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `security.ws-origin.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `tickets.batch-and-limits.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `audit.chain.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db-grants.integration` | `integration (mysql:8.4.11)` and `integration (mysql:9.7.2-oraclelinux9)` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `db.auth-plugin.integration` | `integration (mysql:8.4.11)` and `integration (mysql:9.7.2-oraclelinux9)` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `readyz.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `logging-redaction.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `setpw-link.integration` | `integration` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |
| `openapi.contract`, `openapi.coverage.contract`, `schemathesis.light.contract` (M1 routes) | `contract` | [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) |

The table maps the named §5.4 proofs to the passing Actions lanes. Pure package property suites
run in `unit`; the database property project runs inside both `integration` jobs with 200 runs
and at most 60 model commands. Required chaos uses 20 crash iterations. Larger nightly budgets
are reported separately below; a required CI pass does not stand in for a nightly execution.

## Cross-cutting gates

| §3 gate | Result and evidence |
|---|---|
| Build matrix, types and lint | PASS, [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887): Linux and Windows build/type/lint tasks, and Linux static gates. |
| Format, Knip, dependency identity, boundaries, environment lists, audit and dedupe | PASS, [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) `static`. The registry audit occurred on Actions; the local audit limitation below remains. |
| Authorization route policy, acceptance map and declared non-goals | PASS, [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) `static`, including all due M1 names and layers. |
| Generated artifacts, API lint and licenses | PASS, [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887) `static`, plus live database schema parity on both integration engines. D01-15 settles the project's Elastic License 2.0 identifier; dependency licensing remains under D10-12/D10-15. |
| Coverage | **91% statements / 91.98% lines / 85.86% branches / 91.5% functions** in merge check [106071941895](https://github.com/Mythikos/iridium/actions/runs/35506765887/job/106071941895). The six raw lanes contain 5,814 passes and 84 skips in 500 passing and 2 skipped files; the merge then passes all 428 guards with 10 future skips. Artifact `10604293448` has digest `sha256:0c35905f0d8168c67f196335d1ae68fbe8e8f0f8633e9e35c97aef8785c8e89b`. All raw hashes match their origin records, all 73 grouped M0/M1 named proofs pass, and both unit platforms contain the six passing NoteSession regressions and six native first-frame latch regressions. Unchanged global and per-file gates pass in the normalized remote merge. Raw lane artifacts are retained. |
| Mutation | PASS, the full-scope incremental campaign above exceeds the unchanged 70% M1 gate; the main scoped check is recorded separately in the required-check table. |
| Spikes and decisions | PASS, `docs.spikes.spec` in [35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887); dispositions and ADRs below. |
| Nightly health | Campaign [35506782276](https://github.com/Mythikos/iridium/actions/runs/35506782276) on `20494d32a1e1d84697c1a9dd35303caa1d9a297d` passes both extended property lanes, all eight complete chaos shards, three consecutive integration repetitions and full Electron on Linux, Windows and macOS. Full-scope mutation and the separate API/advisory dispositions are recorded here with actual check IDs. No established green history is claimed from missing or pending runs. |
| Version and tag | Changesets consumed `m1-headless-kernel`; all 20 fixed workspaces and the root are `0.1.0`. There is no version-PR job. Product `v0.1.0` is hand-cut on this record commit. |
| Upgrade fixture | [M1 rehearsal 35495933501, MySQL 8.4 producer 106038899741](https://github.com/Mythikos/iridium/actions/runs/35495933501/job/106038899741) generates artifact `10601480949` from `7176d392232aa8f79f9f4cec47c4d9df9635085a` at `2026-09-20T07:16:57.372Z`. Artifact digest is `sha256:881d2da0e01a86f26f717e7fc7d52b9f407582aac3af5ecae92eb8a31e4c3d9f`. The 19,076-byte dump has SHA-256 `ce390d190fd04a8bb0358a200f2b0e4d5248d38bc5d7680faa50ae3568c6aaea`; manifest hash is `cfeb94168fd7541e891f639a34b5a699b39e718dc1d6e2c57e51c4261693ce1e`. Its exact bytes are committed under `apps/server/test/fixtures/upgrade/v0.1.0/`, with all 55 migrations, six users, four members, one note and zero attachments. It uses the backup role and the shipped MySQL 9.7.2 client. The current required integration jobs restore and verify that fixture on both database engines. Schema, seeder and backup/export inputs are unchanged since its producer. The subsequent serving SQL minimum correction preserves the ten-second default used to produce the fixture; final integration proves its restoration on both engines. |

The required non-admin Schemathesis-light profile passes on both engines with all checks/phases
and 50 examples per shipped operation. Each engine independently records all 131 explicit documented operation/status pairs, with 136 recorded operation/status pairs including 5 defaults across 38 report files. The MySQL 8.4 and 9.7 artifacts are `10604062350` and `10604176958`; both belong to the current source run. Both integration jobs pass 481 tests in 84 files, including the exact promoted fixture restoration.

## Nightly workflow history

GitHub's workflow history captured at **2026-09-20T13:51:02.272Z** contains 8 manual rehearsals and 1 scheduled execution. Every row retains its actual source, trigger and result.

| Run / source | Trigger and start | Workflow result | Extended property | Chaos | Mutation | Flake hunt | Full API |
|---|---|---|---|---|---|---|---|
| [35475597877](https://github.com/Mythikos/iridium/actions/runs/35475597877) / `6da1283` | Manual 2026-09-19 23:15:12 UTC | failure | 1 fail | 1 cancelled | 1 pass | 1 fail | 1 fail |
| [35488088005](https://github.com/Mythikos/iridium/actions/runs/35488088005) / `b663d81` | Manual 2026-09-20 04:01:52 UTC | failure | 2 pass | 4 pass, 4 fail | 1 cancelled | 1 pass | 2 fail |
| [35492580406](https://github.com/Mythikos/iridium/actions/runs/35492580406) / `f8390f1` | Manual 2026-09-20 05:47:52 UTC | failure | 2 pass | 2 fail, 6 pass | 1 pass | 1 pass | 2 fail |
| [35495934601](https://github.com/Mythikos/iridium/actions/runs/35495934601) / `7176d39` | Manual 2026-09-20 07:05:24 UTC | failure | 2 pass | 8 pass | 1 pass | 1 pass | 2 fail |
| [35497703737](https://github.com/Mythikos/iridium/actions/runs/35497703737) / `46f2e8b` | Manual 2026-09-20 07:45:05 UTC | failure | 2 pass | 8 pass | 1 pass | 1 fail | 2 fail |
| [35498879078](https://github.com/Mythikos/iridium/actions/runs/35498879078) / `46f2e8b` | Scheduled 2026-09-20 08:11:28 UTC | failure | 2 pass | 8 pass | 1 pass | 1 pass | 2 fail |
| [35499345923](https://github.com/Mythikos/iridium/actions/runs/35499345923) / `abb968a` | Manual 2026-09-20 08:21:46 UTC | failure | 2 pass | 8 pass | 1 pass | 1 pass | 2 fail |
| [35505721446](https://github.com/Mythikos/iridium/actions/runs/35505721446) / `9f269b9` | Manual 2026-09-20 10:40:21 UTC | failure | 2 pass | 8 pass | 1 pass | 1 fail | 2 fail |
| [35506782276](https://github.com/Mythikos/iridium/actions/runs/35506782276) / `20494d3` | Manual 2026-09-20 11:03:46 UTC | failure | 2 pass | 8 pass | 1 pass | 1 pass | 2 fail |

The first run used one serial 8.4 chaos job and a combined 9.7 property/chaos/API job; failure of the combined job did not establish downstream results. Later runs split both engines into independent property/API lanes and four complete chaos file shards. The serial chaos deadline, startup and durable-ack failures, SQL-count flake and first-frame latch failure remain in [remote-ci.md](remote-ci.md). A later pass does not change an earlier failure or cancellation.

The following completed checks all execute the selected implementation. Both property lanes retain 5,000 examples and at most 300 model commands; both chaos matrices retain all nightly budgets, including 200 kill iterations. Counts come from their actual terminal job logs. The flake row contains three complete consecutive runs.

| Nightly proof | Source | Check-run ID | Terminal result |
|---|---|---|---|
| `property-long` | `20494d3` | [106067832777](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832777) | 2351 pass |
| `mysql-matrix-extended (property, 300)` | `20494d3` | [106067832745](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832745) | 2351 pass |
| `chaos-extended (1)` | `20494d3` | [106067832782](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832782) | 67 pass |
| `mysql-matrix-extended (chaos-1, 1, 240)` | `20494d3` | [106067832831](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832831) | 67 pass |
| `chaos-extended (2)` | `20494d3` | [106067832780](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832780) | 171 pass |
| `mysql-matrix-extended (chaos-2, 2, 240)` | `20494d3` | [106067832763](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832763) | 171 pass |
| `chaos-extended (3)` | `20494d3` | [106067832784](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832784) | 12 pass |
| `mysql-matrix-extended (chaos-3, 3, 240)` | `20494d3` | [106067832801](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832801) | 12 pass |
| `chaos-extended (4)` | `20494d3` | [106067832756](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832756) | 695 pass |
| `mysql-matrix-extended (chaos-4, 4, 240)` | `20494d3` | [106067832908](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832908) | 695 pass |
| `flake-hunt` | `20494d3` | [106067849651](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067849651) | 411 pass; 411 pass; 411 pass |
| `e2e-electron-full (ubuntu-latest)` | `20494d3` | [106067832785](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832785) | 4 pass |
| `e2e-electron-full (windows-latest)` | `20494d3` | [106067832876](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832876) | 4 pass |
| `e2e-electron-full (macos-latest)` | `20494d3` | [106067832812](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832812) | 4 pass |

Future M3/M4/M8 jobs remain skipped at M1. The first four manual Node 26 labels invoked pnpm's Node 24 pin and prove no Node 26 compatibility; later corrected runs execute Node 26. No consecutive green scheduled-history claim is made. D12-20's M1 light-profile gate and the explicitly advisory runtime/database dispositions remain distinct from the due extended gates.

## Review findings and remote repairs

A17 initializes persistence latches before the first native incoming frame, with connected
covering idle connections. The remote oversize reattachment failure led to real SyncStep2/Update
regressions and an integration proof that holds the connected hook chain across role upgrade.
Electron binary installation is explicit in CI, nightly and release; only that setup download
has bounded retries. Failed checks `106065202428` and `106065102033` remain in the ledger.

Both requested NoteSession findings are fixed in `97906b7fc3271a23f61ef5942ec455c3279db467`.
The injected Clock bounds an unanswered document CLOSE at five seconds, retires the stale shared
socket generation and reconnects while retaining the original document, undo manager and pending
edits. Echo, disconnect and disposal cancel the deadline. Grace retries use the exponential ladder
with server grace as a minimum, including zero grace. Six new regressions pass in the remote unit
lanes; neither finding is deferred.

[remote-ci.md](remote-ci.md) preserves failed run IDs and each repair: action APIs, hidden blobs,
runner storage, pinned pnpm commands, enabled Linux Electron sandbox setup, cross-platform report
roots, normalized content U+FEFF, unpublished Hocuspocus document cleanup, and the two API fuzz
counterexamples. Queue loading and refusal delivery are now observed separately without changing
the queue or two-second fairness limit. The dated D10-33 amendment explicitly changes CH-6's
ownership-loss recovery allowance to 75 s to accommodate its existing retry ladders; an intact
owner still has 30 s. It retains the real clients, ownership fences, exact-once edits and 180 s
overall case deadline. Earlier failed runs remain failures.

The long-running property fixture now rotates browser sessions with distinct simulated peer
addresses, preserving the product's login throttle and the fixed property clock. Release builds
embed their source commit through Docker and Turbo's cache key, then verify that identity in the
published image. OPS-04 replaces the x86-only MySQL APT source with signed, hash-pinned 9.7.2
client RPMs for both release architectures; every image build executes the shipped clients and
server version command in the final runtime base.
The image applies Debian fixes, removes unused runtime package managers, and retains the signed
MySQL package's precise version/ownership metadata and license for an accurate SBOM. The Grype
severity and fix-availability gate is unchanged; no vulnerability exclusion is added.
Both published platforms are selected explicitly for Syft/Grype at the same immutable index
digest. Reports have separate architecture names, and version/commit and shipped-client hygiene
commands execute on AMD64 and ARM64. Actual tagged release results are distinct from preflight.

D10-25 records the first extended nightly's four-hour timeout and the subsequent split into
four complete chaos file shards per engine. Iteration counts and case deadlines are unchanged;
the other-engine property and fuzz campaigns run independently so one failure cannot skip the
remaining evidence. Only completed remote shard results establish the repaired nightly's status.

ARCH-02 makes concurrent boot, HTTP and periodic readiness callers share one serial evaluation;
the next call after completion starts a fresh scan, and draining remains irreversible. Fastify's
plugin/onReady deadline is explicitly 60 seconds in all modes, matching the existing child
startup handshake. This addresses the nightly CH-16 startup and blackhole readiness failures
without changing database check thresholds, probe ordering, chaos iterations or case deadlines.
The failed remote and local reproductions remain in the evidence ledger.

D10-6 adds a validated runtime note/sequence selector to the two existing acknowledgement
wire faults. It prevents a repeated baseline reply from consuming the kill intended for the
newly committed edit; the client observer uses the same sequence floor. The synchronous wire
kill and the real client's baseline probe remain active. The maximum nightly SQL latency
also needs a 90-second acknowledgement observation inside the unchanged 180-second case
deadline; normal CI retains 30 seconds and product statement/retry deadlines do not change.
Earlier sequence-observation, selector-wiring and maximum-latency failures are retained.

The nightly SQL-count flake exposed a test-boundary race: Saved can precede the connection
hook's participant-identity read. The proof now observes the actual participant message before
starting its steady-state counter. Holding the real identity read until Saved reproduces the
original extra query for both roles; the repaired boundary passes that same controlled ordering.
The zero-query, two-stale-read and 200-update assertions remain unchanged. Uninstrumented local
and remote results are recorded in the evidence ledger.

The advisory Node 26 lane now verifies and records its test executable before launching Vitest
directly with it. pnpm's frozen install selects the repository's Node 24 pin for its own commands;
the historical green Node 26 job labels therefore did not establish runtime compatibility.
The frozen build and production Docker fixture keep Node 24. Corrected remote results are
identified separately in the nightly evidence.

## Dispositions

- Spec rows retired: initialization/reconnection and durable saving. Concurrent editing,
  viewer enforcement and live revocation gain headless proofs; their later UI/MCP ownership
  remains as listed in §5.5.
- Spikes: S10 passes on both engines and is reproduced by `collab.clientid-stable.chaos`.
  All due earlier verdicts remain closed. S4/S5/S7/S13 fallbacks name `71915f5`; S01/S02/S14/S06
  harness deletions landed in `2915519`.
- ADRs: A17, A20, ARCH-02, D01-15, D04-14, D05-06, D10-6, D10-25, D10-33, D12-20, OPS-04 and OPS-12, with the A54/A51/A2 review amendments,
  are indexed under `docs/adr/`. Remote failed-load cleanup and recovery-observation amendments
  are included; no undocumented policy override is used to declare this exit.
- Questions: the eight §G answers remain settled, and D01-15 resolves the license decision. The
  owner has not clarified a literal MySQL 8.0 requirement; supported engines remain 8.4 and 9.7.
- Deferred to the owner: branch protection and PR workflow until explicitly restored. Commits
  and pushes continue directly to main, and the version bot cannot open PRs.
- Deferred to M2's API/test-harness work: full-profile signed-cursor generation, administrator
  fixture authentication after stateful account changes, transport/router-level 431 and 414 ProblemDetails,
  the outsider profile's one-hour completion bound, and the advisory MySQL innovation override.
  Their first nightly failures are recorded, not
  relabeled as passes. D12-20 makes the full administrator/outsider fuzz profiles separate from
  M1's required light gate. Selected full API checks [106067832605](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832605) (failure) / [106067832826](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832826) (failure) retain artifacts `10604299681`, `10604774311`. Both administrator profiles record one generated-cursor rejection and 27 authentication errors; authenticated administrator fuzz coverage is not established. The 8.4 outsider profile completes in 3060.59 seconds with two content-type failures, HTTP 431 and HTTP 414 returning application/json instead of application/problem+json. The 9.7 outsider profile reaches its 3600000 ms completion deadline and supplies no terminal pass. Cursor generation, administrator fixture recovery, transport/router ProblemDetails and the completion-bound investigation remain M2 work under D12-20; the required non-admin M1 light profiles pass separately on both engines. Innovation check [106067832718](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832718) remains failure: 93 failures, 27 passes and 291 skips retain the production MysqlUnsupportedError for MySQL 26.7.0. The advisory test override does not cross every production version check; investigation remains assigned to future harness/runtime adoption, while both required LTS engines remain separately gated.
- Deferred until Node 26 adoption (A4/D10-19): Actual runtime check [106067832740](https://github.com/Mythikos/iridium/actions/runs/35506782276/job/106067832740) is failure, with 7 failures and 2742 passes. Six boot/lifecycle cases fail strict stderr assertions on Node 26 Web Storage ExperimentalWarning output. A seventh case, same-user multi-session revocation, reaches its one-second connection-close observation deadline. The runtime is advisory under A4/D10-19; both warning behavior and the observed revocation timing remain open for Node 26 adoption, with no assertion weakened and no compatibility pass claimed. Artifact `10604496352` preserves the result.
- Outstanding as directed: local macOS Electron, because there is no local macOS environment;
  and a fresh local `pnpm audit`, because registry egress approval remains unavailable. Remote
  macOS and remote audit success are separate evidence and do not close these local items.
- Known risks: the protocol's pre-release acknowledgement witness requires coordinated server
  and client deployment; collaboration remains one owner per database. Prior R-T10/R-T22 and
  spike sizing dispositions remain recorded in M0. This headless exit does not claim supported
  desktop UI acceptance, MCP completion, or the M8 operations/security review.

The earlier [M1 progress record](M1-progress.md) retains dated local evidence and failed wrappers;
the actual remote runs and tagged implementation above determine this formal exit.

## OPS-12 amendment: InnoDB timeout-sweep margin (2026-09-20)

The supported minimum for `DB_QUERY_TIMEOUT_MS` is now **3000 ms**. The default remains
10 000 ms, the maximum remains 2 147 483 647 ms, and serving lock waits remain
`floor(DB_QUERY_TIMEOUT_MS / 2000)` seconds. This is a pre-release configuration-boundary
correction; explicit values below 3000 are rejected rather than silently clamped.

MySQL 8.4.11 and 9.7.2 check expired InnoDB lock waits in a once-per-second sweep. A nominal
one-second lock wait can therefore be reported near two seconds, leaving no response margin
under the former two-second command minimum. Actual Actions check
[106060922722](https://github.com/Mythikos/iridium/actions/runs/35504070807/job/106060922722)
observes `PROTOCOL_SEQUENCE_TIMEOUT` instead of `ER_LOCK_WAIT_TIMEOUT` in the held audit-head
case. Its failed run and the previously passing runs remain unchanged.

The new minimum reserves one second each for the lock wait, the regular sweep, and delivery
of the refusal. Scheduler or network stalls and multiple waits may still exhaust the total
command budget; those remain `503 unavailable`, and an uncertain COMMIT is never described
as rolled back. No failure mapping, driver destruction, retry policy or test assertion is
weakened. Maintenance/backup commands and idle owner reservations retain their own policies.

`db.session-policy.unit` checks the sweep and response allowance at the minimum and other
budget boundaries; its new regression fails with zero remaining margin under the old minimum.
`config.env.unit` rejects the old range. `audit.bounded-failures.integration` and
`db.lock-timeout.integration` retain exact server 1205, transaction rollback, connection reuse,
chain verification and caller-owned exact-once retry assertions on both supported engines.

Primary implementations: [MySQL 8.4.11](https://github.com/mysql/mysql-server/blob/mysql-8.4.11/storage/innobase/lock/lock0wait.cc#L1353)
and [MySQL 9.7.2](https://github.com/mysql/mysql-server/blob/mysql-9.7.2/storage/innobase/lock/lock0wait.cc#L1353).

## Post-tag release evidence (2026-09-20)

The product tag remains on this record's original commit, `f31a51fd2c3af6b3631a28fc45918245dfac34a1`.
That commit's twelve required checks pass in [35514878482](https://github.com/Mythikos/iridium/actions/runs/35514878482).
Tagged release [35516882462](https://github.com/Mythikos/iridium/actions/runs/35516882462) passes
both MySQL verification lanes, the two-platform build and both architecture-specific SBOM/scan
pairs, but its runtime hygiene job fails when the hosted runner's classic Docker image store
cannot load ARM64 after AMD64 at one immutable index digest. The original release remains a
failure; an empty ARM64 identity file supplies no execution evidence.

The post-tag OPS-04 workflow repair configures a containerd image store and reuses the exact
version/source/client checks in a read-only artifact-verification workflow. It preserves the
product tag and already-published image digest. [remote-ci.md](remote-ci.md) records the failed
job, successful prerequisite IDs, immutable artifact digest and repair. Supplementary runtime
verification must be recorded separately; it cannot replace the original SBOMs/scans or erase
the failed run. The local macOS Electron and fresh local audit items above remain outstanding.
