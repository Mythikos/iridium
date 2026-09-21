/**
 * The two documentation operations of 09-api-reference.md §2.17 and §2.18 — `GET /openapi.json`
 * (`meta.openapi`) and `GET /docs` (`meta.docs`) — and the one piece of wiring they need.
 *
 * **Why a route-policy stamper exists.** `@fastify/swagger-ui` registers seven routes, not one: the
 * page, its static bundle, `/json`, `/yaml` and the redirects. None of them declares `config.auth`,
 * and the boot assertion refuses to start a server with a route that does not (A30) — which is
 * exactly the rule that must not be weakened for a convenience. The M0 header of `rest/plugin.ts`
 * anticipated this ("registered through Iridium's own wrapper rather than the plugin defaults").
 *
 * The wrapper is an `onRoute` hook, and it must run **before** the route policy's own collector,
 * because that collector snapshots `config.auth` at hook time and Fastify runs a scope's `onRoute`
 * hooks in registration order. So `applyDocsRoutePolicy` is called from `app.ts` immediately before
 * `applyRoutePolicyPlugin` — the same reasoning, and the same shape, as the CSRF guard being mounted
 * inside step 4's neighbourhood so that `authenticate()` precedes it.
 *
 * **The policy it stamps is a real one, decided by `authorize()`.** Every route beneath `/docs`
 * carries `{ serverAdmin: true, permission: 'server:settings' }`: the OpenAPI document describes this
 * deployment's surface, which is server configuration, and gating it on a server-scoped permission
 * keeps the decision inside the single authorization core rather than in a hook of its own
 * (invariant 2). `/docs` itself carries the `API_ROUTES` row's `{ serverAdmin: true }`, which is a
 * member of `ADMIN_FLAG_ONLY_ROUTES`.
 *
 * **Development opens both**, as §2.17 says: under `NODE_ENV=development` the two documentation
 * operations and the UI's assets accept any authenticated principal. The committed OpenAPI document
 * is exported under `NODE_ENV=production` (`scripts/export-openapi.ts`), so it records the
 * production policy and never the relaxed one.
 */
import fastifySwaggerUi from '@fastify/swagger-ui';
import { routeByOperationId, type RouteAuth } from '@iridium/contracts';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { API_PREFIX } from '../authz/route-policy.ts';
import type { IridiumConfig } from '../config/env.ts';

/**
 * What the `meta.docs` response body is, for the document: an HTML page.
 *
 * It is a zod schema because `fastify-type-provider-zod`'s serializer compiler is what builds every
 * response serializer on this instance. Fastify never runs it here — a string payload sent with a
 * non-JSON `Content-Type` bypasses serialization — so the schema's only job is to put `text/html`
 * into the OpenAPI document, which is what `toMatchOpenApi('meta.docs', 200)` reads.
 */
const DOCS_PAGE_SCHEMA = z.string().meta({ id: 'SwaggerUiPage' });

/** Where the Swagger UI is mounted, relative to the API root. */
export const DOCS_PATH = '/docs';

/** The absolute prefix every route the UI registers lives under. */
export const DOCS_PREFIX = `${API_PREFIX}${DOCS_PATH}`;

/**
 * The policy the UI's own routes carry: a server administrator with the server-settings permission.
 *
 * `/docs/json` serves the same document `GET /openapi.json` does, so the two cannot differ in who
 * may read them; the static bundle is behind the same gate because the page that loads it is, and a
 * second, looser policy on the assets would be a second policy to keep in step.
 */
export const DOCS_ASSET_AUTH: RouteAuth = Object.freeze({
  serverAdmin: true,
  permission: 'server:settings',
});

/** The relaxed policy of §2.17: any authenticated principal, under `NODE_ENV=development` only. */
export const DOCS_DEVELOPMENT_AUTH: RouteAuth = Object.freeze({
  session: true,
  principalKinds: Object.freeze(['user', 'token'] as const),
});

/** The policy a documentation route carries in this environment. */
export function documentationAuth(config: IridiumConfig, production: RouteAuth): RouteAuth {
  return config.env === 'development' ? DOCS_DEVELOPMENT_AUTH : production;
}

/** Whether a registered url belongs to the Swagger UI mount. */
function isDocsRoute(url: string): boolean {
  return url === DOCS_PREFIX || url.startsWith(`${DOCS_PREFIX}/`);
}

/**
 * Whether a registered url **is** the documented `meta.docs` operation.
 *
 * `@fastify/swagger-ui` registers its index as `/` under the prefix, which Fastify joins to
 * `<prefix>/`; `ignoreTrailingSlash` makes that the same route as `<prefix>`, and the boot assertion
 * and the route index both spell it without the slash.
 */
function isDocsIndex(url: string): boolean {
  return url === DOCS_PREFIX || url === `${DOCS_PREFIX}/`;
}

/**
 * Registers the `onRoute` hook that gives every Swagger UI route a policy and a documentation entry.
 *
 * Call it from `app.ts` immediately before `applyRoutePolicyPlugin(app)`. It is narrow by
 * construction: it touches only urls under `/api/v1/docs`, and only routes that declare no policy of
 * their own, so a route Iridium registers there itself keeps what it declared.
 */
export function applyDocsRoutePolicy(app: FastifyInstance, config: IridiumConfig): void {
  const row = routeByOperationId('meta.docs');

  app.addHook('onRoute', (routeOptions: RouteOptions) => {
    if (!isDocsRoute(routeOptions.url)) return;
    if (routeOptions.config?.auth !== undefined) return;

    if (isDocsIndex(routeOptions.url) && row !== undefined) {
      routeOptions.config = { ...routeOptions.config, auth: documentationAuth(config, row.auth) };
      routeOptions.schema = {
        operationId: row.operationId,
        tags: [row.tag],
        summary: row.summary,
        response: { 200: { content: { 'text/html': { schema: DOCS_PAGE_SCHEMA } } } },
      };
      return;
    }

    routeOptions.config = {
      ...routeOptions.config,
      auth: documentationAuth(config, DOCS_ASSET_AUTH),
    };
    // The bundle, the initialiser, `/json` and `/yaml` are the UI's own mechanism, not operations of
    // the Iridium API: §2.18's route index names `GET /docs` and nothing beneath it.
    routeOptions.schema = { ...routeOptions.schema, hide: true };
  });
}

/**
 * Registers the Swagger UI at `/api/v1/docs`.
 *
 * `"try it out"` is disabled outside development by giving the UI an empty submit-method list
 * (§2.17): a documentation page that can fire authenticated mutations against a production
 * deployment is a footgun sitting behind one administrator's session.
 *
 * `staticCSP` is left off deliberately — the security plugin owns the Content-Security-Policy header
 * for every response, and a second writer would mean two policies to keep in step. The page needs
 * nothing relaxed: every script it loads is a same-origin file under `script-src 'self'`, and its
 * stylesheet is same-origin too.
 */
export async function applyDocsUi(app: FastifyInstance, config: IridiumConfig): Promise<void> {
  const development = config.env === 'development';
  // Registered inside a scope that carries the zod compilers, because the index route's documented
  // `text/html` response is a zod schema and Fastify builds its serializer with whichever compiler
  // that route's scope holds. Without this the default JSON compiler would be handed a zod object
  // and the boot would fail with "schema is invalid" — one scope, one pair of compilers.
  await app.register(async (scope: FastifyInstance) => {
    scope.setValidatorCompiler(validatorCompiler);
    scope.setSerializerCompiler(serializerCompiler);
    await scope.register(fastifySwaggerUi, {
      routePrefix: DOCS_PREFIX,
      staticCSP: false,
      uiConfig: {
        deepLinking: true,
        // An empty list removes the "Try it out" control from every operation; the documented
        // relaxation is development only.
        ...(development ? {} : { supportedSubmitMethods: [] }),
      },
    });
  });
}
