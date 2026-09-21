/** Administrator job routes over the same scheduler used by timers and the CLI. */
import {
  Job,
  JobPage,
  JobParams,
  ListJobsQuery,
  RunJobBody,
  RunJobParams,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

import { requireUserRow } from '../auth/users.ts';
import { API_PREFIX } from '../authz/route-policy.ts';
import type { CursorCodec } from '../mcp/cursor.ts';
import { appDb, auditContext, requireUserPrincipal, routeSpec } from '../rest/handler-context.ts';
import { requestOwnerFence } from '../rest/ownership.ts';
import type { JobScheduler } from './scheduler.ts';

export interface JobRouteDeps {
  readonly jobs: () => JobScheduler;
  readonly cursors: () => Promise<CursorCodec>;
}
/** Register before the scheduler exists; the process service resolves when a request is admitted. */
export function applyJobRoutes(app: FastifyInstance, deps: JobRouteDeps): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  api.setValidatorCompiler(validatorCompiler);
  api.setSerializerCompiler(serializerCompiler);
  const list = routeSpec('admin.jobs.list');
  api.get(
    list.path,
    {
      config: { auth: list.auth },
      schema: {
        operationId: list.operationId,
        summary: list.summary,
        tags: [list.tag],
        querystring: ListJobsQuery,
        response: { 200: JobPage },
      },
    },
    async (request, reply) => {
      const page = await deps
        .jobs()
        .list(
          request.query,
          await deps.cursors(),
          request.principalKey ?? `ses:${requireUserPrincipal(request.principal).sessionId}`,
        );
      return reply.code(200).send(page);
    },
  );
  const get = routeSpec('admin.jobs.get');
  api.get(
    get.path,
    {
      config: { auth: get.auth },
      schema: {
        operationId: get.operationId,
        summary: get.summary,
        tags: [get.tag],
        params: JobParams,
        response: { 200: Job },
      },
    },
    async (request, reply) => reply.code(200).send(await deps.jobs().get(request.params.jobId)),
  );
  const run = routeSpec('admin.jobs.run');
  api.post(
    run.path,
    {
      config: { auth: run.auth },
      schema: {
        operationId: run.operationId,
        summary: run.summary,
        tags: [run.tag],
        params: RunJobParams,
        body: RunJobBody,
        response: { 202: Job },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const user = await requireUserRow(appDb(app), principal.userId);
      const job = await deps.jobs().enqueue(request.params.type, request.body.payload, {
        ownerFence: requestOwnerFence(request),
        actor: {
          userId: principal.userId,
          sessionId: principal.sessionId,
          displayName: user.display_name,
          context: auditContext(request),
        },
      });
      deps.jobs().wake();
      reply.code(202).header('location', `${API_PREFIX}/admin/jobs/${job.id}`);
      return job;
    },
  );
  const cancel = routeSpec('admin.jobs.cancel');
  api.post(
    cancel.path,
    {
      config: { auth: cancel.auth },
      schema: {
        operationId: cancel.operationId,
        summary: cancel.summary,
        tags: [cancel.tag],
        params: JobParams,
        response: { 200: Job },
      },
    },
    async (request, reply) => {
      const principal = requireUserPrincipal(request.principal);
      const user = await requireUserRow(appDb(app), principal.userId);
      return reply.code(200).send(
        await deps.jobs().cancel(request.params.jobId, requestOwnerFence(request), {
          userId: principal.userId,
          sessionId: principal.sessionId,
          displayName: user.display_name,
          context: auditContext(request),
        }),
      );
    },
  );
}
