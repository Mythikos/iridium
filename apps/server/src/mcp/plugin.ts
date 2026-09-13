/**
 * Boot step 10, the `mcp` plugin.
 *
 * M3 fills it in: one `createMcpHandler` instance, one `buildIridiumMcpServer` factory, one
 * `ContentReadCore` and one route handler, mounted twice — `ALL /mcp` for integration tokens and, when
 * `MCP_OAUTH_ENABLED`, `ALL /mcp/connect` for OAuth access tokens. The two mounts differ in exactly two
 * declared things: `config.mcpAudience` and the options the authentication preHandler hands the single
 * `verifyToken` (06-mcp-and-agent-access.md).
 *
 * The route-policy assertion already knows the shape: `mcpAudience` without `bearerOnly` is refused
 * from M0, and the audience-must-match-the-discovery-posture rule joins it when the Protected Resource
 * Metadata documents exist (`PENDING_ASSERTIONS` in `authz/route-policy.ts`).
 */
import type { FastifyInstance } from 'fastify';

/** Applies boot step 10. An empty stub until the milestone named above. */
export function applyMcpPlugin(_app: FastifyInstance): void {
  // Intentionally empty: the plugin order of 02-system-architecture.md is established at M0
  // so that a later milestone adds behaviour to a named step rather than a new step.
}
