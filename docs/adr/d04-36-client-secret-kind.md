# D04-36: the OAuth client secret kind

Status: accepted 2026-09-25.

An OAuth client secret is a credential of the one format (A31): kind `ocs`, `irid_ocs_<id16>_<secret43><crc6>`, stored on `oauth_clients` as `client_secret_hash = SHA-256(secret43)` with `client_secret_prefix = 'irid_ocs_<id16>_'`, the 26-character display prefix the existing column holds, and delivered once, by `POST /admin/oauth-clients` (D06-45). `TOKEN_KINDS` and the published scanner regex `irid_(pat|ses|tkt|spl|oat|ort|oac|ocs)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}` gain it in every printing — 01, 03, 04, 06, 09, 10, 11, 12 §7.2, 14 R-O02, and the Status lines of A31 and AG1 — and in `packages/contracts/src/tokens.ts`; the redaction integration spec imports `SCANNER_REGEX_SOURCE` rather than re-typing the regex. The secret lives in `oauth_clients`, never in `access_tokens.kind`, and is never accepted as a bearer: `authenticate()` and `verifyToken` refuse it as `unknown_kind` through their existing branch.

A `client_secret_basic` client must present `Authorization: Basic` at `/oauth/token` and `/oauth/revoke`, decoded as RFC 6749 §2.3.1's form-urlencoded credentials and verified in constant time by `auth/oauth/clients.ts`; every other presentation answers `401 invalid_client` with `WWW-Authenticate: Basic realm="iridium"`.

One format keeps the leak scanner covering every secret Iridium issues and fits the existing prefix column, and a published regex printed in a dozen places must change in all of them at once. Rejected: an opaque secret outside the credential format.

Verification: `tokens.format.unit`, `tokens.kind-enum.unit` (`ocs` lives in `oauth_clients`, never in `access_tokens.kind`), `oauth.token-endpoint.integration` (Basic success and the `401 invalid_client` cases), `admin.oauth-client-create.integration` and `logging-redaction.integration`.

Source: D04-36 in [the decision log](../plan/13-decision-log.md) and in [04-auth-and-access-control.md](../plan/04-auth-and-access-control.md), "Decisions made in this section".
