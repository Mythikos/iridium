# A31 — PAT / integration token model: id-embedded format, SHA-256 at rest, permission-string scopes, mandatory expiry, rotation, per-call access log

**Status:** Accepted (2026-09-11).

## Context

The brief makes user-granted agent tokens a primary feature: created in the UI, scoped (at minimum vault-scoped and read-only for the MVP), revocable with immediate effect, hashed at rest, and pasted into an agent's MCP configuration. Digest §6.2 verifies the industry patterns: GitHub's format (3-letter prefix, `_` separator so double-click selects the whole token, 30 Base62 random characters, 6 Base62 CRC32 characters enabling offline secret scanning, prefix alone dropping scanner false positives to ~0.5 %), fine-grained PAT lifetime policy (1–366 days, default 366), and rate-limit headers; GitLab's mandatory expiry, `last_used_at` updated at most every 10 minutes, rotation that inactivates the old token immediately while retaining both for audit, and immediate revocation; and Notion's move to a distinct prefix specifically for scanner compatibility. Digest §11.14 records four incompatible formats and three incompatible scope vocabularies across the source plans. Digest §3.2 adds a hard constraint from the MCP SDK: `requireBearerAuth` returns `401 invalid_token` for any `AuthInfo` whose `expiresAt` is unset. A judge review found a gap no plan had closed: a server administrator creating a token would, under a naive "tokens inherit the user's rights" reading, mint a credential that reads every vault on the server.

## Decision

One credential format for every kind, a fast hash with an id lookup, permission-string scopes, and a hard least-privilege rule for administrators.

- **Format** (all kinds): `irid_<kind>_<id16 base62>_<secret43 base62><crc6 base62>`, `kind ∈ {pat, ses, tkt, spl, oat, ort, oac}` with `scim` the one remaining reserved kind. `oat` (OAuth access token), `ort` (OAuth refresh token) and `oac` (OAuth authorization code) became live kinds with AG1 when G1 was answered yes on 2026-09-12; the format, the hashing and the CRC are identical for all seven, which is the whole point of one credential format. The secret is 32 CSPRNG bytes; the CRC32 covers everything before it. Published scanner regex: `irid_(pat|ses|tkt|spl|oat|ort|oac)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}`.
- **At rest**: `access_tokens.secret_hash = SHA-256(secret)` (no pepper), looked up by the unique `token_id`, then compared with `timingSafeEqual`.
- **Scopes** are permission strings from A30. The MVP grants one bundle, "Read" = the six read permissions. Write scopes are schema-valid but are never granted and never listed in the UI.
- **Vault scope** is either an explicit `access_token_vaults` allowlist (a subset of the owner's memberships at creation, re-checked at every use) or `all_vaults = 1`, meaning "every vault I am an explicit member of at call time".
- **Server-admin-owned tokens**: token principals never inherit admin-implied access (`isServerAdmin: false`, explicit memberships only); `all_vaults` is disallowed for administrators; creation shows a warning and audits `token.created {admin_owned: true}`.
- **Expiry is mandatory** (`pat_policy.defaultLifetimeDays` 90, ceiling `pat_policy.maxLifetimeDays` 366, `pat_policy.allowNoExpiry` false — the grouped members of the `pat_policy` row of `server_settings`, to which the skeleton's flat spellings `pat_max_lifetime_days` and `pat_allow_no_expiry` map through the table in `03-data-model.md` §13.1) — which also satisfies the SDK's `expiresAt` requirement.
- **Rotation**: `POST /me/tokens/:id/rotate {overlapHours?}` issues a new secret and revokes the old token immediately, unless `overlapHours ≤ pat_policy.rotationOverlapMaxHours` (maximum 24, default 0; the skeleton spells it `pat_rotation_overlap_max_hours`) sets `rotation_overlap_until`.
- **Revocation** sets `revoked_at`; rows are never deleted. `last_used_*` is written asynchronously at most every 10 minutes.
- **Limits**: a per-token bucket of 120/min burst plus the token's own `access_tokens.rate_limit_per_hour`, where a `null` row value means `pat_policy.defaultRateLimitPerHour` (3 000) and the row value is administrative, set only by `PATCH /admin/tokens/:tokenId`; `search_notes` costs 3 points; `x-ratelimit-*` and `retry-after` headers.
- **Logging**: every token-authenticated read writes an `access_log` row; a rejected presentation audits `token.denied`.
- **Verifier**: implements `OAuthTokenVerifier.verifyAccessToken` returning `AuthInfo {token, clientId, scopes, expiresAt (always set), resource, extras: {principal}}`. Since AG1 there are **two verifier instances over the one verification path** (`apps/server/src/auth/tokens/verify.ts`, D04-26), differing only in the `resource` they are constructed with: the `/mcp` instance carries `new URL(PUBLIC_ORIGIN + '/mcp')` and accepts `pat` alone, the `/mcp/connect` instance carries `new URL(PUBLIC_ORIGIN + '/mcp/connect')` and accepts `oat` alone. `clientId` is `` `pat:${id16}` `` for an integration token and `` `oauth:${oauth_clients.client_id}` `` for an OAuth access token.
- The same PAT authenticates the read-only REST routes; a mutation attempt returns `403 token_scope_insufficient`.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Hash-only lookup, `irid_<type>_<43><6>` with no embedded id (plan-risk-first, plan-enterprise) | Gives no stable display prefix for the UI and no id for `access_log`/rate-limit keys without a second lookup; an indexed `token_id` is O(1) and the secret is still only ever compared in constant time. |
| HMAC-SHA256 with a server pepper (plan-agent-first) | A pepper protects low-entropy secrets; these are 256-bit CSPRNG values where a single SHA-256 is not brute-forceable. It would add a rotation obligation and a restore-critical key for no gain. |
| argon2 for token hashes | Adds 150–300 ms to every agent call; unjustifiable for a 256-bit random secret. |
| `all_vaults` available to everyone including administrators | For an administrator that is "read the whole server", which is exactly the blast radius F4 exists to prevent. |
| Optional expiry for service tokens (digest §3.6 open question) | The MCP SDK rejects an `AuthInfo` without `expiresAt`, and a never-expiring agent credential is the most common enterprise audit finding. The 366-day ceiling plus rotation with overlap covers the legitimate need. |
| Scopes as a bespoke vocabulary (`notes:read`, `vault:<id>:read`) | Three vocabularies existed across the plans (digest §11.14); reusing A30's permission strings means `authorize()` needs no translation layer. |
| Deleting revoked token rows | Destroys the audit trail; `revoked_at` preserves it. |

## Consequences

Positive: a token can never exceed or outlive its owner, and that is a property test rather than a review note; the format is offline-verifiable by secret scanners and double-click-selectable; one credential format covers sessions, tickets, and setup links, so there is one parser, one CRC check, and one redaction pattern; per-call `access_log` rows make the admin agent-activity view possible (F14). Negative: mandatory expiry creates a renewal obligation for agent owners (mitigated by rotation with overlap and by expiry warnings in the UI); `all_vaults` re-resolves memberships on every call, which is the second indexed read A23 already requires; administrators who want a broad-read agent must be granted explicit memberships, which is visible and auditable (intended).

## Verification

`tokens.format.unit` (CRC validation, kind parsing, scanner regex matches and rejects near-misses); `tokens.verifier.integration` (expired, revoked, unknown, wrong-vault, `rotation_overlap_until` honoured then refused); `token.effective-permissions.prop` (rights ⊆ owner's live explicit rights, for random membership and scope sets); `tokens.admin-owned.integration` (an administrator's token sees only explicit memberships and cannot set `all_vaults`); `mcp.rate-limit.mcp` (burst, hourly ceiling, `search_notes` cost 3, header shapes); `access-log.integration` (one row per token read, with returned note ids); `mcp.revocation.mcp` (next call fails); 100 % per-file coverage on `contracts/tokens` (A51).

## References

Digest §6.2 (GitHub/GitLab/Notion token patterns, OWASP secrets), §3.2 (`requireBearerAuth` `expiresAt`, `AuthInfo`), §3.6, §11.14; spec §4, §7; brief requirement 5; plan-risk-first ADR-14; judges 1, 2, 3; gap fix (admin-owned tokens); F4, F14. Implemented in `04-auth-and-access-control.md`, `06-mcp-and-agent-access.md`, `09-api-reference.md`.

---

## Area 5 — MCP and agent access

---

Source: docs/plan/13-decision-log.md, decision A31. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
