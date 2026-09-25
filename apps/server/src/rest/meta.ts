/**
 * `applyMetaRoutes(app)` — `GET /meta` and `GET /openapi.json` (09-api-reference.md §2.2 and §2.17).
 *
 * `GET /meta` is the one route exempt from `client_outdated`, so a client that is too old can always
 * discover *why* it was refused. It is public, it reads the committed compatibility floor, and its `limits` object is
 * built from `publishedLimits()` rather than from eight hand-written assignments — which is what
 * keeps `GET /meta.limits` and the single limits policy the same numbers (ARCH-16).
 *
 * It is also the one `/api/v1` response that is **cacheable**: §2.2 gives it 300 s, while the
 * security plugin's blanket rule marks everything under `/api/v1` `no-store`. The handler overrides
 * the header for this route alone, which keeps "no-store unless a route says otherwise" the default.
 *
 * `GET /openapi.json` serves the document `@fastify/swagger` built from the live route set — never a
 * file read from disk, so the served document and the committed one can only differ by a drift the
 * `pnpm gen` gate already fails on.
 */
import { API_VERSION, LIMITS, Meta, publishedLimits, type RouteSpec } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import { PASSWORD_MAX_CODE_POINTS } from '../auth/credentials/policy.ts';
import type { IridiumConfig } from '../config/env.ts';
import { BUILD_INFO } from '../ops/build-info.ts';
import { hasOpenApi } from '../ops/openapi.ts';
import { documentationAuth } from './docs.ts';
import { routeSpec as manifestRow } from './handler-context.ts';
import { featuresFor, minimumClientVersion } from './version.ts';

/** The operation ids this module registers, in registration order. */
export const META_OPERATION_IDS = ['meta.get', 'meta.openapi'] as const;

/** An operation id of this module. */
type MetaOperationId = (typeof META_OPERATION_IDS)[number];

/**
 * The manifest row for one of this module's operations: the shared lookup, narrowed to the ids
 * above, so a registration cannot name a row this module does not claim.
 */
function routeSpec(operationId: MetaOperationId): RouteSpec {
  return manifestRow(operationId);
}

const HTTP_OK = 200;

/** How long `GET /meta` may be cached (§2.2). Seconds; a cache directive, not a product limit. */
const META_CACHE_SECONDS = 300;

/**
 * The OpenAPI document's own body schema.
 *
 * `API_ROUTES` calls it `opaque-json`: the document is described by the OpenAPI meta-schema, and a
 * schema here that tried to describe it would be a circular reference. A permissive object is the
 * honest description, and it is what puts `application/json` into the document so
 * `toMatchOpenApi('meta.openapi', 200)` has a media type to check.
 */
const OPENAPI_DOCUMENT_SCHEMA = z.record(z.string(), z.unknown()).meta({ id: 'OpenApiDocument' });

/** Applies the metadata routes to an instance already mounted under `/api/v1`. */
export function applyMetaRoutes(app: FastifyInstance, config: IridiumConfig): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const api = app.withTypeProvider<ZodTypeProvider>();

  // ---- GET /meta ---------------------------------------------------------------------------------
  const meta = routeSpec('meta.get');
  api.get(
    meta.path,
    {
      config: { auth: meta.auth },
      schema: {
        operationId: meta.operationId,
        tags: [meta.tag],
        summary: meta.summary,
        response: { [HTTP_OK]: Meta },
      },
    },
    async (_request, reply) => {
      const features = featuresFor(config);
      const oauth = features.includes('oauth');
      return reply
        .code(HTTP_OK)
        .header('cache-control', `public, max-age=${String(META_CACHE_SECONDS)}`)
        .send({
          apiVersion: API_VERSION,
          minClientVersion: await minimumClientVersion(app.database),
          serverVersion: BUILD_INFO.version,
          features,
          publicOrigin: config.server.publicOrigin.origin,
          collab: { path: '/collab', ticketBatchMax: LIMITS.TICKET_BATCH_MAX },
          mcp: {
            path: '/mcp',
            enabled: features.includes('mcp'),
            ...(oauth ? { oauthMcpUrl: config.oauth.resource } : {}),
          },
          limits: publishedLimits(),
          policies: {
            passwordMinLength: config.auth.passwordMinLength,
            passwordMaxLength: PASSWORD_MAX_CODE_POINTS,
            patMaxLifetimeDays: config.tokens.patMaxLifetimeDays,
            patAllowNoExpiry: config.tokens.patAllowNoExpiry,
            patRotationOverlapMaxHours: config.tokens.patRotationOverlapMaxHours,
          },
        });
    },
  );

  // ---- GET /openapi.json -------------------------------------------------------------------------
  const openapi = routeSpec('meta.openapi');
  api.get(
    openapi.path,
    {
      config: { auth: documentationAuth(config, openapi.auth) },
      schema: {
        operationId: openapi.operationId,
        tags: [openapi.tag],
        summary: openapi.summary,
        response: {
          [HTTP_OK]: { content: { 'application/json': { schema: OPENAPI_DOCUMENT_SCHEMA } } },
        },
      },
    },
    async (_request, reply) => {
      // `@fastify/swagger` is registered as the first statement of the rest plugin, so by the time a
      // request arrives the decorator exists; the guard is what makes the impossible case a readable
      // failure rather than a `TypeError` in a handler.
      if (!hasOpenApi(app)) {
        throw new Error(
          'GET /openapi.json was reached without @fastify/swagger registered; applyRestPlugin ' +
            'registers it as its first statement (apps/server/src/ops/openapi.ts).',
        );
      }
      return reply.code(HTTP_OK).send(app.swagger());
    },
  );
}
