# D06-03: bounded `token.denied` and `mcp.access.denied` rows, on the resolved vault's chain

Status: accepted; amended 2026-09-25: `mcp.access.denied` goes on a vault's chain only when the vault the call named resolves, and its row and dedupe key carry the resolved vault id or NULL, for cursor refusals too.

**As accepted.** Deduplicate `token.denied` audit rows to one per `token_id` and `mcp.access.denied` rows to one per `(token_id, vault_id, reason)` per 10 minutes — `vault_id` NULL when no vault was named, `tool` recorded in `metadata` but deliberately not part of the key; every denial still writes an `access_log` row (which carries the tool in `action`) and increments a metric. `04-auth-and-access-control.md` §11.4 states the identical key and window, and `audit.bounded-failures.integration` asserts the counts. A revoked token left in an agent's configuration retries indefinitely. Without deduplication it would flood the HMAC-chained audit table, whose value depends on being readable. The unchained access log keeps the full record.

**Amended 2026-09-25.**

- **The chain.** `mcp.access.denied` goes to the `vault:<id>` chain if and only if the call named a vault id that `authorize()`'s vault lookup resolved; otherwise it goes to `server`. The contracts `AuditChainScope` gains `vault_or_server`, `AUDIT_ACTION_CHAIN['mcp.access.denied']` becomes it, and `chainIdFor` returns the vault chain for that scope when given a vault id and `server` when given null. `collab.connection.rejected` stays `vault`.
- **The key and the row.** The row's `vault_id`, its `metadata.vaultId` and the dedupe key `(token_id, resolved vault_id or NULL, reason)` all carry the resolved id or NULL, so a named but unresolved vault id reaches neither a vault chain nor the key. The metadata is `{reason, vaultId?, tool?}` (D04-35), and the window is `AUDIT_DEDUP_LONG_WINDOW_MS` (D04-16 as amended).
- **Cursor refusals** follow the same rule: `{reason: 'cursor', vaultId?, tool}` keyed `(token_id, resolved vault_id or NULL, 'cursor')`, never an unresolved id the arguments named.

Resolving the vault before choosing a chain bounds chain heads and dedupe keys by real vaults: an attacker who names arbitrary vault ids can neither create chains nor grow the gate's key set with them. Rejected: an unresolved vault id as a chain or a key.

Verification: `audit.bounded-failures.integration` and `mcp.isolation.mcp`.

Source: the D06-03 amendment in [the decision log](../plan/13-decision-log.md), and D06-03 in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section".
