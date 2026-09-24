# M2 exit record

M2, structure and search, closes on 2026-09-24 (UTC), after M1's formal closure and product tag `v0.1.0`.
The implementation is committed at `46352e482f7dcbea249ad2f9cceb19bbc911e123`. The M2 tree landed in
`fba2ca7`, which also versioned the root and every versioned workspace to `0.2.0` with their
changelogs. The commits after it repair what audits, local lanes and the remote runs found; each is
listed under "Review findings and remote repairs" below. This record commit advances `CURRENT` to
`M2`, and the hand-cut `v0.2.0` tag targets this record commit. That is the same two-commit landing
M1 used: the record names its existing implementation parent, and the product tag identifies the
record itself.

## Required remote checks

CI run [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) on `46352e4`:

| Required check | Check-run ID | Result |
|---|---|---|
| `static` | [107740947810](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107740947810) | Pass |
| `unit (ubuntu-latest)` | [107741410897](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410897) | Pass |
| `unit (windows-latest)` | [107741410759](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410759) | Pass |
| `integration (mysql:8.4.11)` | [107741410722](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410722) | Pass |
| `integration (mysql:9.7.2-oraclelinux9)` | [107741410578](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410578) | Pass |
| `chaos-core (mysql:8.4.11)` | [107741410856](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410856) | Pass |
| `chaos-core (mysql:9.7.2-oraclelinux9)` | [107741411211](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741411211) | Pass |
| `e2e-electron (ubuntu-latest)` | [107741410684](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410684) | Pass |
| `e2e-electron (windows-latest)` | [107741410921](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410921) | Pass |
| `e2e-electron (macos-latest)` | [107741410901](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410901) | Pass |
| `mutation-scoped` | [107741410764](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107741410764) | Pass |
| `merge-reports` | [107756416221](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107756416221) | Pass |

The database lanes ran on Actions against MySQL 8.4.11 and 9.7.2, and Electron ran on real Linux,
Windows and macOS runners. Web E2E is not due until M4.

## Named exit proofs

Every name in the §6.4 table was matched to its spec file in the `merge-reports` job of
[36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149): all 59 named tests,
in 42 table rows, are present and passing. None is inferred from a table entry alone. The
acceptance map carries no `file` for 131 of its entries, `testkit.dba-grants.unit` among them, so
those were located by their `describe` title
(`packages/testkit/src/env/dba-grants.unit.spec.ts`, 7 tests).

| Named exit tests | Due lane | Remote proof |
|---|---|---|
| `authz.read-core.unit`, `obsidian.detect.unit`, `obsidian.basename-resolution.unit`, `content.no-ydoc.unit`, `content.lines-and-heading.unit`, `testkit.dba-grants.unit`, `detector.pathological.unit`, `markdown.sanitize-schema.unit`, `preview.data-attributes.unit` | `unit` | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `contracts.paths.unit`, `contracts.paths.prop` | `unit` on Linux and Windows | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `markdown.commonmark.unit`, `markdown.golden.unit`, `markdown.xss-corpus.unit`, `markdown.sanitize.prop`, `markdown.pathological.unit`, `markdown.frontmatter.prop`, `markdown.links.prop`, `markdown.no-rewrite.prop` and the rest of that row | `unit` | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `attachments.policy.unit`, `attachments.storage.unit`, `tree.rename-impact.unit` | `unit` | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `links.index.integration`, `tree.structural-concurrency.integration`, `tree.stale-resurrection.integration`, `tree.invalid-move.integration`, `tree.rename-impact.integration`, `tree.purge-fence.integration`, `tree.paths.integration`, `tree.descent-plan.integration` | `integration` on both engines | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `vaults.settings.integration`, `revisions.restore.integration`, `revisions.thinning.integration`, `projection.monotonic.integration`, `projection.title-after-rename.integration`, `projection.target-lifecycle.integration` | `integration` on both engines | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `content.read-model.integration`, `content.etag.integration`, `content.fresh-flag.integration`, `search.acl.integration`, `search.snippets.integration`, `search.staleness-hint.integration` | `integration` on both engines | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `attachments.security.integration`, `attachments.s3.integration`, `attachments.unreferenced-report.integration` | `integration` on both engines | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `authz.rest-viewer.integration`, `authz.vault-isolation.integration` | `integration` on both engines | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `lock-order.integration`, `migrations.long-running.integration`, `jobs.scheduler.integration`, `collab.vault-channel.integration` | `integration` on both engines | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `hierarchy.model.prop` | database property project inside both `integration` jobs (200 runs); nightly scope below | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `search-index.contract`, `openapi.contract`, `openapi.coverage.contract`, `problem-details.contract`, `schemathesis.light.contract` | `contract`, inside both `integration` jobs | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |
| `migrations.admission.guard` | `guard`, and on the merged reports | [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149) |

Required CI runs the database property project at 200 runs and at most 60 model commands.
Nightly budgets are reported separately below; a required CI pass does not stand in for a nightly
execution.

## Cross-cutting gates

| §3 gate | Result and evidence |
|---|---|
| Build matrix, types and lint | PASS, [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149): Linux and Windows build, type and lint tasks, and the Linux static gates. |
| Format, Knip, dependency identity, boundaries, environment lists, audit and dedupe | PASS, `static` in [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149). The registry audit ran on Actions; the local audit limitation below remains. |
| Authorization route policy, acceptance map and declared non-goals | PASS, `static`, including every name due at M2. |
| Generated artifacts, API lint and licences | PASS, `static`, with live schema parity on both integration engines. PSF-2.0 joined the licence allowlist on 2026-09-21 with the owner's approval (M2-progress.md). |
| Coverage | **90.4% statements / 83.64% branches / 91.41% functions / 91.92% lines** in [107756416221](https://github.com/Mythikos/iridium/actions/runs/36031452149/job/107756416221). The merged lanes contain 9,840 passes and 84 skips; the merge then passes all 27 guard files (465 passes, 10 future skips), and `check-openapi-coverage` confirms all 303 documented `(operationId, status)` pairs were exercised. The per-file `authz/**` 100% gate passes. Artifact `merged-reports` is `10824537407`, digest `sha256:28cf191fda02a821af2a7db46df36d3bbfa1dc08b542c4cc7ab7ebadfc4331e2`. |
| Mutation | PASS. The full-scope nightly campaign scores **72.82%** against the unchanged threshold of 70 in rehearsal [36010848566](https://github.com/Mythikos/iridium/actions/runs/36010848566), job [107670858461](https://github.com/Mythikos/iridium/actions/runs/36010848566/job/107670858461), on `1e43aae`. The same score appears in scheduled nightly [35972887539](https://github.com/Mythikos/iridium/actions/runs/35972887539) and in the first campaign after the `PIPELINE_VERSION` advance, [35835692071](https://github.com/Mythikos/iridium/actions/runs/35835692071/job/107098477330). These campaigns are incremental and reuse prior mutant results; reused results are not described as newly executed. The exit commit's scoped check is in the required-check table. |
| Spikes and decisions | PASS, `docs.spikes.spec` in [36031452149](https://github.com/Mythikos/iridium/actions/runs/36031452149). D12-20 is amended twice during M2 (2026-09-23 and 2026-09-24), in the decision log and its ADR. |
| Nightly health | PASS; see the next section. No job is red for three consecutive runs at exit. |
| Version and tag | The root and every versioned workspace are `0.2.0`, applied in `fba2ca7` with their changelogs; no changeset is pending and there is no version-PR job. Product `v0.2.0` is hand-cut on this record commit. |
| Upgrade fixture | CI exit rehearsal [36010966534](https://github.com/Mythikos/iridium/actions/runs/36010966534), MySQL 8.4 producer [107671831387](https://github.com/Mythikos/iridium/actions/runs/36010966534/job/107671831387), wrote artifact `10814271444` (`upgrade-fixture-M2`, digest `sha256:45ca7374d49d74e3ceaf52bf4d46b67e5736786f8d0e3a1fba236dc8d1eecfdf`) from `1e43aae` at `2026-09-24T14:19:46.434Z`. Its manifest records pipeline version 3, 59 migrations, 20,000 nodes, 7 notes and 1 attachment. The 1,904,640-byte dump has SHA-256 `340035c83e6dc6c7c447d7c261394f509a264ab5fc790450160ea668c7fa84a4`, and the manifest's SHA-256 is `f6ea4e0cef6aa44a82d9e72369454bfac249508fd2cd0ef70702d7caa5980fb2`. `bd14186` commits the manifest, dump and grants byte for byte, plus the one attachment the manifest lists; the artifact also carried the previous fixture's attachment, and that commit's writer and reader repairs are recorded below. Both required integration jobs of the exit commit restore the committed fixture, apply current migrations and serve its content and attachment bytes (`seed.structure.integration`). Schema, seeder and dump inputs are unchanged between the producer and the exit commit. |

## Nightly workflow history

GitHub's workflow history captured at 2026-09-24 contains these runs since M1's exit. Every row
keeps its actual source, trigger and result.

| Run / source | Trigger and start | Workflow result | Extended property | Chaos | Mutation | Flake hunt | Full API |
|---|---|---|---|---|---|---|---|
| [35546980998](https://github.com/Mythikos/iridium/actions/runs/35546980998) / `ed62205` | Manual 2026-09-21 | failure | 2 pass | 8 pass | pass | pass | 2 fail |
| [35578038042](https://github.com/Mythikos/iridium/actions/runs/35578038042) / `0c82bd1` | Scheduled 2026-09-21 | failure | 2 pass | 8 pass | pass | pass | 2 fail |
| [35703215631](https://github.com/Mythikos/iridium/actions/runs/35703215631) / `63d0c5d` | Scheduled 2026-09-22 | failure | 1 pass, 1 fail | 5 pass, 3 fail | pass | pass | 2 fail |
| [35835692071](https://github.com/Mythikos/iridium/actions/runs/35835692071) / `c8f30eb` | Scheduled 2026-09-23 | failure | 1 pass, 1 fail | 6 pass, 2 fail | pass | pass | 2 fail |
| [35940812349](https://github.com/Mythikos/iridium/actions/runs/35940812349) / `071d96e` | Manual M2 rehearsal 2026-09-24 | failure | 1 pass, 1 fail | 7 pass, 1 fail | pass | pass | 2 fail |
| [35958526463](https://github.com/Mythikos/iridium/actions/runs/35958526463) / `663724e` | Manual M2 rehearsal 2026-09-24 | failure | 2 pass | 8 pass | pass | pass | 1 pass, 1 fail |
| [35972887539](https://github.com/Mythikos/iridium/actions/runs/35972887539) / `5798fed` | **Scheduled** 2026-09-24 | **success** | 2 pass | 8 pass | pass | pass | **2 pass** |
| [36010848566](https://github.com/Mythikos/iridium/actions/runs/36010848566) / `1e43aae` | Manual M2 rehearsal 2026-09-24 | failure | 2 pass | 8 pass | pass | fail | **2 pass** |

`schemathesis-full` and `mysql-matrix-extended (schemathesis, 300)` had been red on every run since
M1, which blocked the exit under §3's rule that a job red for three consecutive runs blocks until
it is green. Both pass in scheduled nightly
[35972887539](https://github.com/Mythikos/iridium/actions/runs/35972887539) and again at M2
rehearsal scope in [36010848566](https://github.com/Mythikos/iridium/actions/runs/36010848566),
where the administrator and outsider profiles took 41 and 35 minutes under the D12-20 budgets. The
extended property and chaos failures of 2026-09-22 to 2026-09-24 each named a defect repaired
below, and have been green in the three runs since. `flake-hunt`'s one red run is the isolation
timing statistic repaired in `46352e4`. Scheduled runs gate at `CURRENT` (M1) scope, which is why
the M2-scope evidence comes from the rehearsals; mutation above is the full-scope figure.
`mysql-innovation` and `node-26` carry `continue-on-error` and are dispositioned below, not
counted.

## Review findings and remote repairs

The defects the first remote lanes found through 2026-09-23 are recorded in
[M2-progress.md](M2-progress.md) ("Defects the first remote lanes found"). Those found after that,
in commit order:

- **`3df7614`: the administrator fuzz profile aborted its own stateful phase.** Dropping a case
  with a null path parameter by raising `reject()` from `before_call` was reported as a hook error.
  A `filter_case` hook now drops those cases before they are drawn. `missing_required_header` also
  admits `409 vault_archived`, which authorization answers before any handler reads `If-Match`.
- **`663724e`: a descendant walk re-read the whole vault once per node.** In a flat vault of 4,880
  notes the optimizer chose `ix_nodes_vault_deleted` or `ix_nodes_vault_name` for the recursive
  member, and a note create that projected a link ran past the query deadline (15 s against 10 ms
  pinned). The five descendant walks name `ix_nodes_vault_parent` with `JOIN_INDEX`
  (03-data-model.md §6.3), and `tree.descent-plan.integration` plans each one on both lines.
- **`5cfb250`: the chaos collaboration port could be taken before it was bound.** It is now
  reserved below the kernel's ephemeral range.
- **`d7685af`: live revocation was timed from the request instead of from COMMIT**, which
  04-auth-and-access-control.md §8.8 names. Each case now times from the `AuthzBus` publication.
- **`1e43aae`: the full fuzz profiles were sized to a truncated run.** Their deadlines are 120
  minutes and `schemathesis-full` has a 270-minute job timeout, at the owner's choice to keep 250
  examples and every phase (D12-20, amended 2026-09-24). A run that reaches its deadline now reports
  the fuzzer's output so far.
- **`177915f` and `f6cae7b`: an id's vault and the caller's access are resolved in one
  statement.** A foreign node, note, attachment or job id had cost two statements and an unknown id
  one. Both now cost the same single statement, joined to `vaults` as the foreign key it is, and the
  route-policy unit test asserts that a missing and a found id run the same statement.
- **`bd14186`: the upgrade fixture writer mixed runs.** It wrote over the checked-out directory, so
  the uploaded artifact carried the previous fixture's attachment as well. The writer now clears the
  attachment tree and the reader refuses one that is not the manifest's inventory.
- **`46352e4`: the isolation timing check compared the wrong statistic.** It sampled foreign and
  missing ids in adjacent pairs but compared the two sides' own medians, so a noise burst on the
  runner could fail it (2.44 for pairs whose median ratio was 1.13). The bound of 2 now applies to
  the median of the per-pair ratios, which peaks at 1.46 across every recorded run.

**Correction.** `177915f`'s message attributes the 2.2× `nodes.inboundLinks` failure to the extra
statement. The per-pair ratio of those same samples is 1.29: the statement was a real, small
difference, and most of the 2.2 was the statistic that `46352e4` replaced. The resolver change
stands on its own; the unit assertion, not the timing bound, is what guards it.

## Dispositions

- **`mysql-innovation`** (advisory, `continue-on-error`): on the MySQL innovation line every
  integration file passes except `db-grants.integration`, the one that asserts the exact grant
  matrix. It is recorded, not counted. Iridium's required lines are 8.4.11 and 9.7.2 only.
- **`node-26`** (advisory): passes in every run above.
- **Outstanding local checks**, unchanged from M1: macOS Electron (no local macOS host) and a fresh
  local registry audit (egress approval). The remote results stand in their place and are recorded
  separately.
- **`perf`, `load`, `conformance-all`, `compose-boot`, `mcp-clients`, `backup-restore-drill`** are
  scheduled for later milestones and skipped at M2.
