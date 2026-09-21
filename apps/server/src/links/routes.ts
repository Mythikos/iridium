/** Link transports delegate every authorization and committed read to the shared read core. */
import {
  LinkPage,
  ListInboundLinksQuery,
  NoteId,
  NoteIdParams,
  NoteLinks,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { ContentReadCore } from '../content/read/index.ts';
import { requirePrincipal, routeSpec } from '../rest/handler-context.ts';

/** Registers the two note link reads under the API prefix. */
export function applyLinkRoutes(app: FastifyInstance, core: ContentReadCore): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const outgoing = routeSpec('notes.links');
  api.get(
    outgoing.path,
    {
      config: { auth: outgoing.auth },
      schema: {
        operationId: outgoing.operationId,
        tags: [outgoing.tag],
        summary: outgoing.summary,
        params: NoteIdParams,
        response: { 200: NoteLinks },
      },
    },
    (request) =>
      core.readNoteLinks(requirePrincipal(request.principal), NoteId.parse(request.params.noteId)),
  );
  const incoming = routeSpec('notes.backlinks');
  api.get(
    incoming.path,
    {
      config: { auth: incoming.auth },
      schema: {
        operationId: incoming.operationId,
        tags: [incoming.tag],
        summary: incoming.summary,
        params: NoteIdParams,
        querystring: ListInboundLinksQuery,
        response: { 200: LinkPage },
      },
    },
    (request) =>
      core.readBacklinks(
        requirePrincipal(request.principal),
        NoteId.parse(request.params.noteId),
        request.query,
      ),
  );
}
