# A13 — Optimistic concurrency: `version` CAS and `If-Match` on REST

**Status:** Accepted (2026-09-11).

## Context

Spec §6: "Hierarchy, names, permissions, and deletion use database transactions and metadata version checks; they do not become safe merely because document text uses CRDTs." Spec §9 requires concurrent rename/move/delete to "succeed consistently or return an explicit conflict". Version restore must succeed while other people are typing, so it cannot be conditioned on the note's `head_seq` (which changes per keystroke).

## Decision

Every mutable metadata row carries `version INT UNSIGNED NOT NULL DEFAULT 1`; every update is `UPDATE … SET version = version + 1 WHERE id = ? AND version = ?` asserting `numUpdatedRows === 1n` (A10's `FOUND_ROWS`). REST exposes `ETag: "<version>"`. `If-Match` is **required** on `PATCH /nodes/:nodeId`, `POST /nodes/:nodeId/trash|restore`, `PATCH /vaults/:vaultId`, `PUT`/`DELETE /vaults/:vaultId/members/:userId` (for an existing row), `PATCH /me`, `PATCH /admin/users/:userId`, `PATCH /admin/tokens/:tokenId`, `PUT /admin/settings`, and `DELETE /vaults/:vaultId/attachments/:attachmentId` — the list `09-api-reference.md` §1.2 publishes, and the `If-Match` column of its route table is what `rest.route-index.contract` compares against `openapi.json`: missing → `428 precondition_required`; mismatch → `409 stale_version` with the `current` representation in the ProblemDetails body. The validator each one compares against is the `ETag` of the matching read (`GET /nodes/:nodeId`, `GET /vaults/:vaultId`, `GET /auth/me`, `GET /admin/users/:userId`, `GET /admin/settings`), except member, token and trash rows, which carry `version` in the collection body only so a list view can supply `If-Match` without a second request. Structural conflicts are explicit: `409 name_conflict` (from `ER_DUP_ENTRY` on `uq_sibling`), `409 invalid_move`, `409 category_not_empty`. The note body is CRDT and exempt. Version restore takes `{revision}` in the body with UI confirmation and step-up (A26), and **no** `If-Match` on `head_seq`.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| `If-Match` on `head_seq` for restore | Changes with every keystroke; restores during active editing would never succeed. |
| Last-writer-wins on metadata | Violates spec §6 and §9. |
| Optional `If-Match` | Clients that omit it would silently overwrite; `428` makes the contract unmissable. |

## Consequences

Positive: every conflict is explicit and carries the current row for the UI to re-render; the CAS is one statement, no advisory locks. Negative: clients must thread ETags through every mutation (the generated API client does this); `409 stale_version` on the tree is common under live collaboration and the UI must handle it as a normal path (rename dialog refresh, not an error toast).

## Verification

`tree.structural-concurrency.integration` (`Promise.all` of conflicting rename/move/trash → exactly one 409 or both succeed with a valid tree); `authz.rest-viewer.integration` (every mutating route); `toMatchOpenApi(operationId, status)` (the 428 and 409 shapes); `revisions.restore.integration` (restore succeeds during active edits).

## References

Spec §6, §9; digest §5.2 (`FOUND_ROWS`); plan-risk-first + plan-product-dx §3.6 concurrency contract; judge verdict on restore. Implemented in `03-data-model.md` and `09-api-reference.md`.

---

## Area 3 — Collaboration engine and durability

---

Source: docs/plan/13-decision-log.md, decision A13. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
