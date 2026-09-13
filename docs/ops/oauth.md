# OAuth authorization server (operator view)

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

The operator's document for the OAuth 2.1 authorization server: the two MCP URLs and which client uses which (`/mcp` for a static integration token, `/mcp/connect` for a connector that signs in); the four `/.well-known/` paths that must return `404` and how to verify them through the proxy with `iridium doctor --oauth`; the public-HTTPS reachability requirement for a cloud connector; the registration policy and how to disable dynamic client registration; how to read `/admin/oauth-clients`; how to revoke a connector for one user (`DELETE /me/oauth-consents/:consentId`) or for everyone (`iridium oauth clients disable`); and why a restart drops pending consent requests (`ConsentRequestStore` is in-process, so this is a ten-second inconvenience, never a lost grant).

## Source

- docs/plan/11-operations-and-deployment.md, the paragraph on `docs/ops/oauth.md` under egress and reachability
- docs/plan/12-milestones.md §7 (M3 scope, new at M3)
- docs/adr/0060-oauth-authorization-server.md (AG1)
