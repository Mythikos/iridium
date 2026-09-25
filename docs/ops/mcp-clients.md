# MCP clients (operator view)

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

The operator's view of the MCP surface: reachability (intranet clients — Claude Code, IDEs, the bridge — versus cloud connectors that need a publicly reachable HTTPS origin), proxy header passthrough for a proxied deployment, the kill switches (the server-wide `mcpEnabled` setting, read per request as `SettingsStore.effective().mcpEnabled.enabled` and changed through `PUT /admin/settings`; the per-vault `vaults.mcp_enabled` column; and the deployment switch `MCP_OAUTH_ENABLED`, which unmounts `/mcp/connect` and the OAuth surface — `06-mcp-and-agent-access.md` "Kill switches"), rate limits, and how to read the access log. Finalised at M3 with the real-client matrix's exact recorded versions (`apps/e2e/mcp-clients/versions.json`), a table this document is committed alongside.

## Source

- docs/plan/06-mcp-and-agent-access.md, documentation table ("operator view: reachability ... reading the access log")
- docs/plan/12-milestones.md §7 (M3 scope, new at M3) and §12 (M8: finalised with matrix versions)
- docs/plan/11-operations-and-deployment.md, C50 (documentation set)
