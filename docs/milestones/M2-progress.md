# M2 working record

M2 implementation and exit validation are in progress. `CURRENT` remains M1. This is local working evidence, not an exit declaration or a remote CI result. The working tree prepares version 0.2.0 across the root and 23 workspaces; no M2 implementation commit or tag exists yet.

## Implemented

- Vault settings/archive, structural CRUD and version checks, paths, closing-set coordination, trash/restore/purge and vault-channel notifications.
- Pipeline v2 with source-preserving Markdown, frontmatter and links, sanitized rendering, bounded workers, committed reads, full-text search, snippets, named revisions and atomic minimal-diff restore.
- Filesystem/S3 attachments, streamed validation, ranges, deduplication, retained-history references, maintenance jobs, resumable reindex, retention, audit archive and operator commands.
- A 62-operation REST surface, real-response OpenAPI checks and previous-release wire baselines captured from the immutable `v0.1.0` tag.
- Migrations 0056–0059 replace unsupported high-cardinality JSON indexes with indexed derived terms and widen raw frontmatter. Historical migrations remain unchanged. The complete selected path is inspected before any migration executes; long-running 0056 and 0059 require the operator's explicit `--allow-long-running` flag. Boot remains available for diagnostics while refusing product traffic until migration completes.
- Publication takes the vault shared lock before its first snapshot read. Purge fences writers under a short exclusive lock, waits for disposal outside that lock, then reacquires it and revalidates. Raw durable append remains independent of the publication gate.

## Local evidence through 2026-09-21 UTC

- The final affected 8.4 lifecycle/authorization cohort passed 212 tests in 21 files, including the 30 audit/trash crash cases and real eight-worker lock-order workload. The corresponding 9.7 cohort passed 214 tests; the two extra cases were added during its run and also passed their separate 8.4 cohort. Reports live under `reports/authz/`.
- The final content cohort passed 54 tests in eight files on 8.4 and 56 in nine files on 9.7, including the real-MySQL 200-case query property, 43 error envelopes, hostile projection, ranking, fallback snippets and immutable N−1 wire checks: `reports/m2-content-compatibility-{8.4,9.7}.json`. The ninth 9.7 file is the lock-order proof also included in the lifecycle cohort; these totals must not be added as unique tests.
- At pipeline v2, full HTTP search over 5,000 notes measured p95 31.5823 ms on 8.4 and 28.8395 ms on 9.7, both below 200 ms. Actual worker dispatch through returned 100 KiB projection measured 31.7797 ms and 31.5112 ms respectively, below 250 ms. Raw samples and corpus hashes are retained in `reports/perf/`.
- The 20,000-node fixture includes seven notes, six resolved links, one PNG and source-normalization metadata. Its backup-role dump was restored with the shipped MySQL client on both required database lines and verified through actual content APIs and the audit verifier. `apps/server/test/fixtures/upgrade/v0.2.0/manifest.json` records the dump and separately archived, unmodified DBA grant artifact. The v0.1.0 fixture hashes are unchanged.
- Migration CLI/boot refusal and explicit admission passed on both database lines. Full Unicode frontmatter maxima, real indexed query plans, schema fingerprints, grants, resumed reindex/rebuild and target-lifecycle locking passed their final schema cohorts. Earlier failed runs remain available.
- Attachment/job response coverage passed ten tests on each database line. Search throttling and revision deadline/capacity coverage passed ten on each line, including successful recovery. The REST response matrix passed 15 tests on each database line. The accumulated local OpenAPI recorder now covers all 303 documented operation/status pairs; only a fresh complete CI lane can establish the formal gate.
- S11's original remark candidate failed the browser timing budget. The executed markdown-it fallback measured preview p95 28.8 ms, 100 KiB worker compute p95 37.127 ms and complete browser payload 119,566 gzip bytes. It preserves all 732 corpus sources and passes 1,464 emitted-browser comparisons. The patch keeps the upstream root API and shared grammar intact. Failed experiments remain in the spike evidence; the corpus is representative, not observed pilot usage. The formal note still needs the genuine implementation commit reference.
- The production image builds and passes non-root/read-only runtime checks and explicit migration admission on both databases. This local image has commit `unknown`; it is not the release image or a publication claim. A stale access-log partition readiness placeholder found by this check is being replaced with an actual database probe.
- Full build, native TypeScript project references, ordinary and type-aware lint, boundaries, production Knip and dependency deduplication pass. The latest unit/component/guard run passed 4,502 tests with ten conditional skips and two failures: a corrected CLI usage spacing expectation and the intentionally missing S11 implementation-commit reference. The remaining guard must pass after the implementation is committed.
- The high-severity audit gate passes with three moderate advisories. The exact-version argparse 3.0.2 PSF-2.0 exception is prepared for owner review; it is not active and no approval or issue has been invented.

## Remaining exit work

Complete live migration/readiness recovery checks, generated-artifact and final static checks, the fresh full database lanes, merged coverage, full-scope mutation, Schemathesis light and remote Linux/Windows/macOS requirements. Record the actual implementation commit, close the license decision, obtain required remote CI results and publish the tagged image with its architecture, SBOM and scanner evidence before advancing `CURRENT`.

The owner requires direct commits and pushes to main. Branch protection is deferred under section 13.3 and is not an additional M2 approval gate. This record does not authorize M3 work.
