# AG12 — The M3 settings store and `/admin/settings` carry only `mcpEnabled`, `patPolicy` and `oauthPolicy`

**Status:** Accepted (2026-09-24), answering G12. Supersedes in part `12-milestones.md` §11.2's scheduling of `GET` and `PUT /admin/settings` and of every settings group at M7, and ARCH-10 and D09-10 as to which groups the document carries before M7 (both amended 2026-09-25).

## Context

M3 needs the settings store and `PUT /admin/settings`: the server-wide MCP kill switch of 06 "Kill switches" is flipped through it, `mcp.revocation.mcp` exercises that flip, and `settings-store.contract` is an M3 row. Yet `12-milestones.md` §7.2 registered neither, and §11.2 scheduled the routes and all seven groups of 03 §13.1 at M7. Shipping the full seven-group document at M3 would let `PUT` accept values no M3 code honours: the session TTLs, the step-up window, the password policy, the retention jobs and `GET /desktop/update-policy` all still read the environment until M7 rewires them. On 2026-09-24 the owner answered G12; the owner's words, the reading applied and where each consequence lives are recorded in `14-risks-and-open-questions.md` §G.

## Decision

*Scope.* M3 ships the `SettingsStore`, `GET` and `PUT /admin/settings` (operation ids `admin.settings.get` and `admin.settings.update`; `serverAdmin`; `PUT` requires step-up and `If-Match`; audited `admin.settings.changed`) and exactly the `patPolicy`, `mcpEnabled` and `oauthPolicy` groups with all their 03 §13.1 members, each of which an M3 consumer reads: token create and rotate, the `/meta` policies, the per-credential budget (D04-37), the all-vaults choice (D06-51), `mcpKillSwitch`, `authorize()`'s server switch, `accessibleVaultIds` and the authorization server.

*The M7 groups.* `sessionPolicy`, `passwordPolicy`, `retention` and `desktopUpdatePolicy` are absent from the M3 document. Their consumers — the session TTLs, the step-up window (`STEP_UP_WINDOW_MIN`, the consent page's step-up included), the password policy, the retention jobs and `GET /desktop/update-policy` — keep reading `EnvSchema` until M7 adds each group in the change that rewires its consumer to `SettingsStore.effective()`. At M3 the wire schemas are strict objects of the three groups, so a `PUT` naming any M7 group is `422 validation_failed`. No milestone accepts a setting the server does not honour.

*Where it lives.* The store and routes are the `apps/server/src/settings/` module (ARCH-31); the document's shape, versioning and validation are D09-10 as amended, the store's lifecycle ARCH-10 as amended, and the member vocabulary D03-28. A policy never changes the route table: `POST /oauth/register` stays registered while `MCP_OAUTH_ENABLED`, and its gate answers `404` while registration is disabled (D06-33 as amended).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| The full seven-group document at M3 | `PUT` would accept, store and echo values for groups whose consumers still read the environment, so an administrator could set a policy the server silently ignores. |
| No settings store until M7 | The MCP kill switch, the PAT and OAuth policies and the registration switch are M3 surfaces with M3 tests; each would need an environment-only interim path and a second migration to the store. |

## Consequences

Positive: every value `PUT /admin/settings` accepts at M3 is enforced on the next call; the M3 document is small enough for its contract suite to cover every member. Negative: until M7 an operator changes the session, password, retention and desktop-update policies only through the environment and a restart, and each M7 group lands with a rewiring of its consumers rather than as a pure addition.

## Verification

`admin.settings.integration` (`GET`'s `effective`, `floors` and `stored` each carry exactly `{patPolicy, mcpEnabled, oauthPolicy}`, and a `PUT` carrying `sessionPolicy`, `passwordPolicy`, `retention` or `desktopUpdatePolicy` is `422 validation_failed`), `settings-store.contract`, and `mcp.revocation.mcp` (the kill switch flipped through `PUT`).

## References

Owner's answer to open question G12, 2026-09-24 (`14-risks-and-open-questions.md` §G); ARCH-10, ARCH-31, D03-28 and D09-10 (the store, the module, the vocabulary and the document); 06 "Kill switches"; `12-milestones.md` §7.2, §7.4, §11.2 and §11.4. Implemented in `02-system-architecture.md`, `03-data-model.md`, `09-api-reference.md`, `10-testing-and-quality.md` and `12-milestones.md`.

---

Source: docs/plan/13-decision-log.md, decision AG12. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
