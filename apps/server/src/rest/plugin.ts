/**
 * Boot step 8, the `rest` plugin.
 *
 * At M0 it registers what exists: the static web surface at `/app/*` and the root redirect of
 * ARCH-07. The `/api/v1` route tree, `@fastify/swagger`, `@fastify/swagger-ui` at `/docs` and
 * `GET /openapi.json` arrive with M1 — registered through Iridium's own wrapper rather than the
 * plugin defaults, because the route-policy boot assertion requires *every* registered route to
 * carry `config.auth` (ARCH-27).
 *
 * Static serving is deliberately not `@fastify/static`'s own wildcard route. That route carries no
 * `config`, so the boot assertion would refuse to start; and the SPA entry document needs a
 * per-response CSP nonce substituted into it, which a plain file send cannot do. So the plugin is
 * registered with `serve: false` for `reply.sendFile` alone, and Iridium registers two routes of its
 * own that declare `config.auth = {public: true}` and choose their own `Cache-Control`:
 *
 *   `/app/assets/*` and every other hashed file  →  `public, max-age=31536000, immutable`
 *   the SPA entry document, including every fallback  →  `no-store`, nonce substituted
 *
 * `IRIDIUM_WEB_DIR` unset means the server serves no UI (API-only, 11-operations-and-deployment.md),
 * which is also the state at M0 before `apps/web` has been built: nothing is registered, `GET /`
 * answers the not-found handler's `ProblemDetails`, and no route promises a bundle that is not there.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { IridiumConfig } from '../config/env.ts';
import type { ServerLogger } from '../ops/logging.ts';
import {
  CSP_NONCE_PLACEHOLDER,
  ENTRY_DOCUMENT_CACHE_CONTROL,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  STATIC_METADATA_CACHE_CONTROL,
} from '../security/csp.ts';

/** What the rest plugin needs at M0. */
export interface RestPluginOptions {
  readonly config: IridiumConfig;
  readonly logger: ServerLogger;
}

/** The prefix the SPA is served under. */
export const APP_PREFIX = '/app';
/** The entry document, and the SPA fallback target. */
export const ENTRY_DOCUMENT = 'index.html';
/** Content-hashed assets live here and are safe to cache immutably. */
export const HASHED_ASSET_PREFIX = 'assets/';

const HTTP_FOUND = 302;

/** Thrown when the built bundle cannot carry a per-response nonce. */
export class MissingNoncePlaceholderError extends Error {
  readonly exitCode = 2;

  constructor(path: string) {
    super(
      `${path} does not contain ${CSP_NONCE_PLACEHOLDER}. The nonce is substituted into the entry ` +
        'document per response (D07-10), so a build that emits no placeholder would ship a page ' +
        'whose styles are blocked by its own Content-Security-Policy. Fix the Vite HTML transform ' +
        'rather than relaxing the policy.',
    );
    this.name = 'MissingNoncePlaceholderError';
  }
}

/** Rejects any path that escapes the served root, whatever separators or `..` it uses. */
function resolveWithin(root: string, requested: string): string | null {
  const normalized = normalize(requested).replace(/^([/\\]|\.\.[/\\]?)+/, '');
  if (normalized === '' || normalized === '.') return null;
  const full = join(root, normalized);
  return full === root || full.startsWith(root + sep) ? full : null;
}

function cacheControlFor(relativePath: string): string {
  if (relativePath.startsWith(HASHED_ASSET_PREFIX)) return IMMUTABLE_ASSET_CACHE_CONTROL;
  return STATIC_METADATA_CACHE_CONTROL;
}

/** Applies boot step 8. */
export async function applyRestPlugin(
  app: FastifyInstance,
  options: RestPluginOptions,
): Promise<void> {
  const { config, logger } = options;
  const root = config.web.dir;
  if (root === null) {
    logger.info(
      { webDir: null },
      'IRIDIUM_WEB_DIR is unset: this server is API-only and serves no web bundle',
    );
    return;
  }

  let entryTemplate: string;
  try {
    entryTemplate = await readFile(join(root, ENTRY_DOCUMENT), 'utf8');
  } catch {
    logger.warn(
      { webDir: root },
      `IRIDIUM_WEB_DIR is set but ${join(root, ENTRY_DOCUMENT)} does not exist; no web bundle is served`,
    );
    return;
  }
  if (!entryTemplate.includes(CSP_NONCE_PLACEHOLDER)) {
    throw new MissingNoncePlaceholderError(join(root, ENTRY_DOCUMENT));
  }
  // Split once at boot rather than replacing per request: the entry document is served on every SPA
  // navigation and a global regex replace per response is measurable at that rate.
  const entryPieces = entryTemplate.split(CSP_NONCE_PLACEHOLDER);

  await app.register(fastifyStatic, { root, serve: false, decorateReply: true });

  const sendEntryDocument = (reply: FastifyReply): FastifyReply =>
    reply
      .header('cache-control', ENTRY_DOCUMENT_CACHE_CONTROL)
      .type('text/html; charset=utf-8')
      .send(entryPieces.join(reply.cspNonce.style));

  app.get(
    `${APP_PREFIX}/*`,
    { config: { auth: { public: true } } },
    async (request: FastifyRequest<{ Params: { '*': string } }>, reply) => {
      const requested = request.params['*'];
      if (requested === '' || requested === ENTRY_DOCUMENT) return sendEntryDocument(reply);

      const resolved = resolveWithin(root, requested);
      if (resolved === null) return sendEntryDocument(reply);
      try {
        const stats = await stat(resolved);
        if (!stats.isFile()) return sendEntryDocument(reply);
      } catch {
        // The SPA fallback: an unknown path under /app/ is a client route, not a missing file.
        return sendEntryDocument(reply);
      }
      return reply.header('cache-control', cacheControlFor(requested)).sendFile(requested);
    },
  );

  app.get(APP_PREFIX, { config: { auth: { public: true } } }, async (_request, reply) =>
    reply.redirect(`${APP_PREFIX}/`, HTTP_FOUND),
  );

  // ARCH-07: the SPA is the only human entry point on the origin, and a 404 at the root is a
  // support ticket.
  app.get('/', { config: { auth: { public: true } } }, async (_request, reply) =>
    reply.redirect(`${APP_PREFIX}/`, HTTP_FOUND),
  );

  logger.info({ webDir: root }, `serving the web bundle at ${APP_PREFIX}/*`);
}
