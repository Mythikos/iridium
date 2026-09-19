/**
 * The four things every `/api/v1` handler needs before it can do its own work, in one module so the
 * answer is identical on every route (09-api-reference.md §1.4, §1.5; 02-system-architecture.md
 * ARCH-02).
 *
 *  - **`routeSpec`** — the `M1_ROUTES` row a registration is built from, so a route cannot be
 *    registered with a path, a policy or a schema the OpenAPI document does not describe.
 *  - **`requireConnected`** — the `503` a route answers while the pools are not up. ARCH-02 has boot
 *    proceed without a database, so a handler must say so rather than fail inside a query.
 *  - **`requirePrincipal` / `requireUserPrincipal`** — the narrowing the route policy has already
 *    justified. The policy refused an anonymous caller and a principal kind the route does not list
 *    before the handler ran; these turn that into a type without repeating the reasoning.
 *  - **`auditContext`** — the `context` object of every audit row (03-data-model.md §12.1), built
 *    from the request once so no surface invents a fifth field or forgets the request id.
 *
 * `apps/server/src/auth/routes.ts` declares its own copies of the middle three, written before this
 * module existed; the M1 report asks for that file to import them from here instead, so the two
 * cannot drift.
 */
import { routeByOperationId, type Principal, type RouteSpec } from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { AuditEventContext } from '../audit/chain.ts';
import { truncateUserAgent } from '../auth/user-agent.ts';
import type { Database } from '../db/index.ts';
import { ProblemError } from '../security/problem.ts';

/**
 * The response schema of a status that answers **no body** — a `204`, or a `304` from a validator.
 *
 * `z.undefined()` is the spelling, and it is load-bearing three times over. `reply.send()` with no
 * argument is what Fastify turns into an empty body, and it type-checks only against a schema whose
 * output is `undefined`. `fastify-type-provider-zod` converts that to `{type: 'null'}` for the
 * document, and `@fastify/swagger` emits **no** `content` for a response of that type — which is what
 * makes `toMatchOpenApi(op, 204)` compare an empty body against an empty declaration. And Fastify
 * never reaches a serializer for an `undefined` payload, so nothing tries to encode nothing.
 *
 * An empty `content: {}` map cannot be used instead: the document builder reads the first media type
 * of it unconditionally and throws. `z.null()` cannot either — it serialises to the four bytes
 * `null`, which a `304` would then carry as a body.
 */
export const EMPTY_RESPONSE: z.ZodType<undefined> = z
  .undefined()
  .meta({ description: 'No content; the status is the whole answer.' });

/** A principal a `/api/v1` handler can be reached by: a user or a token, never the system one. */
export type CallerPrincipal = Extract<Principal, { kind: 'user' } | { kind: 'token' }>;

/** Thrown at boot when a module registers an operation `M1_ROUTES` has no row for. */
export class RouteSpecMissingError extends Error {
  constructor(operationId: string) {
    super(
      `M1_ROUTES has no row for '${operationId}', which the rest plugin registers; add the row to ` +
        '@iridium/contracts/rest/routes.ts or remove the registration (09-api-reference.md §2.18)',
    );
    this.name = 'RouteSpecMissingError';
  }
}

/** The manifest row for one operation id. */
export function routeSpec(operationId: string): RouteSpec {
  const row = routeByOperationId(operationId);
  if (row === undefined) throw new RouteSpecMissingError(operationId);
  return row;
}

/** The app pool, or the `503` a route answers while the database is not connected (ARCH-02). */
export function requireConnected(db: Kysely<Database> | null): Kysely<Database> {
  if (db === null) {
    throw new ProblemError('unavailable', { detail: 'The database is not connected.' });
  }
  return db;
}

/** `app.database.dbApp`, or the `503` above. The form every handler in this tree calls. */
export function appDb(app: FastifyInstance): Kysely<Database> {
  return requireConnected(app.database.dbApp);
}

/**
 * The principal a handler reads on a non-public route. A `system` principal is never constructed
 * from a request (04-auth-and-access-control.md §5.1), so the two impossible cases are one refusal.
 */
export function requirePrincipal(principal: Principal | null): CallerPrincipal {
  if (principal === null || principal.kind === 'system') throw new ProblemError('unauthenticated');
  return principal;
}

/**
 * The caller as a user principal on a route whose policy admits users only; a token principal gets
 * the code the route policy uses for the same case (D04-10).
 */
export function requireUserPrincipal(
  principal: Principal | null,
): Extract<Principal, { kind: 'user' }> {
  const resolved = requirePrincipal(principal);
  if (resolved.kind !== 'user') throw new ProblemError('token_scope_insufficient');
  return resolved;
}

/** The `context` object of every audit row this surface writes (03-data-model.md §12.1). */
export function auditContext(request: FastifyRequest): AuditEventContext {
  return {
    ip: request.ip,
    user_agent: truncateUserAgent(request.headers['user-agent']),
    request_id: request.requestId,
    client: request.iridiumClient,
  };
}
