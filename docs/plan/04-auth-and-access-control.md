# Authentication, authorization, and access control

## 1. Scope and design stance

This section is the definitive specification of how Iridium identifies principals, issues and verifies credentials, decides what a principal may do, enforces that decision on every surface (REST, WebSocket collaboration, MCP, attachments, search, history, export, jobs, CLI), revokes access from already-open sessions, and records what happened. It covers skeleton decisions A23–A31 and A57 in full and is consumed by 02-system-architecture.md (placement), 03-data-model.md (tables), 05-collaboration-and-durability.md (hook bodies that are not authorization), 06-mcp-and-agent-access.md (tool semantics under the token principal), 07-client-applications.md (host-side custody), 09-api-reference.md (exact request/response shapes) and 10-testing-and-quality.md (test lanes).

Design stance, fixed by the skeleton and not revisited here:

| Principle | Consequence |
|---|---|
| One first-party auth core, no framework | `apps/server/src/auth/*` and `apps/server/src/authz/*` built on `node:crypto` (`randomBytes`, `createHash`, `timingSafeEqual`, `createHmac`) and `@node-rs/argon2 2.2.1`; better-auth, Passport and Lucia rejected (A29/ADR-09). |
| One `Principal`, one `authorize()` | Five credential kinds (password, session, collab ticket, integration token, OAuth access token) resolve to one `Principal` type from `@iridium/contracts/authz.ts`; every surface calls the single `authorize()` in `apps/server/src/authz/authorize.ts` (A30). The authorization server G1 added does not widen this: an OAuth token produces the same `TokenPrincipal` a personal access token produces, and `authorize()` gained no branch (§5.4, D04-31). |
| Deny by default, 404 for non-members | Every route declares `config.auth`; the server refuses to boot otherwise; non-members of a vault receive `404 not_found` for every vault-scoped resource; members lacking a permission receive `403 forbidden` (A30, F13). |
| Renderer never holds a reusable credential | Web: `__Host-` HttpOnly cookie. Electron: the session token lives only in the main process; the renderer sees only single-use 60 s collab tickets (A26). |
| No caches on the authorization path in MVP | REST = two indexed lookups per request; MCP = fresh token row + membership per call; WebSocket = version epochs + in-process bus + periodic re-validation (A23). |
| Everything security-relevant has a named test | See §14 and 10-testing-and-quality.md; coverage on `auth/**`, `authz/**`, `contracts/{tokens,paths,authz}` is 100 % per file (A51). |

Module placement (from skeleton §B.1):

| Module | Responsibility |
|---|---|
| `apps/server/src/auth/credentials/` | `hasher.ts` (argon2id + pepper + calibration + concurrency), `phc.ts` (PHC parse, re-hash decision), `policy.ts` (password rules, blocklist), `throttle.ts` (rate-limiter-flexible limiters), `blocklist.txt` |
| `apps/server/src/auth/sessions/` | `issuer.ts` (`SessionIssuer.issue`), `verify.ts`, `revoke.ts`, `stepup.ts`, cookie helpers |
| `apps/server/src/auth/tokens/` | PAT format helpers (re-exported from contracts), `verify.ts` (→ `Principal` + MCP `AuthInfo`; the single verification path, wrapped but never duplicated by `mcp/verifier.ts`), `lifecycle.ts` (create/rotate/revoke), `last-used.ts` |
| `apps/server/src/auth/tickets/` | `TicketStore` interface + `InMemoryTicketStore`, issuance route |
| `apps/server/src/auth/oauth/` | the credential half of the authorization server, beside the other credential modules: `codes.ts` (issue and consume `irid_oac_`), `refresh.ts` (rotation, family revocation, reuse detection) |
| `apps/server/src/oauth/` | the protocol half: `metadata.ts` (the two discovery documents and the four explicit `404` routes), `authorize.ts`, `consent-page.ts` (server-rendered, no client script), `token.ts`, `revoke.ts`, `register.ts`, `redirect-uri.ts`, `pkce.ts`, `cimd.ts`. 06-mcp-and-agent-access.md is the specification; this section states only what authentication and authorization guarantee about it |
| `apps/server/src/auth/setpw/` | one-time set-password links |
| `apps/server/src/auth/authenticate.ts` | `authenticate(request)` — cookie or bearer → `Principal \| null` |
| `apps/server/src/authz/` | `permissions.ts` (matrix re-export), `authorize.ts`, `decide.ts` (pure core, re-exported from contracts), `route-policy.ts` (Fastify plugin + boot assertion), `bus.ts` (`AuthzBus`), `epochs.ts` (epoch table), `reconciler.ts` (`EpochReconciler`, §8.6), `accessible-vaults.ts` (`accessibleVaultIds()` for search and listings) |
| `apps/server/src/security/` | CSRF guard, Origin/Host guards, rate-limit registration, request ids, ProblemDetails mapping |
| `apps/server/src/collab/hooks/` | `onAuthenticate`, `beforeHandleMessage`, `beforeHandleAwareness`, `onTokenSync` (authorization parts specified here; persistence parts in 05-collaboration-and-durability.md) |
| `apps/server/src/collab/gateway.ts` | `CollabGateway` — revocation sweeps over live connections |
| `packages/contracts/src/authz.ts`, `tokens.ts` | `Principal`, `Permission`, `Role`, matrix, `decide()`, token format/CRC/regex, `RouteAuth` |

## 2. Credentials and the shared token format

### 2.1 Credential kinds

| Credential | Wire format | At rest | Delivered how | Lifetime | Verified in |
|---|---|---|---|---|---|
| Password | any Unicode string, 15–128 code points | `user_credentials.password_hash` (argon2id PHC string, peppered), `pepper_version` | login form (`POST /auth/sessions`), `POST /auth/reauthenticate`, `POST /me/password` | until changed | `auth/credentials/hasher.ts` |
| Set-password link | `irid_spl_<id16>_<secret43><crc6>` inside `<PUBLIC_ORIGIN>/set-password#<token>` | `password_setup_tokens.secret_hash = SHA-256(secret)`, `token_id` | admin copies the link out of band (MVP); SMTP is a post-MVP `server_settings.smtp` seam | 24 h, single use | `auth/setpw/` |
| Web session | `irid_ses_<id16>_<secret43><crc6>` | `sessions.secret_hash = SHA-256(secret)`, `kind='web'` | `__Host-iridium_session` cookie: `Secure; HttpOnly; SameSite=Lax; Path=/` | idle 24 h sliding / absolute 14 d | `auth/sessions/verify.ts` |
| Desktop session | same format, `kind='desktop'` | same table | `Authorization: Bearer irid_ses_…` sent by the Electron **main** process only | idle 30 d sliding / absolute 90 d | same |
| Collab ticket | `irid_tkt_<id16>_<secret43><crc6>` | in-process `TicketStore` (SHA-256 of the secret → `{sessionId, userId, expiresAt}`), never persisted | Hocuspocus provider `token` (auth message after socket open, never the URL) | 60 s, single use | `auth/tickets/`, `collab/hooks/onAuthenticate.ts` |
| Personal access token (PAT) | `irid_pat_<id16>_<secret43><crc6>` | `access_tokens.secret_hash = SHA-256(secret)`, `token_id`, scopes, allowlist | `Authorization: Bearer` on `POST /mcp` and on the ★ read-only REST routes | required expiry, default 90 d, max `pat_policy.maxLifetimeDays` (366) | `auth/tokens/verify.ts` |
| OAuth authorization code | `irid_oac_<id16>_<secret43><crc6>` | `oauth_authorization_codes.secret_hash = SHA-256(secret)`, `code_id`, bound to client, `redirect_uri`, `resource`, `code_challenge` and the authorizing `session_id` | `302` to the client's registered redirect URI as the `code` parameter; in flight only, never stored by Iridium after exchange | 60 s, single use | `auth/oauth/codes.ts` |
| OAuth access token | `irid_oat_<id16>_<secret43><crc6>` | `access_tokens.secret_hash = SHA-256(secret)` with `kind='oauth'`, plus `client_id`, `consent_id`, `refresh_id`, `resource` | response body of `POST /oauth/token`; presented as `Authorization: Bearer` on `POST /mcp/connect` **only** | `oauth_policy.accessTokenTtlMinutes` (60 min) | `auth/tokens/verify.ts` |
| OAuth refresh token | `irid_ort_<id16>_<secret43><crc6>` | `oauth_refresh_tokens.secret_hash = SHA-256(secret)`, `token_id`, `family_id`, `rotated_from_id` | response body of `POST /oauth/token`; presented only to `POST /oauth/token` and `POST /oauth/revoke` | sliding `oauth_policy.refreshIdleDays` (30) inside absolute `oauth_policy.refreshAbsoluteDays` (90), rotated on every use | `auth/oauth/refresh.ts` |

The three OAuth kinds are live in MVP: G1 was answered yes on 2026-09-12, so Iridium ships its own OAuth 2.1 authorization server for native claude.ai and Claude Desktop connectors (06-mcp-and-agent-access.md). The one remaining reserved kind (schema-valid, never issued in MVP) is `scim` (SCIM provisioning bearer, `kind='scim'`).

### 2.2 The `irid_` format (`@iridium/contracts/tokens.ts`)

```
irid_<kind>_<id16>_<secret43><crc6>
```

| Part | Content | Generation |
|---|---|---|
| `kind` | `pat` \| `ses` \| `tkt` \| `spl` \| `oac` \| `oat` \| `ort` (reserved `scim`) | literal |
| `id16` | public identifier, 16 base62 characters (≈ 95 bits) | 16 characters drawn uniformly from `0-9A-Za-z` by rejection sampling over `randomBytes`; stored verbatim in the `token_id CHAR(16) ascii_bin` column of the owning table |
| `secret43` | 32 CSPRNG bytes encoded as a base62 big integer, left-padded to 43 characters | `randomBytes(32)` |
| `crc6` | CRC-32 (IEEE, `node:zlib` `crc32`) over the ASCII bytes of `irid_<kind>_<id16>_<secret43>`, encoded base62 and left-padded to 6 characters (62⁶ > 2³²) | computed at issuance |

Properties and rules:

- Every kind is three letters, so every credential is exactly 75 characters long — the OAuth kinds included, which is why the format needed no change to carry them. Underscores are not base62 characters, so a double-click selects the whole token in terminals and editors.
- Published secret-scanning regex: `irid_(pat|ses|tkt|spl|oac|oat|ort)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}`. The CRC lets scanners and the server reject malformed strings offline; a string that fails the regex or the CRC never touches the database (this is the first line of the login/verification pipelines and bounds the cost of credential floods).
- `parseToken(raw): { kind, tokenId, secret } | null` is a pure function in `@iridium/contracts/tokens.ts`; `secretHash(secret) = SHA-256(ascii(secret43))` — the hash is taken over the base62 string, not the decoded bytes, so every store and verifier computes the same value.
- Lookup is by `token_id` (unique index), then `timingSafeEqual(secretHash(secret), row.secret_hash)`. When no row exists the verifier still runs `timingSafeEqual` against a constant 32-byte buffer so the response time does not distinguish "unknown id" from "wrong secret".
- SHA-256 without a pepper is correct for 256-bit random secrets (A31): a database dump yields hashes that cannot be inverted or forged into usable credentials. Passwords, which are low-entropy, use argon2id with a pepper (§3.5).
- `display_prefix` for PATs is `irid_pat_<id16>_` (26 characters), shown in lists; the remainder is shown exactly once at creation. An OAuth access token uses the same `CHAR(26)` column with the prefix `irid_oat_<id16>_`, but no part of it is ever shown to a human: the credential is delivered to a client program by `POST /oauth/token`, and the prefix exists so the admin token list and `access_log` stay joinable.
- Property test `tokens.format.prop` (fast-check): for every generated token `parseToken(format(t)) = t`; flipping any single character invalidates the CRC or the regex; two issuances never share an `id16`.

## 3. Identity and accounts

### 3.1 The `users` row

Columns are defined in 03-data-model.md (skeleton §C.1). The semantics that matter for authentication and authorization:

| Column | Meaning here |
|---|---|
| `email`, `email_key` | Login identifier; `email_key = LOWER(email)` is the unique key and the login lookup key, so login is case-insensitive without a collation dependency. |
| `status` | `active` is the only status that authenticates. `disabled` and `deleted` fail every credential check (session, PAT, ticket, set-password link) and are surfaced as `invalid_credentials`/`invalid_token` exactly like a wrong password. |
| `is_server_admin` | Server-level flag, not a vault role. For **user** principals it grants `server:*` and is treated as `manager` on every vault. It never flows to token principals (§9). |
| `authz_version` | Revocation epoch (§8). Bumped in the same transaction as: disable, password set/change, any `vault_members` insert/update/delete for the user, admin session revocation. |
| `color_hue` | Presence colour assigned at creation (golden-angle sequence); shipped to other clients only through the server-authoritative `participants` message (A25). |

### 3.2 Administrator-created accounts and the first administrator

There is no registration route. Accounts are created by server administrators (`POST /admin/users`, `server:users`, step-up) or by the operator CLI (`iridium admin create-user --email <email> --display-name <name> [--server-admin]`). Both paths run the same `users/service.ts#createUser` and return a one-time set-password link; the CLI prints it to the terminal. The first administrator of a deployment is created with `iridium admin create-user --server-admin` inside the server container; there is no environment-variable bootstrap of an admin password, because no plaintext password may ever transit an operator or an environment (A28).

`POST /admin/users` body: `{email, displayName, isServerAdmin?: boolean}` → `201 {user, setPasswordLink: '<PUBLIC_ORIGIN>/set-password#irid_spl_…', expiresAt}`. The new row has `status='active'`, no `user_credentials` row (the account cannot log in yet), and audit `admin.user.created` (chain `server`) with `metadata:{isServerAdmin}`.

### 3.3 One-time set-password links (`irid_spl_…`)

Table `password_setup_tokens` (03-data-model.md §C.1). One code path serves both initial credential delivery and administrator-driven reset.

| Step | Behaviour |
|---|---|
| Issue | `auth/setpw/issue.ts`: generate an `irid_spl_` token, insert `{token_id, secret_hash, user_id, purpose:'initial'\|'reset', issued_by, expires_at = now + password_policy.setupLinkHours}` (24 h by default, 03-data-model.md §13.1). Before the insert, every outstanding link of the same user is superseded by setting `expires_at = now` (only the newest link is ever valid; `consumed_at` keeps its meaning "used"). |
| Deliver | The link is `<PUBLIC_ORIGIN>/set-password#<token>`. The token is in the URL **fragment**, so it never reaches server logs, reverse-proxy logs or `Referer` headers; the SPA reads `location.hash` and immediately replaces the history entry. The desktop login screen has a "Paste set-password link" action that parses the same URL. |
| Consume | `POST /auth/set-password {token, password}` (public; login rate bucket; CSRF guard per §4.4). In one transaction: `SELECT … FROM password_setup_tokens WHERE token_id=? FOR UPDATE` → `timingSafeEqual` → `consumed_at IS NULL AND expires_at > now` → user `status='active'` → password policy (§3.4) → `INSERT … ON DUPLICATE KEY UPDATE user_credentials {password_hash, pepper_version, password_changed_at}` → `consumed_at = now` → `users.authz_version + 1` → audit `user.password.set {purpose}` (chain `server`, `credential_type='setpw'`, `credential_id = password_setup_tokens.id`). Response `204`. Invalid, expired, consumed or superseded links all return `401 invalid_credentials` (one message, no distinction). Policy violations return `400 validation_failed` with the failing rule ids. |
| After consume | No automatic login: the client navigates to the login form with the email pre-filled. Keeping one login path (A29) means one throttle, one audit shape and one session issuer. |
| Reset | `POST /admin/users/:userId/reset-password` (`server:users`, step-up): in one transaction delete the `user_credentials` row (the old password stops working immediately — a reset may be a compromise response), revoke every session of the user (`revoked_reason='admin'`), bump `authz_version`, issue a new `purpose='reset'` link, clear login-throttle limiter A keys for that `email_key` (§3.7), audit `admin.user.password_reset`; after COMMIT publish `session.revoked` for each revoked session (§8). PATs are untouched (A28) — the admin UI shows the user's active tokens next to the reset button and offers `POST /admin/users/:userId/revoke-tokens` as a separate, separately audited action. |

Unconsumed links are removed by the `session_ticket_sweep` job 7 days after expiry (rows are not needed for audit; the audit event carries the link id).

### 3.4 Password policy (`auth/credentials/policy.ts`)

The policy follows NIST SP 800-63B-4 and the OWASP Authentication Cheat Sheet (digest §6.2) and is applied identically by `POST /auth/set-password` and `POST /me/password`.

| Rule | Value |
|---|---|
| Normalisation | Unicode NFC applied before every length check and before hashing (both at set and at verify), so the same password typed on different platforms produces the same hash. |
| Minimum length | 15 Unicode code points (`password_policy.minLength`, floor 15; drops to 8 once MFA exists, a post-MVP setting). |
| Maximum length | 128 code points (bounds argon2 input; longer inputs are rejected, never truncated). |
| Character rules | None: any Unicode, spaces included; no composition or rotation rules. |
| Breached/common list | `auth/credentials/blocklist.txt` — the SecLists `10-million-password-list-top-100000` list (MIT), pinned by SHA-256 at M0 and bundled in the image; loaded into a `Set` of NFC-lowercased entries at boot; the candidate is rejected if its lowercased form is in the set. Checked offline — no network call. An optional HIBP k-anonymity check is a post-MVP `password_policy.hibp` setting. |
| Context words | Rejected when the lowercased candidate equals or contains the user's email local part (when ≥ 4 characters) or the literal `iridium`. |
| Error shape | `400 validation_failed` with `errors:[{rule:'min_length'\|'max_length'\|'breached'\|'context_word'}]`; the UI shows strength guidance, never a composition checklist. |

Server administrators edit `password_policy.minLength` (≥ 15) and `password_policy.checkBreachedList` in the `password_policy` row of `server_settings` (03-data-model.md §13.1 is the single definition of the settings vocabulary, and only the grouped camelCase names exist in the schema and on the wire); env values are floors (A26 pattern).

### 3.5 Password hashing (`auth/credentials/hasher.ts`)

Library: `@node-rs/argon2 2.2.1` (prebuilt napi binary; no node-gyp; identical PHC output to the reference implementation — A29). Iridium uses only `hash(password, options)` and `verify(hashed, password, options)` from it. The re-hash decision ("`needsRehash`" in the skeleton's words) is implemented by Iridium's own `phc.ts`, which parses the PHC string (`$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>`) and compares its parameters with the configured ones, so the decision never depends on a library helper and behaves identically if the binding is ever swapped for `argon2` 0.45.1.

| Parameter | Value | Note |
|---|---|---|
| `algorithm` | `Algorithm.Argon2id` | |
| `memoryCost` | 65536 KiB (`ARGON2_MEMORY_KIB`) | exceeds the OWASP minimum (19456 KiB, t=2) |
| `timeCost` | 3 (`ARGON2_TIME_COST`) | |
| `parallelism` | 1 | each hash costs exactly one libuv thread-pool slot; calibration is predictable |
| `hashLength` | 32 bytes | passed as the binding's `outputLen` option |
| `version` | `0x13` | |
| `secret` | the pepper `Buffer` for the credential's `pepper_version` (§3.6) | never stored in the database |
| salt | 16 bytes generated by the library per hash | inside the PHC string |

Stored form: the PHC string (`$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`) in `user_credentials.password_hash VARCHAR(255)` plus `pepper_version`.

Operational rules:

- **Calibration**: `iridium doctor --argon2` measures hash latency on the target host and prints `ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST` values that land in the 150–300 ms window; operators set them in the environment; `iridium config check` warns when the measured latency falls outside the window.
- **Thread pool**: the image sets `UV_THREADPOOL_SIZE=8` explicitly (A29). `hasher.ts` additionally serialises hashing behind an in-process semaphore of `ARGON2_CONCURRENCY` (default 4) so a burst of logins cannot occupy every thread-pool slot that DNS, `fs` and `zlib` also need; excess callers wait (they are already inside the login rate limits of §10).
- **Timing equalisation**: at boot the hasher creates one dummy PHC hash of a random password with the current parameters. When a login names an unknown email, a disabled user or a user without a credential row, the same `verify()` runs against the dummy hash and the result is discarded, so the response time is independent of account existence. The response is always `401 invalid_credentials`.
- **Re-hash on login** (`phc.ts`): after a successful `verify`, `parsePhc(hash).params` is compared with the current parameters and `row.pepper_version` with `schema_meta.pepper_version`; any difference triggers a transparent `hash()` with the current pepper and parameters and an `UPDATE user_credentials SET password_hash=?, pepper_version=? WHERE user_id=? AND password_hash=?` (the `WHERE` on the old hash makes concurrent logins idempotent). The re-hash happens inside the login request after the session is issued and is logged (`auth.credential.rehashed`, no secrets), never audited (no security decision changed).
- **Verify never throws on mismatch**: `verify()` resolves `false`; malformed stored strings are treated as mismatches and logged at `error` level with the user id only.

### 3.6 Pepper versioning and rotation

| Element | Definition |
|---|---|
| Configuration | `AUTH_PASSWORD_PEPPER_V<n>[_FILE]` for every version `n ≥ 1` still needed to verify some credential; `AUTH_PASSWORD_PEPPER[_FILE]` is an alias of `_V1`. Each value is 32 bytes base64. `*_FILE` mounts are preferred (OWASP secrets guidance; 11-operations-and-deployment.md). |
| Current version | `schema_meta.pepper_version` — the version used for every **new** hash. Boot fails fast when the current version, or any `pepper_version` present in `user_credentials`, has no configured pepper (`config/env.ts` + a startup query `SELECT DISTINCT pepper_version FROM user_credentials`). |
| Rotation | `iridium keys rotate pepper --to <n>` (A57): verifies `AUTH_PASSWORD_PEPPER_V<n>` is configured and differs from every older version, sets `schema_meta.pepper_version = n`, audits `system.key.rotated {key:'pepper', from, to}` (chain `server`, `credential_type='cli'`). No credential is re-hashed by the command (the server never has plaintext passwords); each credential migrates at its owner's next successful login (§3.5). |
| Progress | `iridium doctor --argon2` prints the histogram of `user_credentials.pepper_version`. When the count for an old version reaches zero the operator removes that variable; until then it stays. Users who never log in again can be moved by an admin reset link, which deletes the stale credential. |
| Backup | Every configured pepper and the current version number are part of the encrypted secrets bundle; `restore --verify` refuses a bundle whose key versions do not match the dump (A47). |

The same `key_version` pattern (`AUDIT_HMAC_KEY_V<n>`, `MCP_CURSOR_KEY`) applies to the audit chain and MCP cursors; their rotation commands are specified in 11-operations-and-deployment.md.

### 3.7 Login (`POST /auth/sessions`) and throttling

Request `{email, password, client:'web'|'desktop', deviceName?}`; the `X-Iridium-Client-Version` header is recorded on the session (A54). One code path for both clients:

```
1. rate limit: login bucket 10/min per IP (§10)                         → 429 rate_limited
2. CSRF guard (§4.4; applies although no principal exists yet)           → 403 csrf_rejected
3. channel agreement: request.headers['x-iridium-client'] === body.client → else 403 csrf_rejected
   (no Set-Cookie, no session row, no argon2 work; this is 09-api-reference.md §2's
    "`client:'web'` requires `X-Iridium-Client: web` … `client:'desktop'` requires
    `X-Iridium-Client: desktop` and never sets a cookie" made enforceable, so the
    cookie-setting path is unreachable through the guard's desktop branch)
4. keyA = `${email_key}|${ip}`; resA = await limiterA.get(keyA)
   if resA && resA.remainingPoints <= 0                                  → 429 rate_limited, Retry-After = ceil(msBeforeNext/1000)
   resB = await limiterB.get(ip); same check                             → 429 rate_limited
5. row = SELECT u.*, c.password_hash, c.pepper_version FROM users u LEFT JOIN user_credentials c … WHERE u.email_key = LOWER(?)
6. ok = row && row.status === 'active' && row.password_hash
        ? await hasher.verify(row.password_hash, nfc(password), pepper(row.pepper_version))
        : await hasher.verifyDummy(nfc(password))              // always runs; result discarded
7. if !ok:
     await limiterA.consume(keyA); await limiterB.consume(ip)
     if limiterA is now exhausted: n = (await blocks.penalty(keyA)).consumedPoints
                                    await limiterA.block(keyA, min(900 * 2 ** (n - 1), 86400))
     audit user.login.failed (bounded, §11); pino auth.login.failed; metric iridium_login_failures_total
     → 401 invalid_credentials
8. await limiterA.delete(keyA); await blocks.delete(keyA)       // limiter B is never cleared
9. session = SessionIssuer.issue(user, {kind: client, ip, userAgent, deviceName, clientVersion})   // §4
   UPDATE users SET last_login_at = now
   re-hash if needed (§3.5)
   audit user.login.succeeded {kind, method:'password'}
10. web:     Set-Cookie __Host-iridium_session=…; Cache-Control: no-store → 200 {user}
    desktop: Cache-Control: no-store → 200 {token:'irid_ses_…', expiresAt, user}
```

Throttle implementation (`auth/credentials/throttle.ts`, `rate-limiter-flexible 11.2.0`):

| Limiter | Store | Key | Points / duration | Effect |
|---|---|---|---|---|
| A — consecutive failures per account+source | `RateLimiterMySQL({storeClient: mysql2 pool of dbApp, dbName, tableName:'login_throttle', keyPrefix:'login'})` with `insuranceLimiter: new RateLimiterMemory(...)` | `<email_key>\|<ip>` | 5 points / 24 h window | after the 5th failure `block(key, 900 · 2^(n−1))` where `n` is the number of blocks already applied to this key (limiter `blocks`, `keyPrefix:'loginblocks'`, 24 h duration, counted with `penalty()`); 15 min → 30 min → 1 h → … capped at 24 h |
| B — failures per source per day | same store, `keyPrefix:'loginip'` | `<ip>` | 100 points / 86 400 s | blocks every login from that source until the window ends |
| Fastify route bucket | `@fastify/rate-limit` | IP | 10 / min | cheap first gate before any DB access |

Keys are read with `get()` before the password is verified (so a blocked pair never pays for argon2), consumed only on failure, and limiter A + `blocks` are deleted on success (documented pattern, digest §6.2). Keying A on `email|ip` rather than on the account alone means an attacker cannot lock a legitimate user out from the user's own network. All three tables share `login_throttle` (`key`, `points`, `expire`) created by migration `0005_login_throttle`; `RateLimiterMySQL` is constructed with `tableCreated: true` so it never issues DDL under the `iridium_app` role. `POST /auth/reauthenticate` and `POST /me/password` consume limiter A with the same key on a wrong password (a stolen session must not become an offline password oracle). Limiter A keys for an `email_key` (all IPs) are cleared by an admin reset (§3.3); there is no separate unlock route in MVP.

Throttled responses are `429 rate_limited` with `Retry-After`; the account-existence question is never answered because the key is `email|ip` and the block only reflects the caller's own failures.

### 3.8 Account lifecycle events and their authentication effects

| Action (route / CLI) | Same transaction | After COMMIT (`AuthzBus`, §8) | Integration credentials (PATs and OAuth grants) |
|---|---|---|---|
| `POST /me/password {currentPassword, newPassword}` (self, step-up) | verify current (limiter A on failure) → policy → new hash → `password_changed_at` → revoke every other session of the user (`revoked_reason='password_change'`) → `authz_version+1` → audit `user.password.changed` | `user.password_changed {userId, keepSessionId}` → gateway closes all WS connections of the user except those of the current session | PATs, OAuth grants and consents untouched (A28/D13-6); the settings UI offers "also revoke my integration tokens and authorized applications", which issues `POST /me/tokens/revoke-all` as a second call under the same step-up window |
| `POST /admin/users/:id/disable` (`server:users`, step-up) | `status='disabled'` → revoke all sessions (`user_disabled`) → `authz_version+1` → audit `admin.user.disabled` | `user.disabled {userId}` → every WS connection closed `revoked` | rows untouched; verification step 9 rejects because `users.status ≠ 'active'` → `401` on the next call for a PAT **and** for an OAuth access token, and the next refresh is `400 invalid_grant` (spec §7 "revocation also stops integration access") |
| `POST /admin/users/:id/enable` | `status='active'`, audit `admin.user.enabled` | none (nothing to revoke) | resume working on the next call |
| `PATCH /admin/users/:id` (`If-Match`, step-up) | email/display name/`is_server_admin`; changing `is_server_admin` bumps `authz_version`; audit `admin.user.updated` | `membership.role_changed` is published for every vault where the user has a live WS connection and no explicit membership (admin-implied access is a role) | unaffected (tokens never carry admin power) |
| `DELETE /admin/users/:id` (soft: `status='deleted'`) | as disable + anonymisation rules from 03-data-model.md; audit `admin.user.deleted` | `user.disabled` | rejected as above, for both credential kinds |
| `POST /admin/users/:userId/revoke-tokens`, `POST /admin/tokens/revoke-all`, `iridium tokens revoke-all` | every live `access_tokens` row of the target revoked — `kind='pat'` **and** `kind='oauth'` — plus every `oauth_refresh_tokens` row and every live `oauth_consents` row of that user, in one transaction; audit `token.revoked_all` plus `oauth.consent.revoked` per consent | one `token.revoked` per access token | every agent the user configured stops on its next call; a connector's next refresh is `400 invalid_grant` and it must be re-authorized from the consent screen |
| `POST /admin/users/:id/revoke-sessions`, `DELETE /admin/sessions/:sessionId`, `POST /admin/sessions/revoke-all`, `iridium sessions revoke-all [--user]` | `revoked_at/revoked_reason='admin'`, `authz_version+1` per affected user, audit `session.revoked` / `session.revoked_all` | `session.revoked {sessionId, userId}` per session | untouched |
| `DELETE /me/sessions/:sessionId` (self) | `revoked_reason='logout'`, audit `session.revoked` | `session.revoked` | untouched |
| `DELETE /auth/sessions/current` (logout) | `revoked_reason='logout'`, audit `user.logout`; response clears the cookie, `Cache-Control: no-store`, `Clear-Site-Data: "cookies","storage"` | `session.revoked` | untouched |

## 4. Session model

### 4.1 One table, two delivery channels

| Property | Web (`kind='web'`) | Desktop (`kind='desktop'`) |
|---|---|---|
| Issued by | `POST /auth/sessions {client:'web'}` | `POST /auth/sessions {client:'desktop', deviceName}` |
| Delivery | `Set-Cookie: __Host-iridium_session=irid_ses_…; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=<seconds to absolute expiry>` | response body `{token:'irid_ses_…', expiresAt}` |
| Holder | browser cookie jar (script cannot read it) | Electron **main** process only (§4.5) |
| Presented as | cookie on every same-origin request (`fetch(credentials:'include')` from the SPA at `PUBLIC_ORIGIN`) | `Authorization: Bearer irid_ses_…` added by main's `net.fetch` |
| Channel binding | a `kind='web'` session is accepted **only** from the cookie; a `kind='desktop'` session **only** as a bearer. A desktop token pasted into a cookie (or a cookie value sent as a bearer) fails verification. | |
| Idle / absolute | 24 h sliding / 14 d | 30 d sliding / 90 d |
| CSRF | custom header + Fetch Metadata + SameSite (§4.4) | bearer requests skip the guard; the two pre-login calls (`POST /auth/sessions`, `POST /auth/set-password`) pass on `X-Iridium-Client: desktop` with no cookie (§4.4) |
| Attachments | `<img src="/api/v1/vaults/:v/attachments/:id">` with the cookie | `iridium-attachment://<vault>/<id>` handled in main with the bearer (07-client-applications.md) |
| Collab | tickets from `POST /auth/collab-tickets` with the cookie | tickets requested by main over IPC `collab:tickets` |

Both kinds are rows in `sessions` (03-data-model.md §C.1) and share `SessionIssuer.issue(user, {kind, method, ip, userAgent, deviceName, clientVersion})` — the single function every present and future login method (password now; OIDC, SAML, MFA later) finishes through. `issue()` creates a fresh row on every login (there is no pre-login session, so fixation is structurally impossible), sets `last_authenticated_at = created_at`, and applies the per-user cap: at most 20 live sessions per user per kind; when exceeded, the oldest by `last_seen_at` is revoked with `revoked_reason='replaced'`. A desktop login with the same `deviceName` for the same user also revokes the previous session of that device as `replaced`.

TTLs are policy: the `session_policy` row of `server_settings` — exactly the five members the `ServerSettings` schema declares, `{webIdleHours, webAbsoluteDays, desktopIdleDays, desktopAbsoluteDays, stepUpMinutes}` (09-api-reference.md §4 is authoritative for the spelling; the row key stays `snake_case` and the JSON members stay camelCase, 02-system-architecture.md §7; the desktop `safeStorage` requirement is **not** a member here — it is `desktopUpdatePolicy.requireSecureStorage`) — editable by server admins; the environment values (`SESSION_WEB_IDLE_HOURS` 24, `SESSION_WEB_ABSOLUTE_DAYS` 14, `SESSION_DESKTOP_IDLE_DAYS` 30, `SESSION_DESKTOP_ABSOLUTE_DAYS` 90, `STEP_UP_WINDOW_MIN` 10) are the security floor in the sense used by A26 and §C.10: an administrator may tighten the policy (shorter idle/absolute lifetimes, a shorter step-up window) but never loosen it beyond the environment value. Changing the policy applies to sessions issued afterwards; existing rows keep their stored expiry columns.

### 4.2 Verification (`auth/sessions/verify.ts`)

The module exports **two** entry points over one shared row check, because two callers need it: an HTTP request presents a raw credential, while `/collab` has already proved ownership of a session through a ticket and holds only its id (§6.4, §7.3, §8.7).

```
checkLiveRow(row): Principal | { dead: 'revoked' | 'expired' | 'user_inactive' }
  if row.revoked_at                                                               → { dead:'revoked' }
  if now >= row.idle_expires_at || now >= row.absolute_expires_at:
        UPDATE sessions SET revoked_at = now, revoked_reason = 'expired'
        WHERE id = ? AND revoked_at IS NULL                                       → { dead:'expired' }
  if row.status !== 'active'                                                      → { dead:'user_inactive' }
  if now - row.last_seen_at >= 60 s:
        UPDATE sessions SET last_seen_at = now,
               idle_expires_at = LEAST(now + idle(kind), absolute_expires_at) WHERE id = ?   (awaited; one cheap PK update)
  return { kind:'user', userId, sessionId: row.id, sessionKind: row.kind,
           isServerAdmin: row.is_server_admin === 1, authzVersion: row.authz_version,
           lastAuthenticatedAt: row.last_authenticated_at }

verifySession(raw: string, channel: 'cookie' | 'bearer'): Principal | null
  p = parseToken(raw); if !p || p.kind !== 'ses'                                  → null (no DB access)
  row = SELECT s.*, u.status, u.is_server_admin, u.authz_version
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_id = ?
  if !row: timingSafeEqual(secretHash(p.secret), ZERO32)                          → null
  if !timingSafeEqual(secretHash(p.secret), row.secret_hash)                      → null
  if (row.kind === 'web') !== (channel === 'cookie')                              → null
  r = checkLiveRow(row); return ('dead' in r) ? null : r        // REST never distinguishes the reasons

loadLiveSession(sessionId: SessionId): Principal | { dead: 'revoked' | 'expired' | 'user_inactive' } | null
  row = SELECT s.*, u.status, u.is_server_admin, u.authz_version
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?           // PRIMARY KEY point lookup
  if !row                                                                         → null
  return checkLiveRow(row)                                                        // no secret comparison, no channel binding
```

`loadLiveSession` skips exactly two steps of `verifySession`, and both are already proved by the caller rather than assumed: the `TicketStore` entry binds `{sessionId, userId}` and can only have been created by `POST /auth/collab-tickets`, which is itself authenticated by `verifySession` with the correct channel (§7.2), so the ticket carries the evidence of both secret ownership and channel binding. Everything that can change *after* issuance — revocation, idle expiry, absolute expiry, `users.status`, `is_server_admin`, `authz_version` — is in the shared `checkLiveRow`, so the collab path can never accept a session REST would reject. It returns the dead *reason* rather than `null` because `/collab` maps an expired session and a revoked one to different close codes (§6.4); REST collapses both into `401 invalid_credentials`.

The `last_seen_at`/`idle_expires_at` refresh stays inside the shared block and is not a loophole in either direction: a ticket lives 60 s and the `TicketSource` pool is refilled by `POST /auth/collab-tickets`, which runs `verifySession` and refreshes the row, so at consumption `now − last_seen_at` is almost always under 60 s and the write is skipped. The collab path therefore neither extends an idle window that REST would not have extended, nor lets the window lapse while a socket is genuinely in use.

Session verification is the first of the "two indexed lookups per request" (A23); the second is the membership lookup inside `authorize()` (§5.5). Nothing about a session is cached in process memory. Rows that expired without being touched are finalised by the `session_ticket_sweep` job (`revoked_reason='expired'`), and rows older than `absolute_expires_at + 30 d` are deleted by the same job (the audit log, not the sessions table, is the record).

### 4.3 Web specifics

- Cookie name `__Host-iridium_session` implies `Secure`, `Path=/` and no `Domain` (OWASP session guidance; digest §6.2). The SPA is served by the same Fastify origin (`PUBLIC_ORIGIN`), so there is no CORS configuration for cookie auth at all. `SameSite=Lax` (not `Strict`) so a deep link to a note opens signed in; Lax still blocks cookies on cross-site `POST`s and on cross-site WebSocket handshakes (digest §6.2).
- `Max-Age` equals the seconds until `absolute_expires_at`, so the browser keeps the cookie across restarts for exactly the absolute lifetime; idle expiry is enforced server-side and is not represented in the cookie (no cookie re-issue on sliding).
- Logout: `DELETE /auth/sessions/current` → revoke row → `Set-Cookie` with `Max-Age=0` → `Cache-Control: no-store` → `Clear-Site-Data: "cookies","storage"` (clears any browser-stored UI state — theme, last vault, open tabs, tree expansion, unsent dialog text). Iridium persists no note content in the browser: there is no `y-indexeddb` and no draft store (01-vision-scope-and-principles.md, offline-first non-goal), so there is nothing to clear beyond the in-memory `Y.Doc`, which is discarded when the tab closes. That in-memory text is deliberately kept until the user leaves the page, so `export.myText` still works after a `revoked` close (A40).
- Every `/api/v1/*` response carries `Cache-Control: no-store` (set by the security plugin); attachment responses override with `private, max-age=3600` (A44).
- The `/collab` upgrade never reads cookies: authentication there is by ticket only (§7). Neither MCP mount reads cookies: `/mcp` and `/mcp/connect` are both `bearerOnly`, so §6.1 skips the cookie branch entirely, and the route-level `ignoreCookies` hook strips the header and the parsed jar for the phases that follow (A32). The `/oauth/*` browser routes are the deliberate opposite — `/oauth/authorize` and `/oauth/consent` are the only places outside the SPA where a session cookie authenticates a person, which is why the consent page carries its own framing, caching and referrer headers (06-mcp-and-agent-access.md).

### 4.4 CSRF for cookie sessions (`security/csrf.ts`)

No per-request synchronizer token. The guard is the OWASP custom-header pattern plus Fetch Metadata resource isolation with the mandatory `Origin`/`Referer` fallback, and `SameSite=Lax` as defence in depth (A27):

```
csrfGuard(request):
  if request.method ∈ {GET, HEAD, OPTIONS}                       → pass
  if request.headers.authorization                               → pass   (bearer: no ambient credential)
  if route.config.auth.bearerOnly                                → pass   (authentication already required a bearer)
  if `${request.method} ${route.url}` ∈ CSRF_EXEMPT_ROUTES       → pass   (closed enumerated set, §6.2)
  client = request.headers['x-iridium-client']
  if client !== 'web' && client !== 'desktop'                    → 403 csrf_rejected   (absent, or any other value)
  if client === 'desktop':
        if request.headers.cookie                                → 403 csrf_rejected   (D04-06 channel binding: a desktop host never sends cookies)
        if !route.config.auth.public                             → 403 csrf_rejected   (a desktop caller on an authenticated route must present a bearer; `authenticate()` has already answered 401, so this is a belt-and-braces assertion)
        else                                                     → pass
  // client === 'web' from here — the Fetch-Metadata and Origin/Referer branches below apply to browsers only
  sfs = request.headers['sec-fetch-site']
  if sfs !== undefined:
        if sfs ∈ {'same-origin', 'none'}                         → pass
        else                                                     → 403 csrf_rejected
  origin = request.headers.origin ?? originOf(request.headers.referer)
  if origin === PUBLIC_ORIGIN                                    → pass
  else                                                           → 403 csrf_rejected
```

Rules that follow from it:

- The guard runs in the `onRequest` phase, before body parsing, so it covers multipart uploads (`POST /vaults/:id/attachments`, `PUT /imports/:id/upload`) and any future form-encoded route; it is policy by route, not by content type.
- It applies to **every** state-changing request that is not bearer-authenticated, including the public `POST /auth/sessions` and `POST /auth/set-password`. The accepted header values are exactly `{web, desktop}` (digest §6.2: the custom header is `X-Iridium-Client: web|desktop`); anything else, including an absent header, is `403 csrf_rejected`. A27's own scope is cookie principals; the two public pre-login routes are covered as an extension of it, because they are the only state-changing routes a client reaches before any credential exists. The Fetch-Metadata, `Origin` and `Referer` comparisons are **`web`-only** — a main-process `net.fetch` sends none of those headers, so applying them to a desktop request would reject every desktop login. The only non-bearer requests a desktop host ever issues are those two public routes, and they pass on `X-Iridium-Client: desktop` with no `Cookie` header (§4.5).
- `X-Iridium-Client` is a custom header: a cross-origin sender can only add it via a CORS preflight, and the server has no CORS handler for `PUBLIC_ORIGIN`, so the preflight fails — for *either* value. Login CSRF (forcing a victim into an attacker's account) therefore stays blocked without a pre-session token, and a `desktop` request carries no cookie, so it has no ambient credential to abuse in the first place (a `desktop` header arriving *with* a `Cookie` is rejected). Test clients that use cookies send `X-Iridium-Client: web` and an `Origin` equal to `PUBLIC_ORIGIN`; there is no bypass switch.
- `PUBLIC_ORIGIN` comparison is an exact string comparison against the serialised origin (`scheme://host[:port]`, lower-cased host); `originOf(referer)` extracts the origin with `new URL()` and rejects unparsable values.
- The exemption is no longer "`/mcp` only". Boot assertion (`authz.route-policy.boot`): every route with a non-safe method is CSRF-guarded unless it is a member of the closed set `CSRF_EXEMPT_ROUTES` in `@iridium/contracts/authz.ts` — `POST /mcp`, `POST /mcp/connect`, `POST /oauth/consent`, `POST /oauth/token`, `POST /oauth/revoke`, `POST /oauth/register` — and `authz.route-policy.boot` asserts the set of exempt routes equals that constant exactly. The MCP mounts are exempt because they are `bearerOnly`; the OAuth endpoints are exempt because they are machine or browser-form surfaces that no ambient credential authenticates — `/oauth/consent` carries its own single-use, session-bound `request_id` (06-mcp-and-agent-access.md D06-32) and the other three authenticate the client, not a user. `security.csrf.integration` covers the consent POST.
- Rejections are logged as the SIEM event `authz.denied {reason:'csrf'}` with request id and IP; they are not audit events (unauthenticated noise must not touch the chain).
- `@fastify/csrf-protection 8.0.1` is deliberately not used (digest §6.1).

### 4.5 Desktop specifics: main-process custody

The renderer of the Electron app must never hold a reusable credential (A26, ADR-10, T12). Concretely:

| Concern | Design |
|---|---|
| Sign-in | Renderer `host.auth.signIn(credentials)` → IPC `iridium:auth:signIn` → main calls `POST /auth/sessions {client:'desktop', deviceName: os.hostname()}` via `net.fetch`, with `X-Iridium-Client: desktop` and no cookie (§4.4) → main keeps `irid_ses_…`; the renderer receives `{user}` only. The "Paste set-password link" action calls `POST /auth/set-password` the same way. |
| Storage | `safeStorage.encryptStringAsync(token)` written to `<userData>/iridium/secrets.bin` as a JSON map keyed by server origin (one entry per server profile). When `safeStorage.isEncryptionAvailable()` is false, or on Linux `getSelectedStorageBackend() === 'basic_text'`, the token is kept in memory only and the UI shows a persistent warning; the admin policy `desktop_update_policy.requireSecureStorage` (the `desktopUpdatePolicy.requireSecureStorage` member of `ServerSettings`, 09-api-reference.md §4 and 02-system-architecture.md §7 — it lives there rather than in `session_policy`; published by `GET /desktop/update-policy` as `requireSecureStorage`) makes main refuse to sign in at all in that state. `decryptStringAsync` results with `shouldReEncrypt=true` are re-encrypted immediately. On macOS at 1.0 this path is not reached: `safeStorage` is backed by the Keychain, the Keychain binds an item to a stable code signature, and the 1.0 macOS bundle is ad-hoc signed rather than Developer ID signed, so `isEncryptionAvailable()` reports `false` and the desktop client runs in memory-only mode on every macOS installation (07-client-applications.md §7.6, §7.14). A site that sets `requireSecureStorage = true` therefore makes the macOS client unable to sign in at all until the post-1.0 signing epic ships. This is stated here rather than discovered at deployment. |
| REST | `IpcTransport` (`@iridium/api-client`) → `iridium:api:request {method, path, query, body, headers}` (zod-validated, path must start with `/api/v1/`) → main `net.fetch(origin + path)` adding `Authorization: Bearer`, `X-Iridium-Client: desktop`, `X-Iridium-Client-Version` and `Accept`; the response body and status are relayed; the bearer never appears in any renderer-visible structure (test `attachments-no-token-in-renderer`, `preload-surface`). Main also sends `X-Iridium-Client: desktop` on the two **pre-login** calls where no bearer exists — `POST /auth/sessions` and `POST /auth/set-password` — which is what carries them past the CSRF guard's desktop branch (§4.4). Every `net.fetch` uses `session: iridiumSession, useSessionCookies: false` (07-client-applications.md §7.6), so the "a desktop host never sends a `Cookie`" invariant holds structurally rather than by convention. |
| Tickets | `iridium:collab:tickets {count}` → main `POST /auth/collab-tickets {count}` with the bearer → the tickets (single-use, 60 s) are the only credential the renderer ever receives. |
| WebSocket | The renderer opens `wss://<host>/collab` itself (Origin `app://iridium`, §7.5); if the M0 spike shows the upgrade does not carry that Origin, the `IpcWebSocket` fallback moves socket ownership to main, which still relays tickets and forwards frames verbatim (A53). |
| Attachments | `iridium-attachment://<vault>/<id>` protocol handler in main fetches with the bearer and streams bytes, re-emitting `FORWARDED_ATTACHMENT_HEADERS` verbatim — the one shared constant beside the served-header table of 08-markdown-pipeline-import-export.md §9.4, applied by the handler in 07-client-applications.md §7.7, and it includes `Content-Security-Policy: sandbox` and `Referrer-Policy: no-referrer` — plus a re-asserted `X-Content-Type-Options: nosniff`, and it forwards the renderer's `Range` header so `206`/`Content-Range` seeking works in both hosts. `Cross-Origin-Resource-Policy` is deliberately omitted: the custom scheme is cross-origin to `app://iridium` by construction, so a verbatim `same-origin` value would fail the very no-cors `<img>` fetch the scheme exists for (07-client-applications.md §7.7). The desktop is therefore never the surface with *fewer* protections than the web, and a hardening header added to 08 §9.4 cannot silently stop reaching it. |
| Sign-out | `iridium:auth:signOut` → main `DELETE /auth/sessions/current` → wipe the entry from `secrets.bin` → `session.clearStorageData()` **and `session.clearCache()`** for the renderer partition (`clearStorageData` does not flush Chromium's HTTP cache, which holds attachment bytes for up to 3 600 s — §8.9). The same pair runs when a REST `401` ends the session, and `clearCache()` alone runs on a 4403 `revoked` close. |
| Session end from the server | Any `401` from `iridium:api:request` → main erases the `secrets.bin` entry for that origin and emits `iridium:event:session-changed {state:'expired', me:null, origin}` (the payload schema of 09-api-reference.md §D.4, whose `state` member — never `status` — is the discriminator every host reads; this path sets no `reason`, so a renderer listening for `reason:'revoked'` never fires on a plain expiry). **A `revoked` WS close never touches `secrets.bin`**: a WebSocket close is never an authority on session validity — only a REST `401` is. The close is scoped to one document and is shared by four causes (§8.4), so `@iridium/collab-client` re-checks the session with exactly one `GET /auth/me` (05-collaboration-and-durability.md, per-document close) and only the `401` from *that* call ends the session, through this same row. In the `IpcWebSocket` fallback (§7.5, A53) main relays `collab-close` verbatim and takes no credential action. |
| Multiple servers | one active profile per window; switching profiles reloads the window and clears session storage; secrets are keyed by origin so a token is never sent to a different server. |

The desktop session has no access/refresh split (rejected alternative in A26): a single hashed opaque token with per-request server-side verification already gives immediate revocation and one token model for the whole system.

### 4.6 Step-up ("sudo mode")

`sessions.last_authenticated_at` is set at login and refreshed by `POST /auth/reauthenticate {password}` (session-authenticated, CSRF-guarded, limiter A on failure, audit `user.reauth.succeeded`). A route declared `stepUp: true` requires `now − last_authenticated_at ≤ session_policy.stepUpMinutes` (10, admin-configurable downward); otherwise the route policy answers `403 step_up_required` **after** authorization succeeded (a caller who is not allowed at all still gets 404/403 first, so step-up never leaks whether an action would be permitted). The client shows the password dialog and retries. Token principals can never satisfy step-up; every step-up route is user-only by construction.

Step-up is required for (A26): creating, rotating and revoking PATs (`POST /me/tokens`, `POST /me/tokens/:id/rotate`, `DELETE /me/tokens/:id`, `POST /me/tokens/revoke-all`); `POST /me/password`; every `/admin/*` mutation; `POST /vaults/:id/archive|unarchive`; `POST /notes/:id/revisions/:rev/restore`; `DELETE /nodes/:id?purge=true`; `PUT /admin/settings`; and, for the authorization server, `DELETE /me/oauth-consents/:consentId` plus the `/admin/oauth-clients` and `/admin/oauth-consents` mutations (which the `/admin/*` rule already covers).

Granting an OAuth authorization needs the same freshness but cannot use the same mechanism, and the deviation is stated rather than left to be discovered: `POST /oauth/consent` is reached by a server-rendered page with no application JavaScript, so there is no dialog to raise and no request to retry. The consent page therefore renders a password field when `now − last_authenticated_at > session_policy.stepUpMinutes` and `oauth_policy.allowConsentWithoutStepUp` is false, and a wrong password consumes login limiter A on the key `login:<email_key>|<ip>` exactly as `POST /auth/reauthenticate` does (D04-07). The requirement is identical; only the surface that collects the proof differs. `sessions.mfa_verified_at` is reserved so that a later MFA milestone can make step-up require a second factor without changing the route contract.

### 4.7 Listing and revoking sessions

- `GET /me/sessions` → `[{id, kind, deviceName, clientName, clientVersion, ip, userAgent, createdAt, lastSeenAt, lastAuthenticatedAt, current:boolean}]` (never the secret or its hash). `DELETE /me/sessions/:sessionId` (self; no step-up) revokes one of the caller's own sessions.
- `GET /admin/sessions?userId=&cursor=`, `DELETE /admin/sessions/:sessionId`, `POST /admin/sessions/revoke-all`, `POST /admin/users/:id/revoke-sessions` (`server:sessions:all`, step-up) and the CLI `iridium sessions revoke-all [--user <email>]` (audited with `credential_type='cli'`) — effects per §3.8.
- Revoking a session invalidates its outstanding collab tickets (a ticket is consumed only if its session is still live, §7.3) and closes its WebSocket connections through the `AuthzBus` (§8).
## 5. Roles, permissions and the single `authorize()` function

### 5.1 Principals

`Principal` is a discriminated union in `@iridium/contracts/authz.ts`. It is the only input describing "who" anywhere in the server; no handler, tool or hook ever looks at a request, a cookie, a header or a Hocuspocus connection to decide something.

```ts
// packages/contracts/src/authz.ts
export type Principal =
  | {
      kind: 'user';
      userId: UserId;
      sessionId: SessionId;
      sessionKind: 'web' | 'desktop';
      isServerAdmin: boolean;
      authzVersion: number;              // users.authz_version at authentication time
      lastAuthenticatedAt: Date;         // step-up window
    }
  | {
      kind: 'token';
      tokenKind: 'pat' | 'oauth';        // which credential produced it (§9.1)
      tokenId: TokenId;                  // access_tokens.id
      publicTokenId: string;             // access_tokens.token_id (the id16 in the credential)
      userId: UserId;
      clientId: string | null;           // oauth_clients.client_id (a CIMD URL or a registered id); null for a PAT
      consentId: string | null;          // oauth_consents.id; null for a PAT
      resource: string | null;           // the RFC 8707 audience the token was issued for; null for a PAT
      scopes: readonly Permission[];     // permission strings stored on the row
      vaultScope: { all: true } | { vaultIds: readonly VaultId[] };
      isServerAdmin: false;              // structurally impossible to be true (§9.2)
      adminOwned: boolean;
      surface: 'mcp' | 'rest';
      rateLimitPerHour: number;
      expiresAt: Date;
    }
  | { kind: 'system'; job: string; onBehalfOf?: UserId };
```

| Kind | Produced by | Used on |
|---|---|---|
| `user` | `auth/sessions/verify.ts` (cookie or desktop bearer), `collab/hooks/onAuthenticate.ts` (after ticket consumption) | REST, `/collab`, desktop IPC, admin console, CLI (`system` acting `onBehalfOf` an operator is used instead where no session exists) |
| `token` | `auth/tokens/verify.ts` (PAT or OAuth bearer) | `/mcp`, `/mcp/connect`, the ★ read-only REST routes of 09-api-reference.md |
| `system` | job scheduler, migrations, `iridium` CLI, server-originated collaborative edits (§6.9) | internal only; never constructed from a request |

`system` principals are allowed by construction — they exist so that `AuditWriter` and `ContentReadCore` have an actor for internal work, not to bypass checks. Every `system` principal carries the job name, which lands in `audit_events.actor_type='system'` / `context.job`. The CLI constructs `{kind:'system', job:'cli:<command>', onBehalfOf: <operator user id if resolvable>}` and writes `credential_type='cli'` (A57).

### 5.2 The permission vocabulary

Permissions are strings, not bitmasks or role comparisons, because they are also PAT scopes (A31) and must be readable in a token-creation dialog and in an audit row. The vocabulary is closed and exhaustive; adding one is a code change in `@iridium/contracts/authz.ts` plus a row in the matrix test.

| Group | Permission | Scope | Meaning |
|---|---|---|---|
| read | `vault:read` | vault | See the vault, its settings that are not secrets, its tree and members list |
| read | `note:read` | vault | Read note metadata and committed Markdown |
| read | `search:read` | vault | Query the search index |
| read | `history:read` | vault | List revisions, read a pinned revision, use `?fresh=true` |
| read | `attachment:read` | vault | List and download attachments |
| read | `export:read` | vault | Create and download vault/subtree/note exports |
| write | `note:write` | vault | Send Yjs updates on `note:<id>` (the collaborative write permission) |
| write | `node:create` | vault | Create a note or category |
| write | `node:rename` | vault | Rename a node |
| write | `node:move` | vault | Re-parent a node inside the same vault |
| write | `node:trash` | vault | Move a node to trash |
| write | `node:restore` | vault | Restore a trashed node |
| write | `attachment:write` | vault | Upload and delete attachments |
| write | `revision:name` | vault | Create a named revision (`Ctrl/Cmd+S`) |
| manage | `vault:manage_members` | vault | Add, change and remove memberships |
| manage | `vault:settings` | vault | Edit vault settings (flavour, soft breaks, attachment folder, `mcp_enabled`, `ai_guidance`, retention, checkpoint interval) |
| manage | `vault:archive` | vault | Archive and unarchive the vault |
| manage | `history:restore` | vault | Restore a revision (coordinated content change) |
| manage | `node:purge` | vault | Permanently delete a trashed node |
| manage | `import:commit` | vault | Commit an import into this vault |
| server | `server:users` | server | Create, update, disable, enable, delete users; issue reset links |
| server | `server:vaults:create` | server | Create vaults and import into a new vault |
| server | `server:settings` | server | Read and write `server_settings` |
| server | `server:audit:all` | server | Read and export the audit log across all vaults and the `server` chain |
| server | `server:tokens:all` | server | List and revoke any user's integration tokens |
| server | `server:sessions:all` | server | List and revoke any user's sessions |
| server | `server:jobs` | server | View and trigger maintenance jobs |
| server | `server:releases` | server | Publish desktop releases and the update feed |

`@iridium/contracts/authz.ts` also exports the machine-readable shape the enforcement layer depends on:

```ts
export const PERMISSIONS = [...] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const PERMISSION_SCOPE: Record<Permission, 'vault' | 'server'> = { … };
export const READ_BUNDLE: readonly Permission[] =
  ['vault:read', 'note:read', 'search:read', 'history:read', 'attachment:read', 'export:read'];
```

`PERMISSION_SCOPE` is what makes a missing vault id impossible to ignore: `authorize()` throws a programming error (`AuthzUsageError`, 500, logged, never a deny) when a `'vault'`-scoped permission arrives without a `vaultId`, and when a `'server'`-scoped permission arrives with one. The route-policy boot assertion (§6.2) proves statically that every route supplies what its permission needs, so the throw can only fire from hand-written service code and is covered by `authz.usage.unit`.

### 5.3 The matrix

One static module, `apps/server/src/authz/permissions.ts`, re-exporting the table from `@iridium/contracts/authz.ts`. It is the only place in the system where a role maps to permissions. Roles are ordered `viewer < editor < manager` and are **per vault** (`vault_members.role`); `users.is_server_admin` is a server-level flag, not a fourth role.

| Action (permission) | viewer | editor | manager | server admin (user principal) |
|---|:--:|:--:|:--:|:--:|
| `vault:read` | ✓ | ✓ | ✓ | ✓ |
| `note:read` | ✓ | ✓ | ✓ | ✓ |
| `search:read` | ✓ | ✓ | ✓ | ✓ |
| `history:read` | ✓ | ✓ | ✓ | ✓ |
| `attachment:read` | ✓ | ✓ | ✓ | ✓ |
| `export:read` | ✓ | ✓ | ✓ | ✓ |
| `note:write` | — | ✓ | ✓ | ✓ |
| `node:create` | — | ✓ | ✓ | ✓ |
| `node:rename` | — | ✓ | ✓ | ✓ |
| `node:move` | — | ✓ | ✓ | ✓ |
| `node:trash` | — | ✓ | ✓ | ✓ |
| `node:restore` | — | ✓ | ✓ | ✓ |
| `attachment:write` | — | ✓ | ✓ | ✓ |
| `revision:name` | — | ✓ | ✓ | ✓ |
| `vault:manage_members` | — | — | ✓ | ✓ |
| `vault:settings` | — | — | ✓ | ✓ |
| `vault:archive` | — | — | ✓ | ✓ |
| `history:restore` | — | — | ✓ | ✓ |
| `node:purge` | — | — | ✓ | ✓ |
| `import:commit` | — | — | ✓ | ✓ |
| `server:users` | — | — | — | ✓ |
| `server:vaults:create` | — | — | — | ✓ |
| `server:settings` | — | — | — | ✓ |
| `server:audit:all` | — | — | — | ✓ |
| `server:tokens:all` | — | — | — | ✓ |
| `server:sessions:all` | — | — | — | ✓ |
| `server:jobs` | — | — | — | ✓ |
| `server:releases` | — | — | — | ✓ |

Notes on the matrix that are part of the contract:

- **Server admin = manager on every vault, plus `server:*`, for user principals only.** This is the spec's "explicitly trusted with all vault content" (§4). It is implemented inside `decide()` as "effective role = `max(explicitRole ?? 'none', isServerAdmin ? 'manager' : 'none')`", not as a bypass branch, so every admin action goes through the same matrix and the same audit path. Token principals never receive it (§9.2).
- **Vault managers do not get `server:audit:all`.** They read audit events scoped to their own vault through `GET /vaults/:vaultId/audit` under `vault:manage_members` (A46: "vault managers see admin actions inside their vault"). That route's `config.auth` is `{permission:'vault:manage_members', vaultFrom:'params.vaultId', allowArchived:true}` (the flag is required because `vault:manage_members` is outside `READ_BUNDLE`, §5.6); the handler filters `chain_id = chainIdForVault(vaultId)` (`'vault:' + 32 hex`, §11.1).
- **There is no note-level or category-level permission.** Spec §4: permissions apply to the whole vault and are inherited by categories, notes, attachments, history, search results and exports. `note_*`/`node_*` permissions are vault-scoped; the node id only selects *which* vault is consulted.
- **There is no `vault:delete`.** Vaults are archived (`vault:archive`); `status='deleting'` is set only by the aborted-import teardown — `POST /imports/:jobId/abort` by the import's requester, or the `transfer_cleanup` job when `import_jobs.expires_at` passes (03-data-model.md §1.4) — and by the operator quarantine of a structurally broken vault (`iridium doctor`, invariant I-01). Such vaults are invisible to everyone (§5.6), and there is no route that deletes a vault that ever reached `active`.
- **Deny by default.** `decide()` looks the permission up in the matrix; an unmatched permission denies. `authz.matrix.unit` enumerates the full cross-product (4 role states × every permission, plus the `none` role) and is required to be 100 % branch-covered; adding a permission without a matrix row fails the exhaustiveness test at compile time (`Record<Permission, …>`) and at run time.

### 5.4 `authorize()` — inputs, outputs, algorithm

```ts
// apps/server/src/authz/authorize.ts
export type Decision =
  | 'allow'
  | { deny: 'not_found' }           // → REST 404, MCP isError "no such …", WS close 4404 / 4401
  | { deny: 'forbidden' }           // → REST 403 forbidden, MCP isError, WS readOnly or close 4403
  | { deny: 'step_up_required' };   // → REST 403 step_up_required (user principals only)

export interface AuthzScope {
  vaultId?: VaultId;
  /** Pre-loaded row when the caller already holds it inside a transaction. */
  vault?: Pick<VaultRow, 'id' | 'status' | 'mcp_enabled'>;
  /** Pre-loaded membership when the caller already holds it (structural transactions do). */
  member?: { role: Role; version: number } | null;
  /** Set by the route policy for routes declared `stepUp: true`. */
  requireStepUp?: boolean;
  /** 'mcp' applies the MCP kill switches (§9.4). */
  surface?: 'rest' | 'collab' | 'mcp' | 'internal';
}

export async function authorize(
  principal: Principal,
  permission: Permission,
  scope: AuthzScope = {},
): Promise<Decision>;
```

The function is `async` because it may perform exactly one query (the membership/vault lookup). It performs **no caching** (A23), and it never throws for an authorization outcome — only for usage errors (§5.2) and for database failures, which surface as `503`/`server_error` and are never converted into a deny.

Algorithm, in order. Every early return is a deny; there is no fall-through to allow.

```
1. principal.kind === 'system'                        → 'allow'
2. if PERMISSION_SCOPE[permission] === 'server':
     principal.kind !== 'user'                        → {deny:'forbidden'}   // tokens have no server scope
     !principal.isServerAdmin                         → {deny:'forbidden'}
     matrix.serverAdmin[permission] !== true          → {deny:'forbidden'}
     step-up check (5)                                → 'allow' | {deny:'step_up_required'}
3. vault-scoped. vault = scope.vault ?? SELECT id, status, mcp_enabled FROM vaults WHERE id = :vaultId
     !vault                                           → {deny:'not_found'}
     vault.status === 'importing' | 'deleting'        → {deny:'not_found'}   // invisible, A30
4. member = scope.member ?? SELECT role, version FROM vault_members WHERE vault_id=? AND user_id=:principal.userId
   explicitRole   = member?.role ?? null
   effectiveRole  = principal.kind === 'user' && principal.isServerAdmin
                      ? maxRole(explicitRole, 'manager')
                      : explicitRole
     effectiveRole === null                           → {deny:'not_found'}   // non-member: the vault does not exist for you (F13)
     vault.status === 'archived' && !isRead(permission) → {deny:'forbidden'}  // archived vaults are read-only
     !matrix[effectiveRole][permission]               → {deny:'forbidden'}
5. token principals only — §9.2:
     permission ∉ principal.scopes                    → {deny:'forbidden'}
     vaultId ∉ allowedVaults(principal)               → {deny:'not_found'}
     explicitRole === null                            → {deny:'not_found'}   // admin-implied access never flows to a token
     !matrix[explicitRole][permission]                → {deny:'forbidden'}
     scope.surface === 'mcp' && !(settings.mcp_enabled && vault.mcp_enabled) → {deny:'not_found'}
6. step-up (user principals, scope.requireStepUp):
     now − principal.lastAuthenticatedAt > session_policy.stepUpMinutes → {deny:'step_up_required'}
7. 'allow'
```

The algorithm is **unchanged** by the OAuth authorization server. An OAuth access token resolves to a `TokenPrincipal` with the same `scopes`, `vaultScope`, `isServerAdmin: false` and `surface` members a personal access token produces, so step 5 decides both kinds with one code path and no branch on `tokenKind` exists anywhere in `authz/`. `oauth.principal-parity.prop` is the proof obligation: over random `(role, scopes, vault selection, vault status, mcpEnabled, permission)`, the two principals produce the identical `Decision`. Consent and client status are **credential** properties, checked at verification steps 5b and 5a (§9.1), not authorization properties — they live with expiry and revocation, where the rest of the credential's liveness lives.

`settings.mcp_enabled` in step 5 is `SettingsStore.effective().mcp_enabled` — an in-memory read of the store that 02-system-architecture.md §7 reloads inside the request committing `PUT /admin/settings` (the row's only writer), not a query, so it adds no third lookup and is still effective on the very next call. `vault.mcp_enabled` is the column of the vault row step 3 already read — which is why `AuthzScope.vault` requires all three columns: a caller that pre-loads a row it locked inside a transaction must select `id, status, mcp_enabled`, and on `surface:'mcp'` an absent `mcp_enabled` is an `AuthzUsageError` (§5.2), never an implicit allow. `decide()`'s single `mcpEnabled` input is the AND of the two. The route-level `mcpKillSwitch` preHandler evaluates the same in-memory flag earlier and answers `503 mcp_disabled` before the SDK runs (06-mcp-and-agent-access.md); step 5 re-reads it so a non-route caller on `surface:'mcp'` cannot bypass the server-wide switch.

Three properties of this order matter and are tested:

1. **Existence is decided before permission.** A non-member always receives `not_found`, whatever the permission, so probing `PATCH /nodes/:id` versus `GET /nodes/:id` cannot distinguish "exists but forbidden" from "does not exist" across vault boundaries (`authz.vault-isolation.integration`, spec acceptance row "Vault isolation").
2. **Step-up is evaluated last.** A caller who is not a member, or lacks the permission, gets `404`/`403 forbidden` *before* `403 step_up_required`, so the step-up prompt never reveals that an action would otherwise be allowed (`authz.step-up.order.unit`).
3. **Token rights are the intersection, computed live.** Step 5 recomputes the owner's current explicit role on every call; no part of a token's effective rights is stored anywhere except the scope list and the vault allowlist. `token.effective-permissions.prop` (fast-check) asserts, over random users, memberships, scopes and allowlists, that `effective(token) ⊆ effective(owner as user principal)` and that removing the owner's membership empties the token's rights for that vault.

`decide(...)` in `@iridium/contracts/authz.ts` is the pure core of steps 2, 4 (matrix part), 5 (matrix part) and 6: a total function of `{principalKind, isServerAdmin, explicitRole, vaultStatus, permission, scopes, vaultAllowed, mcpEnabled, stepUpOk}` to `Decision`. It is exported from the contracts package so the client can grey out controls with exactly the server's logic (A30: read-only controls in the client are convenience, not the boundary) and so the matrix can be property-tested without a database.

### 5.5 The two lookups, and why there is no cache

For a REST request the complete authorization cost is:

| # | Query | Index |
|---|---|---|
| 1 | `SELECT s.*, u.status, u.is_server_admin, u.authz_version FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_id = ?` | `uq_sessions_token_id` |
| 1′ | On `/collab` only, `loadLiveSession` replaces query 1 with `SELECT s.*, u.status, u.is_server_admin, u.authz_version FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?` — the cheaper of the two shapes, so the "two indexed lookups" accounting holds for `onAuthenticate`/`onTokenSync` as literally as it does for REST | `sessions` PRIMARY KEY |
| 1″ | For a bearer credential, query 1 is the `access_tokens` statement of §9.1 instead. For an OAuth access token it is the **same** statement with `LEFT JOIN oauth_consents` and `LEFT JOIN oauth_clients` added on their primary keys, so consent liveness and client status arrive with the token row rather than in a second round trip and the accounting stays at two indexed lookups | `uq_tokens_token_id` + two primary keys |
| 2 | `SELECT vm.role, vm.version, v.status, v.mcp_enabled FROM vaults v LEFT JOIN vault_members vm ON vm.vault_id = v.id AND vm.user_id = ? WHERE v.id = ?` | primary key + `PRIMARY KEY (vault_id, user_id)` |

All of them are primary-key or unique-index point lookups on small rows in the InnoDB buffer pool. Query 2 is a single statement producing the vault row and the membership in one round trip, so `authorize()` never issues two queries. The MCP server switch adds no third query either: it is an in-memory `SettingsStore` read (§5.4 step 5). Routes whose `vaultFrom` is a node, note or attachment id resolve the owning vault first (§6.3), which is one additional point lookup on a table the handler needs anyway; the resolved `{vaultId, kind}` is attached to the request and reused by the handler, so the vault is never resolved twice per request. There is no cache of consent or client state either: both arrive as columns on a row read fresh per call, which is what makes revoking an authorization a next-call property (§8.10).

Deliberately absent: a principal cache, a membership cache, a TTL cache, a negative cache, an LRU. The spec requires revocation to affect already-open sessions; a cache with any TTL makes "immediate" a lie, and a cache with invalidation is a second source of truth to get wrong. The `SettingsStore` is not an exception to A23: A23 forbids caching *principal, membership and token* state, and the store holds administrator policy that is reloaded synchronously inside the transaction-committing request that changes it (02-system-architecture.md ARCH-10/ARCH-19), so it has no TTL and no staleness window to reason about. The measured cost (load budget in 10-testing-and-quality.md: two point lookups, p95 well inside the `get_note p95 < 300 ms` MCP SLO) does not justify it. The optimisation that *is* designated, if measurement ever demands one, is the per-vault derived-path cache keyed by `vaults.tree_version` (A12) — a projection cache, not an authorization cache.

### 5.6 Vault status and visibility

`vaults.status` participates in every decision:

| `status` | Non-member | Member (any role) | Server admin (user principal) | Token principal |
|---|---|---|---|---|
| `active` | `not_found` | matrix | manager on the vault | scopes ∩ explicit role |
| `archived` | `not_found` | reads allowed, writes `forbidden` (`vault_archived` problem code on REST routes that mutate) | reads allowed, writes `forbidden` — archiving is not a trap door for admins either | reads allowed (a read-only token is unaffected) |
| `importing` | `not_found` | `not_found` — a half-imported vault is invisible until it flips to `active` (A45, F8) | `not_found` for content routes; visible only in `GET /admin/vaults` and the import job status | `not_found` |
| `deleting` | `not_found` | `not_found` | `not_found` for content routes; visible in `GET /admin/vaults` | `not_found` |

The archived-vault rule is `isRead(permission)`, defined as `READ_BUNDLE.includes(permission)`. `POST /vaults/:id/unarchive` is the primary exception: its `config.auth` is `{permission:'vault:archive', vaultFrom:'params.vaultId', allowArchived:true, stepUp:true}`.

`allowArchived` is the only flag that lifts step 4's archived check, and the set of routes carrying it is closed and enumerated in `@iridium/contracts/authz.ts`:

```ts
export const ALLOW_ARCHIVED_ROUTES = [
  'POST /vaults/:vaultId/unarchive',   // vault:archive — the way out of the freeze
  'GET /vaults/:vaultId/audit',        // vault:manage_members — a read whose permission is not in READ_BUNDLE
] as const;
```

A route needs the flag **if and only if** its permission is outside `READ_BUNDLE` *and* the action must still work while the vault is frozen. Exactly two qualify: unarchiving itself, and the vault manager's audit view, whose permission is `vault:manage_members` (§5.3 notes) rather than a READ_BUNDLE permission even though it is a `GET` — without the flag a manager could not read the `vault:<32-hex>` chain of a vault they had just archived, which this table's `archived` row ("reads allowed") and A46 both require. Every ordinary read route carries a READ_BUNDLE permission, so `allowArchived` on one would be a dead flag; the boot assertion rejects it there too (§6.2).

`authz.archived-vault.integration` asserts that the set of routes carrying `allowArchived` is exactly `ALLOW_ARCHIVED_ROUTES`, that `GET /vaults/:vaultId/audit` and every READ_BUNDLE route answer `200` on an archived vault, and that every mutating vault-scoped route answers `409 vault_archived`.

### 5.7 `accessibleVaultIds()` — authorization inside SQL

Search, cross-vault listings (`GET /vaults`, `GET /search`, `list_vaults`) and the audit viewer must not post-filter results: a result that is filtered after the fact has already been counted, paginated and possibly scored against inaccessible data. `apps/server/src/authz/accessible-vaults.ts` exports the one helper every such query uses:

```ts
accessibleVaultIds(principal, opts: { permission: Permission; surface: 'rest' | 'mcp' }): Promise<VaultId[]>
```

| Principal | Result |
|---|---|
| `user`, not admin | `SELECT vault_id FROM vault_members vm JOIN vaults v ON v.id = vm.vault_id WHERE vm.user_id = ? AND v.status IN ('active','archived') AND matrixAllows(vm.role, permission)` — the role filter is expressed as an `IN (…)` list of roles computed from the matrix in TypeScript, so the matrix stays the single source of truth |
| `user`, server admin | all vaults with `status IN ('active','archived')` |
| `token` | the same query for the owner, additionally intersected with `access_token_vaults` (or all explicit memberships when `all_vaults=1`) and, when `surface:'mcp'`, with `v.mcp_enabled = 1` in SQL; the server-wide switch is not a SQL predicate — a `false` from `SettingsStore.effective().mcp_enabled` short-circuits the helper to `[]` before any query runs |
| `system` | all vaults |

The returned ids go into the query as `vault_id IN (?)` (Kysely parameter list), so the ACL is part of the SQL plan, never a `.filter()` in JavaScript. An empty list short-circuits to an empty page without touching the index. `search.acl.integration` asserts that a FULLTEXT query for a term that exists only in a foreign vault returns zero rows and zero `total`, and that the generated SQL contains the `vault_id IN` predicate (asserted on the compiled query, not on the result).
## 6. Enforcement points

Every surface authenticates, then authorizes through §5, then queries with the vault id in the `WHERE` clause. The table is the map; the subsections are the contract.

| Surface | Authentication | Authorization | Failure shape |
|---|---|---|---|
| REST `/api/v1/*` | `onRequest` → `authenticate(request)`: cookie → `verifySession(raw,'cookie')`, `Authorization: Bearer irid_ses_…` → `verifySession(raw,'bearer')`, `Bearer irid_pat_…` → `verifyToken(raw, {surface:'rest'})` | `preHandler` → `routePolicy`: resolve vault from `config.auth.vaultFrom`, call `authorize()`, attach `request.principal` / `request.vault` | `ProblemDetails` 401 `invalid_credentials` · 403 `forbidden` / `csrf_rejected` / `step_up_required` / `token_scope_insufficient` · 404 `not_found` |
| WebSocket upgrade `/collab` | none yet — `preValidation` only checks Origin, Host and the IP/process socket caps | — | HTTP 403 (Origin/Host) or 429 `rate_limited` (socket caps) before the upgrade completes |
| WebSocket document | Hocuspocus `onAuthenticate`: consume ticket → `loadLiveSession` (§4.2) → resolve `note:`/`vault:` → `authorize('note:read'\|'vault:read')` | same call sets `connection.readOnly = authorize('note:write') !== 'allow'` | throw → close 4401 `unauthorized` / 4403 `revoked` / 4404 `note-not-found`, `note-trashed` or `note-closing` |
| WebSocket message | connection context (already authenticated) | `beforeHandleMessage`: epoch check (§8.6), closing set (`note-closing`), size and rate caps; `readOnly` enforced by Hocuspocus itself | close 4403 `revoked`, 4404 `note-closing`, 1009 `too-large`, close `rate-limited`, `SyncStatus(false)` for a read-only client's update |
| WebSocket awareness | connection context | `beforeHandleAwareness`: decoded `user.id === context.userId`, rate cap | close `awareness-spoof`; excess dropped silently |
| MCP `POST /mcp` (integration tokens) and `POST /mcp/connect` (OAuth connectors) | `onRequest` host/origin guards + `preHandler` `patAuth` (`/mcp`) or `oauthAuth` (`/mcp/connect`), both calling `verifyToken(raw, {surface:'mcp', resource})` → `request.mcpAuthInfo` | every tool and resource handler calls `authorize(principal, …, {vaultId, surface:'mcp'})` through `ContentReadCore` — identically on both mounts | HTTP 401 with `WWW-Authenticate` when the bearer is missing, invalid or of the kind the other mount accepts (`/mcp/connect` adds `resource_metadata` and `scope`, §6.5); `isError` content for every in-tool denial |
| Attachments | as REST | `attachment:read` / `attachment:write` with `vaultFrom:'params.vaultId'`; the attachment row must also match that vault id | 404 `not_found` |
| Search | as REST / MCP | `search:read` per vault; `accessibleVaultIds()` inside the SQL (§5.7) | empty page, never a partial one |
| History / revisions | as REST / MCP | `history:read` to list and read; `history:restore` (+ step-up) to restore | 403 `forbidden` |
| Export / import | as REST | `export:read`; `import:commit` or `server:vaults:create`; job ownership re-checked at every poll and at run | 403 `forbidden` / 404 `not_found` |
| Jobs and server-originated edits | `system` principal carrying the initiating user | the initiating principal is re-authorized at run time, not only at enqueue | job fails with `authz_revoked`, audited |
| CLI | operator shell access on the server host | `system` principal; commands that act on content require explicit ids and are audited with `credential_type='cli'` | non-zero exit + audit row |

### 6.1 `authenticate(request)`

`apps/server/src/auth/authenticate.ts` runs as a single `onRequest` hook registered by the `auth` plugin, before the CSRF guard and before body parsing.

```
authenticate(request): Principal | null
  if route.config.auth.public && no credential present                → null      (anonymous)
  if request.headers.authorization:
      [scheme, raw] = split; scheme must be 'Bearer' (case-insensitive)
      parsed = parseToken(raw)                                         // CRC + shape, no DB
      if !parsed                                                       → 401 invalid_credentials
      if parsed.kind === 'ses':  principal = verifySession(raw,'bearer')
      elif parsed.kind === 'pat' || parsed.kind === 'oat':
            principal = verifyToken(raw, { surface, resource })
            // resource = route.config.mcpAudience === 'oauth' ? PUBLIC_ORIGIN + '/mcp/connect' : undefined
      else                                                             → 401 invalid_credentials   // 'tkt'/'spl'/'oac'/'ort' are not HTTP credentials
      // cookies are ignored entirely on this request (A26)
  else if cookie '__Host-iridium_session' present and !route.config.auth.bearerOnly:
      principal = verifySession(cookieValue, 'cookie')
  if !principal && !route.config.auth.public                           → 401 invalid_credentials
  request.principal = principal
```

Rules that follow:

- **A request never mixes credential channels.** The presence of `Authorization` suppresses cookie reading completely, so a stolen cookie cannot be combined with a low-privilege bearer or vice versa, and the CSRF guard's "bearer requests skip" rule cannot be abused by sending both.
- **A credential kind is bound to a route.** `route.config.mcpAudience` says which kind a route accepts; presenting the other kind is `401 invalid_token` with an `error_description` naming the correct endpoint, never a different status and never a distinguishable shape (§6.5, `oauth.audience.contract`). `/mcp` accepts `pat`, `/mcp/connect` accepts `oat`, and the ★ REST read routes accept `pat` only — an OAuth token is issued for the `/mcp/connect` audience and RFC 8707 audience validation refuses it anywhere else.
- **Collab tickets, set-password links, authorization codes and refresh tokens are not HTTP credentials.** `irid_tkt_` is accepted only inside the Hocuspocus auth message; `irid_spl_` only in the `POST /auth/set-password` body; `irid_oac_` only in the `code` form field of `POST /oauth/token`; `irid_ort_` only in the `refresh_token` or `token` form field of `POST /oauth/token` and `POST /oauth/revoke`. Presenting any of them as a bearer is `401`, and none of them is consumed (a probe cannot burn a victim's link or code).
- **`bearerOnly` is load-bearing, not cosmetic.** It is the only thing that stops a `__Host-iridium_session` cookie from producing a principal on either MCP mount, because `authenticate()` is an instance-level `onRequest` hook (registered by the `auth` plugin in boot step 4) and Fastify runs instance-level hooks *before* a route's own `onRequest` array — so `/mcp`'s `ignoreCookies` has not yet run when this function executes. Removing `bearerOnly` in the belief that `ignoreCookies` already covers the case would reopen the CSRF surface on `/mcp` (§6.5, 06-mcp-and-agent-access.md "Mounting `/mcp` on Fastify").
- **Malformed credentials cost nothing.** The CRC and shape check in `parseToken` happens before any query; `security.credential-flood.integration` asserts that 10 000 malformed bearers produce zero queries on `dbApp`, counted with `countQueries(fn)` from `packages/testkit/src/db/query-counter.ts`.
- `401` responses carry `WWW-Authenticate: Bearer realm="iridium"` only on the two bearer-only routes, and the two challenges differ deliberately, because discovery is a property of a URL rather than of a request (06-mcp-and-agent-access.md). `/mcp` carries exactly `realm`, `error` and `error_description` and **no** `resource_metadata` (A33) — that omission is what keeps a client configured with a static header out of the OAuth discovery chain. `/mcp/connect` carries `realm`, `error`, `error_description`, `resource_metadata="<PUBLIC_ORIGIN>/.well-known/oauth-protected-resource/mcp/connect"` and `scope="vault:read note:read search:read history:read attachment:read export:read"`. `/mcp/connect` is also the one route that can answer `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"` (§6.5). Every header value is ASCII-only, because several HTTP stacks mangle non-ASCII in `WWW-Authenticate`, so the UI's `›` becomes `>` in the header and stays `›` in the JSON body. Cookie-authenticated routes omit the header entirely so browsers never show a native auth dialog, and `/oauth/token` and `/oauth/revoke` answer `invalid_client` with `WWW-Authenticate: Basic realm="iridium"` instead, which is the client-authentication challenge, not a user one. `oauth.discovery-split.contract` parses both challenges with a header parser and asserts the exact parameter set of each.

### 6.2 The route policy and the boot assertion

Every Fastify route declares `config.auth`. The type is in `@iridium/contracts/authz.ts`:

```ts
export type RouteAuth =
  | { public: true }
  | { self: true; stepUp?: boolean }                       // operates only on the caller's own rows
  | { serverAdmin: true; permission: Permission; stepUp?: boolean }
  | {
      permission: Permission;
      vaultFrom:
        | 'params.vaultId'
        | 'node:params.nodeId'
        | 'note:params.noteId'
        | 'attachment:params.attachmentId'
        | 'job:params.jobId'
        | 'body.vaultId';
      stepUp?: boolean;
      allowArchived?: boolean;
      principalKinds?: readonly ('user' | 'token')[];      // default ['user']; ★ routes add 'token'
      bearerOnly?: true;                                   // the two MCP mounts only
      mcpAudience?: 'pat' | 'oauth';                       // which credential kind this route accepts (§6.1)
    };
```

`apps/server/src/authz/route-policy.ts` is a Fastify plugin that, for every route with a non-`public` policy, registers a `preHandler` which:

1. reads `request.principal` (set by §6.1) — absent → `401`;
2. rejects a principal kind the route does not list → `403 token_scope_insufficient` for a token on a user-only route (this is how every mutating REST route refuses a PAT, A31);
3. resolves the vault:
   - `params.vaultId` → the path parameter;
   - `node:params.nodeId` / `note:params.noteId` → `SELECT vault_id, kind, deleted_at FROM nodes WHERE id = ?` (a missing row is `404 not_found`, identical to a foreign row);
   - `attachment:params.attachmentId` → `SELECT vault_id FROM attachments WHERE id = ?`, and the resolved vault must equal `params.vaultId` when both are present (the attachment routes are nested under the vault) — a mismatch is `404`;
   - `job:params.jobId` → the job row's `vault_id` plus the requester check of §6.8;
   - `body.vaultId` → after validation, for `POST /imports` with an existing-vault target;
4. calls `authorize(principal, permission, {vaultId, requireStepUp: stepUp, surface})`;
5. on `allow`, attaches `request.vault = {id, status, role}` and `request.vaultRole`, which handlers and response serialisers reuse (`GET /vaults/:vaultId` returns the caller's role from it);
6. on deny, maps the decision to `ProblemDetails` through one function (`security/problem.ts`), so the body shape, the `code` and the logged SIEM event are identical everywhere.

The boot assertion (`authz/route-policy.ts#assertRoutePolicies`, test `authz.route-policy.boot`) runs inside `buildApp()` after all plugins are registered, walks `app.routes`, and **throws, refusing to start the server**, when any of these hold:

| Assertion | Why |
|---|---|
| A route has no `config.auth` | Deny by default must be impossible to forget (A30) |
| A non-safe method (`POST/PUT/PATCH/DELETE`) is not covered by the CSRF guard and is not `bearerOnly` | A27 |
| The set of routes exempt from the CSRF guard is not exactly `CSRF_EXEMPT_ROUTES` (§4.4) | six routes legitimately need the exemption, so it must be an enumeration rather than a special case that can be widened silently (D04-32) |
| A route declares `mcpAudience: 'oauth'` but no Protected Resource Metadata document is registered for its path, or declares `mcpAudience: 'pat'` and one **is** registered | the credential a route accepts must equal the credential its discovery posture advertises; this is the assertion that makes the two-mount split a decision rather than an accident (06-mcp-and-agent-access.md) |
| `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` or `/.well-known/openid-configuration` is not registered as an explicit `404` route | each of those four paths is a probe a client makes before it sends any credential; they must 404 by decision, and an absent route cannot be asserted |
| An `/oauth/*` route declares neither `public: true` nor `self: true`, or is reachable by a token principal | the authorization server authenticates clients and browser sessions; a token principal must never be able to mint or revoke a grant |
| `config.auth.permission` is `'vault'`-scoped but `vaultFrom` is absent, or `'server'`-scoped but `vaultFrom` is present | §5.2 |
| `serverAdmin: true` with a non-`server:*` permission, or vice versa | keeps the two concepts aligned |
| A route lists `'token'` in `principalKinds` but its method is not `GET`/`HEAD`, or its permission is not in `READ_BUNDLE` | MVP tokens are read-only (A31, F4) |
| A `/admin/*` route lacks `stepUp: true` on a mutating method | A26 |
| `allowArchived` on a route outside `ALLOW_ARCHIVED_ROUTES` (§5.6) | archiving must actually freeze a vault |
| `allowArchived` on a route whose `permission` is in `READ_BUNDLE` | the flag would be a no-op there; a dead flag invites the belief that the freeze was lifted |
| Two routes resolve to the same method+path | catches a duplicated registration that could shadow a policy |

The assertion runs in every test that builds the app (all integration tests use `buildApp()`), so it is continuously enforced rather than checked once.

### 6.3 REST specifics

- **Vault-scoped queries.** Every handler query includes the vault id even when the primary key is globally unique: `WHERE id = ? AND vault_id = ?`. This is belt-and-braces behind `authorize()`, and it is enforced by review plus the `authz.vault-isolation.integration` suite, which, for every route in `openapi.json` that takes an id, issues the request as a member of another vault with a valid id from the first vault and asserts `404` with an empty body (no `current` representation, no `ETag`).
- **`If-Match` and authorization are independent.** A stale `If-Match` is `409 stale_version`, a missing one on a route that requires it is `428 precondition_required` (A13) — both only *after* `authorize()` allowed, so version information never leaks to a non-member.
- **`GET /auth/me`** returns `{user, isServerAdmin, principalKind, sessionKind?}`; for a token principal it additionally returns `{tokenId, scopes, vaults}` so an agent can discover its own rights without probing.
- **Read-only PAT routes (★).** `principalKinds: ['user','token']` on exactly the routes marked ★ in 09-api-reference.md. Any mutating route reached with a PAT is `403 token_scope_insufficient` — not `401`, because the credential is valid; not `404`, because hiding the route from a legitimate owner of the vault would be confusing and leaks nothing.
- **`no-store`.** The security plugin sets `Cache-Control: no-store` on every `/api/v1/*` response except attachment bytes (`private, max-age=3600`, A44) and conditional `304`s, so an intermediary cannot serve an authorized response to a later, unauthorized request.

### 6.4 WebSocket enforcement

Authorization on `/collab` happens at four moments. The persistence-related halves of these hooks are specified in 05-collaboration-and-durability.md; what follows is the authorization contract only.

**(1) Upgrade — `preValidation: [originAllowlist, connectionCaps]`.** Runs before any WebSocket frame exists, on the HTTP request, and therefore with no identity: it checks Origin and Host (HTTP `403 forbidden`) and the per-IP/per-process **socket** caps (HTTP `429 rate_limited`). No WebSocket handshake completes and no close code is sent. The per-user cap is a document-connection cap and is enforced in `onAuthenticate`, where the ticket has bound a user (§7.6). See §7.5 for Origin and §7.6 for caps.

**(2) `onAuthenticate({token, documentName, requestHeaders, connection, socketId})`.** Hocuspocus calls this once per document per connection with the auth message payload.

```
onAuthenticate:
  1. ticket = TicketStore.consume(token)                    // single use, 60 s, §7.3
       none → throw Unauthorized('unauthorized')            // close 4401
  2. res = loadLiveSession(ticket.sessionId)                 // by PK (§4.2); the row must still be live
       null | { dead:'expired' }            → throw Unauthorized('unauthorized')   // close 4401
       { dead:'revoked' | 'user_inactive' } → throw Unauthorized('revoked')         // close 4403
       principal = res
     if principal.userId !== ticket.userId  → throw Unauthorized('unauthorized')
          + SIEM authz.denied {reason:'ticket_session_mismatch'}    // a TicketStore bug can never cross users
  3. parse documentName:  /^(note|vault):([0-9a-f-]{36})$/
       malformed → throw Unauthorized('protocol-error')
  4. note:<id>  →  row = SELECT n.vault_id, n.kind, n.deleted_at, v.id, v.status, v.mcp_enabled
                         FROM nodes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = ?
                   // all three vault columns, so the row satisfies AuthzScope.vault (§5.4) as loaded
         missing | kind != 'note'                → throw 'note-not-found'     (4404)
         deleted_at != null                      → throw 'note-trashed'       (4404)
         gateway.isClosing(id)                   → throw 'note-closing'       (4404)
       vault:<id> → row = SELECT id, status, mcp_enabled FROM vaults WHERE id = ?
         missing                                 → throw 'note-not-found'     (4404)
  5. d = await authorize(principal, 'note:read' | 'vault:read', {vaultId, vault: row, surface:'collab'})
       d !== 'allow' → throw Unauthorized(d.deny === 'not_found' ? 'note-not-found' : 'unauthorized')
  6. write = await authorize(principal, 'note:write', {vaultId, vault: row, member: <reused>, surface:'collab'})
     connection.readOnly = (documentName starts with 'vault:') || write !== 'allow'
  7. admission budget (A50): loaded docs / state bytes  → throw 'capacity'
  8. seed the epoch table (§8.6) with the SAME values the context carries:
       epochTable.retain(userId)                              // refcount; released on connection close
       epochTable.user(userId, principal.authzVersion)
       epochTable.member(vaultId, userId, member?.version ?? 0)
     return context: {
       sessionId, userId, vaultId, noteId?, role,
       authzEpoch: { userAuthzVersion: principal.authzVersion, memberVersion: member?.version ?? 0 },
       isServerAdmin: principal.isServerAdmin,
     }
```

Details that are part of the contract:

- The two `authorize()` calls reuse one membership lookup (`scope.member` is threaded through), so authentication of a document costs one session lookup plus one vault/membership lookup — the same two queries as a REST request.
- **Step 8 is the epoch table's only seeding point besides `onTokenSync`.** Writing the table here — from rows the hook has already read, so it costs no extra query — is what makes `beforeHandleMessage` I/O-free in steady state (§8.6); a connection that has never been the subject of an `AuthzBus` event would otherwise be permanently "stale" and re-authorize on every inbound message. The membership sentinel is the numeric `0`, never `'removed'`: a server admin with no `vault_members` row is authorized as manager (A30, F4) and its context carries `memberVersion: 0`, and `vault_members.version` starts at `DEFAULT 1` (03-data-model.md), so `0` unambiguously means "no membership row" while `'removed'` stays reserved for the reconciler's post-deletion write and therefore never equals a numeric context value.
- `connection.readOnly = true` is the **only** write boundary for viewers. The client's CodeMirror read-only compartment is UX. With `readOnly` set, Hocuspocus refuses the client's `SyncStep2`/`Update` messages and answers `SyncStatus(false)`, which the client surfaces as the `rejected` save state (A20) with the text still exportable. `collab.viewer-enforcement.integration` drives a raw `NoteClient` that sends a well-formed update as a viewer and asserts the server's Y.Doc is unchanged, the DB has no new `note_updates` row, and `collab.write.rejected` is audited.
- `vault:<id>` documents are read-only for everyone (A18), so a manager cannot write to the channel either; all channel traffic is server-originated `broadcastStateless`.
- Every `throw` is an `Unauthorized` carrying one of the `CollabCloseReason` strings of D.2, and the provider surfaces only that string. `collab.connection.rejected` is audited with the reason (bounded per §11.4).
- The context type is `IridiumCollabContext`, declared once and used as the Hocuspocus generic, so every later hook has `context.userId` typed.

**(3) `beforeHandleMessage({documentName, connection, context, update})`.** Authorization work: the epoch check of §8.6, the closing-set check (a trash or purge of this note is being coordinated → the transient `note-closing`, 4404; once the trash has committed the refusal comes from `nodes.deleted_at` as `note-trashed`), and the limits of A.1 (single update ≤ 1 MiB → close 1009 `too-large`; 200 messages per 10 s → close `rate-limited`). The hook never decodes the Yjs update for authorization purposes; identity comes from `context`, and content legality is checked at compaction (A22).

**(4) `beforeHandleAwareness({connection, context, update})`.** Decodes the awareness update with the `y-protocols/awareness` helpers (varint header + JSON states, cheap) and asserts, for every state in the message, that `state.user.id === context.userId`. A mismatch closes the connection with `awareness-spoof` and audits `collab.write.rejected {reason:'awareness_spoof'}`. A per-connection cap of 10 awareness messages per second drops excess messages without closing (a fast mouse is not an attack). Awareness carries only `{user:{id}, cursor?, mode?}`; names and colours are never read from it — the UI uses the server-authoritative `participants` message (A25, F6). Viewers keep awareness enabled, since a null awareness breaks Hocuspocus ping handling.

**(5) `onTokenSync`.** Periodic re-validation; §8.7.

### 6.5 MCP enforcement

Three layers, all fail-closed (A32, A33), over **two mounts**. Iridium serves the identical MCP surface at `POST /mcp`, which accepts integration tokens only and advertises no OAuth discovery, and at `POST /mcp/connect`, which accepts OAuth access tokens only and publishes Protected Resource Metadata; 06-mcp-and-agent-access.md specifies why one URL cannot serve both audiences and what each mount advertises. Everything below applies byte-identically to both: the same transport guards, the same kill switches, the same rate limiter, the same `createMcpHandler` instance, the same `ContentReadCore` and the same per-call authorization. The only differences are which credential kind the mount accepts and what its `401` challenge carries.

1. **Transport guards** in `onRequest`, in the order the route declares them (`hostHeaderValidation`, `rejectBrowserOrigin`, `ignoreCookies`, `mcpIpGate` — the per-IP failed-verification budget of §10.1, last so a rebinding probe is refused without consuming anyone's budget): `hostHeaderValidation([PUBLIC_HOST])` from `@modelcontextprotocol/fastify`, `rejectBrowserOrigin` (the **presence** of any `Origin` header → `403 {"error":"origin_not_allowed"}`; the predicate is `request.headers.origin !== undefined`, never a scheme or value heuristic — MCP clients send no `Origin`, so the check needs no allowlist and removes the DNS-rebinding/CSWSH class for both mounts — including `/mcp/connect`, where a browser-based connector would otherwise be the one plausible source of an `Origin` header, and is not one: the connector's requests originate from the connector's own server, never from a page. The guard's name is historical: `https://evil.example`, `<PUBLIC_ORIGIN>`, `app://iridium` and the literal `null` are all refused alike. Asserted by `mcp.origin.contract.spec`: `Origin: https://evil.example` → 403, `Origin: <PUBLIC_ORIGIN>` → 403 (same-origin is not an exemption), `Origin: app://iridium` → 403, `Origin: null` → 403, no `Origin` header → passes to `patAuth`; `mcp.host-guard.contract.spec` covers the `Host` check), and `ignoreCookies` (deletes `req.headers.cookie` **and** empties the `req.cookies` jar that the `@fastify/cookie` `onRequest` parser has already filled). Because route-level `onRequest` hooks run *after* instance-level ones, this hook runs after `authenticate()`: the guarantee that no ambient credential can authenticate an MCP call comes from `bearerOnly` in §6.1, and `ignoreCookies` is defence in depth for everything downstream — `mcpIpGate`, `patAuth`, `mcpKillSwitch`, `chargeRateLimit`, the route handler and the SDK. Neither layer is redundant and neither may be dropped.
2. **`patAuth` (on `/mcp`) and `oauthAuth` (on `/mcp/connect`) preHandlers**: two registrations of one function. Both call `verifyToken(raw, {surface:'mcp', resource})` — the single verification path of D04-26 — and both build `request.mcpAuthInfo = AuthInfo{token, clientId, scopes, expiresAt, resource, extras:{principal}}`. They differ only in the two values the route supplies: on `/mcp`, `mcpAudience: 'pat'`, `clientId: 'pat:' + id16` and `resource: new URL(PUBLIC_ORIGIN + '/mcp')`; on `/mcp/connect`, `mcpAudience: 'oauth'`, `clientId: 'oauth:' + oauth_clients.client_id` and `resource: new URL(PUBLIC_ORIGIN + '/mcp/connect')`, which is also the value RFC 8707 audience validation compares against (§9.1 step 5a). Absent, invalid, expired, revoked or **of the wrong kind for this mount** → `401` with the challenge of §6.1 — on `/mcp` deliberately **without** a `resource_metadata` parameter (A33), on `/mcp/connect` with it and with `scope`. All five failures share one status, one header and one `error` value; only `error_description` differs, and for a wrong-kind presentation it names the other endpoint so a misconfigured client can be fixed without a support ticket. The route handler re-checks `req.mcpAuthInfo` before `reply.hijack()` so a hook ordering mistake cannot produce an unauthenticated MCP session; `mcp.fail-closed` asserts a `401` when the preHandler is disabled by a test fault, on both mounts.
3. **Per-call authorization** inside every tool and resource handler: the handler reads `ctx.http.authInfo.extras.principal` and calls into `ContentReadCore`, whose every method begins with `authorize(principal, <permission>, {vaultId, surface:'mcp'})`. There is no tool that reads without going through `ContentReadCore`, and no `ContentReadCore` method that takes a pre-authorized flag.

The refuse-any-`Origin` form is deliberately stricter than the MCP specification, which only requires a 403 on a present-and-*invalid* `Origin` (digest item 8 sketched "present ⇒ must equal `PUBLIC_ORIGIN`"). Iridium takes the stricter form from digest §363 because `/mcp` is bearer-only with cookies stripped, so no legitimate browser caller exists: an allowlist would be dead code, and dead code here invites exactly the scheme heuristic this guard must not contain.

Denials inside a tool are `isError: true` results with a single shared text for *both* not-found and forbidden ("No note with that id or path is available to this token"), never HTTP `403`. The rule that used to be "never 403, because a 403 starts an OAuth step-up flow Iridium cannot complete" now splits, because Iridium **can** complete one. A **transport-level** scope failure — a credential whose granted scopes contain none of the six Read permissions — answers `403` on `/mcp/connect` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…", resource_metadata="…"`, because a re-authorization can actually fix it. A **per-argument** scope failure inside a tool (`include_trashed` without `history:read`) stays an `isError` result on both mounts, because the tool-registration filter means a tool whose scope is missing is not registered at all, and no re-authorization makes a narrowed consent grow a permission the owner's role does not carry. No MVP flow produces the transport-level case, since the only grantable bundle is Read; `oauth.insufficient-scope.contract` drives it by writing a narrowed scope set into a consent through the test database, so the seam is exercised rather than merely asserted. Protocol-level failures (unknown tool, malformed params) remain JSON-RPC errors. Every tool call on either mount writes an `access_log` row with `note_ids` (§11.5), including denied calls (`status='denied'`).

### 6.6 Attachments, search, history, export

| Surface | Enforcement detail |
|---|---|
| Attachment download | `GET /vaults/:vaultId/attachments/:attachmentId` with `attachment:read`; the row's `vault_id` must equal the path's; bytes stream with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Content-Disposition: inline` only for `image/png\|jpeg\|gif\|webp\|avif` (A44). There are no signed or unauthenticated attachment URLs in MVP: the web client loads `<img src>` with the session cookie, the desktop through `iridium-attachment://` in the main process. A shared link to an attachment is therefore useless to a non-member — `attachments.security.integration` asserts `404` for a foreign attachment id and `403`/`404` for a revoked member. |
| Attachment upload/delete | `attachment:write`; delete is refused (`409`, referencing notes listed) unless `force`, and `force` still requires `attachment:write` |
| Search | `search:read`; `accessibleVaultIds()` is part of the SQL (§5.7); snippets are produced from `note_projections.markdown` of rows that passed the ACL, so no snippet can come from an inaccessible note |
| Title/path listings | `GET /vaults/:vaultId/nodes` and `list_notes` are `vault:read`; trashed nodes require `history:read` (`include_trashed`), because the trash reveals deleted titles |
| Revisions | list/read `history:read`; restore `history:restore` **plus step-up plus `{confirm:true}`**, and the restore itself flows through a `DirectConnection` whose origin carries the authenticated principal so `note_updates.actor_id` is the restoring user (§6.9) |
| `?fresh=true` on `GET /notes/:id/markdown` | `history:read` in addition to `note:read`, rate-limited 6/min per principal per note (A38) — it forces server work, so it is not a plain read |
| Export | `export:read` to create and to download; the download route re-checks the job's requester **and** re-authorizes `export:read` on the vault at download time, so a membership removed between creation and download blocks the download (`export.revocation.integration`) |
| Import | `POST /imports` with a new-vault target needs `server:vaults:create`; with an existing-vault target `import:commit`; `PUT /imports/:id/upload`, `scan`, `commit`, `abort` are restricted to the requesting principal (§6.8) and re-authorize the target on `commit` |

### 6.7 Desktop IPC

The Electron main process is a *client*, not a second policy layer: every IPC call ends in an HTTP request that the server authorizes normally. What the IPC layer enforces is custody and shape (A53):

- every `ipcMain.handle` validates `event.senderFrame?.origin === 'app://iridium'` (plus the Vite dev origin when unpackaged) synchronously on receipt, then parses the payload with the zod schema from `@iridium/contracts/desktop-ipc.ts`;
- `iridium:api:request` accepts only paths matching `^/api/v1/`, rejects absolute URLs, and never lets the renderer set `Authorization`, `Cookie`, `X-Iridium-Client-Version` or `Host` — main sets those itself;
- `iridium:collab:tickets` takes only `{count: 1..50}`;
- the preload exposes fixed wrappers only; there is no generic `invoke` and no `secrets` member on `IridiumHost` (B.3).

Tests: `desktop.ipc-origin`, `desktop.preload-surface`, `desktop.ipc-contract`, `desktop.attachments-no-token-in-renderer`.

### 6.8 Jobs, transfers and long-running work

Authorization is re-evaluated when work runs, not only when it is requested, because a job can outlive a membership.

| Moment | Check |
|---|---|
| Enqueue | `authorize()` on the route; the job row records `requested_by_user_id`, `requested_by_session_id`, `vault_id` and the permission that authorized it |
| Poll (`GET /imports/:jobId`, `GET /exports/:jobId`) | requester must equal `request.principal.userId` (or `server:jobs`); plus `authorize()` on the recorded permission — a revoked member cannot watch the progress of their own job |
| Run (worker picks the job up) | `system` principal, but the **recorded** principal is rebuilt from the database (`userId` + live membership) and re-authorized; a failed check fails the job with `authz_revoked`, audits `import.aborted` / `export.created {outcome:'failure', reason:'authz_revoked'}`, and deletes staging output |
| Download (`GET /exports/:jobId/download`) | requester + live `export:read` (§6.6) |
| Scheduled maintenance jobs | `system` principal, no user authorization involved; `admin.job.triggered` is audited when a server admin triggers one manually (`server:jobs` + step-up) |

### 6.9 Server-originated collaborative writes

Two operations make the server write into a live Y.Doc: revision restore and import-time initialisation. Both go through `CollabGateway.openServerEdit(noteId, principal, permission)` which:

1. calls `authorize(principal, permission, {vaultId})` — `history:restore` for a restore, `import:commit`/`server:vaults:create` for an import — and refuses otherwise;
2. opens a Hocuspocus `DirectConnection`, transacts with origin `{source:'local', context:{reason:'restore'|'import'|'repair', principal}}`;
3. causes the persistence writer to record `note_updates.actor_id = principal.userId` and `actor_kind='user'`, so authorship in revisions and audit is the authenticated human, never a CRDT client id (spec §8);
4. audits `note.revision.restored` / `import.committed` inside the structural transaction.

`iridium doctor --repair-content` uses the same path with `{kind:'system', job:'cli:doctor'}` and `reason:'repair'` (A22), which is why the repair is audited as `note.content.repaired` with `credential_type='cli'`.

### 6.10 What is *not* an enforcement point

Stated explicitly so no implementer adds a second policy layer that can drift:

- The client's read-only editor compartment, disabled buttons and hidden menu items are convenience (spec §4).
- Hocuspocus's own `readOnly` handling is a mechanism Iridium sets; it is not a separate decision.
- The reverse proxy performs no authorization. It terminates TLS, forwards `X-Forwarded-For` (trusted only from `TRUST_PROXY` CIDRs) and the MCP headers; it has no auth rules, so a direct connection to the Node port (bound to `127.0.0.1:4000`) is not a bypass.
- MySQL roles (A8) limit what the application process can do to the database (notably: it cannot alter audit rows). They are defence in depth for integrity, not user-level authorization.
## 7. Collaboration tickets, Origin handling and connection admission

### 7.1 Why tickets and not the session credential

The WebSocket endpoint deliberately accepts neither the session cookie nor the desktop session bearer (A24):

| Rejected option | Why |
|---|---|
| Cookie on the upgrade | Cookies are ambient: a cross-site page can open `wss://iridium.example/collab` and the browser attaches the cookie (cross-site WebSocket handshakes are not covered by `SameSite` in every engine, and the upgrade is not a "request" the Fetch Metadata guard can fully classify). That is textbook CSWSH (T9). |
| Session bearer in the WebSocket URL | Browsers cannot set headers on `WebSocket`, so the credential would have to travel in the query string, where it lands in proxy logs, `Referer`-style telemetry and error reports. |
| A JWT minted from the session | A self-contained token cannot be revoked before it expires, which contradicts the spec's live-revocation requirement, and introduces a second key to rotate. |
| The desktop session bearer handed to the renderer | Breaks main-process-only custody (A26, T12). |

A ticket is a short-lived, single-use, server-side-stored credential that is presented **inside the Hocuspocus auth message** after the socket is open. It is not ambient (a hostile page cannot obtain one: `POST /auth/collab-tickets` is CSRF-guarded), not replayable (single use, 60 s), and it binds the connection to a concrete session so the revocation machinery of §8 can address it.

### 7.2 Issuance — `POST /auth/collab-tickets`

```
POST /api/v1/auth/collab-tickets
  auth: { self: true }            // session principal, cookie or desktop bearer
  csrf: enforced for cookie principals
  body: { count: number }         // 1..50, default 1
  200: { tickets: string[], expiresIn: 60 }
```

| Property | Value |
|---|---|
| Secret | 32 CSPRNG bytes per ticket, formatted as `irid_tkt_<id16>_<secret43><crc6>` (§2.2) |
| Storage | in-process `TicketStore`: `Map<tokenId, {secretHash, sessionId, userId, expiresAt}>`, SHA-256 of the secret, never persisted (C.1) |
| TTL | 60 s, swept by a 10 s interval timer and lazily on lookup |
| Binding | `{sessionId, userId}` — **not** to a document name |
| Uses | exactly one |
| Batch | up to 50 per request; the response order is irrelevant, the client pops from the batch |

**Why a batch** (A24): a desktop window with 12 open note tabs plus the vault channel needs 13 tickets the instant the network returns. Issuing them one at a time turned the per-session rate limit into a self-inflicted outage in the reconnect storm that the limit was meant to contain. With batches, a full reconnect of 20 documents is one request.

**Why not bound to a document** (deviation from the risk-first draft, settled by A24): binding a ticket to a note id would require the client to know which document it is about to open *before* it asks — which is exactly backwards for the reconnect path, where the provider asks for a token per document as it re-syncs — and it would add nothing, because `onAuthenticate` re-resolves the document and re-authorizes against the live database anyway (§6.4). The ticket proves "this socket belongs to live session S of user U"; the document decision is always fresh.

Client side (`@iridium/collab-client`, `TicketSource`): one `TicketSource` per window holds a small pool, requests `count = max(1, openProviders + 2)` when the pool runs dry, and dedupes concurrent requests into a single in-flight call. The Hocuspocus provider's `token` getter is `async () => ticketSource.take()`; it retries 3 times with exponential backoff on `429` and on network errors, because a transient ticket failure must never close an otherwise healthy connection (A24). On the desktop the pool lives in the renderer but is filled through IPC `iridium:collab:tickets`, so the renderer holds only single-use 60 s credentials (A26).

### 7.3 Consumption

`TicketStore.consume(raw)` is the first statement of `onAuthenticate`:

```
consume(raw):
  p = parseToken(raw); if !p || p.kind !== 'tkt'        → null
  entry = map.get(p.tokenId); if !entry                 → null
  map.delete(p.tokenId)                                 // delete first: a replay of the same ticket always fails,
                                                        // even if the checks below throw
  if !timingSafeEqual(secretHash(p.secret), entry.secretHash) → null
  if now >= entry.expiresAt                             → null
  return entry                                          // {sessionId, userId}
```

The delete-before-verify order is deliberate: an attacker who has observed a ticket id cannot keep the entry alive by submitting wrong secrets, and a racing double-use (two sockets, same ticket) resolves to exactly one winner because `Map.delete` is atomic in the single-threaded event loop. After consumption, the session itself is re-loaded from the database by primary key (`loadLiveSession(ticket.sessionId)`, §4.2) and must still be live, so a ticket issued one second before `DELETE /me/sessions/:id` is useless; the loaded `userId` is additionally compared with the ticket's.

A process restart empties the store; outstanding tickets become invalid and providers simply fetch new ones (their `token` getter is called again on every connection attempt). `tickets.batch-and-limits.integration` covers: single use, expiry, wrong secret, foreign session, replay after revocation, batch size bounds, the 429 path, a ticket whose session idle-expired between issuance and consumption (`ManualClock.advance` → close `unauthorized`, row left `revoked_reason='expired'`), a ticket whose owner was disabled in the same window (close `revoked`), and a ticket whose `userId` does not match the loaded session (refused, with `ticket_session_mismatch` logged).

### 7.4 Ticket economics and tolerant re-validation

| Limit | Value | Rationale |
|---|---|---|
| Tickets per request | ≤ 50 | covers the connection cap of 20 documents twice over |
| Tickets per minute per session | 300 | a 20-document reconnect loop at the provider's maximum backoff cannot exhaust it |
| Tickets per minute per IP | 1 000 | allows a shared-NAT office while bounding a script |
| Ticket TTL | 60 s | long enough for a slow handshake, short enough that a leaked ticket is worthless |
| Re-validation interval | 15 min ± 3 min jitter, per connection | spreads the load of `onTokenSync` across a fleet instead of producing a synchronised spike |
| Re-validation grace | 5 min after `requestToken()` before closing | a browser tab that is throttled in the background must not lose its session |

The jitter is computed per connection at `afterLoadDocument` (`15 min + random(−3, +3) min`) and stored on the connection, so two tabs of the same user do not re-validate in lockstep.

### 7.5 Origin handling on the upgrade

`originAllowlist` runs as `preValidation` on `app.get('/collab', {websocket:true, …})`, i.e. on the HTTP upgrade request, and replies `403` before any WebSocket handshake completes.

```
originAllowlist(request):
  origin = request.headers.origin
  if origin === undefined                       → 403        // absent Origin is always rejected (A24)
  allowed = [ PUBLIC_ORIGIN, 'app://iridium' ]
          ∪ (NODE_ENV === 'development' ? DEV_ORIGINS : [])  // e.g. http://localhost:5173
  if !allowed.includes(origin)                  → 403
  → pass
```

| Client | Origin sent | Notes |
|---|---|---|
| Web SPA | `PUBLIC_ORIGIN` (the SPA is served from it) | exact string compare against the serialised origin |
| Electron renderer | `app://iridium` | the renderer is loaded from the privileged `app://iridium` scheme registered with `corsEnabled:true` (A53); requests from it carry that literal Origin |
| `iridium-mcp` bridge, MCP clients | n/a | they never connect to `/collab` |
| Tests | `PUBLIC_ORIGIN`, injected | `@iridium/testkit`'s `NoteClient` is a `ws` subclass that sets the `Origin` header explicitly |

**Absent `Origin` is rejected, with no bypass switch.** Non-browser clients can always set the header, and an environment flag such as `IRIDIUM_ALLOW_NO_ORIGIN_WS` would inevitably be enabled in production "to make the desktop work" and would then accept any CLI or server-side attacker that reaches the port. This is settled in A24; `security.ws-origin.integration` asserts 403 for an absent Origin, for `https://evil.example`, for a case-mutated `PUBLIC_ORIGIN` with a different port, and 101 for the two allowed values.

**The Electron contingency — resolved.** Spike S3 (`docs/spikes/S03-electron-ws-origin.md`) ran on 2026-09-13 and **passed**: a renderer loaded from `app://iridium/` sent `Origin: app://iridium` — the bare 21-byte serialised origin, no trailing slash, no port — on all 50 observations, across `fetch` and the WebSocket upgrade, against plain and TLS listeners. The desktop renderer therefore opens `/collab` itself, `ElectronHost` does not define `collab.webSocketFactory`, the `iridium:collab:open|send|close` channels are never registered, and this row of the allowlist stands as written with no bypass. The evidence is Windows-only, so the three-OS guarantee is a standing test rather than a spike: `desktop.launch.e2e` asserts the header on ubuntu, windows and macos in `e2e-electron` on every pull request (07-client-applications.md §7.10). **If that assertion ever fails on a platform,** A53's designed fallback is what executes: socket ownership moves to the main process (`IpcWebSocket`), main opens the socket with Electron 44's `net.WebSocket` carrying an explicit `Origin: app://iridium` header on the profile's session, plus the bearer-authenticated ticket relay, and the renderer talks to main over `iridium:collab:open|send|close` with `iridium:event:collab-message|collab-close`. The allowlist does not change and no bypass is introduced: main is a trusted process that can legitimately assert the renderer's own origin.

**Host header.** The same `preValidation` chain validates `Host` against `PUBLIC_HOST` when `TRUST_PROXY` is configured, which closes DNS rebinding against the loopback-bound Node port.

### 7.6 Connection caps and admission

| Limit | Value | Where |
|---|---|---|
| Concurrent `/collab` **document** connections per user | 20 (`CONNECTIONS_PER_USER`, env `COLLAB_MAX_CONNECTIONS_PER_USER`) | `IridiumLimits.onAuthenticate`, after `TicketStore.consume` has bound `{sessionId, userId}` — the upgrade itself carries no credential (§7.1, §7.3), so the cap cannot be evaluated there — counted over the live Hocuspocus `note:*` + `vault:*` connections whose `context.userId` matches. Refusal throws `rate-limited`, which sends `PermissionDenied('rate-limited')` for that document only while the socket and the window's other documents keep syncing; logged and audited as `collab.connection.rejected` |
| Concurrent `/collab` sockets per IP | 50 (`CONNECTIONS_PER_IP`, env `COLLAB_MAX_CONNECTIONS_PER_IP`) | `connectionCaps` `preValidation` on the upgrade, from the per-IP counter in `collab/limits.ts` — incremented when the upgrade is accepted, decremented on socket `close`, and including `pendingUpgrades`, the sockets whose first `onAuthenticate` has not yet completed → HTTP `429` `ProblemDetails{code:'rate_limited'}` with `retry-after` |
| Concurrent `/collab` sockets per process | 5 000 (`CONNECTIONS_PER_PROCESS`, env `COLLAB_MAX_CONNECTIONS_PER_PROCESS`) | same counter, same `429` |
| Loaded documents / total state bytes | 2 000 / 1 GiB | `onAuthenticate` (A50) → close `capacity` |
| WebSocket frame | 2 MiB | `@fastify/websocket` `maxPayload` |
| `maxPendingDocuments` | 100 | Hocuspocus option (A17) |

**The counting unit is a document connection, not a socket.** One `HocuspocusProviderWebsocket` (one OS socket) serves a whole window, but every `HocuspocusProvider` on it — one per open note plus one per open vault — is a separately authenticated document connection and counts against the 20. A window with 12 live note sessions plus its vault channel therefore holds 13 of them. The desktop shell is exactly one `BrowserWindow` (07-client-applications.md D07-16) and caps itself at `MAX_LIVE_NOTE_SESSIONS = 12` (D07-15), so it cannot exceed 13; the web SPA opened in several browser tabs, or web plus desktop at once, can legitimately approach 20. `NoteSessionRegistry` releasing a note session 60 s after its last tab closes (A41) is what keeps closed tabs from counting and bounds churn. The value stays at 20 (skeleton §A.1; §7.4's ticket batch, `MAX_LIVE_NOTE_SESSIONS`, D07-15 and `collab.limits` are all sized to it); a fleet that needs more raises `COLLAB_MAX_CONNECTIONS_PER_USER` (11-operations-and-deployment.md §env).

Upgrade rejections carry a `ProblemDetails` body: HTTP `429` `code:'rate_limited'` with `retry-after` for the IP and process socket caps (the error catalogue of 09-api-reference.md §2 binds `rate_limited` to `429`), and HTTP `403` `code:'forbidden'` for the Origin and Host guards. The per-user document cap is not an upgrade rejection at all — it closes one document with `rate-limited` and leaves the socket alive. All three are logged as `collab.connection.rejected` SIEM events; only the Origin and capacity rejections are audited (bounded, §11.4), because cap rejections are an operational signal rather than a security event.
## 8. Live revocation

Spec §4: *"Revoking access or downgrading a role must affect already-open sessions, not just the next login. The server must stop unauthorized future reads/writes and disconnect or reauthorize affected collaboration sessions."* This section specifies the mechanism that makes that true, with numbers.

### 8.1 The five mechanisms and what each one covers

| # | Mechanism | Covers |
|---|---|---|
| 1 | **No caches on the authorization path** (§5.5) | REST and MCP: the *next* request after COMMIT is already decided on fresh rows. Latency of revocation: zero. |
| 2 | **Version epochs** — `users.authz_version`, `vault_members.version` | Detecting that a live WebSocket connection's authorization is out of date, without a query per message. |
| 3 | **`AuthzBus`** — in-process publish after COMMIT | Turning a database change into an action on live connections. |
| 4 | **`CollabGateway`** — sweeps live connections | Closing, downgrading and upgrading connections; closing documents on trash/archive. |
| 5 | **`onTokenSync`** — periodic re-validation every 15 min ± 3 min | Backstop: catches anything the bus missed (a dropped subscriber, a future multi-process deployment, a connection created during a race). |

Mechanisms 2 and 5 exist because 3 and 4 are best-effort in principle: a sweep iterates a set that can change while it iterates, and in a multi-process future the bus becomes a network hop. Correctness never depends on the sweep alone — the epoch check makes any *write* from a stale connection impossible, and the token sync bounds how long a silent, stale connection can linger.

### 8.2 Epochs

| Column | Bumped when | Read by |
|---|---|---|
| `users.authz_version` | user disabled, user deleted, password set or changed, `is_server_admin` changed, any `vault_members` INSERT/UPDATE/DELETE for that user, admin session revocation | `verifySession`, `verifyToken`, `onAuthenticate` (stored in the connection context) |
| `vault_members.version` | role change on that membership (also `version+1` on the row that is inserted, starting at 1) | `authorize()` (returned by the membership lookup), `onAuthenticate` |

A connection's `authzEpoch` is the **tuple** `{userAuthzVersion, memberVersion}`, never a sum (A23). A sum is not injective: `authz_version 4 + memberVersion 2` equals `5 + 1`, so a simultaneous membership bump and role change could cancel out and leave a stale connection looking current. The in-process epoch table therefore stores two independent counters and the comparison is `a.userAuthzVersion !== b.userAuthzVersion || a.memberVersion !== b.memberVersion`.

Every bump happens **inside the same transaction** as the change it describes, next to the `audit_events` insert, so there is no window in which the change is committed and the epoch is not.

### 8.3 `AuthzBus`

```ts
// apps/server/src/authz/bus.ts
export type AuthzEvent =
  | { type: 'user.disabled';          userId: UserId }
  | { type: 'user.password_changed';  userId: UserId; keepSessionId?: SessionId }
  | { type: 'session.revoked';        userId: UserId; sessionId: SessionId; reason: RevokedReason }
  | { type: 'token.revoked';          userId: UserId; tokenId: TokenId }
  | { type: 'membership.removed';     userId: UserId; vaultId: VaultId; userAuthzVersion: number }
  | { type: 'membership.role_changed'; userId: UserId; vaultId: VaultId; role: Role;
                                       userAuthzVersion: number; memberVersion: number }
  | { type: 'vault.archived';         vaultId: VaultId }
  | { type: 'note.trashed';           vaultId: VaultId; noteId: NoteId }
  | { type: 'note.purged';            vaultId: VaultId; noteId: NoteId };

export interface AuthzBus {
  publish(event: AuthzEvent): void;                     // synchronous fan-out, never throws to the caller
  subscribe(handler: (e: AuthzEvent) => void): Unsubscribe;
}
```

Rules:

- **Publish after COMMIT, never inside the transaction.** `withTransaction()` returns a list of deferred effects; the service pushes `bus.publish(...)` into it and the transaction helper runs them after a successful COMMIT. Publishing inside the transaction would close a user's connections for a change that then rolled back. `authz.bus-after-commit.unit` injects a rollback and asserts no event is published.
- **Synchronous fan-out.** Subscribers run on the same tick, so by the time the HTTP handler returns `204` the epoch table is already updated (and in practice the connections are already closed). Each handler is wrapped in `try/catch` with an `error`-level log plus the `iridium_authz_bus_handler_errors_total` metric; one failing subscriber cannot block another or fail the request that triggered it.
- **In-process today, interface forever.** The single-process deployment (F9) makes fan-out exact and instantaneous. The Redis implementation (post-MVP, `RedisAuthzBus` over pub/sub) is a drop-in; the epoch check and `onTokenSync` are what keep the design correct once fan-out becomes lossy.
- **Subscribers, in registration order:** (1) `EpochReconciler` (§8.6) — updates the in-process epoch table; (2) `CollabGateway` (§8.4) — acts on connections; (3) `TicketStore` — drops outstanding tickets of a revoked session; (4) metrics/SIEM logging. The reconciler is first so that a connection sending a message during the gateway's sweep already sees the new epoch.

### 8.4 `CollabGateway`

`apps/server/src/collab/gateway.ts` is the only module allowed to touch live connections. Its public surface:

```ts
class CollabGateway {
  revokeUser(userId, opts: { vaultId?: VaultId; sessionId?: SessionId; reason: CollabCloseReason }): void;
  changeRole(userId, vaultId, role, epoch: { userAuthzVersion; memberVersion }): void;
  closeNote(noteId, reason: 'note-trashed' | 'note-closing'): void;
  closeVault(vaultId, reason: 'vault-archived'): void;
  broadcastVault(vaultId, message: VaultChannelMessage): void;
  openServerEdit(noteId, principal, permission): Promise<DirectConnection>;   // §6.9
  participants(noteId): ParticipantsMessage;
  markClosing(noteId): void;                       // enters the closing set; called by tree/trash.ts BEFORE its transaction
  isClosing(noteId): boolean;                      // read by onAuthenticate, onLoadDocument, beforeHandleMessage
  clearClosing(noteId): void;                      // released in tree/trash.ts's `finally`, on success and on failure
}
```

The sweep is a bounded iteration over `hocuspocus.documents` (a `Map`), and for each document over `document.getConnections()`:

```
revokeUser(userId, {vaultId, sessionId, reason}):
  for (const [name, doc] of hocuspocus.documents) {
    if (vaultId && docVaultId(name) !== vaultId) continue        // note:* and vault:* both carry a vault
    for (const conn of doc.getConnections()) {
      const c = conn.context as IridiumCollabContext
      if (c.userId !== userId) continue
      if (sessionId && c.sessionId !== sessionId) continue
      conn.close({ code: 4403, reason })                          // 'revoked' | 'vault-archived'
    }
  }
```

`docVaultId(name)` reads the vault id from the gateway's own document→vault index, maintained in `afterLoadDocument`/`afterUnloadDocument`, so the sweep never queries the database and never parses a note id into a vault lookup. A document with no matching connections costs one `Map` iteration step; with the loaded-document budget of 2 000 (A50) the worst-case sweep is 2 000 map steps plus the matching connections — microseconds, well inside the request that triggered it.

| Event | Gateway action |
|---|---|
| `membership.removed` | `revokeUser(userId, {vaultId, reason:'revoked'})` — every `note:*` and the `vault:*` connection of that user in that vault |
| `user.disabled` | `revokeUser(userId, {reason:'revoked'})` — all vaults |
| `session.revoked` | `revokeUser(userId, {sessionId, reason:'revoked'})` — that session's connections only; the user's other devices keep working |
| `user.password_changed` | `revokeUser(userId, {reason:'revoked'})` for every session except `keepSessionId` (the session that performed the change) |
| `membership.role_changed` (downgrade) | `changeRole()`: `connection.readOnly = true` + `connection.sendStateless({v:1, t:'role', role})`; pending viewer updates are answered `SyncStatus(false)` → client state `rejected` (A20) |
| `membership.role_changed` (upgrade) | `changeRole()`: `connection.readOnly = false` + `{t:'role', role}`; the **client** then detaches and re-attaches a fresh provider on the same `Y.Doc` (A20) because a provider that has had updates rejected keeps `unsyncedChanges > 0` and will not resend them; `forceSync()` alone is not sufficient and is not used |
| `vault.archived` | `closeVault()`: `sendStateless({t:'closing', reason:'vault-archived', graceMs:0})` then close 4403 `vault-archived` on every connection in the vault |
| `note.trashed` / `note.purged` | `closeNote()`: `{t:'closing', reason:'note-trashed', graceMs}` then close 4404 `note-trashed`, alongside the `tree-changed` broadcast. `markClosing(noteId)` is **not** part of this reaction: it ran in `tree/trash.ts` before the transaction opened and is released by the same function's `finally` whether the transaction committed or failed (05-collaboration-and-durability.md *Trash*, 09-api-reference.md §2.7), so a refused trash leaves no note unopenable. While the id is in the closing set, `onAuthenticate` and `beforeHandleMessage` answer the transient `note-closing` (4404); from COMMIT on, `nodes.deleted_at` is the authoritative refusal in `onAuthenticate`/`onLoadDocument`, so a stale client cannot resurrect the note (spec acceptance "Structural concurrency") |
| `token.revoked` | nothing on WebSockets (PATs never authenticate `/collab`); the `TicketStore` subscriber is a no-op for tokens |

`changeRole()` also writes the new epoch onto every affected connection's context, so the connection is consistent again and the epoch check of §8.6 does not re-trigger on the next message.

Role changes do **not** close the connection. Closing a downgraded editor would discard in-flight local edits with no way to export them; `readOnly = true` plus the `role` message keeps the document open, the text readable and exportable ("Export my text", A40), and the save state honestly `rejected`.

### 8.5 Sequence: removing a member while they are editing

```mermaid
sequenceDiagram
  autonumber
  participant Mgr as Manager (web)
  participant API as REST handler
  participant DB as MySQL
  participant Bus as AuthzBus
  participant Rec as EpochReconciler
  participant GW as CollabGateway
  participant WS as B's note:N connection
  participant Cli as B's client
  participant MCP as /mcp (B's PAT)

  Mgr->>API: DELETE /api/v1/vaults/V/members/B with If-Match
  API->>API: authorize Mgr vault:manage_members on V = allow
  API->>DB: BEGIN at REPEATABLE READ
  API->>DB: SELECT id FROM vaults WHERE id=V AND status='active' FOR UPDATE
  API->>DB: DELETE FROM vault_members WHERE vault_id=V AND user_id=B — assert 1 row, version CAS
  API->>DB: UPDATE users SET authz_version=authz_version+1 WHERE id=B
  API->>DB: audit_chain_heads FOR UPDATE → INSERT audit_events vault.member.removed → UPDATE head
  API->>DB: COMMIT
  API->>Bus: publish membership.removed userId=B vaultId=V userAuthzVersion=k+1
  Bus->>Rec: epoch table — user B becomes k+1, membership V/B becomes removed
  Bus->>GW: sweep documents of vault V
  GW->>WS: connection.close code=4403 reason=revoked
  Bus->>GW: TicketStore keeps the session — it is still valid for other vaults
  API-->>Mgr: 204 No Content
  WS-->>Cli: onClose code=4403 reason=revoked
  Cli->>Cli: NoteSession destroyed; "Access to this vault was removed"; tabs closed; no reconnect
  Cli--xAPI: reconnect → onAuthenticate → authorize denies not_found → close 4404
  MCP->>DB: next tools/call → verifyToken then authorize → V not in live memberships → isError
```

### 8.6 The epoch check and `EpochReconciler` (closing the commit-to-sweep race)

There is a window — microseconds, but real — between COMMIT and the gateway's `close()`. A Yjs update that arrives inside it must not be persisted. `beforeHandleMessage` closes that window without a query per message.

`apps/server/src/authz/epochs.ts` holds the in-process epoch table:

```ts
class EpochTable {
  private users = new Map<UserId, number>();                    // userId → authz_version
  private members = new Map<`${VaultId}:${UserId}`, number | 'removed'>();
  private refs = new Map<UserId, number>();                     // live connections per user
  user(userId, v: number): void;                   // seeded by onAuthenticate/onTokenSync, updated by the reconciler
  member(vaultId, userId, v: number | 'removed'): void;
  isStale(ctx: IridiumCollabContext): boolean;
  retain(userId): void;                            // onAuthenticate
  release(userId): void;                           // connection close / afterUnloadDocument; calls forget() at zero
  private forget(userId): void;                    // drops the users entry and every members entry of that user
}
```

- Entries exist **only** for users that currently have at least one live `/collab` connection, and the bookkeeping is **refcounted**: `onAuthenticate` calls `retain(userId)`, the connection-close path and `afterUnloadDocument` call `release(userId)`, and only the transition to zero runs the private `forget()`, which drops that user's `users` entry and all of their `members` entries. A refcount rather than a "last connection?" scan is what keeps a second window of the same user from having its table entry dropped underneath it — a premature `forget()` would re-create exactly the per-message database amplifier this section exists to prevent. The table is bounded by the connection cap (5 000 connections → at most 5 000 user entries), not by the user count.
- Both a seeding path and a refresh path write the table: `onAuthenticate` step 8 and `onTokenSync` seed it from rows they have already read (§6.4, §8.7), and `EpochReconciler` — the first `AuthzBus` subscriber — writes the new `userAuthzVersion`/`memberVersion` (or `'removed'`) from the event payload, which is why every membership event carries the post-commit version numbers. `reauthorizeConnection()` writes both the table and the connection context, so the fail-safe lazy path self-heals instead of repeating per message.
- `beforeHandleMessage` then runs, per message, in constant time:

```
beforeHandleMessage({documentName, connection, context, update}):
  if gateway.isClosing(context.noteId)                → throw 'note-closing'          (4404)
  if epochTable.isStale(context):
        d = await reauthorizeConnection(connection, context)      // the ONLY DB access in this hook
        if d === 'closed'                             → throw 'revoked'               (4403)
        // d === 'updated' → context epoch refreshed, readOnly possibly flipped, continue
  if update.byteLength > 1 MiB                        → throw 'too-large'             (1009)
  if messageRateLimiter.hit(connection) > 200 / 10 s  → throw 'rate-limited'
  → proceed (Hocuspocus enforces connection.readOnly for sync messages)
```

`reauthorizeConnection()` repeats steps 4–6 of `authorize()` from the database, updates `connection.readOnly`, writes the re-read `{userAuthzVersion, memberVersion}` **both** into the epoch table (`user()` + `member()`) and onto `connection.context.authzEpoch`, sends `{t:'role', role}` if the role changed, and returns `'closed'` when the user is no longer allowed to read. Writing both sides is what makes the fail-safe path converge: after one re-authorization the connection and the table agree again, so the next message performs no I/O. It costs two point lookups and runs only on a genuine epoch mismatch — in steady state the hook performs no I/O at all. `collab.live-revocation.integration` includes a fault (`auth.slow:<ms>`) that delays the gateway sweep and asserts that an update sent in the gap is rejected by the epoch path and leaves no `note_updates` row.

`isStale()` returns true when the connection's tuple differs from the table in either component, or when the membership entry is `'removed'`, or when there is **no** entry for that user. A missing entry means the table and the connection disagree — a bookkeeping bug, or a future multi-process/`RedisAuthzBus` deployment where the table was not the one that authenticated this socket — so re-validating **and re-seeding** (the `reauthorizeConnection()` write above) is the fail-safe answer, and it is self-limiting: one message pays two lookups, the rest pay nothing. In the single-process MVP (F9) a restart drops every socket, so no live connection outlives the table, and every connection re-authenticates — which re-seeds it.

### 8.7 Periodic re-validation (`onTokenSync`)

Per connection, a timer set at `afterLoadDocument` fires every 15 min ± 3 min and calls `connection.requestToken()`. Hocuspocus sends an `AuthMessageType.Token` frame; the provider re-invokes its `token` getter (a fresh ticket from `TicketSource`) and answers with `sendToken()`; the server runs `onTokenSync`, which performs the **same checks as `onAuthenticate`** (`TicketStore.consume`, `loadLiveSession(ticket.sessionId)` with the same reason split as §6.4, note still present and untrashed, `authorize('note:read')`, `readOnly` from `note:write`, and an epoch refresh that re-seeds the table entry *and* rewrites the connection context, §8.6) and throws to close the connection on any failure.

| Case | Result |
|---|---|
| Fresh ticket, still authorized | epoch re-seeded in the table and on the context, `readOnly` re-derived, connection continues |
| Fresh ticket, role changed since | `readOnly` flipped + `{t:'role'}` sent; no reconnect |
| Fresh ticket, session idle- or absolute-expired | close 4401 `unauthorized` (the client fetches fresh tickets and retries once, then shows sign-in) |
| Fresh ticket, membership gone / user disabled / session revoked | close 4403 `revoked` |
| Ticket unknown, expired or already used | close 4401 `unauthorized` |
| No answer within the 5 min grace | close 4401 `unauthorized` (09-api-reference.md §3.6 lists the elapsed grace under `unauthorized`; the client reconnects if it is actually alive) |
| Ticket request fails transiently (429, offline) | the provider retries 3× with backoff; the grace window absorbs it |

This is the backstop that makes the design safe under a lossy bus: even if every `AuthzBus` subscriber were removed, no unauthorized connection could survive longer than 15 + 3 + 5 = **23 minutes**, and it could never *write* during that time because of §8.6. With the bus in place the observed bound is milliseconds.

### 8.8 Timing guarantees

| Path | Guarantee | Verified by |
|---|---|---|
| REST (next request) | Denied on the first request issued after COMMIT. No cache, no TTL, no grace. | `authz.revocation-rest.integration` |
| MCP (next call) | Denied on the first `tools/call` after COMMIT, including a call already in flight when it re-enters `ContentReadCore` for a second vault. | `mcp.revocation.mcp` |
| MCP over `/mcp/connect` (next call) | Denied on the first call after COMMIT for a revoked token, consent or client, and the next refresh is refused. | `oauth.revocation.mcp` |
| WebSocket write from a revoked principal | Impossible after COMMIT: either the connection is already closed, or `beforeHandleMessage` sees the new epoch. | `collab.live-revocation.integration` (with the sweep artificially delayed) |
| WebSocket connection closure | Test budget **≤ 1 s** from COMMIT; measured p99 in-process is single-digit milliseconds. The budget is deliberately loose so the test is not flaky on CI. | `collab.live-revocation.integration` asserts `onClose` within 1 s |
| Refused reconnect | The next `onAuthenticate` denies; the client does not retry after `revoked` (A20 close-reason handling). | same test |
| Silent stale connection (bus failure) | ≤ 23 min (15 + 3 jitter + 5 grace); no writes possible in that window. | `collab.token-sync.integration` with the bus subscriber detached |
| Attachment / export download in flight | A stream already being written is not aborted; the next request **that reaches the server** is denied. A response already sitting in the viewer's private cache is not recalled (§8.9). | `export.revocation.integration` |

### 8.9 What revocation cannot do (stated, per spec §4)

The spec is explicit that the server "cannot retract content a user already viewed or exported". Iridium adds precision:

- **Bytes already delivered are gone.** An export ZIP already downloaded, a note already rendered, an `access_log`-recorded MCP read — all irretrievable. The audit and access logs record exactly what was read and by which credential, which is the answer to "what did they take" (§11.5).
- **An in-flight response completes.** A range of an attachment or export already streaming is not killed mid-stream; the connection is not a policy checkpoint once the handler has started writing. The window is bounded by the response duration.
- **A cached attachment response can be replayed for up to 3 600 s.** Attachment bytes are the one authenticated response not served `no-store`: A44 settles `Cache-Control: private, max-age=3600` with the `sha256` ETag, so a viewer whose membership was removed can still render an image already in their own browser cache, or in the Electron `persist:iridium` partition cache, until that entry expires — no request reaches the server, so no check runs. The server refuses every new request immediately, and no *new* attachment of that vault can be fetched. The separate user-content origin (A44, post-MVP) does not shorten this window: it addresses same-origin active content, not caching. Three things narrow it. (1) The clients evict on the revocation signal — the web workspace resets the TanStack Query cache and reloads the affected `<img>` elements on a 4403 `revoked`, and the Electron main process calls `session.fromPartition('persist:iridium').clearCache()` on a 4403 `revoked` close and on sign-out (§4.5) — which is best-effort hygiene on a machine the user controls, never a guarantee. (2) An operator who needs a hard bound overrides the header at the reverse proxy for `/api/v1/vaults/*/attachments/*` (nginx `proxy_hide_header Cache-Control` plus `add_header Cache-Control "private, max-age=60" always`; Caddy `header … Cache-Control "private, max-age=60"`), documented in `docs/ops/security.md` with its cost of one revalidation per image view. (3) The content-addressed ETag makes that revalidation cheap (`304`, no bytes) for operators who take it.
- **Local client state is not remotely wiped.** The web client clears its caches on `revoked` (TanStack Query cache reset; browser-stored **UI** state — not note content, of which none is persisted — cleared on logout via `Clear-Site-Data`, §4.3); the desktop main process erases the stored token on any REST `401` — never on a WebSocket close, which is not an authority on session validity (§4.5). Neither is a security guarantee against a user who controls their own machine.
- **A rotated PAT's overlap window is honoured.** If an operator set `rotation_overlap_until`, the old secret keeps working until that instant (A31); `tokens revoke --now` and `tokens revoke-all` end it immediately.

### 8.10 OAuth grants

An OAuth grant introduces **no new revocation mechanism**. The access token is an `access_tokens` row, so mechanism 1 (no caches on the authorization path) covers it exactly as it covers a personal access token; the consent and client rows arrive on the same statement (§5.5 query 1″), so revoking either is also a next-call property. Mechanisms 2–5 (epochs, `AuthzBus`, `CollabGateway`, `onTokenSync`) are untouched: no OAuth credential ever authenticates a WebSocket.

| Trigger | Effect on OAuth sessions | Latency |
|---|---|---|
| `DELETE /me/oauth-consents/:consentId` (self, step-up) | in one transaction: `oauth_consents.revoked_at`, every `access_tokens` row with that `consent_id` revoked (`revoke_reason='consent_revoked'`), every `oauth_refresh_tokens` row with that `consent_id` revoked; after COMMIT one `AuthzBus` `token.revoked` per access token | Next call `401`; the next refresh `400 invalid_grant` |
| `POST /me/tokens/revoke-all` (self, step-up) | now revokes **every** live credential of the caller: PATs, OAuth access tokens, refresh tokens and consents. `{count}` counts access tokens; the response gains `{consentsRevoked}` | Next call `401` |
| `PATCH /admin/oauth-clients/:clientId {status:'disabled'}` and `DELETE /admin/oauth-clients/:clientId` (admin, step-up) | every consent, refresh token and access token for that client revoked in the same transaction | Next call `401` |
| `DELETE /admin/oauth-consents/:consentId` (admin, step-up) | as the self route, `revoke_reason='admin'` | Next call |
| `POST /admin/users/:userId/revoke-tokens`, `POST /admin/tokens/revoke-all`, `iridium tokens revoke-all` | include OAuth rows and consents | Next call |
| `DELETE /admin/tokens/:tokenId` | revokes one OAuth access token; the refresh token survives, so the connector re-mints within an hour. The admin UI says so and offers "Revoke the whole authorization" beside it | Next call, then re-minted |
| User disabled or deleted | verification step 9 (`users.status`), unchanged | Next call |
| Membership removed, role downgraded, vault archived | `authorize()` steps 3–5, unchanged | Next call |
| `vaults.mcp_enabled = 0`, `server_settings.mcp_enabled.enabled = false` | unchanged; both mounts read the same flags | Next call |
| Password change | consents and tokens **untouched**, exactly as PATs are (A28). The settings dialog's existing offer becomes "also revoke my integration tokens and authorized applications" and issues `POST /me/tokens/revoke-all` | — |
| The authorizing session is revoked | outstanding **authorization codes** from that session become unusable (the code row carries `session_id`, re-checked live at exchange); already-issued access and refresh tokens are **not** revoked, because a grant is a separate credential with its own lifetime, exactly like a PAT created in that session. This is stated rather than left to inference | — |

"Next call" is exact for the same reason it is exact for a PAT: nothing is cached, and the consent and client status arrive on the two `LEFT JOIN`s of the existing token statement. `oauth.revocation.mcp` is the OAuth twin of `mcp.revocation.mcp` and drives every row above, each followed by an immediate `/mcp/connect` call that fails in the documented way **and** a refresh attempt that fails.
## 9. Token principals on the authorization path

Integration tokens are specified end to end in 06-mcp-and-agent-access.md: credential format, storage, the verification steps, scopes and the Read bundle, vault allowlists, expiry, rotation, revocation, last-used tracking, per-token rate limits, the REST surface and the UI. This section states only what the **authorization layer** guarantees about them, because those guarantees are invariants of `authorize()` rather than of the token feature.

### 9.1 Where a token principal comes from

`auth/tokens/verify.ts` — one module, one exported entry point:

```ts
verifyToken(raw: string, opts: { surface: 'mcp' | 'rest'; resource?: string })
  : Promise<{ ok: true; principal: TokenPrincipal; authInfo: AuthInfo } | { ok: false; publicReason: string }>
```

It is `verifyToken` rather than `verifyPat` because it dispatches on the credential prefix: `irid_pat_…` and `irid_oat_…` both arrive here and both leave as a `TokenPrincipal`. That dispatch is live, not reserved — the OAuth authorization server ships in M3 (G1, answered yes on 2026-09-12) — which is why a PAT-specific name would now be wrong. `apps/server/src/mcp/verifier.ts` (the SDK's `OAuthTokenVerifier`) only wraps it, so there remains exactly one verification path (D04-26, D04-30).

It is called by `authenticate()` (§6.1) whenever a bearer parses as `kind === 'pat'` or `kind === 'oat'`, and by the two MCP preHandlers of §6.5. It performs one indexed read of `access_tokens` joined to `users`, plus the allowlist read, on **every** request — the "fresh token row per call" of A23. For an OAuth token the same statement carries two further primary-key `LEFT JOIN`s (`oauth_consents`, `oauth_clients`), so the cost stays one lookup (§5.5 query 1″). `surface` is set by the authenticating route (`'mcp'` for both MCP mounts, `'rest'` for the ★ read routes) and `resource` is the route's canonical URI, `<PUBLIC_ORIGIN>/mcp/connect` on `/mcp/connect` and absent elsewhere. Nothing else in the server constructs a token principal.

06-mcp-and-agent-access.md holds the full ordered verification table; three of its steps exist because a credential can now be OAuth, and all three answer `401 invalid_token` with the same body shape and never a distinguishable status:

| Step | Check | Failure |
|---|---|---|
| 5 (amended) | `row.kind === (parsed.kind === 'pat' ? 'pat' : 'oauth')` **and** the presented kind is the one this route accepts (`/mcp` → `pat`, `/mcp/connect` → `oat`, ★ REST read routes → `pat`) | `401 invalid_token`; metric `iridium_token_auth_failures_total{reason="wrong_kind_for_route"}`; `error_description` names the other endpoint |
| 5a (OAuth only) | `row.resource === opts.resource` — the route's canonical URI. This is RFC 8707's MUST on audience validation | `401 invalid_token`; `reason="audience_mismatch"`; audit `token.denied {reason:'audience_mismatch'}` |
| 5b (OAuth only) | `consent_revoked_at IS NULL` **and** `client_status = 'active'` | `401 invalid_token`; `reason="consent_revoked"` / `"client_disabled"`; audit `token.denied` |

The principal it then builds is the **same** `TokenPrincipal` for both kinds, with `tokenKind`, `clientId`, `consentId` and `resource` filled in (§5.1). `AuthInfo.clientId` is `` `pat:${id16}` `` for a PAT and `` `oauth:${oauth_clients.client_id}` `` for an OAuth token; `AuthInfo.resource` is `new URL(PUBLIC_ORIGIN + '/mcp')` for a PAT and `new URL(PUBLIC_ORIGIN + '/mcp/connect')` for an OAuth token.

### 9.2 The five invariants `authorize()` enforces

| Invariant | Mechanism (step 5 of §5.4) | Test |
|---|---|---|
| **A token can never exceed its owner's live rights.** Effective permissions are `scopes ∩ permissionsOf(live explicit role)`, recomputed per call. | The membership row is read fresh; there is no stored copy of the owner's role on the token. | `token.effective-permissions.prop` — for random `(role, scopes, allowlist)` triples, `effective(token) ⊆ effective(owner)`; removing the membership empties the set |
| **A token never inherits server-admin power.** `isServerAdmin` is the literal `false` on the principal, and step 5 requires an **explicit** `vault_members` row even for an administrator's token. | `authorize()` reaches step 5 only after step 4 computed `effectiveRole`; step 5 then re-checks `explicitRole`, ignoring the admin-implied elevation. | `tokens.admin-owned.integration`, `authz.no-mcp-admin-implied.guard` |
| **A token never exceeds its own surface.** MVP tokens hold only read permissions; a mutating REST route rejects any token principal at the route-policy stage (`403 token_scope_insufficient`), and no MCP tool exists that writes. | `principalKinds` on the route (§6.2) plus the boot assertion that `'token'` appears only on `GET`/`HEAD` routes with `READ_BUNDLE` permissions. | `authz.route-policy.boot`, `mcp.scopes` |
| **A token cannot outlive its owner's account or its own expiry.** `expires_at` is mandatory; owner `status !== 'active'` fails verification. | Verification steps 6–9 (06-mcp-and-agent-access.md) run before any authorization. | `mcp.revocation` (token revoke, membership removal, user disable, vault toggle) |
| **A token can only be used at the resource it was issued for.** `access_tokens.resource` is compared with the route's canonical URI; a token issued for `/mcp/connect` is refused at `/mcp` and vice versa — RFC 8707 §2's MUST on audience validation, and the property that makes the two-mount split safe rather than merely convenient. | Verification step 5a (§9.1) runs before any authorization; a PAT carries `resource = NULL` and is accepted only where `mcpAudience` is `'pat'`. | `oauth.audience.contract` |

### 9.3 Surface differences that belong to authorization

| Aspect | `/mcp` and `/mcp/connect` (`surface:'mcp'`) | ★ REST read routes (`surface:'rest'`) |
|---|---|---|
| Kill switches | both are part of the decision, from two different sources: `server_settings.mcp_enabled` (a boolean row) through the in-memory `SettingsStore.effective().mcp_enabled`, and `vaults.mcp_enabled` from the per-request vault row (§5.4 step 5) → a disabled vault is `not_found` for the token | not applied (D.1): a token used against the REST read API is governed by scopes and membership only |
| Denial shape | shared `isError` text for not-found and forbidden; HTTP `403` only for the transport-level `insufficient_scope` case on `/mcp/connect` (§6.5), never for an in-tool denial (A33) | `ProblemDetails`: `404 not_found` for out-of-scope vaults, `403 forbidden` for a missing scope, `403 token_scope_insufficient` for a mutating route |
| Cookies | never resolved: `bearerOnly` suppresses the cookie branch of §6.1; `ignoreCookies` additionally strips the header and the parsed jar for every later phase | ignored whenever `Authorization` is present (§6.1) |
| `Origin` header | present at all → `403 origin_not_allowed` (no allowlist, no value heuristic, §6.5) | normal same-origin rules; bearer requests skip the CSRF guard |
| Logging | `access_log` row per call with `note_ids`, `bytes_out`, `client_name` | `access_log` row per token-authenticated read (`surface='rest'`) |

The middle column covers **both** MCP mounts, because authorization does not distinguish them. Exactly three things do, and none of them is an authorization property: the credential kind the mount accepts (`mcpAudience`, §6.2), what its `401` challenge carries (§6.1), and whether a transport-level `403 insufficient_scope` is reachable there (`/mcp/connect` only). Everything in this table's middle column — the two kill switches, the shared `isError` text, the cookie suppression, the `Origin` refusal and the per-call `access_log` row — is identical on `/mcp` and `/mcp/connect`, which is what `oauth.principal-parity.prop` and the extended `mcp.*` suites hold in place.

Both surfaces share one authorization function, one membership lookup and one `access_log` writer, which is why "search and export use the same access rules as the application" (spec §7) is structurally true rather than a policy that has to be kept in sync.

### 9.4 Step-up and tokens

Token principals can never satisfy step-up: `lastAuthenticatedAt` does not exist for them. Step 6 of §5.4 is therefore unreachable for a token, because every `stepUp: true` route is user-only by the boot assertion (`principalKinds` defaults to `['user']` and a `stepUp` route may not list `'token'`). A token presented to such a route is rejected at step 2 of the route policy with `403 token_scope_insufficient` — not `403 step_up_required`, which would suggest a retry that can never succeed.
## 10. Rate limiting, lockout and load shedding

The single limits policy of the plan (skeleton A.1, constants in `@iridium/contracts/limits.ts`) is reproduced in 02-system-architecture.md. What follows is the authentication-and-authorization slice of it: the buckets that exist to protect credentials, the keys they use, and the exact responses.

### 10.1 The buckets

| Bucket | Store | Key | Budget | Response on exhaustion |
|---|---|---|---|---|
| Global unauthenticated | `@fastify/rate-limit` 11.2.0, in-memory, `onRequest` | IP (from `X-Forwarded-For` only when the peer is inside `TRUST_PROXY`) | 60 / min (`REST_UNAUTHENTICATED_PER_MINUTE`) | `429 rate_limited` + `retry-after`, `x-ratelimit-*` |
| Global authenticated | same | `u:<userId>` \| `tok:<tokenId>` | 600 / min (`REST_AUTHENTICATED_PER_MINUTE`) | same |
| Login | same, route-level | IP | 10 / min (`LOGIN_PER_MINUTE_PER_IP`) | same; evaluated **before** any database access |
| Login failures per account+source | `rate-limiter-flexible` 11.2.0 `RateLimiterMySQL` on `login_throttle` (+ `RateLimiterMemory` insurance), in `auth/credentials/throttle.ts` | `login:<email_key>\|<ip>` | 5 points / 24 h (`LOGIN_FAILURES_PER_ACCOUNT_SOURCE`) | block `LOGIN_BLOCK_BASE_SECONDS · 2^(n−1)` = `900 · 2^(n−1)` s, capped at `LOGIN_BLOCK_MAX_SECONDS` = 86 400 s; `429 rate_limited` + `Retry-After` |
| Login failures per source per day | same store, `keyPrefix:'loginip'` | `<ip>` | 100 / 86 400 s (`LOGIN_FAILURES_PER_IP_PER_DAY`) | `429 rate_limited` until the window ends |
| Blocks counter | same store, `keyPrefix:'loginblocks'` | `login:<email_key>\|<ip>` | counts prior blocks (24 h) | drives the doubling above |
| Set-password link redemption | `@fastify/rate-limit`, route-level | IP | 10 / min | `429`; a wrong link token also consumes login limiter A keyed `spl:<token_id>\|<ip>` (5 / 24 h) so link guessing is bounded |
| Re-authentication (`POST /auth/reauthenticate`) | login limiter A | `login:<email_key>\|<ip>` | shares the login budget | `429`; a stolen session must not become an offline password oracle |
| Password change (`POST /me/password`) | login limiter A on a wrong current password | same | shares the login budget | `429` |
| Consent step-up (`POST /oauth/consent`) | login limiter A on a wrong password in the consent page's step-up field | same | shares the login budget | `429`; the consent page re-renders with the throttle message, and the `request_id` is **not** consumed by a wrong password |
| Collab tickets | `@fastify/rate-limit`, route-level, two keys | `ses:<sessionId>` and IP | 300 / min per session, 1 000 / min per IP | `429`; the provider's `token` getter retries 3× with backoff (§7.2) |
| WebSocket socket caps | `connectionCaps` `preValidation` | IP, process | 50 / 5 000 concurrent sockets | HTTP `429 rate_limited` + `retry-after` before the handshake |
| WebSocket document connections per user | `IridiumLimits.onAuthenticate` (after ticket binding) | user | 20 concurrent `note:*` + `vault:*` connections | close that document with `rate-limited`; the socket and its other documents stay up |
| Yjs messages | `beforeHandleMessage` | connection | 200 / 10 s | close `rate-limited` |
| Awareness messages | `beforeHandleAwareness` | connection | 10 / s | excess dropped, connection kept |
| `/oauth/token` | `@fastify/rate-limit`, route-level | IP | 60 / min (`OAUTH_TOKEN_ENDPOINT_PER_IP_PER_MINUTE`) | `429 rate_limited` + `Retry-After`; the body is the RFC 6749 error object, not `ProblemDetails` (06-mcp-and-agent-access.md) |
| `/oauth/authorize` | `@fastify/rate-limit`, route-level | `ses:<sessionId>` | 30 / h (`OAUTH_AUTHORIZE_PER_SESSION_PER_HOUR`) | `429`; a client looping through authorization requests cannot make the consent screen a denial-of-service primitive |
| `/oauth/register` | `@fastify/rate-limit`, route-level | IP | 10 / h (`OAUTH_DCR_PER_IP_PER_HOUR`) | `429`; open dynamic client registration is additionally bounded by the unused-client ceiling and the 7-day sweep (06-mcp-and-agent-access.md) |
| `/mcp/connect` | the same `mcp/rate-limit.ts` buckets as `/mcp` | `mcpip:<ip>` for failed verifications, `tok:<tokenId>` for the two token budgets | shared with `/mcp`, not doubled | as the `/mcp` rows below |
| `/mcp` failed verification | `mcp/rate-limit.ts`, *checked* by `mcpIpGate` (`onRequest`, after the transport guards and **before** `patAuth`), *consumed* by `patAuth` on each failed verification | `mcpip:<ip>` | 60 / min (the unauthenticated default) | HTTP `429` + `retry-after` from `mcpIpGate`, before any database read; no `access_log` row (no token to attribute it to), metric `iridium_mcp_rate_limited_total{layer="ip"}` |
| Per-token (PAT or OAuth) | `mcp/rate-limit.ts`, charged by `chargeRateLimit` (`preHandler`, after `patAuth` / `oauthAuth` — the first phase that knows the token id) | `tok:<tokenId>` | 120 / min burst + the token's `rate_limit_per_hour` (default `pat_policy.defaultRateLimitPerHour` 3 000 for a PAT, `oauth_policy.defaultRateLimitPerHour` for an OAuth token); `search_notes` costs 3 points | burst, and the hourly budget on any method other than `tools/call`, answer HTTP `429` + `retry-after` + `x-ratelimit-*`; an hourly-exhausted `tools/call` answers `200` with an MCP `isError` result carrying the retry hint (A33/A34, 06-mcp-and-agent-access.md); metric `iridium_mcp_rate_limited_total{layer}` |
| MCP process ceiling | same module, same `chargeRateLimit` | process | 600 / min, shared by both mounts | HTTP `429` + `retry-after` |
| `flush` / `?fresh=true` | `onStateless` / route limit | connection, or principal + note | 6 / min | stateless no-op / `429` |

`@fastify/rate-limit` is registered once with a `keyGenerator` that prefers the principal over the IP, so a shared-NAT office is not one bucket, and `trustProxy` is set to the proxy CIDR — never `true` — so a client cannot spoof its own key with a forged `X-Forwarded-For` (A48, digest §6.2).

The two MCP mounts share one process ceiling of 600 requests per minute, and share the `mcpip:<ip>` failure budget and the `tok:<id>` token buckets, because a bucket protects the process or a credential — not a URL. A connector and a scripted client belonging to the same user therefore draw on the same per-token budgets only when they present the same token, which they never do: the two mounts accept different credential kinds, so each authorization gets its own `tok:` key.

The two MCP routes are the ones that opt out of that plugin: each declares `config.rateLimit = mcpBucket`, which is `{enabled: false}`. The plugin evaluates in an `onRequest` hook, where `patAuth` (a `preHandler`) has not run, so a `tok:<id>` `keyGenerator` there would silently degrade to an IP key and the documented per-token budgets would not exist. All four MCP layers therefore live in `apps/server/src/mcp/rate-limit.ts` behind the `RateLimitStore` interface, registered once and mounted on both routes — the per-IP *failure* budget checked by `mcpIpGate` in `onRequest` and consumed by `patAuth` or `oauthAuth` on its `401` path, the two token-keyed budgets and the process ceiling charged by `chargeRateLimit` in the `preHandler` — which is the arrangement 06-mcp-and-agent-access.md specifies (D06-20) and the one the route-policy boot assertion reads off the route.

### 10.2 Lockout semantics

| Property | Decision |
|---|---|
| What is locked | the pair `(email_key, source IP)`, never the account alone |
| Why | an attacker who knows an address must not be able to lock the legitimate user out from the user's own network; account-only lockout is a denial-of-service primitive (NIST SP 800-63B-4 prefers throttling over lockout) |
| Escalation | 5 consecutive failures → 15 min, then 30 min, 1 h, 2 h, 4 h, 8 h, 16 h, capped at 24 h; the counter of prior blocks lives 24 h |
| Reset | any successful login deletes limiter A and the block counter for that key; limiter B (per IP per day) is never cleared by a success |
| Admin unlock | `POST /admin/users/:id/reset-password` clears limiter A keys for that `email_key` across all IPs (§3.3). There is no separate unlock route in MVP: the operator action that unblocks a genuinely locked-out user is the same action that gives them a working credential |
| Enumeration | the response is `429 rate_limited` with `Retry-After` regardless of whether the account exists; blocks reflect only the caller's own failures, so a probe learns nothing about other users |
| Observability | `iridium_login_failures_total`, SIEM event `auth.login.failed {emailKeyHash, ip, blocked}`, audit `user.login.failed` (bounded, §11.4); the alert rule fires on a sustained failure rate rather than on single events |

`RateLimiterMySQL` is constructed with `tableCreated: true` so it never issues DDL under the `iridium_app` role (A8), and the table is created by migration `0005_login_throttle`. The `RateLimiterMemory` insurance limiter keeps login throttling working if MySQL is briefly unavailable — fail-closed in the sense that matters: when the store is down, the in-memory limiter still blocks, and a login that cannot verify a credential fails anyway.

### 10.3 Cost control before authentication

Order of work on an unauthenticated request, cheapest first, so that a flood is rejected before it costs anything expensive:

```
1. TLS + proxy               (outside the process)
2. @fastify/rate-limit       in-memory counter                        → 429
3. body limit                1 MiB JSON (Fastify bodyLimit)           → 413 payload_too_large
4. zod validation            shape only                               → 400 validation_failed
5. CSRF guard                header + Fetch Metadata comparisons      → 403 csrf_rejected
6. parseToken / regex + CRC  pure function, no I/O                    → 401 invalid_credentials
7. login limiter get()       one indexed MySQL read                   → 429
8. credential lookup         one indexed MySQL read
9. argon2id verify           150–300 ms, semaphore of ARGON2_CONCURRENCY (4)
```

Steps 1–6 are I/O-free apart from the socket, and step 9 — the only expensive one — is reachable only after the two throttles agreed. `@fastify/under-pressure` 9.1.0 adds event-loop-delay-based load shedding in front of everything (503 with `Retry-After` when the loop lag exceeds the threshold), which protects the collaboration path from a login flood and vice versa.

### 10.4 Shapes

Every throttled response is a `ProblemDetails` body with `code: 'rate_limited'`, plus `Retry-After` (seconds, integer) and `x-ratelimit-limit` / `x-ratelimit-remaining` / `x-ratelimit-reset`. WebSocket throttling produces an HTTP body only at the upgrade, where the socket caps answer `429 rate_limited` with `retry-after` before the handshake; the per-user document cap and the in-session message limits both close with the `rate-limited` reason. The two are surfaced differently by the client, because only one of them can be fixed by waiting: the in-session message cap is a socket-level close that the provider retries with backoff ("Connection rate-limited — retrying"), while a `rate-limited` refusal of a *single* document makes that note session dormant with "Too many notes open on this account — pause a note in another window" and is never retried automatically (reusing 07-client-applications.md D07-15's dormancy machinery). On `/mcp` the split is by *method*, not by layer: the burst bucket, the process ceiling, the per-IP failure budget and an hourly exhaustion on any method other than `tools/call` all answer HTTP `429`; only an hourly-exhausted `tools/call` answers `200` with an `isError` result carrying the retry hint, because several clients read an HTTP error on a tool call as a transport failure and drop the session, whereas an `isError` keeps the agent's session alive (A33/A34, 06-mcp-and-agent-access.md D06-20).
## 11. Audit and access logging from the auth surfaces

The audit log itself — the HMAC chain, `audit_chain_heads`, the lock order, the triggers and grants, retention, export and `verify-chain` — is specified in 11-operations-and-deployment.md (A46). This section fixes **which events the authentication and authorization flows emit, with which fields**, because an event that is not emitted here can never be reconstructed later.

### 11.1 Rules that apply to every auth event

| Rule | Consequence |
|---|---|
| Written by `AuditWriter.record(trx, event)` **inside** the transaction that made the change | the audit row and the change commit or roll back together; there is no "we did it but did not log it" state |
| `chain_id` | `vault:<32-hex>` for vault-scoped events (membership, vault settings, archive) — the vault UUID **without** hyphens, 32 lowercase hex characters, produced only by `chainIdForVault()`, never the hyphenated UUID (which would be 42 characters and would not fit `VARCHAR(40)`; see 03-data-model.md D03-05 and invariant I-19 `^(server\|vault:[0-9a-f]{32})$`); `server` for identity, session, token and admin events |
| Actor | from the authenticated principal only. `actor_type='user'` + `actor_id` for sessions, `'token'` + the token's owner in `on_behalf_of_user_id`, `'system'` for jobs and CLI. Never a CRDT client id, never an awareness name (spec §8) |
| `credential_type` | `session` \| `pat` \| `oauth` \| `ticket` \| `setpw` \| `cli` \| `system` \| `none` (the last only for pre-authentication failures). `oauth` is the value for anything an OAuth access token did, and for the grant events of §11.3 |
| `credential_id` | `sessions.id`, `access_tokens.id` (either kind) or `password_setup_tokens.id` — so "which credential did this" is answerable without guessing |
| `context` | `{ip, user_agent, request_id, client, mcp_client}`; `ip` is `VARBINARY(16)`, `user_agent` truncated to 255 bytes |
| `metadata` | before/after of non-content fields only (role, status, flags, names). Never a password, never a token secret, never note text. `logging-redaction.test` greps captured audit JSON for fixture markers |
| Vocabulary | closed, from `@iridium/contracts/audit.ts` (C.9). Adding an event is a code change plus a test |
| Failures | audited when they are security-relevant *and* attributable; unauthenticated noise is logged (pino SIEM events) but does not enter the chain, so the chain cannot be flooded by an anonymous caller |

### 11.2 Events emitted by identity and session flows

| Event | Emitted when | Chain | `credential_type` | Key `metadata` |
|---|---|---|---|---|
| `user.login.succeeded` | successful `POST /auth/sessions` | `server` | `session` (the new session) | `{kind:'web'\|'desktop', method:'password', deviceName?, clientVersion?}` |
| `user.login.failed` | failed login, bounded per §11.4 | `server` | `none` | `{reason:'invalid_credentials'\|'user_disabled'\|'no_credential'\|'blocked', emailKeyHash, attemptsInWindow, blockedUntil?}` — the email is recorded as a salted hash plus the full address in `actor_display` **only** when the account exists, so a typo-storm does not create rows naming non-existent people |
| `user.logout` | `DELETE /auth/sessions/current` | `server` | `session` | `{sessionId}` |
| `user.reauth.succeeded` | `POST /auth/reauthenticate` | `server` | `session` | `{}` |
| `user.password.set` | `POST /auth/set-password` consumed a link | `server` | `setpw` | `{purpose:'initial'\|'reset'}` |
| `user.password.changed` | `POST /me/password` | `server` | `session` | `{revokedSessionCount}` |
| `session.revoked` | one session revoked (self, admin, password change, expiry finalisation) | `server` | `session` \| `cli` \| `system` | `{sessionId, targetUserId, reason}` |
| `session.revoked_all` | `POST /admin/sessions/revoke-all`, `POST /admin/users/:id/revoke-sessions`, `iridium sessions revoke-all` | `server` | `session` \| `cli` | `{targetUserId?, count}` |
| `admin.user.created` | `POST /admin/users`, `iridium admin create-user` | `server` | `session` \| `cli` | `{isServerAdmin, setupTokenId}` — the link id, never the secret |
| `admin.user.updated` | `PATCH /admin/users/:id` | `server` | `session` | before/after of `{email, displayName, isServerAdmin}` |
| `admin.user.disabled` / `.enabled` | disable/enable | `server` | `session` \| `cli` | `{revokedSessionCount}` |
| `admin.user.deleted` | soft delete | `server` | `session` | `{anonymised:boolean}` |
| `admin.user.password_reset` | `POST /admin/users/:id/reset-password` | `server` | `session` \| `cli` | `{setupTokenId, revokedSessionCount, credentialDeleted:true}` |

### 11.3 Events emitted by authorization and membership flows

| Event | Emitted when | Chain | Notes |
|---|---|---|---|
| `vault.member.added` | `PUT /vaults/:id/members/:userId` (new) | `vault:<id>` | `metadata:{role, targetUserId}`; also bumps the target's `authz_version` |
| `vault.member.role_changed` | `PUT …` (existing) | `vault:<id>` | `metadata:{from, to, targetUserId}` |
| `vault.member.removed` | `DELETE /vaults/:id/members/:userId` | `vault:<id>` | `metadata:{previousRole, targetUserId}` |
| `vault.archived` / `vault.restored` | archive / unarchive | `vault:<id>` | `metadata:{closedConnections}` — the number of collaboration connections the gateway closed, which is the evidence that live sessions were affected |
| `token.created` / `token.rotated` / `token.revoked` / `token.revoked_all` / `token.denied` | token lifecycle and rejected presentations | `server` | fields in 06-mcp-and-agent-access.md; `token.denied` bounded per §11.4 |
| `collab.connection.rejected` | `onAuthenticate` threw | `vault:<id>` when the vault is known, else `server` | `metadata:{documentName, reason}`; bounded per §11.4 |
| `collab.write.rejected` | a read-only connection's update was refused, an awareness spoof was detected, or an epoch re-check closed a connection | `vault:<id>` | `metadata:{noteId, reason:'read_only'\|'awareness_spoof'\|'revoked'\|'too_large'}` |
| `mcp.access.denied` | an MCP tool call was denied by `authorize()` | `vault:<id>` when a vault was named, else `server` | `metadata:{reason, vault_id?, tool?}` (06-mcp-and-agent-access.md); bounded per §11.4; the paired `access_log` row always exists and carries the tool in `action` |
| `system.key.rotated` | `iridium keys rotate pepper\|audit\|cursor\|attachment` | `server` | `credential_type='cli'`, `metadata:{key, from, to}` |
| `oauth.client.registered` | a client is created by CIMD first use, by `POST /oauth/register` or by `POST /admin/oauth-clients` | `server` | `metadata:{kind:'cimd'\|'dynamic'\|'manual', clientId, clientName, redirectUris}`; a dynamic registration is marked unverified everywhere it is shown |
| `oauth.client.disabled` / `.deleted` | `PATCH /admin/oauth-clients/:clientId {status:'disabled'}`, `DELETE /admin/oauth-clients/:clientId` | `server` | `metadata:{clientId, consentsRevoked, tokensRevoked}` |
| `oauth.client.expired` | the sweep deleted a dynamically registered client that never completed an authorization | `server` | `credential_type='system'`, `metadata:{clientId, registeredAt}` |
| `oauth.consent.granted` / `.updated` / `.revoked` | the consent screen was submitted with Allow, an existing grant was widened, or a consent was revoked by its owner, an administrator or the CLI | `server` — a consent spans vaults, so it is not a vault-chain event | `metadata:{clientId, scopes, vaultIds \| allVaults, reason?}`; this is the chained record of the human decision |
| `oauth.refresh.reuse_detected` | an already-rotated or revoked refresh token was presented | `server` | `metadata:{clientId, familyId, tokensRevoked}`; **never** bounded (§11.4) |
| `oauth.code.replayed` | an already-consumed authorization code was presented at the token endpoint | `server` | `metadata:{clientId, codeId, tokensRevoked}`; **never** bounded |
| `oauth.authorize.denied` | an authorization request was refused before or after the redirect decision | `server` | `metadata:{clientId?, reason}`; bounded per §11.4 |

Access-token issuance and refresh are deliberately **not** chained events: a connector mints a token every hour, and one `audit_events` row per hour per connector would trade the chain's readability for nothing. They are `access_log` rows (`action='oauth.token.issue'`, `'oauth.token.refresh'`) plus `iridium_oauth_tokens_issued_total{grant}`; the chained event is `oauth.consent.granted`, which is where the human decision happened.

Vault managers can read the `vault:<id>` chain for their own vault (`GET /vaults/:vaultId/audit`, §5.3 notes), which is how "who removed my colleague from this vault" is answerable without a server administrator.

### 11.4 Bounding failure events (deliberate, and required)

Every audit insert takes `SELECT … FROM audit_chain_heads WHERE chain_id=? FOR UPDATE` (A46). An unauthenticated attacker who could force one insert per request would serialise every writer on the `server` chain — a denial-of-service through the audit log. Failure events are therefore **deduplicated in a small in-process window**, and the counters that are never dropped carry the volume:

| Event | Bounding rule | What is never lost |
|---|---|---|
| `user.login.failed` | at most one row per `(email_key, ip)` per 60 s; **always** written when a block is applied or lifted, and always for the first failure of a key | `iridium_login_failures_total`, one pino `auth.login.failed` line per attempt, `login_throttle` counters |
| `token.denied` | at most one row per `token_id` per 10 min (a revoked token left in an agent's config retries forever) | `iridium_token_auth_failures_total{reason}`, one `access_log` row per call with `status='denied'` |
| `collab.connection.rejected` | at most one row per `(userId ?? ip, reason)` per 60 s | `iridium_ws_connections`, pino `collab.connection.rejected` per attempt |
| `mcp.access.denied` | at most one row per `(token_id, vault_id, reason)` per 10 min — `vault_id` is NULL for denials raised before a vault is named (`mcpKillSwitch`, scope); `tool` is recorded in the written row's `metadata` but is deliberately **not** part of the key, because a looping agent retries the same tool. `vault_id` must be in the key because §11.3 puts this event on the `vault:<32-hex>` chain when a vault was named and on `server` otherwise, so a key without it would suppress rows belonging to a different HMAC chain | `access_log` row per call (`action` names the tool, `status='denied'`), `iridium_mcp_calls_total{tool,status}` |
| `oauth.authorize.denied` | at most one row per `(client_id, reason)` per 10 min — a connector configured against the wrong endpoint, or one whose redirect URI no longer matches, retries on a timer exactly as a revoked PAT does | `iridium_oauth_authorize_denied_total{reason}`, one pino `authz.denied {reason:'oauth_authorize'}` line per attempt |
| `oauth.refresh.reuse_detected`, `oauth.code.replayed` | **never** bounded — they are low-rate security events, each one already revokes a token family or a code's descendants, and the volume *is* the signal | nothing is dropped; a detected refresh reuse additionally increments `iridium_oauth_refresh_reuse_total` |
| Malformed credentials, CSRF rejections, Origin rejections, rate-limit rejections | **never** audited | pino SIEM events `authz.denied {reason}` with request id and IP, plus metrics |

The suppression window is per process and is reset on restart (a restart is itself an `audit`-visible event through `system.migration.applied`/startup logging). `audit.bounded-failures.integration` drives 500 failed logins for one key and asserts: between 1 and 10 `user.login.failed` rows exist, the block event is present, the pino output has 500 lines, and the chain still verifies. The same suite carries the MCP case: one token makes 200 denied `/mcp` tool calls spread over two vaults, two reasons and three tools inside a 10-minute `ManualClock` window, and the test asserts exactly 4 `audit_events` rows with `action='mcp.access.denied'` (one per distinct `(token_id, vault_id, reason)`), 200 `access_log` rows with `status='denied'`, `iridium_mcp_calls_total{status="denied"}` at 200, and a still-verifying chain; a 201st call after the clock passes 10 minutes adds exactly one row.

Successful and privileged actions are **never** bounded — they are low-rate by nature and are exactly what an auditor needs.

### 11.5 `access_log`: what agents and token clients read

Every token-authenticated read writes one `access_log` row (C.9, partitioned monthly, 90-day retention), regardless of outcome:

| Column | Auth-relevant content |
|---|---|
| `surface` | `mcp` \| `rest` \| `export` |
| `action` | `mcp.get_note`, `mcp.search_notes`, `mcp.resources.read`, `rest.notes.markdown`, `oauth.token.issue`, `oauth.token.refresh`, … |
| `token_id`, `user_id` | the credential and its owner |
| `oauth_client_id` | the **verified** client identity for a call made with an OAuth access token, NULL for a PAT — the first identity in this plan the server established rather than accepted. `client_name` and `client_version` below stay the untrusted self-report, and the admin activity view labels the two differently ("Claude · verified connector" versus "self-reported") |
| `note_ids JSON` | **every** note id returned by a list, search or read — the answer to "what did this agent see" |
| `status` | `ok` \| `denied` \| `not_found` \| `error` \| `rate_limited` |
| `client_name`, `client_version` | MCP `clientInfo` or `User-Agent` — untrusted, informational, and labelled as such in the admin UI |
| `bytes_out`, `latency_ms`, `revision`, `request_id`, `ip` | volume and correlation |

`access_log` rows are written by a batched writer (`audit/access-log.ts`) off the request path — they are telemetry, not tamper-evident history, and they are explicitly **not** part of the audit chain, so their volume cannot slow a mutation down. The admin "agent activity" view and `GET /admin/tokens/:id/activity` read them (06-mcp-and-agent-access.md).

### 11.6 Operational (non-audit) security events

pino SIEM events emitted by this section's code, consumed by log-based alerting (A49): `auth.login.succeeded`, `auth.login.failed`, `auth.login.blocked`, `auth.setpw.consumed`, `auth.reauth.failed`, `auth.session.expired`, `authz.denied {reason:'csrf'|'origin'|'forbidden'|'not_found'|'step_up'|'token_scope'|'ticket_session_mismatch'|'oauth_authorize'}`, `authz.revocation.swept {event, connectionsClosed, durationMs}`, `collab.connection.rejected`, `collab.write.rejected`, `token.auth.failed {reason}` — whose `reason` vocabulary gains `wrong_kind_for_route`, `audience_mismatch`, `consent_revoked` and `client_disabled` (§9.1). All of them carry `request_id` and principal ids only; `redact` strips `authorization`, `cookie`, `set-cookie`, `*.password`, `*.token`, `*.secret` (A49), and the metric `iridium_authz_bus_handler_errors_total` exists so a silently failing revocation subscriber is visible.
## 12. Threat model (T1–T20)

Adopted per A57 as a plan section. **This section is where the `T<n>` namespace lives** (14-risks-and-open-questions.md D14-01 registers `T<n>` against 04-auth-and-access-control.md §12): every `T1`–`T20` citation anywhere in the plan resolves against the table below, and `docs/threat-model.md` is the shipped form of *this* table, not a second source. The control-to-evidence map that pairs with it is a different table — the compliance checklist of 11-operations-and-deployment.md, shipped as `docs/compliance-checklist.md` — and it cross-links to these rows rather than restating them. 14-risks-and-open-questions.md's `R-T<n>` rows are a third, unrelated namespace (risks, not threats). Each row names the threat, the mechanisms that mitigate it (with the section or file that specifies them), and the named automated tests that hold the mitigation in place. Rows T1, T2, T11–T15 and T17 are mitigated mostly outside this section, and T18–T20 are mitigated mostly in 06-mcp-and-agent-access.md, which specifies the authorization server; they are listed in full because the table is the artefact security reviewers read, and because "not my section" is not an acceptable gap in a threat model.

| # | Threat | Mitigations | Verified by |
|---|---|---|---|
| **T1** | Hostile Markdown executes script or exfiltrates data (XSS, DOM clobbering, `javascript:`/`data:` URLs, SVG/MathML, CSS injection) | `remark-rehype` with `allowDangerousHtml:false`; `rehype-sanitize` **last** with `iridiumSchema` (`clobberPrefix:''`, restricted `href`/`src` schemes, no `style`); hast → React with no `dangerouslySetInnerHTML`; DOMPurify only at HTML-string sinks; strict CSP with per-response nonces; attachments served `nosniff` + `Content-Security-Policy: sandbox`, SVG never inlined; Electron sandbox + `contextIsolation` (08-markdown-pipeline-import-export.md, 07-client-applications.md) | `markdown.xss-corpus`, `security.hostile-markdown` (web + electron E2E), `attachments.security.integration` |
| **T2** | Pathological Markdown stalls the server (quadratic emphasis, autolink blowup, deep nesting) | pre-scan caps (2 MiB source, blockquote depth 32, list indent 64 cols, 20 000 lines/paragraph); piscina worker isolation with a 10 s timeout and worker kill/respawn; browser preview in a dedicated Web Worker with a 2 s timeout; linear autolink transform only (A42, A.1) | `markdown.pathological`, `projection.hostile.integration` |
| **T3** | Hostile client writes as a viewer (forged Yjs update, `SyncStep2` carrying new content, direct REST mutation, MCP write attempt) | `connection.readOnly` set from `authorize('note:write')` in `onAuthenticate` (§6.4) — enforced by Hocuspocus at the protocol level, `SyncStatus(false)` back to the client; route policy with `principalKinds` and the boot assertion (§6.2); no REST endpoint replaces a note body (spec §5); MVP tokens carry read scopes only and reserved write scopes are inert (§9.2) | `collab.viewer-enforcement`, `authz.rest-viewer` (every mutating route), `mcp.scopes`, `token.reserved-scopes-inert.unit` |
| **T4** | ID guessing across vaults (notes, nodes, attachments, history, search, exports, MCP resources) | `authorize()` decides existence before permission and returns `not_found` for non-members (§5.4, F13); every handler query carries `vault_id`; `accessibleVaultIds()` puts the ACL inside the SQL (§5.7); MCP not-found and forbidden share one `isError` text (§6.5); cursors are HMAC-signed and bound to the token (A35) | `authz.vault-isolation.integration` (every id-taking route), `search.acl`, `mcp.isolation.mcp`, `mcp.cursor`, Schemathesis `--stateful=links` |
| **T5** | Stale client resurrects a trashed note or overwrites newer state | the `markClosing()` closing set consulted by `onAuthenticate`, `onLoadDocument` and `beforeHandleMessage` (§8.4, transient `note-closing`); `closeNote()` on trash/purge; per-note `head_seq` CAS in the writer; projection `revision` guards; boot-time sweep closing any loaded trashed document (A46) | `tree.stale-resurrection`, `tree.structural-concurrency`, `persistence.model.prop` |
| **T6** | Awareness spoofing (fake participant names, cursors attributed to someone else) | `beforeHandleAwareness` decodes every awareness update and closes the connection when `state.user.id !== context.userId`; awareness carries only `{user:{id}, cursor, mode}`; names/colours come from the server-authoritative `participants` message; revision and audit authorship from `connection.context` only (§6.4, A25, F6) | `collab.awareness-identity`, `collab.participants.integration` |
| **T7** | Token leakage (agent config files, shell history, logs, URLs, database dump) | SHA-256 at rest with `token_id` lookup; secret displayed once; never in a URL (PAT in a header, ticket in the auth message); pino redaction; published secret-scanning regex `irid_(pat\|ses\|tkt\|spl\|oac\|oat\|ort)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}` with an offline CRC check, so an OAuth access or refresh token leaked into a client's configuration file is findable by the same scanner; mandatory expiry; rotation with bounded overlap; per-token rate limit and `access_log`; `tokens revoke-all`; snippets use environment indirection instead of literals (§2.2, §9, 06-mcp-and-agent-access.md) | `tokens.format.prop`, `logging-redaction.test`, `mcp.auth.mcp`, `tokens.rotation.integration` |
| **T8** | Session theft (cookie exfiltration, CSRF, fixation, renderer credential theft) | `__Host-` prefixed `HttpOnly; Secure; SameSite=Lax` cookie; custom header + Fetch Metadata CSRF guard on every mutating cookie request including multipart (§4.4); new session row per login (fixation impossible); idle + absolute expiry; channel binding (web cookie-only, desktop bearer-only); desktop token held only by the Electron main process, encrypted with `safeStorage`; renderer holds only single-use 60 s tickets (§4.5, §7); on macOS at 1.0 the desktop credential is never written to disk at all (memory-only mode, §4.5), which removes the at-rest exposure and adds a re-authentication on every launch | `security.csrf`, `auth.sessions-web.integration`, `auth.sessions-desktop.integration`, `desktop.preload-surface`, `desktop.attachments-no-token-in-renderer`, `desktop.macos-secure-storage.e2e` |
| **T9** | Cross-site WebSocket hijacking (CSWSH) | `/collab` never reads cookies; single-use 60 s tickets obtained through a CSRF-guarded endpoint; strict Origin allowlist on the upgrade with **absent Origin rejected** and no bypass flag; `Host` validation; per-user/IP/process connection caps (§7.5, §7.6) | `security.ws-origin` (absent, foreign, port-mutated origins), `tickets.batch-and-limits` |
| **T10** | Insider administrator abuse or audit tampering | every privileged action requires step-up and is audited inside its own transaction; HMAC chain per `chain_id` with locked heads; `BEFORE UPDATE/DELETE` triggers `SIGNAL SQLSTATE '45000'`; `iridium_app` holds only `INSERT, SELECT` on `audit_events`; `iridium audit verify-chain`; vault managers see admin actions inside their vault; admin-owned tokens get no implied access (§9.2, §11, A8, A46) | `audit.chain.integration`, `db-grants.integration`, `admin.*.integration`, `authz.no-mcp-admin-implied.guard` |
| **T11** | Supply-chain compromise (malicious package, postinstall script, typosquat) | pnpm `allowBuilds` allowlist (`electron`, `lefthook`, `@node-rs/argon2` only), `minimumReleaseAge 4320`, `trustPolicy no-downgrade`, exact pins with `saveExact`, Renovate `config:best-practices`, digest-pinned GitHub Actions and container images, licence allow/deny scan, SBOM + provenance on release (A1, A52) | CI `static` job (audit, dedupe, licence scan), `release.yml` SBOM step |
| **T12** | Electron escape (Node access from the renderer, navigation to remote content, deep-link injection, privileged-scheme CORS bugs of the CVE-2026-70604 class) | `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webviewTag:false`; `app://iridium` registered with `corsEnabled:true`; `will-navigate` and `setWindowOpenHandler` deny; permission/device handlers deny-by-default; electron-builder fuses; zod-validated IPC with a synchronous `senderFrame.origin` check; zod-validated deep links; main-only credential custody (§6.7, A53). The 1.0 desktop bundle is unsigned, so ASAR integrity validation and `enableCookieEncryption` are configured but cannot be honoured by the operating system; the fuses stay set so the post-1.0 signing epic changes nothing here, and 07-client-applications.md §7.14 states which of them are inert at 1.0 and why | `desktop.webPreferences`, `desktop.ipc-origin`, `desktop.ipc-contract`, `desktop.hardening` (3 OSes), `desktop.deep-link-fuzz` |
| **T13** | Denial of service via CRDT growth, message floods, upload floods or credential floods | the single limits policy (A.1): frame 2 MiB, update 1 MiB, 200 msgs/10 s, awareness 10/s, connection caps, loaded-document budget (2 000 docs / 1 GiB) with refusal rather than eviction, writer queue backpressure, upload and import caps; REST/login/ticket/PAT rate limits (§10); `@fastify/under-pressure` load shedding; malformed credentials rejected before any query (§10.3) | `collab.limits`, `collab.backpressure`, `security.credential-flood.integration`, k6 nightly load lane |
| **T14** | Data loss on crash, or a "Saved" indicator that lies | durable ack only after COMMIT with `innodb_flush_log_at_trx_commit=1`; append-only update log with `head_seq` CAS; baseline on every reconnect; explicit `rejected` / `save-failed` states with "Export my text"; unsaved-work warning before close (A19, 05-collaboration-and-durability.md) | `collab.durable-ack.chaos` (kill-after-ack ×20 plus fault points), `e2e.saved-indicator` |
| **T15** | Backup restore incomplete or inconsistent (including a restore that loses the audit chain or the peppers) | defined backup set with `manifest.json`; encrypted secrets bundle carrying pepper, audit HMAC and cursor key versions; `restore --verify` blocks on audit-chain verification, CRDT↔projection hash comparison, attachment presence and collaboration invariants; nightly drill; key versions must match the dump (A47) | `ops.backup-restore.drill` (the nightly drill in the `chaos` project, `apps/server/test/chaos/ops.backup-restore.drill.spec.ts`), `keys-rotate.integration` |
| **T16** | Prompt injection reaching an agent through note content | MCP `instructions.md` and every tool description state that note content is untrusted data; tools are read-only with `readOnlyHint:true` and `openWorldHint:false`; no agent write path exists in MVP (future writes go through `note_proposals`, never direct CRDT mutation); per-vault `ai_guidance` is administrator-authored, not note-authored; per-call `access_log` makes agent reads reviewable (A34, 06-mcp-and-agent-access.md) | `mcp.instructions` (asserts the warning text is present), `mcp.tools-schema-drift` |
| **T17** | Secrets in the environment, logs, metrics or error bodies | `*_FILE` secret loading for every secret (peppers, audit keys, cursor key, DB passwords, metrics token); redacted configuration summary at boot; pino `redact` list; `ProblemDetails` never echoes credentials; `/metrics` behind a bearer token or internal CIDR; unknown `IRIDIUM_*` keys rejected at boot (A49, 11-operations-and-deployment.md) | `config.test`, `logging-redaction.test`, `security.problem-details.unit` |
| **T18** | OAuth authorization-flow attacks (redirect-URI manipulation, open redirection, authorization-code interception and replay, CSRF on the consent POST, clickjacking of the consent screen) | exact-match redirect-URI validation against a registered set with no wildcards, prefix or substring matching; `client_id` and `redirect_uri` are validated **before** any redirect can happen, so an invalid value renders an error page instead of bouncing the browser; the login bounce's `return_to` is validated to be a same-origin `/oauth/authorize` path; PKCE S256 is required on every authorization request with no `plain` and no exemption for confidential clients; the code lives 60 s, is single-use under a locked row, and is bound to `client_id`, `redirect_uri`, `resource` and the authorizing `session_id`; replaying a consumed code revokes every token minted from it and audits `oauth.code.replayed`; the consent POST's CSRF defence is its single-use, session-bound 10-minute `request_id`, and `/oauth/consent` is a named member of the closed `CSRF_EXEMPT_ROUTES` set (§4.4); the consent page carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`, requires step-up, and shows the destination origin (06-mcp-and-agent-access.md) | `oauth.redirect-uri.unit`, `oauth.pkce.unit`, `oauth.authorization-code.integration`, `oauth.consent.integration`, `oauth.consent-page.integration`, `security.csrf.integration`, `authz.route-policy.boot` |
| **T19** | OAuth client identity and confused deputy (client impersonation, SSRF through the Client ID Metadata Document fetch, token audience confusion, token passthrough) | a CIMD `client_id` is an HTTPS URL whose document must name itself, fetched under a resolved-address allowlist with the socket pinned to the checked address, at most one redirect, and 32 KiB / 5 s caps; a dynamically registered client is marked unverified on the consent screen, in the user's authorized-applications list and in the admin console; `logo_uri` is stored but never rendered; the client name is HTML-escaped and truncated; the RFC 8707 `resource` parameter is required on both requests and must equal the canonical URI, and `access_tokens.resource` is compared at verification step 5a (§9.1), so a token issued for `/mcp/connect` is refused at `/mcp` and vice versa; Iridium never forwards a token it received to another service and never accepts one it did not issue | `oauth.cimd.unit`, `oauth.audience.contract`, `oauth.consent-page.integration`, `mcp.verifier.dispatch.unit` |
| **T20** | OAuth credential-lifetime abuse (refresh-token theft and replay, open-registration abuse, consent phishing) | refresh tokens rotate on every use inside one transaction, and presenting a rotated or revoked one revokes the whole `family_id`, every access token minted from it, audits `oauth.refresh.reuse_detected` unbounded and answers `400 invalid_grant`; the sliding idle window never advances past the family's absolute expiry; registration is bounded by a per-IP rate limit, an unused-client ceiling, a 7-day sweep of clients that never completed an authorization, an administrator kill switch that also removes `registration_endpoint` from the served metadata, and the refusal to issue a secret to a public client; consent requires a live session plus step-up, names the client and the destination origin, and carries the ⚠ line for a self-registered client; every grant is revocable per consent from Settings › Integrations with next-call effect (§8.10) | `oauth.refresh-rotation.integration`, `oauth.revoke-endpoint.integration`, `oauth.dcr.integration`, `oauth.revocation.mcp`, `oauth.sweep.integration` |

### 12.1 Assets, trust boundaries and assumed adversaries

The rows above are the checklist; this is the model they come from.

```mermaid
flowchart LR
  subgraph Untrusted
    B["Browser tab<br/>(any origin)"]
    A["MCP agent process<br/>(holds a PAT)"]
    C["Connector backend<br/>(holds an OAuth token)"]
    N["Note content<br/>(authored by any editor)"]
  end
  subgraph SemiTrusted["Semi-trusted client"]
    R["Electron renderer<br/>app://iridium — sandboxed"]
  end
  subgraph Trusted["Trusted, operator-controlled"]
    M["Electron main<br/>holds the session token"]
    S["Iridium server<br/>REST + /collab + /mcp + /mcp/connect + /oauth"]
    D[("MySQL 8.4 / 9.7")]
    F[("Attachment store")]
  end
  B -->|"cookie + CSRF guard"| S
  B -->|"session cookie on /oauth/authorize<br/>and /oauth/consent"| S
  R -->|"IPC, no credential"| M
  M -->|"Bearer session"| S
  R -->|"WSS + single-use ticket"| S
  A -->|"Bearer PAT on /mcp"| S
  C -->|"Bearer OAuth token on /mcp/connect"| S
  N -->|"sanitized preview"| B
  N -->|"sanitized preview"| R
  S --> D
  S --> F
```

| Asset | Why it matters | Primary controls |
|---|---|---|
| Note content and attachments | the product; confidential internal documentation | vault RBAC, 404-for-non-members, ACL in SQL, hardened attachment serving |
| Credentials (passwords, sessions, tickets, PATs, OAuth access and refresh tokens) | grant everything the owner has | argon2id + pepper, SHA-256 for high-entropy secrets, one-time links, main-process custody, mandatory expiry, revocation |
| OAuth grants and client registrations | a standing grant is a credential that renews itself | exact redirect-URI matching, PKCE S256, refresh rotation with reuse detection, step-up consent, per-consent revocation, bounded registration |
| Audit history | the only record of who did what | same-transaction HMAC chain, triggers, least-privilege DB role, verify-chain |
| Availability of the collaboration path | a stalled writer means lost trust in "Saved" | limits policy, admission control, backpressure, load shedding |
| The server host | everything | least-privilege DB roles, read-only container rootfs, loopback bind, no shell in the image |

Assumed adversaries: (1) a curious or malicious **employee with a valid account** in some vault — the main adversary the RBAC and isolation tests target; (2) an **unauthenticated network attacker** reaching the public HTTPS endpoint; (3) a **hostile note author** trying to escape the renderer or the agent; (4) a **compromised agent host** holding a PAT or an OAuth refresh token; (5) a **self-registered OAuth client** that a user is persuaded to authorize (T19, T20); (6) an **honest-but-careless operator** (secrets in the wrong place, a forgotten token or a standing grant nobody reviews). Explicitly out of scope for MVP: a compromised server host, a malicious database administrator, and a compromised end-user workstation — each of which is documented in `docs/threat-model.md` with the operational controls (disk encryption, MySQL TDE guidance, backups, and the published SHA-256 checksum a site administrator verifies out of band on the 1.0 desktop bundles, which are unsigned until the post-1.0 signing epic) that reduce, but do not eliminate, the exposure.
## 13. Extension seams (post-MVP, designed now)

Spec §10 defers enterprise SSO. Nothing below is built in MVP. Each item is listed with the seam that already exists, so adding it is additive and does not touch `authorize()`, the route contract or the collaboration hooks.

The OAuth 2.1 authorization server was the first row of this table until G1 was answered yes on 2026-09-12. It is now built in M3 and specified in `06-mcp-and-agent-access.md`; what remains here are the seams it did **not** consume. The distinction matters and is easy to lose: Iridium's authorization server authenticates Iridium's own accounts to Iridium's own MCP surface. It is not single sign-on, it does not make Iridium an identity provider for anything else, and the OIDC row below is still an unbuilt extension — one that will let a corporate IdP authenticate the *human* who reaches the consent screen, which is the opposite direction of travel.

| Extension | Seam that exists in MVP | What the extension adds | Ordering |
|---|---|---|---|
| **Enterprise-Managed Authorization for MCP** | the authorization server, the Protected Resource Metadata document and the consent screen exist (06-mcp-and-agent-access.md); `oauth_clients.registration_kind` already distinguishes a managed client from a self-registered one | the EMA extension's metadata and the cross-app-access grant, so a corporate IdP rather than Iridium authenticates the connector's user | With OIDC SSO |
| **OIDC single sign-on** | `SessionIssuer.issue(user, {kind, method, …})` is the single funnel every login method ends in (§4.1); `auth_providers` and `identities` tables are designed (C.11); `users.status`/`authz_version` already drive revocation; the desktop deep-link scheme `iridium://` is registered (A53) | `openid-client` 6.8.8 with PKCE S256, discovery, nonce/state; `POST /auth/oidc/start` + `/auth/oidc/callback`; JIT provisioning into `users` + `identities`; domain routing; desktop flow = system browser → `iridium://auth/callback?code=…` exchanged for a desktop session | First |
| **SAML 2.0** | same `SessionIssuer` funnel and `auth_providers.type='saml'` | preferably brokered through an OIDC IdP; native support only via `@node-saml/node-saml` or `samlify` with strict signature validation and a standing dependency-alert policy (both had critical 2025 signature-bypass CVEs) | After OIDC, on demand |
| **SCIM 2.0 provisioning** | `access_tokens.kind='scim'` is a valid enum value; `users.status` transitions (`active` → `disabled`) already revoke sessions, close connections and stop token access through `AuthzBus`; `groups` / `group_members` and a nullable `vault_members.group_id` are designed (C.11) | `/scim/v2/Users` and `/scim/v2/Groups` with a per-connection `kind='scim'` bearer, hand-written resource mapping plus `scim2-parse-filter` for filters, `users.managed_by='scim'` and `external_id`, deactivate-vs-delete semantics, drift reconciliation | After SSO |
| **MFA and passkeys** | `sessions.mfa_verified_at` exists and is unused; step-up is already a route flag, so making it require a second factor changes one function, not every route; the password policy already has the "min 8 once MFA exists" branch | TOTP (`otplib`) and WebAuthn (`@simplewebauthn/server`), enrolment UI, server-policy enforcement, recovery codes, `authz_version` bump on factor changes | After SCIM |
| **Group-based vault access** | `authorize()` resolves an `explicitRole` from one lookup; making that lookup a union of direct and group-derived memberships is a change inside `authz/` only, and `vault_members.version` generalises to a per-principal epoch | `groups`, `group_members`, `vault_members.group_id`, and a role-resolution query that takes the maximum of direct and group roles | With SCIM |
| **Agent write access** | `RESERVED_WRITE_SCOPES` are already schema-valid and inert; `note_proposals` is designed (C.11); `openServerEdit()` is the only server-side write path into a live document and already requires a principal and a permission | `note:propose` scope, a proposal review UI, and application of an accepted proposal through `openServerEdit()` — never direct CRDT mutation by an agent. The scope value would be grantable on the consent screen exactly as the six Read scopes are, so the authorization server needs no change for it | After OIDC SSO |
| **Redis-backed multi-process** | `AuthzBus`, `TicketStore`, `SettingsStore` and the rate-limit stores are interfaces with in-process implementations (F9); the epoch check and `onTokenSync` already make correctness independent of a lossy bus (§8.1) | `RedisAuthzBus` (pub/sub), `RedisTicketStore`, `RateLimiterRedis`, `@hocuspocus/extension-redis`, and a `settings.changed` fan-out for `SettingsStore.reload()` (02-system-architecture.md singleton catalogue) so the server-wide MCP switch stays server-wide instead of per process; revocation latency becomes bus latency, bounded by the same 23-minute backstop | When horizontal scaling is required |
| **SIEM streaming of audit events** | closed audit vocabulary, `schema_version` on every row, `iridium audit export --format jsonl` | outbound webhook/streaming with retries and a cursor | Any time |

Two rules keep these seams honest: (1) every new login method must end in `SessionIssuer.issue()`, and (2) every new credential kind must produce a `Principal` and go through `authorize()`. The authorization server is the first thing to leave this table by being built, and it obeyed rule 2 to the letter: an OAuth access token produces the same `TokenPrincipal` a PAT produces, and `authorize()` gained no branch (§5.4, `oauth.principal-parity.prop`). That is the standard the remaining rows are held to. `authz.seams.unit` asserts that the `Principal` union and the `RouteAuth` type have not grown a bypass shape (a route policy with neither `public`, `self`, `serverAdmin` nor `permission` fails to type-check).

## 14. Verification matrix

Every mechanism in this section has at least one named automated test. The lanes and runners are defined in 10-testing-and-quality.md; the milestone in which each test first runs green is from §E.

| Area | Tests | Lane | Milestone |
|---|---|---|---|
| Token format and CRC | `tokens.format.prop`, `tokens.format.unit` | unit, property | M1 |
| Password hashing, PHC, re-hash, pepper drift | `auth.hasher.unit`, `auth.phc.unit`, `auth.pepper-rotation.integration` | unit, integration | M1 |
| Password policy | `auth.policy.unit` (length, NFC, blocklist hit, context word), `auth.policy.blocklist-hash.unit` | unit | M1 |
| Login path and throttling | `auth.login.integration`, `auth.throttle.integration` (5 → block, doubling, reset on success, limiter B), `auth.login-timing.unit` (unknown user vs wrong password) | integration | M1 |
| Set-password links | `setpw-link.integration` (consume, expiry, replay, superseded, reset flow, policy failure) | integration | M1 |
| Sessions | `auth.sessions-web.integration`, `auth.sessions-desktop.integration` (issue, sliding idle, absolute cap, channel binding, per-user cap eviction, expiry finalisation), `auth.logout.integration` (`Clear-Site-Data`, cookie cleared), `auth.session-verify-parity.unit` (table-driven over the row states {live, revoked, idle-expired, absolute-expired, owner disabled, owner deleted}: `verifySession` and `loadLiveSession` accept and reject the identical set, so the shared `checkLiveRow` cannot drift; `loadLiveSession` never accepts a raw `irid_ses_…` string and `verifySession` never accepts a bare session id) | integration, unit | M1 |
| CSRF | `security.csrf` (missing header, unknown value such as `cli`, cross-site `Sec-Fetch-Site`, foreign `Origin`, missing `Referer`, multipart, bearer skip, login CSRF; desktop login passes with `X-Iridium-Client: desktop`, no cookie, no `Sec-Fetch-*` and no `Origin`; desktop `POST /auth/set-password` passes; `desktop` plus a `Cookie` header → `403`; `desktop` on a mutating non-public route with no bearer → 401/403, never 2xx; a header/body `client` mismatch on `POST /auth/sessions` → `403` with no `Set-Cookie` and no session row) | integration | M1 |
| Step-up | `auth.step-up.integration`, `authz.step-up.order.unit` (deny before step-up) | integration, unit | M1 |
| Permission matrix | `authz.matrix.unit` (full cross-product, 100 % coverage), `authz.usage.unit` (missing/extra vault id throws) | unit | M1 |
| Route policy | `authz.route-policy.boot` (every assertion of §6.2), `authz.rest-viewer`, `authz.vault-isolation.integration` | integration | M1/M2 |
| Token principals | `token.effective-permissions.prop`, `authz.no-mcp-admin-implied.guard`, `token.reserved-scopes-inert.unit`, `tokens.self-revoke-all.integration` (two live tokens → `200 {count: 2}`; each token's next MCP call `401`; one `token.revoked_all {scope:'user', count:2}` row with both ids in `targets` plus two `token.revoked {reason:'revoke_all_self'}` rows; a second call `200 {count: 0}`; a PAT principal refused; without step-up `403 step_up_required`) | property, unit, integration | M1/M3 |
| Tickets | `tickets.batch-and-limits` (single use, replay, expiry, foreign session, batch bounds, 429, session idle-expired between issuance and consumption → `unauthorized`, owner disabled in the same window → `revoked`, `userId` mismatch → `ticket_session_mismatch`) | integration | M1 |
| WebSocket Origin and caps | `security.ws-origin` (absent, foreign, port-mutated), `collab.limits` (the 21st *document* connection of one user is refused with `rate-limited` while that socket's other documents keep syncing; the 51st socket from one IP is refused with `429 rate_limited` at the upgrade, before any Hocuspocus state exists), `limits.policy.unit` (enforcement-site mapping: `CONNECTIONS_PER_USER` → `collab/limits.ts`'s `onAuthenticate` path, `CONNECTIONS_PER_IP`/`_PER_PROCESS` → the `connectionCaps` hook) | integration, unit | M1 |
| Viewer enforcement on the wire | `collab.viewer-enforcement` | integration | M1 |
| Awareness identity | `collab.awareness-identity` | integration | M1 |
| Live revocation | `collab.live-revocation.integration` (removal, disable, session revoke, downgrade → upgrade re-attach, delayed-sweep race, refused reconnect, ≤ 1 s), `collab.epoch-steady-state.integration` (`apps/server/test/integration/collab.epoch-steady-state.integration.spec.ts`: (a) a seeded editor connection sends 200 updates with no intervening authz event and the query count on `dbApp` across all 200 `beforeHandleMessage` invocations is zero; (b) the same for a server-admin connection with no `vault_members` row, pinning the `?? 0` sentinel; (c) after one `corruptDeliberately('bump-authz-version')` the next message performs exactly two lookups and the message after it performs none, proving the re-seed — counted with `countQueries(fn)` from `packages/testkit/src/db/query-counter.ts` over the `dbApp` Kysely instance, the same helper `security.credential-flood.integration` uses), `authz.revocation-rest.integration`, `collab.token-sync.integration` (bus detached), `authz.bus-after-commit.unit` | integration, unit | M1 |
| MCP authorization | `mcp.scopes`, `mcp.isolation`, `mcp.revocation` (including the server switch flipped **through `PUT /admin/settings` with a step-up session** — a direct `UPDATE server_settings` is invisible to the in-process `SettingsStore` and must not be used — with the effect asserted on the very next `/mcp` call, no restart and no reload allowance), `mcp.fail-closed`, `mcp.auth.mcp` (401 shapes on `/mcp`, still **without** `resource_metadata` — the two-mount split of §6.1 depends on that omission; plus the three cookie cases that pin both layers of §6.5 step 1: a request carrying a valid `__Host-iridium_session` cookie and no `Authorization` is `401 invalid_token` and never a session principal; the same request with the fault point `FAULT.mcpSkipIgnoreCookies` armed is still `401`, proving the `bearerOnly` branch of §6.1 carries the property alone; and inside the handler both `req.headers.cookie` and `req.cookies` are empty), `mcp.host-guard.contract` (every `Origin` value refused, no header passes); each of these runs against **both** mounts, and `oauth.discovery-split.contract` and `oauth.audience.contract` carry the parts that only exist on `/mcp/connect` | mcp, contract | M3 |
| OAuth authorization server | `oauth.discovery-split.contract`, `oauth.metadata.contract`, `oauth.authorization-code.integration`, `oauth.pkce.unit`, `oauth.redirect-uri.unit`, `oauth.refresh-rotation.integration`, `oauth.token-endpoint.integration`, `oauth.consent.integration`, `oauth.consent-page.integration`, `oauth.cimd.unit`, `oauth.dcr.integration`, `oauth.audience.contract`, `oauth.insufficient-scope.contract`, `oauth.revocation.mcp`, `oauth.revoke-endpoint.integration`, `oauth.principal-parity.prop`, `oauth.scope-mapping.unit`, `oauth.sweep.integration` | contract, integration, mcp, unit, property | M3 |
| Audit from auth flows | `audit.chain.integration`, `audit.bounded-failures.integration`, `db-grants.integration`, `access-log.integration` | integration | M1/M3 |
| Rate limits | `security.rate-limits.integration`, `security.credential-flood.integration` | integration | M2 |
| Desktop custody | `desktop.preload-surface`, `desktop.ipc-origin`, `desktop.ipc-contract`, `desktop.attachments-no-token-in-renderer`, `desktop.signin-headers` (main's pre-login `POST /auth/sessions` and `POST /auth/set-password` carry `X-Iridium-Client: desktop` and no `Cookie`, so a desktop sign-in cannot regress into `403 csrf_rejected`), `desktop.revocation-while-open.e2e` (sign-out calls both `clearStorageData()` and `clearCache()` on `persist:iridium`, and a previously rendered attachment no longer loads offline) | unit, electron E2E | M5 |
| End-to-end authorization behaviour | `e2e.viewer-readonly`, `e2e.revocation-while-open` (after `DELETE /api/v1/vaults/V/members/B`: the `__Host-iridium_session` cookie is still present, exactly one `GET /auth/me` was issued and returned `200`, the banner reads "Access to this note was removed" with no "Sign in again" control, and a note in a second vault still reaches `saved`), `desktop.revocation-while-open` (`apps/e2e/electron/desktop.revocation-while-open.e2e.spec.ts`: after the same `DELETE`, `secrets.bin` still holds the entry for that origin, `iridium:auth:status` still answers `state:'signed-in'`, no `iridium:event:session-changed` was emitted, and a note in a second vault reaches `saved`; then `DELETE /admin/sessions/:sessionId` and the opposite — the entry is gone and `session-changed {state:'expired'}` fired once), `e2e.admin` (step-up dialogs), `e2e.sign-in` (electron) | Playwright | M4/M5/M7 |
| Fuzzing and drift | Schemathesis `--stateful=links` against `openapi.json` (401/403/404 shapes), `openapi.contract` | contract | M2 |

Coverage gates: 100 % per-file line and branch coverage on `apps/server/src/auth/**`, `apps/server/src/authz/**`, `apps/server/src/oauth/**` and `packages/contracts/src/{authz,tokens}.ts`, and all four are inside Stryker's mutate scope; the mutation score is ≥ 70 on those paths at M1, raised to ≥ 80 by M8 (A2, A51). `apps/server/src/oauth/**` is in the gate for a specific reason: the redirect-URI matcher and the PKCE comparison are exactly the kind of code a mutant that flips `===` to `!==` must not survive, and both are one function each with no ambiguity about what the test should assert. The mutation lane is what keeps `authorize()` honest: a mutant that turns a `!==` into `===` in the epoch comparison, or drops the `explicitRole === null` check in step 5, must be killed by an existing test.

## Decisions made in this section

Decisions the skeleton does not cover, made here, used consistently above, and offered to 13-decision-log.md for merging. Skeleton rows are the authority wherever they speak; none of the following contradicts one.

| id | Decision | Rationale |
|---|---|---|
| D04-01 | **Per-user session cap of 20 live sessions per kind**, enforced in `SessionIssuer.issue()`; the oldest by `last_seen_at` is revoked with `revoked_reason='replaced'`. A desktop login with the same `deviceName` for the same user also replaces that device's previous session. | Bounds the blast radius of a stolen password, keeps `GET /me/sessions` readable, and gives `replaced` (already in the `revoked_reason` enum) a defined producer. |
| D04-02 | **Set-password links travel in the URL fragment** (`/set-password#<token>`), and issuing a new link supersedes every outstanding link of that user by setting `expires_at = now`. | A fragment never reaches server logs, proxy logs or `Referer` headers; superseding removes the "two valid links, one leaked" state without a second column. |
| D04-03 | **`ARGON2_CONCURRENCY` semaphore (default 4)** in `auth/credentials/hasher.ts`, in addition to `UV_THREADPOOL_SIZE=8`. | A login burst must not occupy every libuv thread-pool slot that DNS, `fs` and `zlib` also need; the queue is already bounded by the login rate limits. |
| D04-04 | **Password inputs are NFC-normalised** before length checks and before hashing, at set and at verify; the policy additionally rejects a candidate containing the user's email local part (≥ 4 chars) or the literal `iridium`; the breached list is the SecLists top-100 000 file pinned by SHA-256 at M0. | The same typed password must hash identically across platforms; context words are the cheapest high-value rule that NIST permits; pinning the list by hash makes the bundled artefact auditable. |
| D04-05 | **Peppers are versioned as `AUTH_PASSWORD_PEPPER_V<n>[_FILE]`** with `schema_meta.pepper_version` naming the current one; boot fails when the current version, or any `pepper_version` present in `user_credentials`, has no configured value. | Makes rotation (A29's "pepper-version drift → transparent re-hash") operable and fail-fast rather than silently unverifiable. |
| D04-06 | **Channel binding of sessions**: a `kind='web'` session is accepted only from the cookie, a `kind='desktop'` session only as a bearer. | Removes the whole class of "cookie value replayed as a bearer to skip the CSRF guard" and vice versa. |
| D04-07 | **`POST /auth/reauthenticate` and `POST /me/password` consume login limiter A** on a wrong password, and an administrator reset clears limiter A for that `email_key` across all IPs. | A stolen session must not become an unthrottled offline password oracle; the reset is the operator action that already restores access, so it is also the unlock. |
| D04-08 | **`authorize()` is a single async function with an explicit `AuthzScope`** that may carry a pre-loaded vault row and membership, and `PERMISSION_SCOPE` makes a missing or superfluous `vaultId` a thrown usage error (500), never a deny. | Lets structural transactions reuse rows they already locked without a second query, while making "forgot the vault id" impossible to mistake for "denied". |
| D04-09 | **Step-up is evaluated last**, after existence and permission. | The step-up prompt must not reveal that an action would otherwise be allowed. |
| D04-10 | **Token principals are refused on step-up routes with `403 token_scope_insufficient`**, never `403 step_up_required`. | A token can never satisfy step-up; suggesting a retry that cannot succeed is a worse API. |
| D04-11 | **`accessibleVaultIds(principal, {permission, surface})`** is the only way a cross-vault query obtains its ACL, and the role filter is derived from the matrix rather than hard-coded as `IN ('viewer','editor','manager')`. | Keeps the matrix the single source of truth and keeps the ACL inside the SQL plan, so no result is ever post-filtered. |
| D04-12 | **`allowArchived` route flag**, permitted only on the two routes of `ALLOW_ARCHIVED_ROUTES` (`POST /vaults/:vaultId/unarchive`, `GET /vaults/:vaultId/audit`) — the escape hatch and the one read whose permission is outside `READ_BUNDLE` — is the single exception to the archived-vault write freeze, and the boot assertion both enumerates its users and rejects it on any route whose permission is already in `READ_BUNDLE`. | Unarchiving must be possible without weakening the freeze for anything else, including server administrators; a no-op flag on a read route would suggest the freeze had been lifted where it had not. |
| D04-13 | **The in-process epoch table holds entries only for users with live `/collab` connections**; it is seeded at `onAuthenticate`/`onTokenSync` from the rows those hooks already read, updated by `EpochReconciler` from the `AuthzBus` payload (which therefore carries post-commit version numbers), re-seeded by `reauthorizeConnection()` on the fail-safe path, refcounted per user (`retain`/`release`, private `forget()` at zero), and treats a missing entry for a live connection as stale. | Bounds memory by the connection cap rather than the user count, keeps `beforeHandleMessage` I/O-free in steady state (an unseeded entry would make every inbound message re-authorize), and fails safe when table and connection disagree. |
| D04-14 | **`AuthzBus` fan-out is synchronous and after COMMIT**, with per-subscriber `try/catch`, a dedicated error metric, and a fixed subscriber order (`EpochReconciler` → `CollabGateway` → `TicketStore` → telemetry). | Guarantees the epoch is current before the sweep runs, and prevents one failing subscriber from failing the mutation or silently disabling revocation. |
| D04-15 | **`CollabGateway` keeps its own document→vault index** (maintained in `afterLoadDocument`/`afterUnloadDocument`) so a revocation sweep performs no database query. | A sweep runs inside the request that triggered it; it must be microseconds and must not be able to fail on a database hiccup. |
| D04-16 | **Bounded failure auditing**: `user.login.failed`, `token.denied`, `collab.connection.rejected`, `mcp.access.denied` and `oauth.authorize.denied` are deduplicated per key per window (60 s for `user.login.failed` and `collab.connection.rejected`; 10 min for `token.denied`, `mcp.access.denied` and `oauth.authorize.denied`, which are keyed by credential or client and are retried indefinitely by a misconfigured agent), always writing the block/lift transitions; `oauth.refresh.reuse_detected` and `oauth.code.replayed` are deliberately exempt from bounding; malformed credentials, CSRF, Origin and rate-limit rejections are never audited, only logged and counted. | Every audit insert locks a chain head; an unauthenticated attacker must not be able to serialise all writers or flood the tamper-evident history. Metrics and pino keep the full volume. |
| D04-17 | **`user.login.failed` records a salted hash of the submitted address** and names the account in `actor_display` only when it exists. | A typo storm or an enumeration attempt must not fill the permanent audit history with third-party email addresses. |
| D04-18 | **Job authorization is re-evaluated at run and at download**, from the recorded principal rebuilt against live memberships, not only at enqueue. | An import or export can outlive a membership; "revocation stops further reads" has to include work already queued. |
| D04-19 | **`POST /me/tokens/revoke-all`** exists alongside the admin route, offered in the settings UI next to a password change. Contract, so the other surfaces can carry it verbatim: `auth: {self: true, stepUp: true}`, request `{}` → `200 {count: int}` (`0` when nothing was live; idempotent), setting `revoked_at = now`, `revoked_by = the caller` and `revoke_reason = 'revoke_all_self'` on every live token of the **caller** — a value distinct from the admin path's `'revoke_all_user'`, so a user's own action stays forensically distinguishable from an administrator's; one audit `token.revoked_all {scope:'user', user_id, count}` with the affected token ids in `targets`, plus a per-token `token.revoked {reason:'revoke_all_self'}` row; after COMMIT one `token.revoked` `AuthzBus` event per token. Errors: `403 step_up_required`; a PAT principal is refused (`403 token_scope_insufficient`, §9.4). Registered in 06-mcp-and-agent-access.md's token REST table and 09-api-reference.md (operation id `me.tokens.revokeAll`, recorded in D09-8 as a route 09 adds beyond the skeleton); the service function is the shared `revokeAll({userId, actor:'self'\|'admin'\|'cli'})`. Asserted by `tokens.self-revoke-all.integration`. G1 widens what the one action covers without changing its shape: the same call now revokes the caller's OAuth access tokens, refresh tokens and consents as well, `{count}` still counts access tokens, and the response gains `{consentsRevoked}` (§8.10). | A user who suspects compromise needs one action that stops every agent they configured, without an administrator; `revoke_reason` is free text (`VARCHAR(120) NULL`) and `token.revoked_all` is already in the closed audit vocabulary, so nothing settled has to change. |
| D04-20 | **Set-password link redemption is throttled on the link id** (`spl:<token_id>\|<ip>`, 5 per 24 h) in addition to the per-IP route limit. | The link secret is high-entropy, but a throttle makes the id space uninteresting to probe and bounds the cost of a flood. |
| D04-21 | **`system` principals are constructed only by the job scheduler, migrations, the CLI and `openServerEdit()`**, always with a job name, and the CLI additionally records `onBehalfOf` when an operator identity is resolvable. | Keeps "allowed by construction" narrow, and keeps every internal write attributable in the audit log. |
| D04-22 | **The CSRF guard accepts `X-Iridium-Client ∈ {web, desktop}`**, applies the Fetch-Metadata/`Origin`/`Referer` comparisons to `web` only, rejects a `desktop` value that arrives with a `Cookie` header or on a non-public route, and requires the `client` field of `POST /auth/sessions` to equal the header. | A27's own scope is cookie principals, but the guard also covers the two public pre-login routes, and the desktop main process reaches them with no bearer and no browser headers: a `web`-only test rejects every desktop sign-in and every desktop "Paste set-password link". The digest's header definition is `web\|desktop`; neither value can be forged cross-origin (no CORS handler), and a cookie-less `desktop` request has no ambient credential to abuse. |
| D04-23 | **`auth/sessions/verify.ts` exports two entry points over one shared row check** — `verifySession(raw, channel)` for HTTP and `loadLiveSession(sessionId)` for `/collab` after ticket consumption — with `checkLiveRow` holding revocation, idle/absolute expiry, `users.status` and the `last_seen_at` refresh; `loadLiveSession` returns the dead reason so the close code can differ. | Ticket consumption yields a session id, not a secret, so calling the raw-token verifier with an id was unimplementable and invited a second, divergent session-validation path. One shared block plus a parity test is the only way "the collab path checks exactly what REST checks" stays true. |
| D04-24 | **The per-user `/collab` cap of 20 counts document connections and is enforced in `onAuthenticate`** (after the ticket binds a user), refusing one document with `rate-limited` while the socket keeps syncing; the per-IP (50) and per-process (5 000) caps count sockets, are enforced in the upgrade `preValidation`, and answer `429 rate_limited` with `retry-after`. | The upgrade carries no credential, so a per-user cap cannot be evaluated there; and one socket multiplexes many documents, so "sockets" and "document connections" are different units with a 13-to-1 ratio in a single window. `429` is what the error catalogue binds `rate_limited` to; `403` is reserved for Origin and Host. |
| D04-25 | **A WebSocket close is never an authority on session validity; only a REST `401` is.** A `revoked` close triggers exactly one `GET /auth/me`, and only that call's `401` erases the desktop `secrets.bin` entry or ends the web session. | `revoked` is deliberately shared by four causes (membership removed, user disabled, session revoked, password changed elsewhere), so treating it as a session end logs a user out of the whole application when one vault membership was removed — and destroys their stored credential. |
| D04-26 | **One bearer-verification module and one symbol**: `apps/server/src/auth/tokens/verify.ts` exporting `verifyToken(raw, { surface: 'mcp' \| 'rest' })`, wrapped (never duplicated) by `apps/server/src/mcp/verifier.ts`. D04-30 extends the option bag with `resource` and the accepted kinds with `oat`; the module and the symbol are unchanged, which is the point. | The plan named the same module `verifier.ts` and `verify.ts` and the same function `verifyPat` and `verifyToken`; with `mcp/verifier.ts` already fixed by A32, the auth-side name must be `verify.ts`, and a credential-neutral symbol survives the `irid_oat_…` branch that §13 designs. |
| D04-27 | **Attachment bytes are the one authenticated response with a private cache window, and it is stated rather than papered over**: §8.9 documents the ≤ 3 600 s replay, the clients evict on a 4403 `revoked` (Electron main also calls `session.clearCache()`, which sign-out does too), and the reverse-proxy override is documented for operators who need a hard bound. | A44's `private, max-age=3600` is settled, so "the next request is denied" can only be true of requests that reach the server. `clearStorageData()` alone does not flush Chromium's HTTP cache, so sign-out was leaving readable attachment bytes behind. |
| D04-28 | **`bearerOnly` is the primary mechanism that keeps a browser session off `/mcp` — and, identically, off `/mcp/connect`; `ignoreCookies` is defence in depth, and neither may be dropped.** Fastify merges instance-level hooks ahead of route-level ones, so `authenticate()` (registered at root scope in boot step 4) and the `@fastify/cookie` parser both run *before* `/mcp`'s own `onRequest` array: the property "no ambient credential authenticates an MCP call" comes from the `bearerOnly` branch of §6.1, while `ignoreCookies` deletes `req.headers.cookie` **and** empties the parsed `req.cookies` jar for every later phase (`mcpIpGate`, `patAuth`, `mcpKillSwitch`, `chargeRateLimit`, the handler, the SDK). Pinned by the three cookie cases of `mcp.auth.mcp`, one of which arms `FAULT.mcpSkipIgnoreCookies`. | The plan previously justified the property with hook ordering Fastify does not provide, which invites an implementer to delete `bearerOnly` as redundant and reopen the CSRF surface on `/mcp`. A32 fixes `ignoreCookies` in the route-level array, so the fix is to state the real order and test both layers, not to move the hook. |
| D04-29 | **A23's "no caches on the authorization path" is about principal, membership and token state; the `SettingsStore` is not an exception to it.** The server-wide MCP switch is read as `SettingsStore.effective().mcp_enabled` — an in-memory read of a store that `PUT /admin/settings` (the row's only writer) reloads inside the committing request — so it has no TTL and no staleness window, and it adds no third query to `authorize()`. The vault switch stays a per-request database read because it arrives with the vault row (§5.5 query 2, now `SELECT id, status, mcp_enabled`). | Saying "read per request, no cache" of a value that lives in an in-process store was simply false, and it left a reader unable to tell where the flag is read; saying "cached" would contradict A23. Naming the scope of A23 keeps both statements true and makes the post-MVP multi-process obligation explicit: without the `settings.changed` fan-out a server-wide switch would become per process. |
| D04-30 | **`verifyToken` accepts both `irid_pat_` and `irid_oat_` and takes the route's canonical URI as a `resource` option**; the credential kind a route accepts is declared as `config.mcpAudience` and asserted at boot (§6.2). One verification path, one place where a kind is bound to a URL. | Two verifiers would be two places for the audience check to be forgotten, and the MCP specification's audience-validation MUST (RFC 8707 §2) has to be enforced where the row is read, not where the route is written. Declaring the binding on the route makes it readable by the boot assertion, so "the credential a route accepts is exactly the one its discovery posture advertises" is checked rather than believed. |
| D04-31 | **`authorize()` is unchanged by the authorization server**, and a branch on `tokenKind` inside `authz/` is a defect that `oauth.principal-parity.prop` fails on. Consent and client liveness are **credential** properties checked at verification steps 5a and 5b (§9.1), not authorization properties. | The whole value of one `Principal` and one `authorize()` (A30) is lost the moment a second credential kind earns its own branch; and consent revocation belongs next to expiry and token revocation, where "is this credential still live" is already decided, rather than duplicated inside the permission decision. |
| D04-32 | **The CSRF exemption set becomes a closed, enumerated constant (`CSRF_EXEMPT_ROUTES`) asserted at boot**, instead of the single special case `/mcp`. | Five more routes legitimately need the exemption, and a rule stated as "only `/mcp`" would have been quietly widened instead of re-stated — which is precisely how a CSRF hole is introduced by someone who believed they were following the plan. |
