# A28 — Initial credential delivery and password reset: one-time set-password links

**Status:** Accepted (2026-09-11).

## Context

Spec §4 says accounts are administrator-managed with no public registration, and spec §10 defers enterprise SSO; e-mail delivery is not a spec §10 item at all but a non-goal the plan fixes for itself (`01-vision-scope-and-principles.md` §4.4). That leaves an unanswered question every plan skipped: how does a new user obtain their first password, and how is a forgotten password reset, without an email service and without an administrator ever knowing a user's password? Administrator-typed temporary passwords mean a plaintext secret passes through a second human and usually through a chat message.

## Decision

One-time set-password links, delivered out of band by the administrator in the MVP.

- `POST /admin/users` creates the user **without credentials** (no `user_credentials` row) and returns a single-use link token `irid_spl_…` (kind `spl`, A31 format), valid 24 h, stored SHA-256-hashed in `password_setup_tokens`.
- The administrator copies `<PUBLIC_ORIGIN>/set-password#<token>` and delivers it out of band (the fragment keeps the token out of the server's access log and out of `Referer` headers).
- `POST /auth/set-password {token, password}` sets the credential, consumes the link, and audits `user.password.set`.
- `POST /admin/users/:id/reset-password` issues a new link and revokes all of that user's sessions; PATs are deliberately untouched (an administrator-forced password reset is not evidence that the user's integration tokens are compromised, and silently killing an agent's access would be a surprising side effect; `iridium tokens revoke-all --user` is the explicit tool when that is intended).
- The desktop login screen accepts the same link.
- SMTP delivery is a post-MVP seam: the `smtp` group is reserved in `server_settings` and is deliberately absent from the strict `ServerSettings` object until it ships (`09-api-reference.md` §2.15.3).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Administrator-typed temporary passwords | A plaintext password transits an administrator and a chat system; also needs a `must_change` flag and a second code path in login. |
| `must_change_password` flag on a real credential | Same plaintext exposure, plus an extra state in the login state machine. |
| Requiring SMTP in the MVP | `01-vision-scope-and-principles.md` §4.4 places e-mail delivery outside the MVP as one of the plan's own non-goals, and it adds an infrastructure dependency (and a deliverability support burden) to the first release; the seam is reserved. |
| Token in the query string rather than the fragment | Query strings land in proxy access logs and `Referer` headers. |
| Longer-lived or reusable setup links | A reusable account-takeover link; 24 h single use with an explicit reissue path is the correct trade. |

## Consequences

Positive: no plaintext password is ever known to anyone but its owner; account creation and password reset share one mechanism and one audit event; adding SMTP later changes only the delivery step. Negative: administrators must hand over links manually in the MVP (documented in the operations runbook); a link that leaks before use is an account takeover until it expires, which is why it is single use, 24 h, fragment-delivered, and audited on consumption.

## Verification

`setpw-link.integration` (link is single use; expiry enforced; consuming it audits `user.password.set`; a setup token cannot authenticate any other route); `admin.reset-password.integration` (a new link is issued, sessions are revoked, PATs survive); `toMatchOpenApi(operationId, status)` on both routes' responses.

## References

Digest §6.2 (OWASP authentication and secrets guidance); spec §4, §10; gap fix (no source plan covered it). Implemented in `04-auth-and-access-control.md`, `09-api-reference.md`, `11-operations-and-deployment.md`.

---

Source: docs/plan/13-decision-log.md, decision A28. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
