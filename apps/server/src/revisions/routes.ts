/** Revision reads delegate to ContentReadCore; mutations use the existing collaboration writer. */
import {
  CreateRevisionBody,
  LIMITS,
  ListRevisionsQuery,
  NoteId,
  NoteIdParams,
  NoteRevision,
  RestoredRevision,
  RestoreRevisionBody,
  RevisionContent,
  RevisionPage,
  RevisionParams,
} from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { WindowedBudget } from '../auth/tickets/ip-budget.ts';
import { requireUserRow } from '../auth/users.ts';
import type { ContentReadCore } from '../content/read/index.ts';
import {
  appDb,
  auditContext,
  EMPTY_RESPONSE,
  requirePrincipal,
  requireUserPrincipal,
  routeSpec,
} from '../rest/handler-context.ts';
import { ProblemError } from '../security/problem.ts';
import type { RevisionMutationInput, RevisionService } from './service.ts';

/** The composition root owns service construction and read-core authorization. */
export interface RevisionRouteDeps {
  readonly core: () => ContentReadCore;
  readonly service: () => RevisionService;
}

const MARKDOWN = 'text/markdown';
const REVISION_CACHE = 'private, max-age=86400, immutable';

/** Registers history routes under the established API mount. */
export function applyRevisionRoutes(app: FastifyInstance, deps: RevisionRouteDeps): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();
  const budget = new WindowedBudget({
    clock: app.clock,
    max: LIMITS.FLUSH_PER_MINUTE,
    windowMs: 60_000,
  });
  app.addHook('onClose', async () => {
    budget.close();
  });
  const mutationInput = async (
    request: FastifyRequest,
    noteId: string,
  ): Promise<RevisionMutationInput> => {
    const principal = requireUserPrincipal(request.principal);
    const vault = request.vault;
    if (vault === null) throw new ProblemError('not_found');
    const user = await requireUserRow(appDb(app), principal.userId);
    return {
      principal,
      actorDisplay: user.display_name,
      noteId: NoteId.parse(noteId),
      vaultId: vault.id,
      context: auditContext(request),
    };
  };

  const list = routeSpec('revisions.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        tags: [list.tag],
        summary: list.summary,
        params: NoteIdParams,
        querystring: ListRevisionsQuery,
        response: { 200: RevisionPage },
      },
    },
    async (request, reply) =>
      reply.send(
        await deps
          .core()
          .listRevisions(
            requirePrincipal(request.principal),
            NoteId.parse(request.params.noteId),
            request.query,
          ),
      ),
  );

  const get = routeSpec('revisions.get');
  api.get(
    get.path,
    {
      config: { auth: get.auth },
      schema: {
        operationId: get.operationId,
        tags: [get.tag],
        summary: get.summary,
        params: RevisionParams,
        response: {
          200: {
            content: {
              'application/json': { schema: RevisionContent },
              [MARKDOWN]: { schema: z.string() },
            },
          },
          304: EMPTY_RESPONSE,
        },
      },
    },
    async (request, reply) => {
      const revision = await deps
        .core()
        .readRevision(
          requirePrincipal(request.principal),
          NoteId.parse(request.params.noteId),
          request.params.revisionId,
        );
      const etag = `"${String(revision.id)}"`;
      reply.header('etag', etag).header('cache-control', REVISION_CACHE).header('vary', 'Accept');
      const validators = request.headers['if-none-match'];
      if (validators?.split(',').some((value) => [etag, `W/${etag}`, '*'].includes(value.trim())))
        return reply.code(304).send();
      if (
        request.headers.accept?.split(',').some((value) => value.trim().split(';')[0] === MARKDOWN)
      ) {
        return reply.type(`${MARKDOWN}; charset=utf-8`).send(revision.markdown);
      }
      return reply.send(revision);
    },
  );

  const create = routeSpec('revisions.create');
  api.post(
    create.path,
    {
      config: { auth: create.auth },
      schema: {
        operationId: create.operationId,
        tags: [create.tag],
        summary: create.summary,
        params: NoteIdParams,
        body: CreateRevisionBody,
        response: { 201: NoteRevision },
      },
    },
    async (request, reply) => {
      const input = await mutationInput(request, request.params.noteId);
      const allowed = budget.hit(`${request.principalKey ?? request.ip}|${input.noteId}`);
      if (!allowed.allowed)
        throw new ProblemError('rate_limited', { retryAfterMs: allowed.retryAfterMs });
      const revision = await deps.service().create(input, request.body.label);
      return reply
        .code(201)
        .header('location', `/api/v1/notes/${input.noteId}/revisions/${String(revision.id)}`)
        .send(revision);
    },
  );

  const restore = routeSpec('revisions.restore');
  api.post(
    restore.path,
    {
      config: { auth: restore.auth },
      schema: {
        operationId: restore.operationId,
        tags: [restore.tag],
        summary: restore.summary,
        params: RevisionParams,
        body: RestoreRevisionBody,
        response: { 200: RestoredRevision },
      },
    },
    async (request, reply) =>
      reply.send(
        await deps
          .service()
          .restore(await mutationInput(request, request.params.noteId), request.params.revisionId),
      ),
  );
}
