# D12-22: integration suites are scheduled with their routes

Status: accepted 2026-09-25.

An integration suite is first scheduled at the milestone that ships the routes it covers, and a later milestone's additions mark its row "(extended)" with only that milestone's clauses. Three suites are therefore M3 rows of 12 §7.4 (lane `integration`), extended at M7 in §11.4:

- `admin.tokens.integration` covers the four M3 admin token routes (D06-02 as amended): only server administrators pass, a token principal being refused with `403 token_scope_insufficient`; step-up on the three mutations; each action audited (`token.revoked` with the administrator's reason only in its metadata, and `token.revoked_all` in D04-19's shape); `lastUsedSummary` equal to the `access_log` aggregate read through the testkit's flushing reader; each revoked PAT's next ★ REST call answering `401 unauthenticated`; `kind='oauth'` rows listed with their client and `consentId`, their revocation's consequence proven by `oauth.revocation.mcp`; no response carrying a secret; admin-owned rows marked. M7 adds `admin.tokens.get`, `admin.tokens.update` (`If-Match`, the 60–100 000 range, the `null` fallback) and `admin.tokens.activity`.
- `admin.settings.integration` covers AG12's three groups: `GET`'s `effective`, `floors` and `stored` each carry exactly `{patPolicy, mcpEnabled, oauthPolicy}`, and a `PUT` carrying an M7 group is `422 validation_failed`, beside D09-10's case list. M7 adds `sessionPolicy`, `passwordPolicy`, `retention` and `desktopUpdatePolicy`, the console and `GET /desktop/update-policy`.
- `agent-activity.integration` covers `me.tokens.activity` and `vaults.agentActivity`: owner-only reads (a foreign token id and a `kind='oauth'` token id answer `404`); a manager of vault A never sees a vault B row for a token that read both; a non-manager is refused; keyset paging on the access cursor, the bounded `occurred_at` window and `allowArchived` on an archived vault. M7 adds `admin.agentActivity.list`, `admin.agentActivity.export` (streamed, the same rows as the filtered view, audited) and `admin.tokens.activity`.

`token-list.component` joins 12 §8.4's component table and `token-create-and-use.e2e` its Playwright `chromium` table, scheduling both at M4 through the exit-table authority rather than inheriting M3 from 15's fallback. D10-10's coverage gate thereby has a test for every M3 route pair at M3.

A suite scheduled only at the milestone that completes its route set leaves the earlier routes without their integration test in the milestone that ships them, which the coverage gate refuses; marking later clauses "(extended)" keeps one suite per area without claiming work a milestone has not done.

Verification: `admin.tokens.integration`, `admin.settings.integration` and `agent-activity.integration` at M3, extended at M7; `pnpm gen` regenerates `docs/acceptance-map.json` from 12 §7.4 and §11.4.

Source: D12-22 in [the decision log](../plan/13-decision-log.md) and in [12-milestones.md](../plan/12-milestones.md), "Decisions made in this section".
