# A26 — Session model: one `sessions` table, two delivery channels, no reusable credential in the renderer

**Status:** Accepted (2026-09-11).

## Context

Two clients need sessions with very different constraints. The web SPA is served from `PUBLIC_ORIGIN` and can use a cookie; the Electron renderer runs on `app://iridium`, a different origin from the server, where cookies are cross-site. Digest §6.2 gives the requirements: ≥64 bits of CSPRNG entropy, `Secure`, `HttpOnly`, `SameSite`, the `__Host-` prefix, server-enforced idle and absolute timeouts, session-ID regeneration at login and privilege change, logout invalidating server-side with `Cache-Control: no-store`, and never storing tokens in `localStorage`/`sessionStorage`. It also records that better-auth 1.7.4 stores its session token in **plaintext** with no hashing option, which disqualifies it as the session store for an enterprise audit. Digest §11.15 records the desktop disagreement: plan-product-dx (Topic 4) wanted rotating refresh tokens plus 10–15-minute access tokens held by the Electron main process; plan-risk-first (Topic 6) wanted a single desktop session token. Both agreed the renderer holds nothing. Digest §6.2 also documents `safeStorage` behaviour, including that Linux can report a `basic_text` backend that is not real encryption.

## Decision

One `sessions` table, one secret shape, two delivery channels.

- Secret: 32 CSPRNG bytes; `sessions.secret_hash = SHA-256(secret)`; lookup by the embedded `token_id` (A31 format, kind `ses`) then `timingSafeEqual`.
- **Web**: `__Host-iridium_session=<irid_ses_…>; Secure; HttpOnly; SameSite=Lax; Path=/`, idle 24 h sliding, absolute 14 d.
- **Desktop**: `POST /auth/sessions {client: 'desktop', deviceName}` returns the credential in the response body; it is held **only by the Electron main process**, encrypted with `safeStorage.encryptStringAsync` into `userData/iridium/secrets.bin` keyed by server origin. When `isEncryptionAvailable()` is false, or the Linux backend is `basic_text`, the session is memory-only and the UI shows a visible warning; the admin policy `desktop_update_policy.requireSecureStorage` (published by `GET /desktop/update-policy` as `requireSecureStorage`; it lives in the desktop group, never in `session_policy`) can refuse login outright. Idle 30 d, absolute 90 d.
- The renderer performs REST through the IPC `ApiTransport` → main-process `net.fetch` with the `Authorization` header; tickets are requested over IPC; attachments load through `iridium-attachment://<vault>/<id>` handled in main (A44, A53).
- When `Authorization` is present, cookies are ignored (one principal per request, no ambiguity).
- A new `sessions` row is created on every login (session-ID regeneration by construction). A password change revokes all other sessions. Logout deletes the row, clears the cookie, and responds with `Cache-Control: no-store` and `Clear-Site-Data`.
- **Step-up ("sudo")**: `last_authenticated_at` within 10 minutes is required for token create/rotate/revoke, password and email change, every `/admin/*` mutation, vault archive, and version restore; otherwise `403 step_up_required`, resolved by `POST /auth/reauthenticate`.
- All TTLs are administrator-configurable in the `session_policy` row of `server_settings` — `{webIdleHours, webAbsoluteDays, desktopIdleDays, desktopAbsoluteDays, stepUpMinutes}`, the grouped shape `03-data-model.md` §13.1 fixes — with the environment values (`SESSION_WEB_IDLE_HOURS`, `SESSION_WEB_ABSOLUTE_DAYS`, `SESSION_DESKTOP_IDLE_DAYS`, `SESSION_DESKTOP_ABSOLUTE_DAYS`, `STEP_UP_WINDOW_MIN`) acting as security floors: an administrator may tighten a lifetime but never loosen it past the environment value.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Refresh token + 15-minute access tokens in the renderer, with CORS for `app://iridium` (plan-product-dx) | Puts a reusable bearer in the renderer — the one place hostile note content executes — and requires a credentialed CORS path. Two token kinds, two expiry rules, two revocation paths, for no gain over main-process custody. |
| better-auth 1.7.4 as the session framework | Stores the session token in plaintext with no hashing option (digest §6.2); also brings an opinionated schema into a database the plan controls exactly. |
| JWT sessions (stateless) | Cannot satisfy A23 (revocation within 1 s) without a denylist, which is a session table with extra steps. |
| Cookies for the desktop too | `app://iridium` → server is cross-site; `SameSite=None` would be required, re-opening CSWSH (digest §6.2). |
| Session secret hashed with argon2 | Session lookup happens on every request; a 256-bit random secret needs no slow KDF (same reasoning as A31). |

## Consequences

Positive: one session table, one revocation path (A23), one audit actor shape; the renderer never holds a credential, so an XSS in the preview cannot steal one; step-up protects exactly the operations that create or destroy long-lived access. Negative: every desktop REST call crosses IPC to main, so the `ApiTransport` and its zod-validated channels become load-bearing (A53, and the `ipc.origin.guard` guard test); `safeStorage` unavailability on some Linux configurations degrades to memory-only sessions, which the UI must explain; the step-up rule adds a re-authentication dialog to several admin flows (deliberate).

## Verification

`auth.sessions-web.integration` (idle and absolute expiry enforced server-side; rotation at login; password change revokes others; the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax` and `Path=/` attributes); `auth.sessions-desktop.integration` (bearer custody, and the cookie ignored when `Authorization` is present); `auth.step-up.integration` (each listed operation returns `403 step_up_required` outside the 10-minute window); `desktop.attachments-no-token-in-renderer.e2e` (main-process custody; `basic_text` fallback warning); `desktop.preload-surface.guard` (the renderer surface exposes no credential); `logging-redaction.integration` (no session secret reaches a log).

## References

Digest §6.2 (OWASP session management, `safeStorage`, better-auth plaintext), §4.2, §11.13, §11.15; spec §4, §8; plan-risk-first ADR-09; judges 1, 2, 3. Implemented in `04-auth-and-access-control.md` and `07-client-applications.md`.

---

Source: docs/plan/13-decision-log.md, decision A26. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
