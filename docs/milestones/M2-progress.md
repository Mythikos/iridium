# M2 working record

M2 implementation is committed and exit validation is in progress. `CURRENT` remains M1. This is local working evidence, not an exit declaration or a remote CI result. The tree carries version 0.2.0 across the root and 23 workspaces; no `v0.2.0` tag exists.

## Implemented

- Vault settings/archive, structural CRUD and version checks, paths, closing-set coordination, trash/restore/purge and vault-channel notifications.
- Pipeline v2 with source-preserving Markdown, frontmatter and links, sanitized rendering, bounded workers, committed reads, full-text search, snippets, named revisions and atomic minimal-diff restore.
- Filesystem/S3 attachments, streamed validation, ranges, deduplication, retained-history references, maintenance jobs, resumable reindex, retention, audit archive and operator commands.
- A 62-operation REST surface, real-response OpenAPI checks and previous-release wire baselines captured from the immutable `v0.1.0` tag.
- Migrations 0056–0059 replace unsupported high-cardinality JSON indexes with indexed derived terms and widen raw frontmatter. Historical migrations remain unchanged. The complete selected path is inspected before any migration executes; long-running 0056 and 0059 require the operator's explicit `--allow-long-running` flag. Boot remains available for diagnostics while refusing product traffic until migration completes.
- Publication takes the vault shared lock before its first snapshot read. Purge fences writers under a short exclusive lock, waits for disposal outside that lock, then reacquires it and revalidates. Raw durable append remains independent of the publication gate.

## Landed

The implementation is committed. `fba2ca7` carries the whole M2 tree; the nine commits after it
close what a defect audit and the first fresh lane runs on that tree found. `CURRENT` remains M1 and
no `v0.2.0` tag exists.

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

## Remaining exit work

The `chaos` lane, merged coverage and the full-scope mutation campaign have not been measured at M2
scope. Neither required database line has a remote result, and no remote run has seen this tree at
all: the `ubuntu`/`windows` build matrix, macOS Electron and the three-consecutive-green nightly
floor are all outstanding, and the nightly floor is a wait no engineering compresses. `M2-exit.md`
and an M2 section in `remote-ci.md` are unwritten and both depend on those results. The tagged image
with its architecture, SBOM and scanner evidence is unpublished, and `CURRENT` advances only after
all of it.

The owner requires direct commits and pushes to main. Branch protection is deferred under section
13.3 and is not an additional M2 approval gate. This record does not authorize M3 work.
