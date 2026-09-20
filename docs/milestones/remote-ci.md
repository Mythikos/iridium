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

## Report portability repair

Commit `66f3d631dccddb00c5c5d89de3ce4b8be0369bb9` starts
[CI 35478972790](https://github.com/Mythikos/iridium/actions/runs/35478972790). All three Electron
jobs pass, including Linux job `105993370422` with four actual tests and the enabled sandbox.
The preceding M1 rehearsal passes both integration jobs (`105991867028` on 8.4 and
`105991867027` on 9.7), each with 84 files, including the repaired capacity cleanup.

Replaying its actual Windows and Linux unit blobs exposes an additional reporting defect:
Vitest 5 retains absolute checkout paths and counts 294 source files twice (588 coverage entries).
The merge now verifies each blob's captured commit and SHA-256 and relocates a copy to the merge
runner's root. Raw artifacts, test results, reference indices and coverage counters are preserved.
The same downloaded inputs then produce 294 entries. Four regressions cover path forms, unchanged
results/counters, format and collision refusal, stale/tampered/missing origins and workflow wiring;
all 48 combined portability and acceptance-map checks pass, as do types and targeted lint.
This local artifact replay diagnoses and verifies report handling; it is not a substitute for the
complete remote merged coverage gate.

The completed rehearsal merge (`105996021630`) and main merge (`105997306931`) confirm the defect:
duplicated roots lower functions/branches below the gates, and Windows drive colons make the Linux
HTML report artifact invalid. Replaying all six rehearsal blobs after relocation gives 91.01%
statements, 91.98% lines, 85.79% branches and 91.58% functions; unchanged coverage thresholds pass.
The original failed chaos result remains in the raw artifacts and its required job stays failed.
Actual passing Electron blobs from main also reproduce Playwright's different-root rejection.
Passing the existing explicit Playwright config fixes that merge (12 passes); CI platform tags
distinguish the three executions, following [Playwright's merge guidance](https://playwright.dev/docs/test-sharding#merge-reports-cli).

The rehearsal's 8.4 chaos (`105991867057`) times out observing backpressure; 9.7 (`105991867133`)
passes. A constrained local replay also proves that WebSocket refusals can arrive before child
stdout. The oracle now observes queue loading separately, records each refusal on its actual event
even if the state was already `save-failed`, and retains the 5,001-update bound, 15 s delivery check,
two-second independent-writer limit, pending-edit recovery and 180 s overall deadline. One-core
8.4 with coverage and the 9.7 focused check pass. Failed intermediate observations are retained.

Main `35478972790` finishes with both integration engines and 9.7 chaos green; its 8.4 chaos
(`105993370481`) instead fails CH-6's 30 s recovery assertion after ownership loss. Readiness and
two clients recover; the third is still in the documented reconnect ladder. The explicit
[D10-33 amendment](../adr/d10-33-collaboration-owner-lease.md#outage-recovery-observation) reconciles
that ownership-loss case with the existing retry ceilings using 75 s, while retaining 30 s for an
intact owner. It changes that acceptance deadline, not the product retry policy, and keeps the
original documents, undo history, exact-once content and overall case deadline as assertions.
The focused real-outage cases pass on both MySQL 8.4 and 9.7 after that amendment. Full types,
targeted lint, formatting, Knip and acceptance-map generation checks also pass before the push.

## Complete workload results and artifact layout

Commit `42d15d3683c8d467c147ce5885f35f9ea625c903` runs
[CI 35480896583](https://github.com/Mythikos/iridium/actions/runs/35480896583). Static and all three
Electron jobs pass. The Linux and Windows unit artifacts each record 2,314 passes with no unhandled
errors. Integration jobs `105998579113` (8.4) and `105998579129` (9.7) each pass 479 tests in 84 files.
Chaos jobs `105998579101` (8.4) and `105998579149` (9.7) each pass 88 cases, with 42 explicitly
nightly-only cases skipped. These are actual Actions results, including both repaired chaos oracles.

Merge job `106002618060` passes the unchanged coverage thresholds: 91.04% statements, 92.01% lines,
85.82% branches and 91.55% functions. Playwright merges all 12 passing three-OS Electron cases.
The following OpenAPI coverage step fails because the integration artifact combines `reports/`
and `results/`: upload-artifact retains their common parent, so extraction into `reports/` produces
`reports/reports/openapi-coverage`. The checker correctly refuses that empty expected directory.
Each downloaded engine artifact independently proves all 131 documented operation/status pairs;
its authenticated light-fuzz profile also passes (3,361 generated cases on 8.4, 3,156 on 9.7).

Integration reports now use the same reports-relative root as static reports. MCP's separate
`results/` directory has its own artifact, preserving those files without changing the report root.
The workflow guard covers the upload/download layout. The failed merge remains preserved;
local inspection of its artifacts is not a replacement for the corrected remote merge.

The first nightly's extended 9.7 matrix (`105984200106`) finishes with four property failures and
2,310 passes. One repeats the already-fixed two-U+FEFF initializer defect (seed `-470708079`).
The remaining failures expose a fixture login bucket: the model's clock is fixed, and rotating
sessions after every 500 examples eventually exceeds ten logins from one IP. Its original 429 is
masked by later shrink attempts logging out an already-retired session (401). Each simulated
replacement browser now uses the existing auth fixture's independent peer address; product limits
and the property clock stay unchanged. A twelve-rotation regression fails with the original 429,
then passes on both engines; the complete logout file passes five cases per engine. Full types,
targeted lint and Knip pass. This repair still needs its remote follow-up; the first nightly is red.

## Owner license commits and ticket-clock isolation

Commit `c2207979033d5ac7654ccb68ff8565ce304d8ef8` starts
[CI 35482654693](https://github.com/Mythikos/iridium/actions/runs/35482654693). It passes static,
both unit jobs and all three Electron jobs, but the owner's license-decision commit `694c2b4`
supersedes it. Both integration and both chaos jobs are cancelled, not passing evidence.
[CI 35483346224](https://github.com/Mythikos/iridium/actions/runs/35483346224) has the same completed
passes and is superseded by `4b34cd2`, which adds the exact Elastic License 2.0 text. Its four
database jobs are cancelled, and the incomplete report merge fails. D01-15 settles the license
question independently of those cancelled runs.

The resulting [CI 35483701742](https://github.com/Mythikos/iridium/actions/runs/35483701742) passes
static (`106006189954`), both units and all three Electron runners. Static records 418 guards
passing and ten future skips; the registry audit has three moderate advisories and passes its
unchanged high-severity threshold. The 8.4 integration job `106006563850` passes. The 9.7 job
`106006563851` has 477 passes and three failures in the ticket suite, using sequence seed
`1789871205685`. Both chaos jobs (`106006563846` on 8.4 and `106006563888` on 9.7) pass;
report merge is still pending at this checkpoint.

The ticket TTL test calls `ManualClock.advance`, replaying a minute of readiness and session
delivery timers while mysql2 still uses real sockets. Its virtual acquisition deadlines fire
before socket callbacks run, poisoning the shared fixture's readiness for later shuffled tests.
The local replay reproduces those spurious acquisition errors, although its six tests pass in
that execution order. The test now uses the clock's existing `jump` operation to age the ticket
and prove `consume` rejects it at expiry without requiring a sweep. Real deadlines and product
readiness policy are unchanged. The original remote failure and local replay remain preserved.
Both corrected engine runs pass all six ticket cases at that seed, with coverage on 9.7 and no
acquisition-timeout or session-delivery error logs. Full types, targeted lint and 55 release guards pass.

The first nightly's 8.4 property job `105984200011` also finishes red: six failures and 2,308 passes.
Its failures repeat the fixed session-rotation fixture bucket problem (including seed
`-1762743971`, original path `4500`); later shrinking masks the original 429 as 401. The extended
chaos and full mutation jobs are still running. There is still no earlier scheduled history.

## Release identity and architecture preflight

The release preflight finds that `build-info` has a commit placeholder but the bundler never
defines it. Docker now passes the tagged SHA through `SOURCE_COMMIT`, the server build includes
that value in its Turbo cache key, and tsdown embeds it. Release image hygiene checks the actual
CLI JSON against `GITHUB_SHA`; the OCI revision label carries the same value. Two host builds
with distinct synthetic commits prove that the build cache invalidates, and a runtime environment
override cannot rewrite an already-built identity. Full types and the release guards pass.

The first local ARM64 attempt fails before package execution because the default Docker builder
has no ARM emulator. A separate builder with BuildKit's bundled emulator resolves that local
runner gap. Inspection also proves a real image-recipe defect: Oracle's Debian repository declares
only `i386 amd64`, so its ARM64 package index is absent. The dated [OPS-04 amendment](../adr/ops-04-mysql-client-packaging.md)
replaces that source with Oracle's signed `mysql-community-client-9.7.2-1.el9` RPM on both
architectures. Each exact package is pinned by SHA-256, its signing key fingerprint is checked,
and a signature is mandatory. A diagnostic confirms that plain `rpmkeys --checksig` accepts an
unsigned digest-only package; the recipe additionally requires the signed result and pinned bytes.
Only `mysql`, `mysqldump` and `mysqlbinlog` enter the Debian runtime with its compatible libraries.

Both AMD64 and ARM64 images build and execute all three client binaries plus the deployed server's
version command in the final runtime base. Each reports MySQL 9.7.2 and the embedded synthetic
commit `1111111111111111111111111111111111111111`; these are preflight builds, not release artifacts.
The shipped-client dump/restore file passes both cases on each supported database engine using
unchanged image identity `sha256:2bf62963b1a4556e62359abda3e3eb5e86b2f1f8fd26757268fef56a3cdb3cc4`.
The first local attempts supplied an image identifier that Testcontainers treated as a registry
name and failed to pull; the corrected tag-based invocations preserve and compare the image identity
before and after. Both failed attempts remain in `reports/remote-ci/` with their passing follow-ups.


## First complete green main run and M0 closure

[CI 35485518914](https://github.com/Mythikos/iridium/actions/runs/35485518914) completes successfully on 2026-09-20 UTC at
`efa6de83b0cb5b28bc069cc32544787a89471f74`. These are actual check-run IDs, verified through the checks API.

| Required check | Check-run ID | Result |
|---|---|---|
| `static` | [106011045588](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011045588) | Pass |
| `chaos-core (mysql:9.7.2-oraclelinux9)` | [106011279877](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279877) | Pass |
| `chaos-core (mysql:8.4.11)` | [106011279878](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279878) | Pass |
| `integration (mysql:9.7.2-oraclelinux9)` | [106011279895](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279895) | Pass |
| `integration (mysql:8.4.11)` | [106011279897](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279897) | Pass |
| `unit (ubuntu-latest)` | [106011279899](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279899) | Pass |
| `e2e-electron (macos-latest)` | [106011279900](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279900) | Pass |
| `mutation-scoped` | [106011279907](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279907) | Pass; scope detection only, Stryker not due for this push |
| `e2e-electron (windows-latest)` | [106011279943](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279943) | Pass |
| `unit (windows-latest)` | [106011279963](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279963) | Pass |
| `e2e-electron (ubuntu-latest)` | [106011279966](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106011279966) | Pass |
| `merge-reports` | [106015500694](https://github.com/Mythikos/iridium/actions/runs/35485518914/job/106015500694) | Pass |

Both integration lanes pass 480 tests in 84 files. Both unit lanes pass 2,314 tests in 152 files.
Each chaos lane passes 88 cases in 14 files, with 42 later/nightly cases skipped by the declared
CI scope. The six raw Vitest artifacts have verified origin hashes and zero unhandled errors;
all 73 grouped M0/M1 named proofs are present. The merged report records 5,764 passes and 84 skips.
Coverage is 91.03% statements, 92.00% lines, 85.84% branches and 91.52% functions; the unchanged
global and per-file gates pass. Electron contributes twelve passing cases across the three OSes.
Static and the final guard check each pass 420 cases with ten future-milestone skips.

Each engine's API artifact independently covers all 131 explicit operation/status pairs
(136 observations including five default responses). The required authenticated light fuzz
passes 3,427 generated cases on 8.4 and 3,299 on 9.7, with 1,244/1,071 generated cases skipped
and three warnings per profile. Both authentication proofs report `authenticationFailed: false`.
Web E2E is explicitly skipped until M4. The two separate full mutation jobs are still running;
this push's successful scope detector is not a mutation score.

The previous `35483701742` report merge eventually passes as job `106010742479`, but that
run remains failed because its 9.7 integration lane failed. A merged report cannot override a
failed required job. This new complete green run supplies the remote prerequisite for
[M0's formal closure](M0-exit.md), before consuming the M1 changeset.

The first nightly `35475597877` still has mutation in progress at this checkpoint. Its extended
chaos job `105984200183` is cancelled at 03:15 UTC with the explicit annotation that it exceeded
the four-hour maximum. The retained logs show one failed second-process handover iteration
(index 10 of 20), 150 passing revocation cases including the 200-connection campaign, and other
completed files; there is no final aggregate and no evidence for the interrupted remainder.
Artifact `10597510856` is partial. The complete timeout log remains preserved. No scheduled
run has appeared as of this closure, so established green nightly health is not claimed.
The next M1 implementation prepares a full-budget shard repair and retains this failed run.

## M0 marker, M1 version preparation and release scan

M0's record commit is `3da2ab24fa42ff14353a10dd6943058a4c697667`; the annotated `v0.0.0`
marker is pushed at that commit. [Release 35487366236](https://github.com/Mythikos/iridium/actions/runs/35487366236)
passes its selector (`106016104310`) and skips verify, server-image, bridge, desktop,
release-feed and drill. It publishes nothing, as required. The M1 changeset is then consumed
by Changesets 3.0.2: all 20 fixed workspaces and the root become `0.1.0`; the per-workspace
changelogs are committed directly, with no version-PR job. CURRENT stays M0 until the M1 record.
M1's manual CI dispatch bypasses incremental-cache restoration for its full mutation job,
implementing the existing fresh-campaign requirement; ordinary changed-scope pushes retain caching.

The nightly repair follows [D10-25](../adr/d10-25-nightly-chaos-budget.md): four complete chaos
file shards per engine, unchanged scenarios/iterations/deadlines, and separate property/fuzz
members on 9.7. The current 14-file inventory partitions exactly once into groups of 4/4/3/3.
Vitest's installed sequencer verifies that selection; this is not a passing nightly execution.
All 420 current guards pass with ten future skips. Manual rehearsals retain separate captured
commits while scheduled runs remain serialized, preserving the first run's ongoing mutation job.

The release preflight uses Grype 0.119.0 with the September 19 database and the unchanged
`--only-fixed --fail-on high` gate. Its first Windows invocation fails while creating a layer
cache filename containing a colon. The preserved Linux-container follow-up scans the same local
image and finds eight high matches: npm's bundled brace-expansion, tar and ip-address; the
base's libpcre2; and a MySQL binary-string identification truncated to `9.7` instead of `9.7.2`.
Runtime assembly now applies Debian package updates and removes unused npm/Corepack/Yarn.
The verified MySQL client RPM's exact version/file ownership and license/README are retained
without executing RPM scripts or shipping the RPM tool. Syft's package ownership precedence
uses that authoritative metadata; no CVE exclusion or severity change is introduced.

The corrected AMD64 preflight scan exits zero with no fixable matches. Syft 1.52.0 catalogs
363 packages, including `mysql-community-client 9.7.2-1.el9` and `libpcre2-8-0 10.42-1+deb12u1`,
and no npm installation. Both the failed scan and corrected JSON/SBOM are retained under
`reports/remote-ci/release-amd64-*`. These local synthetic-commit images are preparation;
the tagged release still needs its own Actions scan, SBOM and provenance.

The first local frozen offline install after versioning fails replacing a Windows dependency
junction, after removing its package-managed Node copy. The failed attempt is preserved.
A checksum-verified official Node 24.21.0 archive restores the local bootstrap tool; the next
install uses the existing offline package store and the unchanged frozen lockfile. This does
not perform or substitute for the explicitly outstanding local registry audit.

The successful offline retry reuses all 1,145 packages with zero downloads. The versioned tree
passes all 27 build/type tasks, generated-artifact checks (the local database generation phase
is explicitly skipped; both remote integration engines own schema parity), formatting, Knip,
and 420 guards with ten future skips. The corrected ARM64 image also builds and executes all
three MySQL tools and the `0.1.0` server CLI with the synthetic preflight source identity.
Both architecture builds and the local scan are preparation for the versioned remote runs.

## Versioned rehearsal: frozen credential-flood clock

The versioned `b663d81` tree starts [main CI 35488087214](https://github.com/Mythikos/iridium/actions/runs/35488087214),
[M1 rehearsal 35488086906](https://github.com/Mythikos/iridium/actions/runs/35488086906), and
[nightly rehearsal 35488088005](https://github.com/Mythikos/iridium/actions/runs/35488088005).
The two CI runs pass static, both unit jobs and all three Electron jobs. Both 9.7 integration
jobs pass, including 480 tests in the main run (`106018453010`). Both 8.4 integration jobs
fail (`106018452991`, `106018242143`): 479 tests pass and the credential-flood case fails its
final `/readyz` assertion. The fixture upload is skipped in the failed rehearsal; no fixture
from that job is promoted. The full mutation and remaining chaos jobs are still running at
this checkpoint, so neither CI run is described as successful.

The flood intentionally freezes its injected clock while attributing all 10,000 real malformed
bearer requests to exactly zero SQL/native-password work. On the slower runner the flood lasts
over 30 seconds, so its final readiness probe compares stale fixture time with live MySQL time
and correctly returns 503 for clock skew. The regression deliberately starts that frozen clock
31 seconds behind. The first diagnostic hits the resulting negative-uptime schema check; the
preserved follow-up probes readiness first and confirms `clock_skew: fail` at 38,804 ms with
every other check healthy or the expected access-log warning.

After query/native-work accounting finishes, both flood cases now jump the fixture clock back
to wall time without firing scheduled work, then check readiness with the full response in any
failure message. No product threshold, request count, concurrency, or SQL/native-work assertion
changes. Both cases pass on each required engine in the local correction run. Logs are retained
as `credential-flood-clock-before*` and `credential-flood-clock-after-{84,97}.log`.

The corrected ARM64 preflight scan also passes with zero fixable matches under the unchanged
Grype gate, using the same September 19 database as AMD64. Its image identity is
`sha256:3cc740e2f00dd64efe08685161f963fe3642b08842cdfdc2345215257448b6bd`.
The committed-source AMD64 validation image reports version `0.1.0`, commit `b663d81`, and
schema head `0055_min_client_version`; its identity is
`sha256:dab7a62adc42a2a387b70ad2bada0d793f4c768877bc3133e2f22ca72bfccd86`.
These remain local preflights, not published release evidence.

The second nightly passes Node 26 (`106018032696`: 2,724 tests in 226 files) and the third chaos
shard on each engine (`106018032708`, `106018032668`: twelve cases each). Its first chaos shards
fail (`106018032671`, `106018032704`): CH-16 encounters Fastify's default onReady timeout under
injected database latency, and 9.7 also exceeds the blackhole outage readiness-response deadline.
Each first shard reports 65 passes and two failures. The innovation advisory repeats its fixture
override/version-floor failure (`106018032681`). Other long-running jobs remain pending.
These failures are preserved for diagnosis, not counted as green health. There are still only
two manual nightly runs and no observed scheduled run.

The M0 record's own push CI `35487362872` was superseded by the versioning push: its completed
static, unit and Electron jobs pass, its four database jobs are cancelled, and its merge fails
on incomplete inputs. M0's formal source proof remains complete successful `35485518914`, and
its marker release remains successful `35487366236`; the superseded record run is not substituted
for either proof.

## Completed first remote mutation campaign

The first nightly's full mutation job
[105984200123](https://github.com/Mythikos/iridium/actions/runs/35475597877/job/105984200123)
finishes successfully at 04:44 UTC on September 20, after 328 min 31 s of Stryker execution.
It checks `6da12835fdaa1ccd41d4cbcf2bb74d9847d47fb9`, an earlier tree, and scores
**74.92810927390366%** against the unchanged 70 threshold. Both the Actions cache miss and
Stryker's explicit absent incremental-result file establish a fresh full campaign. It instruments
87 source files and 10,612 mutants; its initial dry run passes 2,034 tests.

The official report metrics reconcile 3,845 killed, 324 timed out, 1,231 survived, 164 uncovered,
4,526 compile errors, 521 ignored and one runtime error, with zero pending results. Every one
of the report's 85 source contents matches its checked-out commit. Standard scoring uses
4,169 detected out of 5,564 valid mutants. Mutant 1091 in `auth/credentials/throttle.ts`
(`tableCreated: true` to `false`) hits the previously recorded Vitest/Stryker opaque-error
formatting failure after two worker restart attempts. It is excluded, not killed; conservatively
counting it as undetected still exceeds 74.9%.

Artifact `10599175688` (`nightly-mutation`) has digest
`sha256:8b2db02a2e8e418c70e696e95d5777db49bd85b3b36079db588a499823787e1a`.
The extracted report SHA-256 is
`a0588883a35353d71174fe3154b91c262b1be2b22762214801d4a55221630717`.
The log, report, output cache and source/metric reconciliation are retained under
`reports/remote-ci/35475597877-mutation*`. This is actual remote full-scope evidence for
`6da1283`; later NoteSession, content and readiness changes are not certified by that score.
The nightly run as a whole remains failed.

The second nightly's flake hunt also finishes successfully:
[106018054926](https://github.com/Mythikos/iridium/actions/runs/35488088005/job/106018054926)
passes 410 tests in 74 files on each of three independent repetitions, taking
709.17 / 662.93 / 672.33 seconds. Its artifact is `10597439572` (`nightly-flake-hunt`);
the complete log is retained. This proves that lane at `b663d81`, not a green nightly overall.

## Readiness lifecycle correction

The second nightly's first chaos shards fail on both required engines, as recorded above.
A local unmodified reproduction of CH-16 iteration 10 on 8.4 fails with the same Fastify
onReady timeout; `second-owner-startup-before-84.log` preserves that failure. The new concurrency
regressions initially fail twice because three callers start three scans and receive different
results (`readiness-single-flight-before.log`).

[ARCH-02](../adr/arch-02-readiness-probe-lifecycle.md) now makes concurrent HTTP, periodic and
boot probes share one complete serial scan, released on completion so recovery performs fresh
checks. Drain remains irreversible. The explicit Fastify plugin/onReady limit is 60 seconds
in every mode, matching the existing child startup handshake; CH-16's latency, twenty nightly
iterations and 180-second case deadline are unchanged. This corrects the runtime lifecycle
exposed by the real runner failures.

The focused readiness/shutdown unit check passes all seven cases; the complete unit project
passes 2,317 tests in 153 files. Build, TypeScript, focused type-aware lint and all 420 guards
pass (ten future guard cases remain skipped). All nine generated artifacts reproduce with
the local database generation phase explicitly skipped.

The complete two-file targeted chaos check uses the unchanged nightly budget
`IRIDIUM_CHAOS_ITERATIONS=200`, selecting all twenty CH-16 iterations and all four database-outage
modes without a title filter or retry. MySQL 8.4 passes all 24 cases in 923.47 seconds; MySQL 9.7
passes all 24 in 909.32 seconds. Both run the real child process and retain the acknowledged
content/owner-fencing assertions. Logs are `readiness-nightly-after-{84,97}.log`. These are
targeted local regressions, not a full nightly or a substitute for the blocked Actions run.

The subsequent complete readiness HTTP and shutdown-drain files pass all 23 cases on each
engine (25.13 / 25.76 seconds). They retain the real pending-migration 503-to-200 transition,
unreachable-database behavior, complete check schema, admission fence and durable drain.
Logs are `readiness-http-after-{84,97}.log`. All local runtime checks use the same built repair;
the build is not replaced between child-process restarts.

## Actions billing refusal

At 04:40 UTC, [CI 35489747824](https://github.com/Mythikos/iridium/actions/runs/35489747824)
for `0118ef24579f0dbeeafa70af20a7ffaffe035c1c` fails before starting a runner. Its static
check `106022532161` and merge check `106022535840` have no executed steps. GitHub's annotation
reports failed account payments or an Actions spending limit and directs the owner to
Billing & plans. The earlier rehearsal's merge `106022287270` and main merge `106022337916`
receive the same refusal after both of their chaos jobs pass. Their 8.4 integration failures
remain independently recorded; billing does not explain those earlier test failures.

The annotations are preserved as `35489747824-static-annotations.json`,
`35488086906-merge-annotations.json` and `35488087214-merge-annotations.json`. Their missing
job logs are consistent with jobs never starting, not a passing or empty workload. Jobs that
already obtained runners continue independently. The owner has been asked to resolve the
account payment/spending setting; no financial setting, repository visibility or CI gate is
changed to bypass it. Until new runners can start, the repaired tree cannot obtain its required
remote matrix, fixture-production artifact or final exit evidence. `CURRENT` remains M0 and
`v0.1.0` is not cut.

The verified readiness repair is committed and pushed as
`2a643a26aecfffa2cf4af0847cb979580897dde8`. Its
[CI 35490708111](https://github.com/Mythikos/iridium/actions/runs/35490708111) is refused in
the same way: static `106025020502` and merge `106025024018` fail before a runner starts,
with the same billing annotation; all dependent jobs skip. Its run/check metadata and
`35490708111-static-annotations.json` are preserved. This following documentation commit
records that existing implementation identity without claiming a successful remote repair.

At the billing checkpoint, M0 is formally closed and the version-PR job is removed; the
changeset has been consumed. Remaining M1 work is: regain a complete green run for the repaired
tree, finish and reconcile its full mutation evidence, produce/promote the successful versioned
Actions fixture and verify both restores, then land the implementation/exit-record sequence
and tag `v0.1.0` on the record commit. The tagged release still needs its own matrix, published
image identity, architecture scans, SBOM and provenance. Already-started remote campaigns
remain running and retain their own commits; they are neither cancelled nor counted as green.

## Public repository: runners resume

The owner changes the repository to public on September 20. At 05:47 UTC,
[M1 rehearsal 35492579410](https://github.com/Mythikos/iridium/actions/runs/35492579410)
and [nightly 35492580406](https://github.com/Mythikos/iridium/actions/runs/35492580406)
start actual runners on `f8390f1a3ef577a3d58672dfb77234ca978c86c2`; this resolves the runner
allocation blocker. The failed private-repository runs remain intact.

The rehearsal's static check `106029937072` passes its build, all 420 guards (ten future skips),
types, lint, formatting and generation, then fails `check-test-name-references`: the readiness
ADR references the new `ops.readiness.unit` suite, but its inventory row was omitted from
`10-testing-and-quality.md`. The repair adds its M1 row with the actual path and `[area:ops]`
tag and regenerates `docs/acceptance-map.json` to 466 keys. No test or gate is removed.
`35492579410-static.log` preserves the failed check; dependent workload jobs skip and merge
`106030046310` fails on missing inputs, so this rehearsal is not green evidence.

The plan overview and M1 progress summary now reflect M0's formal closure and the resumed
runner availability. The new nightly remains an execution against its original captured tree,
independent of this documentation/inventory correction.

The local name-reference check now resolves all 466 inventory keys, and all 420 guards pass
with ten future skips. The first commit attempt then exposes an independent hook gap: when
the only formatter-matching staged file is the intentionally ignored generated acceptance map,
oxfmt exits 2 because no target remains. The staged formatter now uses its documented
`--no-error-on-unmatched-pattern` option, as recommended for
[pre-commit hooks](https://oxc.rs/docs/guide/usage/formatter/ci#pre-commit-hook). Existing ignore
rules and the repository-wide CI format check stay intact. Before/after executions of the same
ignored path return 2 and 0 respectively; both logs are retained as `public-resume-format-hook-*`.

The corrected tree `bb8a96425593a6099c2c0f6061eb795f6fe2f528` starts
[main CI 35492818679](https://github.com/Mythikos/iridium/actions/runs/35492818679) and
[M1 rehearsal 35492818517](https://github.com/Mythikos/iridium/actions/runs/35492818517).
Both static checks pass, followed by both unit and all three Electron jobs. The rehearsal's
9.7 integration check `106030678981` passes 480 tests in 84 files in 469.16 seconds.
The remaining matrix jobs and full mutation are still running at this checkpoint.

The third nightly passes all three Electron jobs, Node 26 `106029939091` (2,727 tests in
227 files), and its third chaos shard on both engines (`106029939117` / `106029939134`,
twelve cases each). The innovation advisory `106029939076` repeats the known fixture
override/version-floor failure: 93 failures, 27 passes and 290 skips. D10-42 explicitly makes
that early-warning job non-blocking; its failure is retained, not reported as engine support.
The second nightly's second shards also finish: `106018032677` / `106018032784` each pass
171 cases in four files, taking 6,992.02 / 7,068.96 seconds. These are results for `b663d81`.

## Release platform evidence

Pre-tag workflow review finds that the release builds a two-platform image index while its
standalone Syft/Grype scans implicitly select the runner's native architecture. The corrected
workflow explicitly scans AMD64 and ARM64 at the same immutable registry digest, with separate
CycloneDX and vulnerability report names. Both retain the high-severity, fix-available gate.
The version/commit and shipped-client hygiene commands also execute on both platforms, and
artifact upload retains any partial evidence if a later release step fails.

The dated [OPS-04 amendment](../adr/ops-04-mysql-client-packaging.md) records this correction.
All 63 release-policy guard cases pass, including eight adversarial variants for a missing
platform, colliding SBOM artifact, tool drift, weaker cutoff, disabled scan or missing ARM64 execution;
TypeScript, focused type-aware lint and all 466 documentation references pass. This is workflow
validation before the tag; the actual tagged scans and image identities still need Actions.

The pinned SBOM action bundles Syft 1.51.1, while the completed image preflight used 1.52.0.
Explicit action inputs now select Syft 1.52.0 and Grype 0.119.0, matching the preflight tools.
Both exact local scanner binaries confirm `platform: linux/arm64` from the environment setting;
this configuration check is separate from the actual tagged scans still due.

## Actions-produced M1 upgrade fixture

The M1 rehearsal's 8.4 producer `106030679007` passes all 480 tests in 84 files and uploads
artifact `10600305875` (`upgrade-fixture-v0.1.0`), digest
`sha256:2e62ce27f9dd91fcf786c0729a4c9d8e05715fb04bdfb9769b90d74149ee968b`.
It generates the fixture at `2026-09-20T05:59:16.536Z` from `bb8a96425593a6099c2c0f6061eb795f6fe2f528`.
The downloaded manifest, producing job's successful conclusion and timestamp, captured commit,
55 migrations, seed counts, unchanged public fixture keys, empty attachment inventory and exact
dump hash/length all validate before promotion. No bytes in the artifact are rewritten.

The promoted dump is 19,104 bytes, SHA-256
`dca322b05696e45cbb3fde7b7495ff78a81a959ab9bd3b0f535576db298de47e`;
manifest SHA-256 is `52cf4f181850d5015fd9f7fe56a357f7edd8f91b059eea0746ba49d667263286`.
The report `35492818517-fixture-promotion.json` records promotion at 06:11 UTC. Both required
Actions integration engines pass on the producing tree. Separate checks of the newly promoted
fixture follow; the old fixture and failed earlier producers retain their original evidence.

The complete grants/fixture file subsequently passes both cases on each local engine, with
fixture writing explicitly disabled: 62.79 seconds on 8.4 and 60.83 seconds on 9.7. The dump
hash is unchanged afterward. These checks use `iridium-server:m1-fixture-validation`, image
`sha256:6d32cf371a2bf64846637de3e43f2d5f9a6ac9178c29fea3b061245cf7a9bf67`, reporting version
`0.1.0`, commit `f8390f1a3ef577a3d58672dfb77234ca978c86c2` and schema head
`0055_min_client_version`. Product sources, migrations, packages, Docker recipe, mutation inputs
and dependency manifests are byte-identical between that image source and the producing
`bb8a964` tree; its later delta is the documented inventory/hook correction. This identifies
the actual local restore inputs without claiming that an older image embeds the later commit.
Logs are `public-fixture-restored-{84,97}.log`; the final committed fixture is also subject to
both required Actions integration lanes before M1 exit.

Further completed nightly evidence: the second run's 8.4 property job `106018032553` passes
2,327 tests in 155 files at the full 5,000-run / 300-command budgets, taking 7,450.37 seconds.
The third run's flake hunt `106029956106` passes all 410 integration tests in each of three
repetitions (360.53 / 340.28 / 352.78 seconds). Other pending jobs still carry no inferred result.

The second run's 9.7 property job `106018032626` also passes: 2,327 tests in 155 files,
8,344.19 seconds, at the full budgets. The third nightly's first chaos shards now pass on both
engines (`106029939115` / `106029939112`, 67 cases in four files each, 1,666.85 / 1,602.80
seconds). These are the completed remote checks of the readiness lifecycle correction,
including CH-16 and database blackhole recovery. Their logs are preserved alongside the
earlier failed first shards.

## Further completed failures

The older rehearsal `35478419591` reaches GitHub's six-hour maximum on mutation job
`105991867100`. Its annotation and complete log are retained as `35478419591-mutation-*`.
The last progress line reports 8,829 of 10,086 non-ignored mutants tested; no terminal mutation
report or passing score is inferred. The current public-runner full campaign remains separate.

The second nightly's fourth chaos shards `106018032722` / `106018032782` finish with 397
failures and 298 passes in three files, taking 5,177.53 / 5,805.29 seconds. All failures occur
in the durable-ack file: the observed acknowledgement sequence equals the pre-edit committed
head. The first two-method local reproduction, at the unchanged nightly latency budget,
fails both cases with `expected 2 to be greater than 2` (`durable-ack-nightly-before-84.log`).
The observer previously accepted the next arriving frame, which may be a delayed prefix or
baseline acknowledgement. It now asks the existing testkit API for `seq >= before.head + 1`,
matching the crash trigger and the assertion. The held-COMMIT case uses the same explicit floor.
No acknowledgement is fabricated, and the state-vector, committed-row, fresh-client recovery,
exact-once, crash methods, latency and iteration requirements remain intact. Validation of the
repair is recorded separately from those failed runs.

The second nightly's full API jobs `106018032655` / `106018032793` also fail. Their logs and
artifacts (`10598712899` / `10598957330`) preserve the signed-cursor generation and isolated
administrator authentication failures. These remain the explicit D12-20 full-profile follow-ups;
neither job establishes full-profile coverage.

## Resumed main is green

[Main CI 35492818679](https://github.com/Mythikos/iridium/actions/runs/35492818679) completes
successfully on `bb8a96425593a6099c2c0f6061eb795f6fe2f528`. GitHub's check-runs API confirms
the following twelve successful required checks on that commit:

| Check | Check-run ID |
|---|---|
| static | `106030558210` |
| unit, Linux / Windows | `106030668215` / `106030668152` |
| integration, MySQL 8.4 / 9.7 | `106030668206` / `106030668149` |
| chaos-core, MySQL 8.4 / 9.7 | `106030668122` / `106030668134` |
| Electron, Linux / Windows / macOS | `106030668144` / `106030668250` / `106030668374` |
| mutation-scoped | `106030668147` |
| merge-reports | `106034425458` |

Each integration engine passes 480 tests in 84 files. Each required chaos engine passes 88
tests with 42 documented future/nightly skips; no due durability case is skipped. The merge
reconciles 5,770 passes and 84 skips across the six Vitest lanes and passes the unchanged
global/per-file coverage gates: 91.03% statements, 92% lines, 85.84% branches, 91.53% functions.
All 420 guards pass, with ten future skips. Artifact `10600437007` contains the merged reports;
check metadata, artifact digests and logs are retained under `reports/remote-ci/35492818679*`.

The mutation-scoped check on this documentation/hook push correctly reports no changed target;
its success is not a mutation score. The separate fresh full-scope M1 rehearsal still has to
finish. This complete green main run unblocks the final implementation landing; the promoted
fixture, durable-ack observation repair and release platform checks require their own subsequent
main run before the exit record names that implementation commit.

## Targeted acknowledgement fault

Requiring a newer acknowledgement alone exposes the second half of the nightly race:
`durable-ack-nightly-after-{84,97}.log` record five / four failures out of fourteen selected
cases. The unqualified synchronous fault still consumes a repeated baseline before the new
edit commits. Kernel-signal and held-COMMIT cases pass. No test timeout is raised to mask this.

The [D10-6 amendment](../adr/d10-6-targeted-ack-faults.md) adds an optional runtime-only
note/sequence selector to the two existing post-ack wire faults. The one registry validates
the target and keeps the point armed across older baselines and unrelated notes; the socket
supplies the actual decoded outbound frame before the synchronous kill. Unqualified faults
retain their behavior. This preserves the client's five-second baseline probe and both real
crash mechanisms. The test's wait and its fault now name the same post-baseline revision.

Three new unit regressions fail before the selector exists and pass afterward. Type checking
then catches the collaboration plugin's forwarding adapter; two intermediate local runs are
stopped when that missing adapter is found, with their partial logs preserved and no result
claimed. The completed control-route file passes ten cases on each engine (48.10 / 49.30
seconds), including invalid-target refusals and production/development namespace absence.
All 428 guards pass with ten future skips. Final crash/recovery results follow separately.

The third nightly's mutation job `106029938957` finishes successfully in 46 minutes 46 seconds:
74.71223021582733%, 4,154 detected out of 5,560 valid mutants. It instruments 87 files / 10,607
mutants and reuses 9,280 prior results; the 2,047-test dry run and completed report remain
distinct from the fresh full-scope campaign. Its 85 reported source contents match `f8390f1`,
with zero pending mutants. Counts are 3,849 killed, 305 timeouts, 1,242 survivors, 164 uncovered,
4,525 compile errors, 521 ignored and one runtime error; the runtime error is excluded, not
called killed. Artifact `10599743441` and report hash
`3e44ce4d3042836b971a00a871ded09f68e1d66b34c1dc5839cc16ccf0d0ec14` are retained under
`reports/remote-ci/35492580406-mutation*`.

The complete unit project then passes 2,323 cases in 153 files. Naming the two existing fault
unit suites in the new ADR reveals missing inventory rows; both rows are added and the generated
acceptance map now resolves all 468 names. The maximum-latency diagnostic (iteration 27,
1,997 ms plus jitter per SQL packet) records an old committed head, live server, no fired
fault and no persistence error when the original 30-second observation expires. The nightly
acknowledgement observation becomes 90 seconds inside the existing 180-second case deadline;
normal CI remains 30 seconds. This explicit D10-6 amendment does not change product deadlines.
The failed 30-second observations remain in `durable-ack-wire-after-*` and
`durable-ack-max-latency-*`; the repaired targeted result is recorded only after completion.

At 06:52 UTC, the workflow history API still lists exactly three nightly runs, all manual
rehearsals. No scheduled nightly has completed or started. The third run's full API jobs
`106029939104` / `106029939171` repeat the carried full-profile failures; artifacts
`10599823933` / `10599914198` retain the evidence. The D12-20 scope disposition remains explicit.

Final targeted nightly validation passes all sixteen selected cases on both engines: 334.30
seconds on 8.4 and 275.67 seconds on 9.7 (`durable-ack-final-nightly-{84,97}.log`). Selection
covers both crash mechanisms, each prefix length, the maximum injected latency at iteration 27,
and both 3,000 ms / 50 ms held-COMMIT observations. The slowest 8.4 maximum-latency case takes
81.383 seconds end to end and recovers the real acknowledged revision. These are targeted local
checks, not the complete 680-case nightly file or remote evidence for the repair.

Review also finds that rearming `ws.drop-after-ack` deletes a bare point name although its
consumed keys include socket IDs. The registry now resets that point's actual socket keys;
the new rearm regression fails before and passes after the fix. All 39 focused fault tests and
the complete 2,324-test unit project pass. Build, full types, focused type-aware lint, formatting,
all 428 guards and all 468 name references pass. All nine generated artifacts reproduce with
`pnpm gen --skip-db`; the earlier command's incorrectly named skip variable and consequent
unavailable-container failure remain in `durable-ack-final-generation.log`.

The following repaired-tree Actions rehearsal must regenerate its own fixture and mutation
evidence before the final fixture promotion and implementation/exit-record landing. The earlier
`bb8a964` fixture and green run remain identified above and are not relabeled as this later tree.

## Repaired-tree remote evidence, 2026-09-20

Commit `7176d392232aa8f79f9f4cec47c4d9df9635085a` starts
[main CI 35495933424](https://github.com/Mythikos/iridium/actions/runs/35495933424),
[M1 rehearsal 35495933501](https://github.com/Mythikos/iridium/actions/runs/35495933501),
and [nightly 35495934601](https://github.com/Mythikos/iridium/actions/runs/35495934601).
The main static check `106038739513` passes all 428 guards, with ten later-milestone skips,
and all 468 acceptance-map references. Its remote registry audit passes the high-severity
gate with three moderate findings; this is not a claim of zero vulnerabilities or a local audit.
Main's scoped mutation job `106038921941` reports no changed mutation-source path and does no
mutation work. The independent full-scope nightly below supplies the actual score.

Nightly mutation check `106038745003` passes at **74.71223021582733%**, above M1's unchanged
70% gate: 4,154 detected of 5,560 valid mutants, comprising 3,849 kills, 305 timeouts,
1,242 survivors and 164 uncovered. The full report has 10,607 mutants, 4,525 compile errors,
521 ignored, one runtime error and zero pending. Invalid mutants are excluded, not counted as
kills. All 85 reported source contents match `7176d39`. Stryker instruments 87 files, passes a
fresh 2,086-test baseline and reuses 10,060 results from the successful `f8390f1` incremental
cache. This is the full-scope incremental lane specified in the milestone plan, not a fresh
mutation campaign. The separate M1 rehearsal's fresh campaign remains separately identified.
Artifact `10601185309` has digest
`sha256:e24bb3e2169b70f97e68d550757dd42f00f8197f14c2d401248293296db25718`;
the JSON report SHA-256 is `c857a08f5f35be13652e4e0055f37412266446ae01b03a06979da0938abf223e`.

The fourth nightly's third chaos shards pass all twelve cases on both engines
(`106038745108` / `106038745090`, 180.92 / 172.14 seconds). Node 26 check `106038745063`
passes 2,735 tests in 227 files. All three full Electron jobs pass. Advisory innovation check
`106038745034` still fails, with 93 failures, 27 passes and 291 skipped cases; its artifact is
`10600955124`. None of these results stands in for the still-running extended property and
other chaos shards. The 07:14 UTC history capture lists four manual nightly rehearsals and
no scheduled runs; established green nightly history is not claimed.

The third nightly's pre-D10-6 fourth shards fail on both engines: MySQL 8.4 check
`106029939138` has 399 failures and 296 passes in 5,427.69 seconds; MySQL 9.7 check
`106029939105` has 396 failures and 299 passes in 5,230.75 seconds. Both logs remain under
`35492580406-chaos-4-{84,97}.log`. These are results of the older `f8390f1` tree, not the
repaired `7176d39` campaign.

Main CI's integration checks `106038921897` / `106038921960` pass 481 tests in 84 files on
each engine, in 736.03 / 620.22 seconds. Unit checks `106038921878` / `106038921887` pass
2,324 tests in 153 files on Linux and Windows. The complete main result still depends on its
required chaos and report-merging checks at this checkpoint.

The fourth nightly's flake check `106038761059` passes all three consecutive 411-test,
74-file integration runs (375.80 / 369.50 / 361.53 seconds). Artifact `10600990914` retains
its accumulated reports.
Its first chaos shards also pass all 67 cases in four files on both engines
(`106038745020` / `106038745151`, 1,691.38 / 1,544.48 seconds), reproducing the ARCH-02
readiness repair on the D10-6 tree.

The repaired-tree M1 fixture comes from rehearsal `35495933501`, passing MySQL 8.4 producer
`106038899741` (481 tests, 84 files). Artifact `10601480949` has digest
`sha256:881d2da0e01a86f26f717e7fc7d52b9f407582aac3af5ecae92eb8a31e4c3d9f`.
Its generation time is `2026-09-20T07:16:57.372Z`, its dump is 19,076 bytes with SHA-256
`ce390d190fd04a8bb0358a200f2b0e4d5248d38bc5d7680faa50ae3568c6aaea`, and the manifest hash is
`cfeb94168fd7541e891f639a34b5a699b39e718dc1d6e2c57e51c4261693ce1e`.
All 55 migrations, seed keys, counts, shipped MySQL 9.7.2 dump client, backup-role identity
and zero-attachment contract are validated before copying the exact artifact bytes.

## Node 26 runtime selection

The advisory Node 26 jobs above have green job conclusions, but their test runtime claim
does not hold. Their setup selects Node 26.9.0, then the frozen pnpm install adds the declared
Node 24.21.0 runtime; `pnpm exec vitest` uses that local executable. pnpm documents this
selection in [devEngines.runtime](https://pnpm.io/package_json#devenginesruntime).
The green historical jobs remain intact and are not counted as Node 26 compatibility proof.

An isolated check of pnpm 12.4.1's documented
[runtimeOnFail override](https://pnpm.io/settings/cli#runtimeonfail) shows that ignoring the
runtime declaration changes the dependency specification and fails the frozen lockfile check.
The correction retains the normal frozen install, build and Node 24 production image. The
nightly test step verifies the runner's Node 26 process and launches Vitest with that exact
`process.execPath`, bypassing pnpm's local Node shim. Its version and executable path become
an uploaded JSON artifact. The lane remains explicitly advisory; its next Actions execution
must establish the corrected result.

## Green repaired implementation and fixture landing

[Main CI 35495933424](https://github.com/Mythikos/iridium/actions/runs/35495933424) completes
successfully on `7176d39`. All twelve required check-run IDs are verified through GitHub's
check-runs API. Required chaos checks `106038921926` / `106038922059` each pass 88 tests,
with 42 later/nightly cases skipped, in 1,817.32 / 1,770.09 seconds. Merge check
`106043018950` passes with 5,786 tests and 84 skips across the six raw lanes, then all 428
guards with ten future skips. Coverage is 90.99% statements, 91.98% lines, 85.85% branches
and 91.49% functions; global and per-file thresholds are unchanged and pass.
Merged artifact `10601157428` has digest
`sha256:391986a74f84c169e161640bdde29ab43a4c8f00377224ead08c06ff9d76b117`.

All six raw blob hashes match their origin records and report zero unhandled errors. All 73
grouped named M0/M1 exit proofs appear as passed; guards and Electron remain separate checks.
Both operating-system blobs contain all six passing regressions for the two requested
NoteSession findings. Each database artifact independently covers all 131 explicit documented
operation/status pairs, with 136 total observations including five defaults, across 38 files.

The following fixture landing changes only documentation, the promoted fixture, CI comments
and the independent advisory Node 26 launcher. It leaves product sources, unit inputs,
mutation configuration, dependency pins and the other nightly jobs unchanged. Its own main
run must still pass before the following exit-record commit can cite it. The full-scope
incremental nightly is valid M1 mutation evidence under §3; the explicit rehearsal's fresh
campaign remains an additional, separately reported execution and is never described as
completed while it is running.

Local validation of this landing passes formatting, all 468 name references and all 428
guards (ten future skips). The Node 26 launcher parses and its Node 24 negative control fails
before launching tests, as intended. The exact promoted fixture is next exercised by both
remote restoration lanes; earlier fixture results are not relabeled as its verification.

## Final fixture commit: `46f2e8b`

Commit `46f2e8bfdd85a914368117e679cc4e922f72d4c4` lands the fixture and runtime-launcher
correction directly on main. [CI 35497678473](https://github.com/Mythikos/iridium/actions/runs/35497678473)
and [nightly 35497703737](https://github.com/Mythikos/iridium/actions/runs/35497703737)
capture that commit. No pull requests are open.

The full-scope nightly mutation check `106043686493` passes at **74.71223021582733%**:
4,154 detected of 5,560 valid mutants, zero pending, and all 85 reported source contents
matching this commit. It instruments 87 files with 10,607 mutants, runs a fresh 2,086-test
baseline and reuses 10,056 results from `7176d39`. Counts remain 3,849 killed, 305 timeout,
1,242 survived, 164 uncovered, 4,525 compile errors, 521 ignored and one runtime error.
Artifact `10601567507` has digest
`sha256:2b34b4fa17fc1cc687c81a79528919212614f390607f39c18e49af43fd446c02`;
the report hash is `67fbe82832f0ed4371e4185c6f4a1b10aaf00edc6086dd2daa6c3efe8ab3f126`.
This is an incremental full-scope result, not a fresh mutation campaign.

Corrected Node 26 check `106043686560` now records the actual test runtime:
`v26.9.0`, executable `/opt/hostedtoolcache/node/26.9.0/x64/bin/node`, in artifact
`10601427919`. It fails six cases in `app.boot-modes.integration`, with 2,729 tests passing
across the remaining 226 files. All six failures compare expected empty stderr with
Node 26's `ExperimentalWarning: localStorage is not available because --localstorage-file
was not provided.` The expected exit codes and signals match. This is an actual advisory
compatibility finding under A4/D10-19, carried to Node 26 adoption; its originating accessor
remains to be traced. The runtime warning and the existing assertions are retained.
Earlier green jobs redirected through pnpm's Node 24 pin do not establish Node 26 support.

The fifth nightly's innovation check `106043686687` repeats the explicit advisory failure
(93 failed, 27 passed, 291 skipped; artifact `10600987031`). Its MySQL 9.7 third chaos shard
`106043686557` passes twelve cases. Older third-nightly second shards also complete green:
`106029939178` / `106029939129` each pass 171 cases, in 7,054.56 / 7,118.44 seconds, with
artifacts `10601046975` / `10601706854`. These dated results do not replace unfinished
property or fourth-shard results on the fixture commit.

Both extended property jobs in the third nightly finish successfully with 2,330 tests in
156 files: MySQL 8.4 check `106029939097` takes 8,569.94 seconds and uploads artifact
`10601738405`; MySQL 9.7 check `106029939114` takes 7,539.20 seconds and uploads artifact
`10601283035`. Their 5,000-run/300-command budgets remain unchanged. Run `35492580406`
finishes red because of the separately recorded failures; its passing jobs do not make the
whole workflow green.

The fourth nightly's full API profiles remain red on both engines (`106038745087` /
`106038745107`, artifacts `10601199071` / `10601043941`). The logs repeat D12-20's signed-cursor
and stateful administrator-authentication findings; the 9.7 outsider profile also reproduces
the transport-level content-type finding. These are kept separate from M1's passing light
profiles, and no failing run is deleted or renamed as successful.

The fifth nightly exposes a new flake in check `106043702789`: the first integration pass
has 411 passing tests in 74 files (369.34 seconds); the second has 410 passes and one failure
(363.48 seconds), so the third pass does not run. The administrator case in
`collab.epoch-steady-state.integration` observes one application query where the steady-state
window requires zero. Artifact `10600747903` and `35497703737-flake.log` preserve the failure.
The race is between the initial Saved boundary and the asynchronous connection hook's
participant-identity read. Thirty unmodified local repetitions pass and do not reproduce it.
A controlled diagnostic holds that real read until Saved, then releases it: both roles fail
with exactly `SELECT display_name, color_hue FROM users WHERE id = ?` inside the measurement
window, matching the remote count of one. The diagnostic records SQL shape without bind values.

The correction awaits the actual client's participant message before taking the SQL baseline.
Both controlled cases then pass at zero steady-state queries and exactly two stale-epoch
reads. After all diagnostic instrumentation is removed, the existing epoch and participant
suites pass on both MySQL engines. Types, type-aware lint, formatting and all 468 name
references pass. No product source, mutation input, fixture, timing allowance, update count or
SQL assertion changes. The diagnostic failures and passing checks remain in
`epoch-controlled-{before,after}-84.log` and `epoch-final-{84,97}.log`; the next Actions run
must validate this repaired observation boundary.

The fifth nightly's first chaos shards pass on both engines: `106043686555` / `106043686586`,
67 cases in four files, 1,700.90 / 1,642.40 seconds. Main CI's MySQL 8.4 chaos check
`106043780622` also passes 88 cases with 42 skips (1,732.49 seconds). Its source run remains
identified separately from the nightly campaigns.

Main CI `35497678473` completes successfully on `46f2e8b`, including MySQL 9.7 chaos check
`106043780576` and merge check `106047789359`. All twelve required jobs pass, including both
engines' restoration of the promoted fixture. This complete green run is preserved before
the subsequent test-only synchronization repair is pushed to main.

The fixture commit's aggregate contains 5,786 passes and 84 skips, followed by 428 passing
guards and ten future skips. Coverage is 91.02% statements, 91.99% lines, 85.88% branches and
91.53% functions; every unchanged threshold passes. Merged artifact `10601068431` has digest
`sha256:cc01616bdbd6bea297a035ec26e03d70896cfc38478c15ff51f6006f4f8fd6b7`.
All six raw lane hashes match their origin records, with zero unhandled errors and all 73
grouped named exit proofs passed. Both unit platforms pass the six requested NoteSession
regressions. Each engine independently records all 131 explicit API operation/status pairs
(136 observations including five defaults, across 38 report files).

## SQL observation repair: `abb968a`

Commit `abb968a1c506b50743f5cf40d30bcc35b30857af` contains the five-line participant-message
wait and its evidence. [Main CI 35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783)
and [nightly 35499345923](https://github.com/Mythikos/iridium/actions/runs/35499345923) run
against that commit. Static check `106048104100` passes; the complete main result and the
repaired flake run remain pending at this checkpoint.

An explicit comparison with `7176d39` confirms unchanged production and testkit sources,
unit/property/chaos suites, dependency and build/test configuration, and all nightly job
definitions before the separate Node 26 job. Only documentation, the promoted fixture,
CI comments, the independent Node 26 launcher and this integration observation change.
The still-running D10-6 campaigns therefore retain their named, identical property/chaos
inputs. This comparison does not label any unfinished job as passing.

At 08:31 UTC, superseded manual rehearsals `35488086906` (`b663d81`) and `35492818517`
(`bb8a964`) are cancelled after confirming that only their additional fresh mutation jobs
remain (`106018242092` / `106030678996`). These incomplete campaigns supply no terminal
score. Their existing failed and passing jobs, logs and fixture artifacts remain intact.
The cancellation releases runner capacity without cancelling any nightly history or the
current implementation's full-scope mutation evidence; the `7176d39` fresh rehearsal remains
a separate ongoing execution.
The retained final progress observations are 9,940/10,086 tested mutants for `b663d81`
(98%) and 6,648/10,086 for `bb8a964` (69%). Neither partial observation is a terminal score;
their mutation-runner assertion failures describe mutant executions, not a failed baseline.

The current commit's full-scope mutation check `106048191187` passes at **74.71223021582733%**,
with zero pending mutants and all 85 reported source contents matching `abb968a`. It instruments
87 files/10,607 mutants, passes a fresh 2,086-test baseline, and reuses 10,057 results from
the `46f2e8b` cache. Counts are 3,849 killed, 305 timeouts, 1,242 survivors, 164 uncovered,
4,525 compile errors, 521 ignored and one runtime error: 4,154 of 5,560 valid mutants detected.
Artifact `10602010555` has digest
`sha256:4ea030fd108911d3f9cb33647076ba4cbadf588e8ee8dc91ed396fb48c4b30f5`;
the verified report hash is `a4b06a052a87a413d3c05cf9b395d3f1e5003176d2913a9b2c943182cdd234bf`.
Main's `mutation-scoped` check `106048380551` is a successful no-op and supplies no score.

Corrected Node 26 check `106048191301` repeats the same six lifecycle stderr failures, with
2,729 passes in 227 files (353.06 seconds). Artifact `10601014023` again records Node 26.9.0
at `/opt/hostedtoolcache/node/26.9.0/x64/bin/node`; the six expected exit codes/signals match,
and each mismatch is the existing WebStorage ExperimentalWarning. The A4/D10-19 adoption
disposition is unchanged. Innovation check `106048191277` also repeats its advisory failure:
93 failed, 27 passed, 291 skipped, artifact `10602065205`.

The fifth nightly's full API jobs `106043686561` / `106043686558` finish red on both engines,
with artifacts `10602560909` / `10602331488`. Their administrator profiles reproduce the
signed-cursor and invalidated-fixture authentication findings; each subsequent outsider profile
reaches the existing 3,600,000 ms completion deadline. No complete outsider coverage is claimed.
That runtime-bound follow-up joins the full-profile harness work due at M2 under D12-20;
neither the deadline nor the M1 light-profile gate is weakened.

Current main MySQL 9.7 integration check `106048380555` passes all 481 cases in 84 files
(753.85 seconds), with report artifact `10601901553`. All three current main Electron checks
and both unit operating systems pass; the full source run still awaits its remaining jobs.

The repaired flake check `106048203440` passes all three full 411-test, 74-file integration
runs on `abb968a` (308.85 / 335.07 / 327.27 seconds), with artifact `10602705419`. This is the
remote verification of the participant-message boundary; failed check `106043702789` remains
unchanged. The current nightly's first MySQL 8.4 chaos shard `106048191282` passes 67 cases
(1,690.05 seconds), and both third shards `106048191328` / `106048191350` pass twelve cases
(177.93 / 182.37 seconds).

The repaired production campaign's MySQL 8.4 property check `106038744887` passes 2,337 tests
in 156 files at the extended budgets (6,177.02 seconds), with artifact `10602595413`. Its
other-engine property and remaining chaos results remain separately pending at this checkpoint.

Current main MySQL 8.4 integration check `106048380609` passes the same 481 cases in 84 files
(785.34 seconds), with report artifact `10602845269`. The current nightly's first MySQL 9.7
chaos shard `106048191392` passes 67 cases (1,553.39 seconds), completing both first shards.
The repaired production campaign's second MySQL 8.4 chaos shard `106038745066` passes all
171 cases in four files (6,983.96 seconds), with artifact `10602377391`.

The corresponding second MySQL 9.7 nightly shard `106038745089` also passes 171 cases in
four files (7,125.92 seconds), with artifact `10602037888`. Current main's MySQL 8.4 chaos
check `106048380598` passes 88 cases with 42 skips (1,750.04 seconds), followed by the
successful MySQL 9.7 chaos check `106048380566`. The final merge check is `106053852281`.

[Main CI 35499314783](https://github.com/Mythikos/iridium/actions/runs/35499314783) completes
green on `abb968a`, with all twelve required check-run IDs verified through GitHub's API.
Its merged 5,786 passing tests and 84 skips are followed by 428 passing guards and ten future
skips. Coverage is 91.03% statements, 92.01% lines, 85.86% branches and 91.53% functions,
with every unchanged global and per-file gate passing. Artifact `10602491467` has digest
`sha256:da041f3181f1f0965c0228868cc85eef9aeebf3b2cdacb001d465591d77fbf8f`.
All six raw origin hashes match, all 73 grouped named exit proofs pass, and the six requested
NoteSession regressions pass on both unit operating systems. Each database artifact independently
contains all 131 explicit API response pairs, plus five defaults, across 38 report files.

Both extended property jobs now pass on the repaired production inputs: the MySQL 9.7 check
`106038745152` also passes 2,337 tests in 156 files (7,362.23 seconds), with artifact
`10602811078`. Together with the prior 8.4 result, this completes both extended property
proofs. Only the fourth crash shards remain unfinished in the collected nightly gate set.

The current full MySQL 8.4 API check `106048191335` repeats the D12-20 findings in artifact
`10602451643`: the administrator profile fails signed-cursor generation and fixture
authentication; the outsider profile completes 26,756 generated cases with the known
transport-level HTTP 431 returning `application/json` instead of `application/problem+json`.
That completed profile is a failure, distinct from the earlier outsider timeouts.

## First scheduled nightly

The history refresh includes [scheduled run 35498879078](https://github.com/Mythikos/iridium/actions/runs/35498879078),
started at `2026-09-20T08:11:28Z` on `46f2e8b`, alongside the six manual rehearsals.
It is an actual scheduled execution; the exit record must include it rather than infer an
absence of scheduled history. Its still-running jobs do not establish green health.

Scheduled mutation check `106046908330`, all three full Electron jobs and flake check
`106046924107` pass. The flake job completes three 411-test, 74-file repetitions in
378.24 / 379.91 / 360.64 seconds, artifact `10600759619`. This older-source success does
not replace the final implementation's verification of the repaired SQL observation boundary.

Both full API jobs fail (`106046908176` / `106046908363`), retaining artifacts
`10602646174` / `10603020664`. Their administrator profiles repeat signed-cursor validation
and invalidated fixture authentication. The 8.4 outsider profile completes 23,434 generated
cases with one unique failure and 6,326 skips, reproducing the HTTP 431 content-type mismatch.
The 9.7 outsider profile instead reaches the existing one-hour completion deadline.
These remain the separately scoped D12-20 follow-ups, not passing API evidence.

Corrected Node 26 check `106046908339` also repeats the six lifecycle stderr failures,
with 2,729 passes (442.77 seconds), artifact `10601479551`. The recorded comparisons show
the same WebStorage ExperimentalWarning; the advisory adoption disposition is unchanged.
Innovation check `106046908306` fails separately. The first and third chaos shards pass
on both engines; the extended properties and second/fourth shards remain pending at this
checkpoint. The watcher now includes the scheduled run as well as every manual rehearsal.

The final-source MySQL 9.7 full API check `106048191306` also finishes red, with artifact
`10602846736`. Its administrator profile generates 1,979 cases and retains the existing
signed-cursor/authentication findings; the outsider profile reaches the one-hour deadline.
Together with check `106048191335`, both final-source full API outcomes are now explicit.

The repaired production campaign's full MySQL 9.7 fourth crash shard `106038745098`
passes all 695 cases in three files (9,510.49 seconds). This includes all 680 durable-ack
cases at the unchanged nightly budgets. Its complete job log is retained as
`35495934601-chaos-4-97.log`; no artifact ID is inferred when the upload has no report files.
The corresponding full 8.4 fourth shard remains the last pending M1 proof at this checkpoint.

The fifth manual rehearsal also completes both second crash shards successfully:
`106043686629` / `106043686609`, each 171 cases in four files, 7,133.18 / 7,119.79 seconds,
artifacts `10603126104` / `10602877640`. Its MySQL 9.7 property check `106043686567`
passes 2,337 tests in 156 files (7,165.69 seconds), artifact `10603160976`.

Final-source extended MySQL 9.7 property check `106048191329` passes the same 2,337 tests
in 156 files (5,273.83 seconds), with artifact `10603181486`. This is an additional result
on `abb968a`; earlier successful campaigns retain their actual source identities.

The full MySQL 8.4 fourth shard `106038745101` also passes all 695 cases in three files
(10,316.67 seconds), including the 680-case durable-ack file. Both 200-iteration kill methods
pass on both engines. As on 9.7, the successful log is the proof and the upload has no report
files. All eight full chaos shards and both extended properties on the repaired production
inputs are now green. Run `35495934601` itself finishes with `failure` because the separately
scoped full API and advisory jobs remain red; its whole-run result is not relabeled.

## M1 exit landing

[M1-exit.md](M1-exit.md) records implementation `abb968a1c506b50743f5cf40d30bcc35b30857af`,
main CI `35499314783`, all twelve required check-run IDs, both integration engines, merged
coverage, the full-scope mutation score, the promoted fixture and fourteen completed due
nightly checks. The captured workflow history includes six manual rehearsals and one scheduled
run. Both requested NoteSession findings are fixed; the separate local macOS/audit limitations
and full-API/advisory follow-ups remain stated explicitly.

This following record commit advances `CURRENT` to `M1`, after M0's marker and formal closure.
Its own required main checks precede the hand-cut `v0.1.0` tag on that record commit. Tagged
release verification and the due server-image publication remain distinct remote executions;
the local release preflight is not described as their result.

Local exit checks pass all 428 guards with ten future skips, all 468 test-name references
and repository formatting. The initial guard run caught the generated acceptance map's
`currentMilestone: M0`; its generator changes only that stamp to `M1`, and the final guard
run passes. Both logs remain as `m1-exit-guards.log` and `m1-exit-final-guards.log`.

## Exit candidate refusal and SQL timeout-sweep correction

Candidate exit commit `2d62b99d17bca30e8d2d842a1a88c73b15ba0284` is pushed directly to main.
Its own [CI 35504070807](https://github.com/Mythikos/iridium/actions/runs/35504070807)
passes the static, unit, Electron and MySQL 8.4 integration checks, but MySQL 9.7 integration
check `106060922722` fails one of 481 tests. `audit.bounded-failures.integration` receives
`PROTOCOL_SEQUENCE_TIMEOUT` while expecting server `ER_LOCK_WAIT_TIMEOUT` / 1205 for a held
audit chain head. The run retains 480 passes in 83 files (870.60 seconds), raw artifact
`10603367847` and database report artifact `10603562791`. No `v0.1.0` tag is created.

The first exit candidate is therefore provisional. `CURRENT` returns to `M0`, with the
candidate evidence and failed run preserved, until the correction and replacement exit record
are verified. M0's completed marker and exit are unaffected; the workspace versions and
promoted M1 fixture stay at `0.1.0`.

MySQL 8.4.11 and 9.7.2 scan expired InnoDB lock waits once per second. The former two-second
serving command minimum allowed a one-second lock wait plus its regular sweep to consume the
entire response budget. The new `db.session-policy.unit` regression fails that former policy
with zero response margin. OPS-12 now requires a three-second minimum, preserving one second
after the nominal lock wait and regular sweep. The ten-second default, half-budget lock-wait
formula, maximum, error mappings, connection destruction and uncertain-COMMIT handling stay
unchanged. Configuration values from 2000 through 2999 are now explicitly rejected; the ADR,
data-model contract, operator reference and unreleased server changelog record this change.

No error assertion is broadened. The audit and lock-timeout integration proofs still require
actual server 1205, complete rollback, physical-connection reuse and exactly one caller-owned
retry append. All seven cases pass locally on each engine (32.30 / 31.97 seconds), including
both app/persist pools at the new minimum and unchanged default. All 2,332 unit tests in 153
files pass. The negative timing-margin proof is retained in `sql-sweep-before.log`; the first
post-change unit run exposed four fixtures still using the old minimum, corrected before the
passing `sql-sweep-final-unit.log`. The engine proofs are `sql-sweep-after-{84,97}.log`.

The older `b663d81` nightly mutation job `106018032638` ends cancelled at its six-hour limit
after the candidate snapshot, with 8,977/10,086 tested mutants at the final progress report.
It supplies no terminal score. `35488088005-mutation-timeout.log` preserves that outcome;
the separately verified incremental full-scope score is not inferred from this incomplete run.

The corrected serving bundle builds, types and type-aware lint pass, all 428 guards pass with
ten future skips, all 468 name references resolve, and formatting passes. The failed candidate's
job snapshot is retained before the corrective push; standard main-branch concurrency may
cancel its still-running chaos jobs when the new CI starts. That supersession does not change
the completed 9.7 failure or substitute for the correction's required remote verification.

## Explicit Electron setup and first-frame latch repair

The SQL correction's [main CI 35505687511](https://github.com/Mythikos/iridium/actions/runs/35505687511)
passes both required integration engines (checks `106065202399` / `106065202416`). Windows
Electron check `106065202428` fails before collecting a test: the pinned Electron package
tries its lazy binary download during fixture import and reports `TypeError: fetch failed`.
Artifact `10603154765` and `35505687511-electron-windows.log` preserve that failure.

The shared setup-electron action now invokes the pinned package's own install-electron binary
before desktop tests or packaging in CI, nightly and release. The installer retains its embedded
checksums. Three bounded setup attempts handle transient download failures, with five- and
ten-second delays; exhaustion fails the job. Test commands have no new retry. The actual Windows
installer succeeds locally, and shell fault probes verify first/second/third-attempt success and
failure after exactly three attempts. All 428 workflow/repository guards pass with ten future skips.
The pinned [Electron installation instructions](https://github.com/electron/electron/blob/v44.3.0/docs/tutorial/installation.md)
document this explicit binary-install command.

Nightly [35505721446](https://github.com/Mythikos/iridium/actions/runs/35505721446) exposes a
separate first-frame latch race in flake check `106065102033`: 410 passes and one failure
in the first 411-case repetition, with artifact `10604255106`. A reattached oversize note
has a writable native connection before the connected hook's identity SQL completes. Its
`35505721446-flake.log` remains unchanged; the second and third repetitions did not run.

A17 now applies initial writer latches before the first native incoming frame, with connected
covering idle clients. Both paths share one initialization so late connected completion does not
duplicate notices. The native-frame regression fails both content-invalid and oversize against
the former implementation; its writable control passes after correcting a stale in-memory-store
reference in the test. The real MySQL 8.4 reproduction holds the actual connected chain and
fails the oversize client-latch assertion. Those negative logs are retained as
`latch-before-unit-final.log` and `latch-before-84.log`. No assertion is replaced with a delay.

Final local validation passes all 2,338 unit tests in 153 files, including six first-frame
SyncStep2/Update cases and both hook error-containment matrices. The controlled latch and
steady-state epoch suites pass all five cases on each engine (30.15 / 29.30 seconds), retaining
zero app SQL in steady state and exactly two reads at one epoch mismatch. Types, lint, the
server bundle, 428 guards, 468 documentation references and formatting pass. Logs use the
`latch-final-*` and `latch-after-{84,97}` prefixes.

The preceding nightly mutation check `106065083633` passes 74.71223021582733% with 4,154
detected of 5,560 valid mutants, zero pending and 85 report sources matching `9f269b9`.
Artifact `10603384635` holds report SHA-256
`78fea0f0f23eb16b827a917a6aa6211b3411bc07e4782380326e52835a90c7cd`.
The actual Node 26 check `106065083771` fails the same six lifecycle stderr assertions with
2,737 other passes; artifact `10603619399` preserves its advisory result.

The failed main-run snapshot is retained before the next corrective push. Normal main
concurrency may cancel its remaining chaos jobs, while the completed Windows failure remains
visible. The new production latch boundary requires fresh remote evidence; neither that
supersession nor the prior green mutation campaign certifies the repaired implementation.

## Current implementation verification and fresh rehearsal completion

Implementation `20494d32a1e1d84697c1a9dd35303caa1d9a297d` runs in
[main CI 35506765887](https://github.com/Mythikos/iridium/actions/runs/35506765887)
and [nightly 35506782276](https://github.com/Mythikos/iridium/actions/runs/35506782276).
All twelve required main checks pass. The six raw lanes contain 5,814 passes and 84 declared
skips; both integration engines pass 481 tests in 84 files and record all 131 explicit API
operation/status pairs plus five defaults. Both unit platforms pass 2,338 tests, including
all six requested NoteSession regressions and all six native first-frame latch regressions.
All 73 grouped M0/M1 named proofs are present, every raw origin hash matches, and every
check-run API entry names this source commit.

Merge check `106071941895` passes the unchanged coverage gates at 91% statements, 91.98%
lines, 85.86% branches and 91.5% functions, then all 428 guards with ten future skips.
Merged artifact `10604293448` has digest
`sha256:0c35905f0d8168c67f196335d1ae68fbe8e8f0f8633e9e35c97aef8785c8e89b`.
The final exit record maps each required check and named proof to these remote results.

Main mutation check `106068100420` and nightly mutation check `106067832796` both score
74.78417266187051%, with 4,158 detected of 5,560 valid mutants and zero pending. Both reports'
85 source contents match the implementation. These are incremental full-scope executions;
the nightly log records a fresh 2,100-test baseline and 8,982 reused results, with two test
files changed. Main artifact `10605256311` has report hash
`4620c1e937d37863cb904130c65b57f7b9dffa628cf0d03fb0a5e75c51a3a303`.
Nightly artifact `10605050663` has digest
`sha256:0cbb4ea51a09230cab594da0dd81d5313b0d5c6da41a8dd799587475024b047e`
and report hash `84ef180b3921e8e1421d78935b8ce57418b337a1d880b1baa225dadfa04f57dd`.

The earlier fresh full-scope rehearsal
[35495933501 / 106038899755](https://github.com/Mythikos/iridium/actions/runs/35495933501/job/106038899755)
finishes successfully after 296 minutes and 37 seconds. Its log explicitly records that no
incremental result file exists, then a fresh 2,086-test baseline. The final score is
74.49640287769785%, with 4,142 detected of 5,560 valid mutants and zero pending. All 85 report
sources match `7176d392232aa8f79f9f4cec47c4d9df9635085a`. Artifact `10604434657` has digest
`sha256:89228000272e464d8ac59767a18623fa04c9131fd8b7cc3e7dcb2a6be38d5176`; the report hash is
`97636317c81c3b5081abab3c03ebea9123759bec17d5a4b80239098c935f6c27`.
This is completed historical evidence. It does not replace the current implementation's
separately recorded mutation result, and it does not convert any earlier timeout into a pass.

The current nightly's MySQL 8.4 full API check `106067832605` retains one administrator
cursor-generation failure and 27 authentication errors. Its outsider profile completes with
two content-type failures: HTTP 431 from oversized headers and HTTP 414 from the router's
maximum parameter length. Both return `application/json` where the contract documents
`application/problem+json`. Artifact `10604299681`, digest
`sha256:02941ef4e88abce17ded544674fa228a461635fab9f0f00c15156307327610ae`, contains both profiles'
logs, XML and authentication-network records; all six files are archived and hashed locally.
The 414 observation joins the existing full-profile M2 follow-up under D12-20. Required M1
non-admin light profiles pass separately on both supported engines. No failing profile is
described as a pass; the administrator authentication errors do not establish authenticated
full-profile coverage.

The corresponding 9.7 full API check `106067832826` has the same one administrator cursor
failure and 27 authentication errors, then its outsider profile reaches the 3,600,000 ms
completion deadline without a terminal pass. Artifact `10604774311` has digest
`sha256:3a169f38ea2eaf28e6f2c94f60eec4aaeaca6f68642798bee75e7e41f2b7b228`.
The complete failed job log and available profile files are archived separately; neither the
timeout nor the missing outsider terminal result is treated as passing coverage.

The current campaign completes all fourteen due extended proofs: both 5,000-example property
lanes pass 2,351 tests in 156 files, all eight chaos shards pass (67 / 171 / 12 / 695 tests
per engine), the flake hunt passes 411 tests in each of three consecutive repetitions, and
full Electron passes four tests on each operating system. The final crash shards retain the
200-iteration kill budgets. The workflow itself remains failed because the separate full API
and advisory findings above remain open; it is not described as green nightly health. The
exit record retains all nine actual nightly runs, including the first scheduled execution,
with their sources, triggers, check IDs and conclusions.

## Tagged M1 release: classic Docker store failure (2026-09-20)

The immutable product tag `v0.1.0` identifies exit record
`f31a51fd2c3af6b3631a28fc45918245dfac34a1`. Its required CI
[35514878482](https://github.com/Mythikos/iridium/actions/runs/35514878482) passes all twelve
checks. Tagged release [35516882462](https://github.com/Mythikos/iridium/actions/runs/35516882462)
remains failed: selector `106094222212` and both tagged verification checks
`106094280257` (8.4) / `106094280233` (9.7) pass. Each engine records 428 guards with
10 future skips, 2,338 unit tests, and 469 integration/contract tests in 81 files. The separate
main integration jobs include the database property project and pass 481 tests in 84 files.

Image check [106096275055](https://github.com/Mythikos/iridium/actions/runs/35516882462/job/106096275055)
successfully builds and pushes
`ghcr.io/mythikos/iridium-server@sha256:e2fab1f49fc92594032a04025dee3d94afede5ed102f4f6429275d42a92f9e7e`.
Its AMD64 and ARM64 Syft and Grype steps all pass. Direct registry inspection confirms both
platform manifests and their attached SBOM and provenance records at that index digest.
AMD64 then executes and reports version `0.1.0`, commit `f31a51f` and MySQL client 9.7.2.
ARM64 fails before execution: the runner's Docker 28.0.4 overlay2 store returns
`cannot overwrite digest` (exit 125) when the same index resolves to its second platform.
The empty ARM64 identity file is not evidence of a pass.

Artifact `10607117926` preserves the two CycloneDX SBOMs, two SARIF reports and partial
runtime identities, with digest
`sha256:30be707108fad6055817281ab025ee9ae0b231b4785662862e153e0529d0fe0a`.
The complete failed job log and downloaded evidence remain under
`reports/remote-ci/35516882462-*`. The OCI index and product tag are preserved.

The OPS-04 repair explicitly enables the containerd image store through the pinned official
Docker setup action and shares the unchanged two-platform hygiene checks with the read-only
`release-image-check.yml` workflow. The guard rejects a classic store, missing emulation,
host-only execution and weakened version/source comparisons. Local checks pass 433 guards
(10 future skips) and root formatting. A separate local runtime probe verifies AMD64 but
returns `exec format error` on ARM64; it supplies no ARM64 proof. The repaired Actions
workflow includes explicit QEMU setup and must supply its own terminal result.

### Completed remote image verification

Repair `0f3d68f55cf629989e3906b9a218a99212784008` is verified by read-only Actions run
[35518865586](https://github.com/Mythikos/iridium/actions/runs/35518865586), check
[106099350162](https://github.com/Mythikos/iridium/actions/runs/35518865586/job/106099350162): **PASS**.
The log confirms Docker 29.8.1 with `io.containerd.snapshotter.v1` and explicit QEMU setup.
Both platforms execute the original published image, report `0.1.0`, source
`f31a51fd2c3af6b3631a28fc45918245dfac34a1`, Node 24.21.0 and schema head
`0055_min_client_version`; the shipped `mysqldump` reports 9.7.2 on x86_64 and aarch64.
Artifact `10607752207`, digest
`sha256:21b084271901e2d78109bf541c04ec1c69d5b1eb54cd2378c53ad973349b7850`, preserves
both runtime identities and the separate product-source/workflow-commit record.

The verified image remains
`ghcr.io/mythikos/iridium-server@sha256:e2fab1f49fc92594032a04025dee3d94afede5ed102f4f6429275d42a92f9e7e`.
Its AMD64 manifest is `sha256:4a9fbb2c0a7110e4562f946a3c325805329bfeebc1d4e0009608ff58052b57be`;
its ARM64 manifest is `sha256:f9418cc150d3fed37f83d74b43442399666cec3ce72c716d2453de75a98eabb0`.
Registry inspection verifies an attached SBOM and linked provenance on each platform, with
both provenance source revisions equal to the product tag. Each attached SPDX SBOM records
364 packages. The original CycloneDX reports record 3,814 AMD64 and 3,813 ARM64 components;
both original SARIF reports contain zero findings under the unchanged fixed-high/critical gate.
Those scan results are not a claim that no vulnerability of any kind exists.

The original [release 35516882462](https://github.com/Mythikos/iridium/actions/runs/35516882462)
remains failed and supplies its successful tagged verification/build/scan prerequisites.
This completed supplementary run supplies the missing two-platform runtime proof. Neither
the product tag nor image digest was moved or rebuilt. The raw logs, artifact metadata,
downloaded identities, registry records and verified file hashes are retained under
`reports/remote-ci/35516882462-*` and `reports/remote-ci/35518865586-*`.
