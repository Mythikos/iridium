# D06-01: `token_not_rotatable`

Status: accepted (2026-09-11); amended 2026-09-25: the code also answers a token that is already superseded, so a rotation chain can never fork, and an OAuth access token is not addressable on `/me/tokens`.

**As accepted.** Add one ProblemDetails code, `token_not_rotatable` (`409`), returned when `POST /me/tokens/:id/rotate` targets an already revoked or expired token. The closed error-code list of the skeleton has no code for this case; `validation_failed` would be wrong (the body is valid) and `stale_version` would be misleading (no version conflict occurred). One precise code keeps client handling deterministic.

**Amended 2026-09-25.**

- **A superseded token.** `token_not_rotatable` also answers a token whose derived status is `rotated` (D06-50's `deriveTokenStatus`: `rotation_overlap_until` is set and has not elapsed). Its successor carries the name and is the one to rotate, so every rotation starts from the newest link and a chain cannot fork into two live successors. The check runs under the old token's `FOR UPDATE`, taken after the owner's `users` row in the credential lock order (A46 as amended), so two concurrent rotations of one token serialise and the second answers `409`.
- **Only integration tokens.** The `/me/tokens` routes address the caller's `kind='pat'` rows only: an OAuth access-token id answers `404 not_found` on `me.tokens.get`, `me.tokens.snippets`, `me.tokens.rotate`, `me.tokens.revoke` and `me.tokens.activity`, because an OAuth credential is managed per grant through `/me/oauth-consents` and rotating it would mint a PAT-shaped credential outside its consent.

Rejected: allowing a superseded token to rotate again, which forks the chain and leaves two live successors under one name; `422` for the superseded case, whose body is valid; addressing OAuth access tokens on `/me/tokens`.

Verification: `tokens.rotation.integration` (the superseded refusal beside the revoked and expired ones), `tokens.lifecycle.integration` (an OAuth access-token id answers `404` on the `/me/tokens` routes) and `lock-order.integration` (rotation raced against create and revoke-all, D06-50).

Source: the D06-01 amendment in [the decision log](../plan/13-decision-log.md), and D06-01 in [06-mcp-and-agent-access.md](../plan/06-mcp-and-agent-access.md), "Decisions made in this section".
