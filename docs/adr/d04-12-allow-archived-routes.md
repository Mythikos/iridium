# D04-12: archived-vault administrative reads

Status: accepted (2026-09-11); amended 2026-09-25: `ALLOW_ARCHIVED_ROUTES` is the closed set of four, a route carries the flag by a stated rule, and the boot assertion refuses a vault-scoped administrative read that lacks it.

**As accepted.** The `allowArchived` route flag, permitted only on the two routes of `ALLOW_ARCHIVED_ROUTES` (`POST /vaults/:vaultId/unarchive`, `GET /vaults/:vaultId/audit`) — the escape hatch and the one read whose permission is outside `READ_BUNDLE` — is the single exception to the archived-vault write freeze, and the boot assertion both enumerates its users and rejects it on any route whose permission is already in `READ_BUNDLE`. Unarchiving must be possible without weakening the freeze for anything else, including server administrators; a no-op flag on a read route would suggest the freeze had been lifted where it had not.

**Amended 2026-09-25.**

- **The set.** `ALLOW_ARCHIVED_ROUTES` is the closed set of four: `POST /vaults/:vaultId/archive`, whose handler answers the already-archived state with `409 invalid_state` (09-api-reference.md §2.5); `POST /vaults/:vaultId/unarchive`; `GET /vaults/:vaultId/audit` (M7); and `GET /vaults/:vaultId/agent-activity` (M3; `ROUTE_POLICIES['vaults.agentActivity'] = {permission: 'vault:settings', vaultFrom: 'params.vaultId', allowArchived: true}`).
- **The rule.** A route carries `allowArchived` if and only if its permission is outside `READ_BUNDLE` and it is either a `GET`/`HEAD` read of that vault's administrative data or one of the two archive-state transitions, whose handler answers the archived state itself.
- **The boot assertion** also refuses a vault-scoped `GET`/`HEAD` route whose permission is outside `READ_BUNDLE` and which lacks the flag, so 04 §5.6's "reads allowed" holds by construction. A `HEAD` twin maps to its `GET`, so `exposeHeadRoutes` cannot trip it. 06's token and activity table and 09 §2.15.2 state the flag on the agent-activity route, as 04's matrix notes already do for the audit route.

A read of a vault's own administrative data is what an archived vault's manager still needs, and a rule stated once, with a boot refusal for its converse, keeps the next such route from being frozen by omission.

Verification: `authz.archived-vault.integration` (a safe-method partition: the mounted safe-method, vault-scoped, non-`READ_BUNDLE` routes equal the mounted `GET` members of the set, and each answers `200` to the vault's manager on an archived vault; the write partitions are unchanged, `FROZEN_OPERATIONS` and `LIFTED_OPERATIONS` = archive and unarchive) and `agent-activity.integration` (the `200` on an archived vault).

Source: the D04-12 amendment in [the decision log](../plan/13-decision-log.md), and D04-12 in [04-auth-and-access-control.md](../plan/04-auth-and-access-control.md), "Decisions made in this section".
