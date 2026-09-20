# M1 exit candidate

**Formal M1 exit is pending.** Candidate record commit `2d62b99d17bca30e8d2d842a1a88c73b15ba0284`
failed its own MySQL 9.7 integration check in [CI 35504070807](https://github.com/Mythikos/iridium/actions/runs/35504070807).
No `v0.1.0` tag was created. `CURRENT` returns to `M0` while the OPS-12 timeout-sweep correction
is verified; M0's formal closure and `v0.0.0` marker remain complete.

The following evidence belongs to implementation `abb968a1c506b50743f5cf40d30bcc35b30857af`
and its named predecessor campaigns. It is retained with its original inputs and capture time;
it does not certify the pending correction. A replacement exit record will name the repaired
implementation before the product tag is cut on that following record commit.

## Required remote checks

| Required check | Check-run ID | Result |
|---|---|---|
| `static` | [106048104100](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048104100) | Pass |
| `unit (ubuntu-latest)` | [106048380552](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380552) | Pass |
| `unit (windows-latest)` | [106048380556](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380556) | Pass |
| `integration (mysql:8.4.11)` | [106048380609](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380609) | Pass |
| `integration (mysql:9.7.2-oraclelinux9)` | [106048380555](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380555) | Pass |
| `chaos-core (mysql:8.4.11)` | [106048380598](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380598) | Pass |
| `chaos-core (mysql:9.7.2-oraclelinux9)` | [106048380566](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380566) | Pass |
| `e2e-electron (ubuntu-latest)` | [106048380573](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380573) | Pass |
| `e2e-electron (windows-latest)` | [106048380610](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380610) | Pass |
| `e2e-electron (macos-latest)` | [106048380584](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380584) | Pass |
| `mutation-scoped` | [106048380551](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106048380551) | Pass |
| `merge-reports` | [106053852281](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106053852281) | Pass |

All check IDs above come from GitHub's check-runs API. The database lanes ran on Actions with
MySQL 8.4.11 and 9.7.2, and Electron ran on actual Linux, Windows and macOS runners. Web E2E is
not due until M4. [Nightly 35499345923, check 106048191187](https://github.com/Mythikos/iridium/actions/runs/35499345923/job/106048191187) passes the full configured scope at **74.71223021582733%** (4,154/5,560 valid mutants), above the unchanged 70% gate. It has 10,607 mutants, zero pending and 85 reported source files matching the implementation commit. The fresh baseline runs 2,086 tests; 10,057 mutation results are reused from the `46f2e8b` cache. This is full-scope incremental evidence, not a fresh mutation campaign. Counts are 3,849 killed, 305 timeouts, 1,242 survivors, 164 uncovered, 4,525 compile errors, 521 ignored and one runtime error. Artifact `10602010555` has digest `sha256:4ea030fd108911d3f9cb33647076ba4cbadf588e8ee8dc91ed396fb48c4b30f5`; report SHA-256 is `a4b06a052a87a413d3c05cf9b395d3f1e5003176d2913a9b2c943182cdd234bf`. Main's successful scoped mutation check performs no mutation work for this test-only change.

## Named exit proofs

| Named exit tests | Due lane | Remote proof |
|---|---|---|
| `admin.reset-password.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `audit.bounded-failures.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `audit.vocabulary.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `authz.archived-vault.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `healthz.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `metrics.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `notes.initialize.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `security.headers.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `shutdown.drain.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db.grants-provenance.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db.grants-readiness.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db.session-policy.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db.grants-provenance.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db.lock-timeout.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.awareness-windows.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `auth.user-agent.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.commit-reconcile.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `testkit.child-server.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `crdt.frame.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `projection.text-monotonic.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `kernel.smoke.integration` | `integration` (child mode) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.convergence.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.restart-no-duplication.integration` | `integration` (child mode) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.baseline-on-connect.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.owner-lease.unit` | `unit` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.owner-lease.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.second-process-refused.chaos` | `chaos-core` on both engines (CH-16, one iteration; nightly scope is recorded separately) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.viewer-enforcement.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.live-revocation.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.durable-ack.chaos` | `chaos-core` on both engines (20 kill iterations; nightly scope is recorded separately) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.graceful-shutdown.chaos` | `chaos-core` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.backpressure.chaos` | `chaos-core` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.admission-budget.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.unload-after-veto.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.awareness-identity.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.limits.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.lf-invariant.guard` | `static` + `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.content-invalid.chaos` | `chaos-core` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.initial-state-only-path.guard`, `collab.no-reinit.guard` | `static` (grep guards) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `routes.test-namespace-absent.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `persistence.model.prop` | `integration` on both engines, database property project (200 runs) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `convergence.model.prop` | `integration` on both engines, database property project | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `collab.clientid-stable.chaos` | `chaos-core` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `crdt.dominates.prop` | `unit` on Linux and Windows | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `authz.matrix.unit` | `unit` (100 % file coverage) | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `token.effective-permissions.prop` | `unit` on Linux and Windows | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `security.csrf.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `security.ws-origin.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `tickets.batch-and-limits.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `audit.chain.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db-grants.integration` | `integration (mysql:8.4.11)` and `integration (mysql:9.7.2-oraclelinux9)` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `db.auth-plugin.integration` | `integration (mysql:8.4.11)` and `integration (mysql:9.7.2-oraclelinux9)` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `readyz.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `logging-redaction.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `setpw-link.integration` | `integration` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |
| `openapi.contract`, `openapi.coverage.contract`, `schemathesis.light.contract` (M1 routes) | `contract` | [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) |

The table maps the named §5.4 proofs to the passing Actions lanes. Pure package property suites
run in `unit`; the database property project runs inside both `integration` jobs with 200 runs
and at most 60 model commands. Required chaos uses 20 crash iterations. Larger nightly budgets
are reported separately below; a required CI pass does not stand in for a nightly execution.

## Cross-cutting gates

| §3 gate | Result and evidence |
|---|---|
| Build matrix, types and lint | PASS, [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783): Linux and Windows build/type/lint tasks, and Linux static gates. |
| Format, Knip, dependency identity, boundaries, environment lists, audit and dedupe | PASS, [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) `static`. The registry audit occurred on Actions; the local audit limitation below remains. |
| Authorization route policy, acceptance map and declared non-goals | PASS, [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) `static`, including all due M1 names and layers. |
| Generated artifacts, API lint and licenses | PASS, [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) `static`, plus live database schema parity on both integration engines. D01-15 settles the project's Elastic License 2.0 identifier; dependency licensing remains under D10-12/D10-15. |
| Coverage | **91.03% statements / 92.01% lines / 85.86% branches / 91.53% functions** in merge check [106053852281](https://github.com/Mythikos/iridium/actions/runs/35499314783/job/106053852281). The six raw lanes contain 5,786 passes and 84 skips in 500 passing and two skipped files; the merge then passes all 428 guards with ten future skips. Artifact `10602491467` has digest `sha256:da041f3181f1f0965c0228868cc85eef9aeebf3b2cdacb001d465591d77fbf8f`. All raw hashes match their origin records, all 73 grouped M0/M1 named proofs pass, and both unit platforms contain the six passing NoteSession regressions. Unchanged global and per-file gates pass in the normalized remote merge. Raw lane artifacts are retained. |
| Mutation | PASS, the full-scope incremental campaign above exceeds the unchanged 70% M1 gate; the current main scoped no-op supplies no score. |
| Spikes and decisions | PASS, `docs.spikes.spec` in [35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783); dispositions and ADRs below. |
| Nightly health | The repaired production campaign [35495934601](https://github.com/Mythikos/iridium/actions/runs/35495934601) passes both extended property jobs and all eight full chaos shards. Its production, testkit, property/chaos, dependency and relevant workflow inputs match the final implementation. The final-source rehearsal [35499345923](https://github.com/Mythikos/iridium/actions/runs/35499345923) passes full-scope mutation, all three 411-test flake repetitions and full Electron on three operating systems. The check IDs, trigger history and separate API/advisory failures appear below. No established green history is claimed from missing or pending runs. |
| Version and tag | Changesets consumed `m1-headless-kernel`; all 20 fixed workspaces and the root are `0.1.0`. There is no version-PR job. Product `v0.1.0` remains uncut; the replacement exit record follows verification of the correction. |
| Upgrade fixture | [M1 rehearsal 35495933501, MySQL 8.4 producer 106038899741](https://github.com/Mythikos/iridium/actions/runs/35495933501/job/106038899741) generates artifact `10601480949` from `7176d392232aa8f79f9f4cec47c4d9df9635085a` at `2026-09-20T07:16:57.372Z`. Artifact digest is `sha256:881d2da0e01a86f26f717e7fc7d52b9f407582aac3af5ecae92eb8a31e4c3d9f`. The 19,076-byte dump has SHA-256 `ce390d190fd04a8bb0358a200f2b0e4d5248d38bc5d7680faa50ae3568c6aaea`; manifest hash is `cfeb94168fd7541e891f639a34b5a699b39e718dc1d6e2c57e51c4261693ce1e`. Its exact bytes are committed under `apps/server/test/fixtures/upgrade/v0.1.0/`, with all 55 migrations, six users, four members, one note and zero attachments. It uses the backup role and the shipped MySQL 9.7.2 client. The current required integration jobs restore and verify that fixture on both database engines. Production, schema and seeder inputs are unchanged since its producer. |

The required non-admin Schemathesis-light profile passes on both engines with all checks/phases
and 50 examples per shipped operation. Each engine independently records all 131 explicit documented operation/status pairs, with 136 total observations including five defaults across 38 report files. The MySQL 8.4 and 9.7 artifacts are `10602845269` and `10601901553`; both belong to the current source run. Both integration jobs pass 481 tests in 84 files, including the exact promoted fixture restoration.

## Nightly workflow history

GitHub's workflow history captured at **2026-09-20T10:00:54.408Z** contains 6 manual rehearsals and 1 scheduled execution. The table preserves each run's actual source and unfinished status.

| Run / source | Trigger and start | Workflow result | Extended property | Chaos | Mutation | Flake hunt | Full API |
|---|---|---|---|---|---|---|---|
| [35475597877](https://github.com/Mythikos/iridium/actions/runs/35475597877) / `6da1283` | Manual 2026-09-19 23:15:12 UTC | failure | 1 fail | 1 cancelled | 1 pass | 1 fail | 1 fail |
| [35488088005](https://github.com/Mythikos/iridium/actions/runs/35488088005) / `b663d81` | Manual 2026-09-20 04:01:52 UTC | in progress; failed jobs retained | 2 pass | 4 pass, 4 fail | 1 in_progress | 1 pass | 2 fail |
| [35492580406](https://github.com/Mythikos/iridium/actions/runs/35492580406) / `f8390f1` | Manual 2026-09-20 05:47:52 UTC | failure | 2 pass | 2 fail, 6 pass | 1 pass | 1 pass | 2 fail |
| [35495934601](https://github.com/Mythikos/iridium/actions/runs/35495934601) / `7176d39` | Manual 2026-09-20 07:05:24 UTC | failure | 2 pass | 8 pass | 1 pass | 1 pass | 2 fail |
| [35497703737](https://github.com/Mythikos/iridium/actions/runs/35497703737) / `46f2e8b` | Manual 2026-09-20 07:45:05 UTC | in progress; failed jobs retained | 1 in_progress, 1 pass | 2 in_progress, 6 pass | 1 pass | 1 fail | 2 fail |
| [35498879078](https://github.com/Mythikos/iridium/actions/runs/35498879078) / `46f2e8b` | Scheduled 2026-09-20 08:11:28 UTC | in progress; failed jobs retained | 2 in_progress | 4 pass, 4 in_progress | 1 pass | 1 pass | 2 fail |
| [35499345923](https://github.com/Mythikos/iridium/actions/runs/35499345923) / `abb968a` | Manual 2026-09-20 08:21:46 UTC | in progress; failed jobs retained | 1 in_progress, 1 pass | 4 in_progress, 4 pass | 1 pass | 1 pass | 2 fail |

The first run used one serial 8.4 chaos job and a combined 9.7 property/chaos/API job; the latter failed and did not establish the downstream results. Subsequent runs split both engines into independent property/API jobs and four complete chaos file shards. The first serial chaos job timed out at four hours. Earlier first- and fourth-shard failures and the fifth manual run's SQL-count flake remain recorded in [remote-ci.md](remote-ci.md). A successful later check does not change a failed run's result.

The following complete checks supply the due extended evidence. Both property jobs run 5,000 examples and at most 300 model commands, with 2,337 passing tests in 156 files per engine. All four chaos shards on each engine retain the full nightly budgets, including 200 kill iterations. The repaired flake hunt runs on the final implementation; the other reused checks have verified unchanged inputs.

| Nightly proof | Source | Check-run ID | Result |
|---|---|---|---|
| `property-long` | `7176d39` | [106038744887](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038744887) | Pass |
| `mysql-matrix-extended (property, 300)` | `7176d39` | [106038745152](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745152) | Pass |
| `chaos-extended (1)` | `7176d39` | [106038745020](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745020) | Pass |
| `mysql-matrix-extended (chaos-1, 1, 240)` | `7176d39` | [106038745151](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745151) | Pass |
| `chaos-extended (2)` | `7176d39` | [106038745066](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745066) | Pass |
| `mysql-matrix-extended (chaos-2, 2, 240)` | `7176d39` | [106038745089](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745089) | Pass |
| `chaos-extended (3)` | `7176d39` | [106038745108](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745108) | Pass |
| `mysql-matrix-extended (chaos-3, 3, 240)` | `7176d39` | [106038745090](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745090) | Pass |
| `chaos-extended (4)` | `7176d39` | [106038745101](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745101) | Pass |
| `mysql-matrix-extended (chaos-4, 4, 240)` | `7176d39` | [106038745098](https://github.com/Mythikos/iridium/actions/runs/35495934601/job/106038745098) | Pass |
| `flake-hunt` | `abb968a` | [106048203440](https://github.com/Mythikos/iridium/actions/runs/35499345923/job/106048203440) | Pass |
| `e2e-electron-full (ubuntu-latest)` | `abb968a` | [106048191374](https://github.com/Mythikos/iridium/actions/runs/35499345923/job/106048191374) | Pass |
| `e2e-electron-full (windows-latest)` | `abb968a` | [106048191692](https://github.com/Mythikos/iridium/actions/runs/35499345923/job/106048191692) | Pass |
| `e2e-electron-full (macos-latest)` | `abb968a` | [106048191312](https://github.com/Mythikos/iridium/actions/runs/35499345923/job/106048191312) | Pass |

All captured full Electron jobs pass on Linux, Windows and macOS. Future M3/M4/M8 jobs remain skipped at M1. The MySQL innovation override remains advisory and fails in the captured history. The first four manual Node 26 labels used pnpm's Node 24 pin and prove no Node 26 compatibility; the two corrected manual runs and scheduled run execute Node 26 and fail the six stderr assertions described below. No consecutive green scheduled-history claim is made. The specific M1 light-profile scope in D12-20 and advisory runtime/database dispositions remain distinct from the due nightly gates.

## Review findings and remote repairs

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
  fixture authentication after stateful account changes, transport-level 431 ProblemDetails,
  the outsider profile's one-hour completion bound, and the advisory MySQL innovation override.
  Their first nightly failures are recorded, not
  relabeled as passes. D12-20 makes the full administrator/outsider fuzz profiles separate from
  M1's required light gate. The final-source full API checks are `106048191335` / `106048191306` in run [35499345923](https://github.com/Mythikos/iridium/actions/runs/35499345923); their captured result remains visible in the history table. The scheduled run [35498879078](https://github.com/Mythikos/iridium/actions/runs/35498879078) also fails both full API checks (`106046908176` / `106046908363`): its 8.4 outsider profile completes 23,434 generated cases and reproduces the HTTP 431 content-type failure, while the 9.7 outsider profile reaches the one-hour deadline. Both administrator profiles reproduce signed-cursor validation and invalidated fixture authentication. Scheduled artifacts `10602646174` / `10603020664` retain those results. Corrected Node 26 checks `106043686560`, `106046908339` and `106048191301` fail the same six lifecycle stderr comparisons; they are advisory runtime-adoption evidence, not passing M1 checks.
- Deferred until Node 26 adoption (A4/D10-19): the corrected advisory runtime lane executes
  on Node 26.9.0 and reports six lifecycle-child stderr failures caused by its WebStorage
  ExperimentalWarning when no local-storage file is configured. Expected exit codes and
  signals match in all six cases; 2,729 other tests pass. The warning remains visible, and
  its originating accessor must be traced before adopting the new runtime. Historical jobs
  that pnpm redirected through Node 24 are not Node 26 compatibility evidence.
- Outstanding as directed: local macOS Electron, because there is no local macOS environment;
  and a fresh local `pnpm audit`, because registry egress approval remains unavailable. Remote
  macOS and remote audit success are separate evidence and do not close these local items.
- Known risks: the protocol's pre-release acknowledgement witness requires coordinated server
  and client deployment; collaboration remains one owner per database. Prior R-T10/R-T22 and
  spike sizing dispositions remain recorded in M0. This headless exit does not claim supported
  desktop UI acceptance, MCP completion, or the M8 operations/security review.

The earlier [M1 progress record](M1-progress.md) retains dated local evidence and failed wrappers;
these proofs retain their original inputs and do not close the pending correction.
