/**
 * The OpenAPI document's own conventions, in one place (09-api-reference.md §6, "Documentation
 * conventions inside the generated document"; ARCH-27).
 *
 * `packages/contracts/openapi/openapi.json` is produced by `app.swagger()` from a live Fastify
 * instance — never hand-written — and `pnpm gen` exports it in `in-process` mode with
 * `database: 'none'`, so the drift gate needs no container. This module holds the two halves that are
 * not routes:
 *
 *  - `openApiDocument()`: the document skeleton `@fastify/swagger` merges the route set into. Info,
 *    the templated server URL, the tag set of §6, and the two security schemes. It is a constant so
 *    that the `rest` plugin registering `@fastify/swagger` at M1 reuses it rather than restating the
 *    conventions in a second place — which is the failure mode §6 exists to prevent.
 *  - `applyOpenApiPlugin`: the registration itself, with `fastify-type-provider-zod`'s transforms
 *    wired, so every route's zod schemas become JSON Schema.
 *
 * **The server URL is templated on purpose.** Paths in §2 are relative to
 * `<PUBLIC_ORIGIN>/api/v1`, and `PUBLIC_ORIGIN` is per deployment. A committed document that baked
 * one deployment's origin in would either be wrong everywhere else or make the drift gate depend on
 * the exporting machine's environment. An OpenAPI 3.1 server variable states the relationship and
 * stays byte-identical on every machine.
 *
 * **Ordering note, recorded because the M1 work depends on it.** `@fastify/swagger` collects routes
 * through an `onRoute` hook, so it documents only routes registered after it. It therefore belongs at
 * the very top of `applyRestPlugin` (boot step 7): everything that registers a route — `rest`,
 * `collab`, `mcp`, `ops`, `jobs` — comes at or after step 7, while steps 3–6 register none. Until
 * that registration lands, `scripts/export-openapi.ts` registers this plugin itself after
 * `buildApp`, which produces a valid document whose `paths` is empty because the M0 route set was
 * registered before the hook existed. The export script reports exactly which registered routes are
 * undocumented, so the gap is a printed line rather than a silent omission.
 */
import fastifySwagger from '@fastify/swagger';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';

/** The OpenAPI version the document declares. `3.1` is what `openapi-typescript` 7 consumes. */
export const OPENAPI_VERSION = '3.1.0';

/** The `{publicOrigin}` server variable's default: a documentation placeholder, never a deployment. */
export const OPENAPI_SERVER_DEFAULT_ORIGIN = 'https://iridium.example';

/**
 * The tag set of 09-api-reference.md §6, one per domain, in the order that section lists them.
 *
 * Order is data: `@fastify/swagger` emits `tags` verbatim, so sorting or reordering here would show
 * up as a diff in the committed document for no behavioural reason.
 */
export const OPENAPI_TAGS: readonly { readonly name: string; readonly description: string }[] = [
  { name: 'auth', description: 'Sign-in, sign-out, set-password and re-authentication.' },
  { name: 'meta', description: 'Server metadata, the OpenAPI document and the documentation UI.' },
  { name: 'me', description: 'The calling user and their own sessions.' },
  { name: 'tokens', description: 'Integration tokens and their client snippets.' },
  { name: 'oauth', description: "Iridium's own OAuth 2.1 authorization server." },
  { name: 'vaults', description: 'Vault lifecycle and settings.' },
  { name: 'members', description: 'Vault membership and roles.' },
  { name: 'tree', description: 'The vault tree.' },
  { name: 'nodes', description: 'Categories and notes as tree nodes.' },
  { name: 'notes', description: 'Note metadata and Markdown.' },
  { name: 'revisions', description: 'Revision history and restore.' },
  { name: 'search', description: 'Full-text search within a vault and across vaults.' },
  { name: 'attachments', description: 'Attachment metadata and bytes.' },
  { name: 'imports', description: 'Import jobs.' },
  { name: 'exports', description: 'Export jobs and downloads.' },
  { name: 'admin', description: 'Server administration.' },
  { name: 'desktop', description: 'Desktop update policy and release feeds.' },
  { name: 'ops', description: 'Liveness, readiness and metrics.' },
];

/**
 * The document skeleton `@fastify/swagger` merges the route set into.
 *
 * A factory rather than a frozen constant: `@fastify/swagger` takes a mutable `Partial<Document>` and
 * merges the route set into it, so handing it a deeply `readonly` object would not type-check — and a
 * shared mutable constant would let one registration's merge leak into the next. Each call returns a
 * fresh object.
 *
 * The two security schemes are §6's: each operation lists what it accepts, a `★` operation lists both,
 * and each MCP mount lists exactly one credential kind (§4.9). Their discriminants carry `as const` so
 * they keep their literal types without freezing the rest of the document.
 */
export function openApiDocument() {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Iridium API',
      description:
        'The REST surface of an Iridium server. Every path below is relative to ' +
        '`<PUBLIC_ORIGIN>/api/v1`; the operations published outside that prefix carry their own ' +
        'absolute paths (09-api-reference.md §2.18). This document is generated from the running ' +
        "server's zod schemas by `pnpm gen` and committed; `gen.drift.guard` fails any change to a " +
        'schema that is not regenerated.',
      version: '1',
    },
    servers: [
      {
        url: '{publicOrigin}/api/v1',
        description: "An Iridium server's own origin.",
        variables: {
          publicOrigin: {
            default: OPENAPI_SERVER_DEFAULT_ORIGIN,
            description:
              "The deployment's `PUBLIC_ORIGIN`, `https://` in every deployment except the " +
              'documented development profile (09-api-reference.md §1.2).',
          },
        },
      },
    ],
    // A fresh, mutable copy per call: `@fastify/swagger` merges the route set into the object it is
    // given, and the exported constant is `readonly`.
    // eslint-disable-next-line oxc/no-map-spread -- eighteen two-field objects, once per boot.
    tags: OPENAPI_TAGS.map((tag) => ({ ...tag })),
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey' as const,
          in: 'cookie' as const,
          name: '__Host-iridium_session',
          description:
            'A web session. Issued with `Secure; HttpOnly; SameSite=Lax; Path=/`. Ignored entirely ' +
            'when an `Authorization` header is present (09-api-reference.md §1.2).',
        },
        bearer: {
          type: 'http' as const,
          scheme: 'bearer',
          bearerFormat: 'irid_ses|irid_pat|irid_oat',
          description:
            'A desktop session (`irid_ses_…`), an integration token (`irid_pat_…`) on `/api/v1` ' +
            'and `/mcp`, or an OAuth access token (`irid_oat_…`) on `/mcp/connect` only.',
        },
      },
    },
  };
}

/**
 * Registers `@fastify/swagger` with Iridium's conventions.
 *
 * Call it as the first statement of the plugin that registers routes, so the `onRoute` hook sees
 * every one of them. Registering it twice is a Fastify decorator conflict, so callers check
 * `hasOpenApi(app)` first.
 */
export async function applyOpenApiPlugin(app: FastifyInstance): Promise<void> {
  await app.register(fastifySwagger, {
    openapi: openApiDocument(),
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
}

/** Whether `@fastify/swagger` is already registered on this instance. */
export function hasOpenApi(app: FastifyInstance): boolean {
  return typeof (app as { swagger?: unknown }).swagger === 'function';
}
