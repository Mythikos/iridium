# M2 working record

M2 implementation is committed and exit validation is in progress. `CURRENT` remains M1. This is a working record, not an exit declaration; remote CI has now run this tree, and each section below says whether its evidence is remote or only this machine's. The tree carries version 0.2.0 across the root and 23 workspaces; no `v0.2.0` tag exists.

## Implemented

- Vault settings/archive, structural CRUD and version checks, paths, closing-set coordination, trash/restore/purge and vault-channel notifications.
- Pipeline v3 with source-preserving Markdown, frontmatter and links, sanitized rendering, bounded workers, committed reads, full-text search, snippets, named revisions and atomic minimal-diff restore.
- Filesystem/S3 attachments, streamed validation, ranges, deduplication, retained-history references, maintenance jobs, resumable reindex, retention, audit archive and operator commands.
- A 62-operation REST surface, real-response OpenAPI checks and previous-release wire baselines captured from the immutable `v0.1.0` tag.
- Migrations 0056–0059 replace unsupported high-cardinality JSON indexes with indexed derived terms and widen raw frontmatter. Historical migrations remain unchanged. The complete selected path is inspected before any migration executes; long-running 0056 and 0059 require the operator's explicit `--allow-long-running` flag. Boot remains available for diagnostics while refusing product traffic until migration completes.
- Publication takes the vault shared lock before its first snapshot read. Purge fences writers under a short exclusive lock, waits for disposal outside that lock, then reacquires it and revalidates. Raw durable append remains independent of the publication gate.

## Landed

The implementation is committed. `fba2ca7` carries the whole M2 tree; the commits after it close
what a defect audit, the first fresh local lanes and then the first remote runs on that tree found.
`CURRENT` remains M1 and no `v0.2.0` tag exists.

Four of those were product defects rather than stale expectations.

- `attachRequestId` ran in an `onRequest` hook registered after `under-pressure` and `rate-limit`,
  and Fastify runs those in registration order, so a shed `503` and a limited `429` went out with no
  `requestId` and no echoed header (ARCH-12, ARCH-15).
- `doctor --repair-heads` declared `sql<number>` over a `GREATEST(COALESCE(MAX(...)))` that widens to
  DECIMAL and returns from mysql2 as a string, so `head_seq !== expected` compared a number with a
  string, held for every consistent note, and the repair reported and audited work it never needed.
- `NODE_PATH_MAX_CHARS` is 16,387 against Node's 16,384-byte head budget, so a maximal `pathPrefix`
  could never be sent: the published bound described a request the transport refused with `431`. The
  budget is now `REQUEST_HEADERS_MAX_BYTES`, passed to `createServer`.
- `tree/service.ts` shadowed the contracts `InvalidMoveReason` with a local union of three of its
  four members, so the shadowing type could not name the `cycle` refusal the route produces.

## Local evidence, 2026-09-21 UTC

Everything below was run against the committed tree on this machine. None of it is a remote result.

| Lane | Result |
|---|---|
| `unit` + `guard` + `component`, `IRIDIUM_TEST_TARGET_MILESTONE=M2` | 4,508 passed, 9 skipped, 0 failed, 223 files |
| `integration`, `mysql:8.4.11` | 623 passed, 0 failed, 124 files |
| `integration`, `mysql:9.7.2-oraclelinux9` | 623 passed, 0 failed, 124 files |
| `contract`, including `schemathesis.light.contract` | 108 passed, 0 failed, 11 files |
| `property`, `mysql:8.4.11` | 14 passed, 0 failed, 5 files |
| `build`, `check-types`, `lint` | 45 tasks, all green |
| `oxfmt --check`, `knip --production`, `turbo boundaries`, `pnpm dedupe --check` | all green |
| the nine `scripts/check-*.ts` static checks | all green, licence scan included |
| `pnpm gen` with the database step | every artefact current; kysely diff against `mysql:8.4.11` reports 37 tables, 436 columns, no difference |

The Schemathesis light gate had never run against this tree. It passes now, and the failures it found
on the way were all one shape: a rule the server enforces that the document did not publish. Where
the rule belongs to a route released at `v0.1.0` the published shape is unchanged and the refusal is
declared in the fuzz configuration, because A54 prices a tightened validation at an `apiVersion` bump
and none of these changes can be observed by a client. Where the route is new at M2 the schema states
the rule. `compat.n-minus-1` and the contract lane are green together.

Five named exit tests passed without asserting a clause their §6.4 row states — the depth bound, the
pre-trash validator, the job claim columns, the vault-status search cases and the after-thinning half
of the unreferenced report. Each now asserts it; `hierarchy.model.prop` models depth independently,
because the recursive CTE stops at the ceiling and a read-back would have been a clamp wearing the
shape of an invariant.

The licence scan passes. PSF-2.0 joined the allowlist on 2026-09-21 with the owner's approval, the
way BlueOak-1.0.0 did at M0: `argparse` 3 reaches the production closure through `markdown-it`'s CLI,
which Iridium never runs, and a per-package exception would carry an expiry that recurs on every
dependency bump for no policy gain.

## Defects the first remote lanes found (2026-09-22 to 2026-09-23)

The 2026-09-21 record above was written from local runs alone. Every lane has since run remotely,
and each red run named a real defect rather than a flaky budget. They are listed in the order they
surfaced, because each one hid the next.

- **The e2e and matrix jobs never reached their assertions.** `0056_projection_alias_lookup` and
  `0059_projection_terms_backfill` are long-running, and five `iridium migrate up` steps across
  `ci.yml` and `nightly.yml` did not pass `--allow-long-running`, so the workflows stopped at the
  operator gate M2 introduced.
- **`jobs.scheduler.integration` raced its own scheduler.** The cancel case needed a row that was
  still queued when the cancel landed, and the run route earlier in the test wakes the scheduler,
  whose drain claims queued rows of any handled type. An `export` row is in `JobType`, has no
  handler at M2 and therefore cannot be claimed, which is what makes the case deterministic.
- **Three budgets were sized for a machine that is not also hosting the lane's containers**: the
  multipart storage-driver contract, two collaboration waits and the chaos reconnect, which now
  shares one constant across its five call sites.
- **A stopped fixture clock turned a purge into a hang.** `attachments.unreferenced-report` drove a
  `ManualClock` with `jump()` alone, which fires nothing, while purge waits outside the structural
  lock for the note's writer to reach disposal — including a backoff retry armed on that clock. One
  lane per run expired at 120 s while the other passed in six seconds. `withPacedClock` awaits real
  server work while injected time keeps pace with host time, the way `drainWithClock` already did
  for shutdown. Pacing then exposed that `ManualClock` reported a fractional instant, which the
  rate-limit store refuses outright.
- **The administrator fuzz profile revoked its own sign-in.** `schemathesis-full` had been red every
  night since M1: a stateful scenario links a real id out of `GET /admin/users` into
  `POST /admin/users/{userId}/reset-password`, which replaces the password the fixture holds (A28),
  and every case after that was an authentication error. Both operations stay in the run against
  every other identity; only the fixture's own id is redirected onto the spare `editorC` account.
- **A projection bound cut an astral character in half.** `persistence.model.prop` found it at 300
  commands, seed 533595407: a fence language longer than `CODE_LANGUAGE_MAX_CHARS` ending at an odd
  UTF-16 boundary left a lone surrogate in `note_projections.code_langs`, and MySQL refuses that
  with `ER_INVALID_JSON_TEXT`, so an ordinary note create answered 500. `truncateChars` cuts between
  complete combining sequences at all four bounded sites, and `PIPELINE_VERSION` advances to 3.
- **A documented refusal nobody produced.** CI 35817415988 was the first run where every lane
  passed, so `merge-reports` reached `check-openapi-coverage` for the first time. One of 303
  documented `(operationId, status)` pairs had never been exercised: `tree.listChildren` 422.
  `ListChildrenQuery` bounds `limit` at 1..500, so the refusal is real and the gap was the test
  (D10-10).
- **A crash fault's own log line races its kill.** `collab.trash-crash.chaos` failed one kill
  iteration in the nightly's chaos shard 3 and in one CI 9.7 lane, each time as `waitFault` expiring
  with nothing but "expected false to be true". With the failure message widened to carry the
  server's account, a local reproduction — about one iteration in twenty — showed the server had
  exited abnormally with its last line being `fault point armed`: the fault fired, killed the
  process, and the two lines it wrote went with the kill, which is exactly what HP-2's "no `finally`,
  no drain, no flush" promises. A crash point is now observed by the process exiting without a clean
  status, which nothing else in that test produces; the eight points that leave the process alive
  keep the logged consumption.
- **A descendant walk re-read the whole vault once per node.** The first M2 rehearsal's
  `mysql-matrix-extended (property, 300)` failed `persistence.model.prop` with a note create
  answering `503 unavailable`, a statement past the 10 s query deadline. The counterexample `[[]]`
  mattered only because a note with a link builds the projection's vault index inside its
  structural transaction, and by then the fixture vault held 4,880 notes, all under the root. A
  root-privileged dump of InnoDB's transactions at the moment of refusal named the statement: the
  recursive path CTE, holding no lock and waiting on none. The optimizer costs a recursive member
  against a one-row estimate of the CTE, and in a flat vault the parent index's rows-per-key is the
  whole vault, so from about 3,000 notes it chose `ix_nodes_vault_deleted` or `ix_nodes_vault_name`
  and scanned every live node once per node reached: 15 s at 4,880 notes on both lines. The five
  descendant walks now name `ix_nodes_vault_parent` in their recursive member with MySQL's
  `JOIN_INDEX` hint, and the same walk takes 10 ms. `tree.descent-plan.integration` plans each walk
  on both lines; with the hint removed, all seven cases fail on 8.4.11 and six on 9.7.2; `tree.paths.integration`'s 10,000-node budget had not
  caught it because its generated tree is branched (03-data-model.md §6.3).

## Remaining exit work

Both required database lines now pass the complete `integration`, `contract`, `mcp` and `property`
lanes on this machine — 140 files and 746 tests each — and the `unit`, `guard` and `component`
projects pass 4,511 tests in 225 files. Remotely, CI run
[35817415988](https://github.com/Mythikos/iridium/actions/runs/35817415988) on `6593ba8` is the
first since the M2 tree landed to pass `static`, both `unit` platforms, all three `e2e-electron`
platforms, `mutation-scoped`, **both** required `integration` lanes and **both** `chaos-core` lanes.
Its `merge-reports` job then failed on the two findings above, each the first time that check had
run at all. CI run
[35823413588](https://github.com/Mythikos/iridium/actions/runs/35823413588) on `1d4652e` is green
in every job: 706 test files with 2 skipped across the merged lanes, merged coverage of **90.4%
statements / 83.66% branches / 91.32% functions / 91.93% lines**, all 303 documented
`(operationId, status)` pairs exercised, and the 27 guard files passing on the merged reports.

- Nightly health (12-milestones.md section 3) is a rule against a job staying red, not a required
  streak of passes: a job red for three consecutive runs blocks the exit until it is green. An
  earlier revision of this record called it a three-green floor; that was wrong. `schemathesis-full`
  and `mysql-matrix-extended (schemathesis, 300)` have been red every night since M1 and so block M2
  until one run passes them. Their fixes are in `071d96e`, and the M2 rehearsal
  [35940812349](https://github.com/Mythikos/iridium/actions/runs/35940812349) was dispatched on
  2026-09-24 to prove them, as M1's exit relied on its own manual rehearsal. `mysql-innovation` and
  `node-26` carry `continue-on-error` and are dispositioned, not counted.
- Merged coverage and the full-scope mutation campaign have both been re-measured since the
  `PIPELINE_VERSION` advance: coverage in every CI `merge-reports` job from
  [35823413588](https://github.com/Mythikos/iridium/actions/runs/35823413588) on (90.4% statements),
  and the full-scope campaign in nightly
  [35835692071](https://github.com/Mythikos/iridium/actions/runs/35835692071/job/107098477330) at
  **72.82%** against the M2 break threshold of 70.
- `apps/server/test/fixtures/upgrade/v0.2.0/` records `pipeline_version` 2, which no released build
  will ever write. The milestone-exit build regenerates it (12-milestones.md §3, "Upgrade fixture").
- `M2-exit.md` and an M2 section in `remote-ci.md` are unwritten and both depend on those results.
  The tagged image with its architecture, SBOM and scanner evidence is unpublished, and `CURRENT`
  advances only after all of it.

The owner requires direct commits and pushes to main. Branch protection is deferred under section
13.3 and is not an additional M2 approval gate. This record does not authorize M3 work.
