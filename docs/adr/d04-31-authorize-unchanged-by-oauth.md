# D04-31: `authorize()` is unchanged by the authorization server

Status: accepted (2026-09-12); amended 2026-09-25: the invariant is proven by two tests with disjoint reach, and neither is claimed to cover the other's half.

**As accepted.** `authorize()` is unchanged by the authorization server, and a branch on `tokenKind` inside `authz/` is a defect that `oauth.principal-parity.prop` fails on. Consent and client liveness are credential properties checked at verification steps 5a and 5b (04 §9.1), not authorization properties. The whole value of one `Principal` and one `authorize()` (A30) is lost the moment a second credential kind earns its own branch; and consent revocation belongs next to expiry and token revocation, where "is this credential still live" is already decided, rather than duplicated inside the permission decision.

**Amended 2026-09-25.** Two tests prove the invariant, with disjoint reach:

- `oauth.principal-parity.prop` (`apps/server/src/authz/oauth.principal-parity.prop.spec.ts`, unit project, at `@iridium/testkit`'s `PROP` budget) runs a fast-check property over role, scopes, vault scope (an allowlist or `all_vaults`), vault status, vault `mcp_enabled`, the server's `mcpEnabled`, permission and surface against the real `createAuthorizer()` with an injected `MembershipLookup` and `mcpServerEnabled`: OAuth and PAT `TokenPrincipal`s built from identical inputs must produce the identical `Decision`, so a `tokenKind` branch anywhere in `authorize()`'s own input resolution — `vaultAllowedFor`, the membership lookup, the MCP switches, `decide()` — fails it.
- The verifier's construction of the `TokenPrincipal` — `verify.ts`'s allowlist load, `all_vaults` and scopes — is outside `createAuthorizer` and is proven by `token.effective-permissions.prop` (`apps/server/test/property/token.effective-permissions.prop.spec.ts`, property project, `PROP_DB`), which M3 extends over OAuth and PAT principals minted through the product.

A property that feeds hand-built principals to the real authorizer cannot see how the verifier built them, and a database property over minted credentials cannot isolate a branch inside `authorize()`; stating each test's reach keeps the invariant's proof honest.

Verification: `oauth.principal-parity.prop` and `token.effective-permissions.prop`.

Source: the D04-31 amendment in [the decision log](../plan/13-decision-log.md), and D04-31 in [04-auth-and-access-control.md](../plan/04-auth-and-access-control.md), "Decisions made in this section".
