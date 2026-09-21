/** The two search transports share the committed read core and no SQL of their own. */
import { SearchPage, SearchQuery, VaultId, VaultIdParams } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ContentReadCore } from '../content/read/index.ts';
import { requirePrincipal, routeSpec } from '../rest/handler-context.ts';

/** Registers search under the API prefix. */
export function applySearchRoutes(app: FastifyInstance, core: ContentReadCore): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const all = routeSpec('search.all');
  api.get(
    all.path,
    {
      config: { auth: all.auth },
      schema: {
        operationId: all.operationId,
        tags: [all.tag],
        summary: all.summary,
        querystring: SearchQuery,
        response: { 200: SearchPage },
      },
    },
    async (request) => core.search(requirePrincipal(request.principal), request.query),
  );
  const vault = routeSpec('search.vault');
  api.get(
    vault.path,
    {
      config: { auth: vault.auth },
      schema: {
        operationId: vault.operationId,
        tags: [vault.tag],
        summary: vault.summary,
        params: VaultIdParams,
        querystring: SearchQuery,
        response: { 200: SearchPage },
      },
    },
    async (request) =>
      core.search(
        requirePrincipal(request.principal),
        request.query,
        VaultId.parse(request.params.vaultId),
      ),
  );
}
