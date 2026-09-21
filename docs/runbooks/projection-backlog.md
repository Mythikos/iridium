# Projection backlog

Never lower MySQL durability settings to clear a backlog. Never hand-edit projection, snapshot or sequence rows; use the audited maintenance commands.

## Symptoms

Search stays `stale: true`, content reports a projected revision below the head, or `iridium doctor --stale-projections` reports pending/error/timeout work. The editor can truthfully show Saved while search reflects an earlier committed projection.

## What the system is already doing

Acknowledged updates persist before projection. CPU parsing runs in a bounded Piscina pool outside SQL row locks. A timeout terminates the worker; source remains durable and readable. Projection, search, links and sequence bookkeeping publish atomically. Reindex reads durable source with bounded keyset pages and a stored progress cursor. It does not load an editing document or rewrite note text.

## Triage

1. Run `iridium doctor --heads --stale-projections --json`. Separate inconsistent heads from projection lag. Lag is grouped into less than one minute, one minute to one hour, and at least one hour. Invalid-content notes are excluded from rebuild candidates.
2. Check `/readyz` for worker-pool, writer backlog, owner-lease and database health. Inspect `projection.timeout`, `projection.completed` and maintenance errors by job/request id.
3. Run `iridium jobs list --type reindex --json`. Inspect status/progress before submitting another rebuild. Check `iridium_projection_duration_seconds` and `iridium_projection_timeouts_total` alongside CPU/database saturation.

## Resolution

Use `iridium reindex --stale --json` for ordinary lag, `iridium reindex --vault <vault-uuid> --json` for a vault, or `iridium reindex --note <note-uuid> --json` for a note. After a pipeline upgrade, use `iridium reindex --pipeline-version --json`.

The command prints its durable job id to stderr and waits for the actual owner. Explicit jobs run even when automatic scheduling is disabled. `REINDEX_RATE_PER_SECOND` controls admission; address saturation before increasing it. An interrupted job retains its committed work/cursor. A new selection also finds newly stale ids earlier than a prior cursor.

Inspect pathological notes when timeouts recur. `too_large` and `too_complex` are explicit classifications, not permission to discard source. The global pipeline marker advances only after the full eligible selection completes. A fresh read or collaboration flush can publish one note on demand; their rate budgets make them unsuitable as bulk-rebuild loops.

For inconsistent bookkeeping, review `iridium doctor --repair-heads --dry-run --json` first. Stop the serving process before a confirmed repair takes its owner lease. Repair refuses loaded notes and projections ahead of the durable log; those require recovery from a verified backup. Apply `--yes` only after reviewing the proposed values.

## Verification

The job must finish `succeeded`. Repeat doctor, confirm pending/error/timeout counts drain, and check representative search hits show the published revision with `stale: false`. Confirm rebuild leaves original Markdown and durable heads unchanged. Verify readiness and check for a continuing timeout loop.

## Follow-up

Retain job output, source-free diagnostics and performance measurements. Add the triggering note shape to the hostile/pathological corpus when appropriate. Recheck the real worker and 5,000-note search budgets after parser/index changes; do not raise limits to conceal a regression.
