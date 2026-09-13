# A30 — Permission matrix and `authorize()`: one static matrix, one function, 404 for non-members

**Status:** Accepted (2026-09-11).

## Context

Spec §4 fixes the roles (viewer, editor, vault manager, server administrator), states that permissions apply to the whole vault and are inherited by every child object and by history, search, attachments, and exports, and requires server-side enforcement for REST, collaboration connections and incoming edits, attachments, search, history, and exports — with the explicit rule that "knowledge of a note ID must not grant access". Spec §9's "Vault isolation" row tests it with guessed IDs. Digest §6.2 records the OWASP authorization guidance: deny by default, centralized middleware, never trust client-side checks, never rely on unguessable IDs, fail closed with generic errors. Three credential kinds (session, PAT, CLI) and three surfaces (REST, WebSocket, MCP) must share one decision function or they will diverge.

## Decision

One static matrix and one function.

- Roles are ordered `viewer < editor < manager`. `users.is_server_admin` is treated as manager on every vault plus the `server:*` permissions — **for user principals only** (A31/F4: admin-implied access never flows into a token).
- Permissions. Read: `vault:read`, `note:read`, `search:read`, `history:read`, `attachment:read`, `export:read`. Editor adds `note:write`, `node:create`, `node:rename`, `node:move`, `node:trash`, `node:restore`, `attachment:write`, `revision:name`. Manager adds `vault:manage_members`, `vault:settings`, `vault:archive`, `history:restore`, `node:purge`, `import:commit`. Server admin adds `server:users`, `server:vaults:create`, `server:settings`, `server:audit:all`, `server:tokens:all`, `server:sessions:all`, `server:jobs`, `server:releases`.
- `authorize(principal, permission, {vaultId?}) → 'allow' | {deny: 'not_found' | 'forbidden' | 'step_up_required'}` is the only decision point.
- Token principals get `scopes ∩ permissionsOf(live explicit role)`, restricted to `vaultId ∈ allowlist`, and gated by the MCP kill switches.
- An archived vault allows reads only. Vaults in `importing` or `deleting` status are invisible.
- Every route declares `config.auth = {permission, vaultFrom: 'params.vaultId' | 'node:params.nodeId' | 'note:params.noteId' | 'attachment:params.attachmentId'}` or `{public: true}` / `{serverAdmin: true}` / `{self: true}`. The vault is resolved before the handler runs, and every query carries `WHERE vault_id = ?`.
- Non-members receive **404** for every vault-scoped resource; members lacking a permission receive **403** (F13).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Per-handler permission checks | Guarantees drift between REST, MCP, and collaboration; nothing can assert completeness. The boot-time route-policy assertion only works because the policy is declarative. |
| An ABAC or policy-engine dependency (OPA, Cedar, CASL) | The MVP has no per-note ACLs (spec §4) and no customer-defined roles; a static matrix is fully testable and has no policy-language failure mode. The `authorize()` signature is the seam if that changes. |
| 403 for non-members | Confirms a vault or note exists to someone who guessed its ID, failing the "Vault isolation" acceptance row. |
| Role ranks compared numerically at the call site | Invites `>=` bugs; permissions are named and looked up in the matrix. |
| Letting server-admin status flow into token principals | An administrator's agent would read the entire server from one leaked token (F4). |

## Consequences

Positive: one function to test exhaustively, and one property test asserting `rightsOf(token) ⊆ rightsOf(owner)`; a new route cannot ship without a policy, because the process refuses to boot; the 404 rule is uniform, so there is no resource where the error shape leaks existence. Negative: the 404-for-non-members rule makes some support conversations harder ("the link is broken" versus "you do not have access") — the UI compensates with an explicit "you may not have access to this vault" empty state; the matrix must be edited, and its test updated, for every new capability (deliberate friction).

## Verification

`authz.matrix.unit` (every role × permission cell, including archived-vault read-only and `importing`/`deleting` invisibility); `authz.route-policy.boot.guard` (every route declares `config.auth`); `authz.vault-isolation.integration` (guessed IDs across REST, WebSocket, MCP, attachments, search, history, export all return 404); `authz.rest-viewer.integration` and `collab.viewer-enforcement.integration` (the "Viewer enforcement" acceptance row); `token.effective-permissions.prop` (token rights are a subset of the owner's live rights); 100 % per-file coverage on `authz/**` (A51).

## References

Digest §6.2 (OWASP authorization); spec §4, §9; plan-risk-first ADR-11; F13, F4. Implemented in `04-auth-and-access-control.md`, `06-mcp-and-agent-access.md`, `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A30. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
