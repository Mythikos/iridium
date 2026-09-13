# A12 — Tree model: adjacency list with a real root row, derived paths, per-vault mutex

**Status:** Accepted (2026-09-11).

## Context

Categories and notes form a tree with filesystem-like naming (spec §2–§3): unique names among live siblings, rejected cycles, cross-vault moves refused, trash that frees the name. Digest §5.2 verified: InnoDB allows `UNIQUE` on virtual generated columns (partial-unique emulation for soft delete); `NULL`s are distinct in unique indexes (so a nullable `parent_id` root defeats sibling uniqueness at the top level); locking reads in an outer statement do not lock rows read inside a recursive CTE (so `FOR UPDATE` over a CTE is not a mutex); `utf8mb4_0900_as_ci` gives accent-sensitive, case-insensitive names (Windows/macOS-compatible export). The agent-first plan stored a materialised `path`; the digest's Topic 5 recommendation was "paths derived, never stored".

## Decision

`nodes.parent_id NOT NULL` with a real root row per vault (`parent_id = id`; CTEs stop at `id = parent_id`; `vaults.root_node_id`); `UNIQUE uq_sibling(parent_id, name, live)` where `live` is `TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL`; `name VARCHAR(255) COLLATE utf8mb4_0900_as_ci`; paths derived by one recursive CTE per request (the per-vault in-process path cache keyed by `vaults.tree_version` is the designated optimisation, added only when measured p95 `list_notes` > 200 ms at 20 000 nodes); every structural transaction runs at `REPEATABLE READ` and begins with `SELECT id, tree_version FROM vaults WHERE id=? AND status='active' FOR UPDATE` (`db/withVaultLock.ts`); a move runs the recursive ancestor walk of the target parent and refuses if it contains the moving id; depth ≤ 64; `vaults.tree_version` is bumped in every structural transaction and broadcast on the vault channel (A18); name rules: no `/`, `\`, or control characters, no leading/trailing spaces or dots, not `.`/`..`, ≤ 255 bytes, reserved Windows names rejected; `vault_id` is immutable (cross-vault moves rejected). Trash is modelled by `trash_entries` with `cascade_root_id` as the restore unit.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Materialised `path`/`path_key` (agent-first ADR-15) | Every rename/move rewrites a subtree; the stored path can disagree with the parent chain; derived paths cannot. |
| Closure table | Write amplification on move; a second structure to keep consistent. |
| Nullable `parent_id` root | `NULL`s are distinct in `UNIQUE`, so two root-level notes could share a name. |
| `utf8mb4_bin` names | Case-sensitive siblings ("Notes" and "notes") break export to Windows/macOS filesystems. |
| Relying on `FOR UPDATE` over the CTE | Verified not to lock base rows; the vault-row mutex is the only correct serialisation. |

## Consequences

Positive: O(1) writes for rename/move; sibling uniqueness survives soft delete; the vault mutex makes structural concurrency deterministic (spec §9 "Structural concurrency"); Obsidian-like naming semantics. Negative: path derivation is a CTE per request (bounded by `cte_max_recursion_depth=200` and depth ≤ 64); the per-vault mutex serialises structural writes per vault (acceptable — they are low-rate).

## Verification

`tree.structural-concurrency.integration`, `tree.stale-resurrection.integration`, `hierarchy.model.prop` (fast-check model of a tree against the SQL implementation), `contracts.paths.unit`, `lock-order.integration` (M2 gates); perf budget for `list_notes` at 20 000 nodes (M8 load lane).

## References

Digest §5.2 (generated columns, CTE locking, collations), digest Topic 5 recommendation; judges 1–3; plan-risk-first ADR-14; plan-enterprise ADR-24. Implemented in `03-data-model.md` and `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A12. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
