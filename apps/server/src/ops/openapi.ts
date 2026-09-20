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
import {
  ERROR_CODE_STATUS,
  ERROR_CODE_TITLE,
  GLOBAL_ERROR_CODES,
  IfMatchHeaders,
  routeByOperationId,
  type ErrorCode,
  type ResponseEtag,
  type RouteSpec,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { API_PREFIX } from '../authz/route-policy.ts';

/** The OpenAPI version the document declares. `3.1` is what `openapi-typescript` 7 consumes. */
export const OPENAPI_VERSION = '3.1.0';

/** The `{publicOrigin}` server variable's default: a documentation placeholder, never a deployment. */
export const OPENAPI_SERVER_DEFAULT_ORIGIN = 'https://iridium.example';

/**
 * A fresh `{publicOrigin}` variable declaration.
 *
 * Both server entries — the document's `/api/v1` base and the origin-root override below — declare
 * the same variable, and `@fastify/swagger` merges the object it is handed, so each call returns its
 * own copy rather than sharing one that a later merge could mutate.
 */
function publicOriginVariable(): { default: string; description: string } {
  return {
    default: OPENAPI_SERVER_DEFAULT_ORIGIN,
    description:
      "The deployment's `PUBLIC_ORIGIN`, `https://` in every deployment except the documented " +
      'development profile (09-api-reference.md §1.2).',
  };
}

/**
 * The server list an operation published outside `/api/v1` carries instead of the document's.
 *
 * The document declares one server, `{publicOrigin}/api/v1`, which is the right base for every
 * operation of the API and the wrong one for the three that 09-api-reference.md §2.18 publishes at
 * the origin root: resolved against it, the documented `/healthz` reads as `/api/v1/healthz`, which
 * no server serves. OpenAPI 3.1 lets an operation override the server list, so each of those names
 * the origin itself and the document stops describing a URL that does not exist.
 */
function originServers(): readonly {
  url: string;
  description: string;
  variables: Record<string, { default: string; description: string }>;
}[] {
  return [
    {
      url: '{publicOrigin}',
      description: "An Iridium server's own origin, with no API prefix.",
      variables: { publicOrigin: publicOriginVariable() },
    },
  ];
}

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
      // Source-available, not open source: internal and personal use are free, offering Iridium to
      // third parties as a hosted or managed service is not (D01-15). OpenAPI 3.1 takes the SPDX
      // identifier directly, so no URL is published beside it.
      license: { name: 'Elastic License 2.0', identifier: 'Elastic-2.0' },
    },
    servers: [
      {
        url: `{publicOrigin}${API_PREFIX}`,
        description: "An Iridium server's own origin.",
        variables: { publicOrigin: publicOriginVariable() },
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

/** The three schema containers whose members become OpenAPI `parameters` rather than a body. */
const PARAMETER_CONTAINERS = ['params', 'querystring', 'headers'] as const;

/** Identity keywords zod stamps on a generated root schema; they are noise inside a parameter. */
const IDENTITY_KEYWORDS: ReadonlySet<string> = new Set(['id', '$id', '$schema']);

/**
 * One parameter container as an **inline** JSON Schema.
 *
 * `fastify-type-provider-zod` emits `{$ref: '#/components/schemas/<id>'}` for any schema carrying a
 * component id, and every DTO in `@iridium/contracts` carries one. For a request body or a response
 * that is correct and resolves. For `params`, `querystring` and `headers` it is not: `@fastify/swagger`
 * expands those containers into an OpenAPI `parameters` array *while it is still building the paths*,
 * and the component map it would resolve the reference against is written by `transformObject`
 * afterwards — so the lookup returns `undefined` and the export dies with
 * `Cannot read properties of undefined (reading 'type')`.
 *
 * Converting the container on its own, with no registry to reference into, produces the object the
 * expansion needs. A parameter set is three or four members, so inlining costs nothing in the
 * document, and nothing about validation changes: Fastify compiled the route's validators from the
 * original schemas long before a document is asked for.
 */
function inlineParameterSchema(schema: z.ZodType): Record<string, unknown> {
  const converted: Record<string, unknown> = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  // A schema that carries an id converts to `{$ref: '#/$defs/<id>', $defs: {…}}` — zod references
  // its own definition block. `$defs` is not part of the OpenAPI parameter object, so the block is
  // resolved away here rather than emitted into a document nothing would resolve it against.
  const defs = asRecord(converted['$defs']) ?? {};
  const resolved = asRecord(inlineDefs(converted, defs, 0)) ?? converted;
  const inlined: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(resolved)) {
    if (!IDENTITY_KEYWORDS.has(keyword)) inlined[keyword] = value;
  }
  return inlined;
}

/** A plain object, or `null` for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null;
}

/** The `$defs` prefix zod emits for a self-reference. */
const DEFS_PREFIX = '#/$defs/';

/** How deep the definition inlining walks; a parameter object is two or three levels at most. */
const DEF_INLINE_DEPTH_CEILING = 32;

/**
 * Replaces every `#/$defs/<id>` reference with the definition it names and drops the block.
 *
 * The ceiling is what keeps a schema that references itself — none of the parameter containers does,
 * but nothing here can promise that about a schema added later — from spinning the recursion.
 */
function inlineDefs(
  value: unknown,
  defs: Readonly<Record<string, unknown>>,
  depth: number,
): unknown {
  if (depth > DEF_INLINE_DEPTH_CEILING) return value;
  if (Array.isArray(value))
    return value.map((entry: unknown) => inlineDefs(entry, defs, depth + 1));
  const record = asRecord(value);
  if (record === null) return value;

  const reference = record['$ref'];
  if (typeof reference === 'string' && reference.startsWith(DEFS_PREFIX)) {
    const target = defs[reference.slice(DEFS_PREFIX.length)];
    return target === undefined ? record : inlineDefs(target, defs, depth + 1);
  }

  const result: Record<string, unknown> = {};
  for (const [keyword, child] of Object.entries(record)) {
    if (keyword === '$defs') continue;
    result[keyword] = inlineDefs(child, defs, depth + 1);
  }
  return result;
}

/** The zod schema a route declared for one parameter container, when it declared one. */
function parameterSchema(schema: unknown, container: string): z.ZodType | null {
  if (typeof schema !== 'object' || schema === null || !Object.hasOwn(schema, container)) {
    return null;
  }
  const value: unknown = Reflect.get(schema, container);
  return value instanceof z.ZodType ? value : null;
}

/**
 * What a route accepts, as an OpenAPI `security` requirement list.
 *
 * §6 says each operation lists what it accepts. Every authenticated Iridium surface accepts both of
 * the document's two schemes — a `__Host-` session cookie from the browser, or a `Bearer` credential
 * from the desktop host, an integration token or an OAuth access token — so an authenticated
 * operation lists both and a `public` one lists none. The list is derived from `config.auth` here
 * rather than written per route, because it is a *restatement* of the policy and a second hand-written
 * copy is how the document would come to claim something the route policy does not enforce.
 */
function securityFor(auth: unknown): readonly Readonly<Record<string, readonly string[]>>[] {
  if (auth === undefined || auth === 'test-only') return [];
  if (typeof auth === 'object' && auth !== null && Object.hasOwn(auth, 'public')) return [];
  return [{ sessionCookie: [] }, { bearer: [] }];
}

/** The `config.auth` value a route declared, read from the route object the transform receives. */
function declaredAuth(route: unknown): unknown {
  const config: unknown =
    typeof route === 'object' && route !== null && Object.hasOwn(route, 'config')
      ? Reflect.get(route, 'config')
      : undefined;
  return typeof config === 'object' && config !== null && Object.hasOwn(config, 'auth')
    ? Reflect.get(config, 'auth')
    : undefined;
}

/** How each validator form of 09-api-reference.md §1.2 reads, for the header's description. */
const ETAG_DESCRIPTIONS: Readonly<Record<ResponseEtag, string>> = {
  'strong-version':
    'The row version, as `"<version>"`. This is the value `If-Match` compares against.',
  'strong-revision-hash':
    'The revision and the whole note’s content hash, as `"<revision>:<contentHash>"`.',
  'weak-version-revision':
    'A weak validator, `W/"<version>:<revision>"`, for cache validation only — never an `If-Match` value.',
};

/**
 * The `ETag` header declarations one operation's responses carry.
 *
 * The validator forms are `M1_ROUTES`' (`etag` on each response row), and reading them from there is
 * what keeps the document and the route policy from disagreeing about which reads are versioned. The
 * declaration cannot live in the route's own Fastify schema: `fastify-type-provider-zod`'s transform
 * emits `description` and `content` for a response and drops everything else, so a `headers` sibling
 * written there would never reach the document.
 */
function withEtagHeaders(schema: Record<string, unknown>): Record<string, unknown> {
  const operationId = schema['operationId'];
  if (typeof operationId !== 'string') return schema;
  const row = routeByOperationId(operationId);
  if (row === undefined) return schema;
  const responses =
    typeof schema['response'] === 'object' && schema['response'] !== null
      ? { ...schema['response'] }
      : {};

  let changed = false;
  for (const response of row.responses) {
    const etag = response.etag;
    if (etag === undefined) continue;
    const key = String(response.status);
    const declared: unknown = Reflect.get(responses, key);
    if (typeof declared !== 'object' || declared === null) continue;
    Reflect.set(responses, key, {
      ...declared,
      // `@fastify/swagger` reads a header declaration as a JSON Schema and wraps it in `schema`
      // itself, lifting `description` out; a `schema` written here would be nested twice.
      headers: { ETag: { type: 'string', description: ETAG_DESCRIPTIONS[etag] } },
    });
    changed = true;
  }
  return changed ? { ...schema, response: responses } : schema;
}

/** The media type every refusal is served as (09-api-reference.md §1.4). */
const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** The component the `ProblemDetails` envelope is named by; `transformObject` writes it. */
const PROBLEM_SCHEMA_REF = '#/components/schemas/ProblemDetails';

/** Every `ProblemDetails` code one route can answer: its own, plus the global ones inside `/api/v1`. */
function globalCodesOf(row: RouteSpec): readonly ErrorCode[] {
  return row.mount === '/api/v1' ? GLOBAL_ERROR_CODES : [];
}

/**
 * The refusal responses one operation documents.
 *
 * §6 requires every operation to document every `ProblemDetails` code it can produce, and `M1_ROUTES`
 * is where those codes are already written down — so they are read from there rather than restated in
 * thirty route schemas. They cannot be a Fastify `schema.response` entry either: Fastify would then
 * build a serializer for each status and the handler's `sendProblem` would be serialized twice.
 *
 * Several codes share a status (`forbidden`, `step_up_required` and `csrf_rejected` are all `403`), so
 * one response is emitted per status and its description names the codes that reach it — which is the
 * question a reader actually has in front of a `403`.
 *
 * **The five `GLOBAL_ERROR_CODES` are the operation's `default`, not five concrete statuses.** They
 * are what *any* `/api/v1` route can answer for a reason that has nothing to do with the route — a
 * rejected `Host`, an outdated client, a server that is not ready, a body over the limit, an
 * unhandled fault — which is exactly what OpenAPI's `default` response means. Writing them out as
 * `413`/`421`/`426`/`500`/`503` on all thirty operations claims instead that each route has thirty
 * separate documented refusals, and D10-10's coverage gate then asks for a test per operation per
 * code for behaviour that is one hook's, asserted once. A row's *own* `errors` stay concrete: those
 * are claims about the route, and a test has to produce each of them.
 */
function withErrorResponses(schema: Record<string, unknown>): Record<string, unknown> {
  const operationId = schema['operationId'];
  if (typeof operationId !== 'string') return schema;
  const row = routeByOperationId(operationId);
  if (row === undefined) return schema;

  const declared =
    typeof schema['response'] === 'object' && schema['response'] !== null
      ? { ...schema['response'] }
      : null;
  // A route that declared no response at all would otherwise lose the `200 Default Response`
  // `@fastify/swagger` emits for it: the moment this function writes a `response` object, that
  // default stops applying. The row's own success statuses are what it would have said.
  const responses: Record<string, unknown> = declared ?? {};
  if (declared === null) {
    for (const response of row.responses) {
      const body = response.body;
      if (body.kind === 'empty') {
        responses[String(response.status)] = { description: 'No response body', type: 'null' };
      } else if (body.kind === 'json') {
        const id = z.globalRegistry.get(body.schema)?.id;
        if (id === undefined)
          throw new Error(`Operation ${operationId} requires a named response schema.`);
        responses[String(response.status)] = {
          description: 'Response',
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${id}` } } },
        };
      } else {
        const mediaType =
          body.kind === 'text'
            ? body.contentType
            : body.kind === 'markdown'
              ? 'text/markdown'
              : 'application/json';
        responses[String(response.status)] = {
          description: 'Response',
          content: {
            [mediaType]: { schema: { type: body.kind === 'opaque-json' ? 'object' : 'string' } },
          },
        };
      }
    }
  }
  const byStatus = new Map<string, ErrorCode[]>();
  for (const code of row.errors) {
    const status = String(ERROR_CODE_STATUS[code]);
    if (Object.hasOwn(responses, status)) continue;
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const globals = globalCodesOf(row);
  const writesDefault = globals.length > 0 && !Object.hasOwn(responses, 'default');
  if (byStatus.size === 0 && !writesDefault && declared !== null) return schema;

  for (const [status, codes] of byStatus) {
    responses[status] = problemResponse(codes, false);
  }
  if (writesDefault) responses['default'] = problemResponse(globals, true);
  return { ...schema, response: responses };
}

/**
 * One `ProblemDetails` response whose description names every code that reaches it.
 *
 * `withStatus` is true only for the `default` response, whose codes do not share one status; on a
 * response keyed by its status, repeating that status in the prose says nothing a reader cannot see.
 */
function problemResponse(
  codes: readonly ErrorCode[],
  withStatus: boolean,
): Record<string, unknown> {
  return {
    description: codes
      .map((code) => {
        const status = withStatus ? ` (${String(ERROR_CODE_STATUS[code])})` : '';
        return `\`${code}\`${status} — ${ERROR_CODE_TITLE[code]}`;
      })
      .join('; '),
    content: { [PROBLEM_MEDIA_TYPE]: { schema: { $ref: PROBLEM_SCHEMA_REF } } },
  };
}

/**
 * The `If-Match` header parameter a route marked in the manifest documents.
 *
 * The header cannot be declared as a route *schema*: `IfMatchHeaders` makes it required, so a request
 * without one would be refused `422 validation_failed` by the validator, while 09-api-reference.md
 * §1.7 says the answer is `428 precondition_required` — a different code, answered by the handler
 * after it has read the row. So the parameter is added to the document from the manifest's `ifMatch`
 * member, where the requirement is already stated, and the served behaviour is left alone.
 */
function withIfMatchParameter(schema: Record<string, unknown>): Record<string, unknown> {
  const operationId = schema['operationId'];
  if (typeof operationId !== 'string') return schema;
  const row = routeByOperationId(operationId);
  if (row?.ifMatch === undefined) return schema;

  const declared =
    typeof schema['headers'] === 'object' && schema['headers'] !== null
      ? { ...schema['headers'] }
      : { type: 'object' };
  const inherited: unknown = Reflect.get(declared, 'properties');
  const properties: Record<string, unknown> =
    typeof inherited === 'object' && inherited !== null ? { ...inherited } : {};
  if (Object.hasOwn(properties, 'if-match')) return schema;
  const headerSchema = inlineParameterSchema(IfMatchHeaders);
  const matchSchema = asRecord(headerSchema['properties'])?.['if-match'];
  properties['if-match'] = {
    ...asRecord(matchSchema),
    description:
      row.ifMatch === 'required'
        ? 'The `"<version>"` this write is conditional on. Absent, weak, `*` or malformed is `428 precondition_required`.'
        : 'The `"<version>"` this write is conditional on, required only when the row already exists.',
  };
  const required = Array.isArray(Reflect.get(declared, 'required'))
    ? [...Reflect.get(declared, 'required')]
    : [];
  return {
    ...schema,
    headers: {
      ...declared,
      type: 'object',
      properties,
      required: row.ifMatch === 'required' ? [...required, 'if-match'] : required,
    },
  };
}

/**
 * Zod's complete UUIDv7 pattern already implies the generic UUID format. Keeping both makes
 * schema generators choose arbitrary UUID versions and then discard almost every sample. Remove
 * only that redundant annotation; the exact Zod pattern and runtime validator remain unchanged.
 */
function removeRedundantUuidFormats<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (
    Reflect.get(value, 'type') === 'string' &&
    Reflect.get(value, 'format') === 'uuid' &&
    Reflect.get(value, 'pattern') === z.regexes.uuid7.source
  ) {
    Reflect.deleteProperty(value, 'format');
  }
  for (const child of Object.values(value)) removeRedundantUuidFormats(child);
  return value;
}

/** Keep registry schemas only when the served route surface can reach them. */
function pruneUnusedSchemas<T>(document: T): T {
  if (typeof document !== 'object' || document === null) return document;
  const components: unknown = Reflect.get(document, 'components');
  if (typeof components !== 'object' || components === null) return document;
  const schemas: unknown = Reflect.get(components, 'schemas');
  if (typeof schemas !== 'object' || schemas === null) return document;
  const reachable = new Set<string>();
  const pending: string[] = [];
  const scan = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (Array.isArray(value)) {
      for (const child of value) scan(child);
      return;
    }
    const reference: unknown = Reflect.get(value, '$ref');
    if (typeof reference === 'string' && reference.startsWith('#/components/schemas/')) {
      const name = reference.split('/')[3]?.replaceAll('~1', '/').replaceAll('~0', '~');
      if (name !== undefined && !reachable.has(name)) {
        reachable.add(name);
        pending.push(name);
      }
    }
    for (const child of Object.values(value)) scan(child);
  };
  scan({ ...document, components: { ...components, schemas: undefined } });
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index];
    if (name !== undefined) scan(Reflect.get(schemas, name));
  }
  for (const name of Object.keys(schemas)) {
    if (!reachable.has(name)) Reflect.deleteProperty(schemas, name);
  }
  return document;
}

/**
 * Add links after the Zod and Swagger transforms, which otherwise discard response metadata.
 * The manifest names only shipped operations; a stale target or source status must fail export.
 */
function withResponseLinks<T>(document: T): T {
  const paths = asRecord(asRecord(document)?.['paths']);
  if (paths === null) return document;
  const operations = new Map<string, Record<string, unknown>>();
  for (const [path, item] of Object.entries(paths)) {
    const pathItem = asRecord(item);
    if (pathItem === null) continue;
    for (const [method, value] of Object.entries(pathItem)) {
      const operation = asRecord(value);
      const operationId = operation?.['operationId'];
      if (operation !== null && typeof operationId === 'string') {
        operations.set(operationId, operation);
        pathItem[method] = operation;
      }
    }
    paths[path] = pathItem;
  }
  for (const [operationId, operation] of operations) {
    const row = routeByOperationId(operationId);
    for (const response of row?.responses ?? []) {
      if (response.links === undefined) continue;
      const responses = asRecord(operation['responses']);
      const declared = asRecord(responses?.[String(response.status)]);
      if (responses === null || declared === null)
        throw new Error(
          `OpenAPI links require ${operationId} response ${String(response.status)}.`,
        );
      const links = { ...asRecord(declared['links']) };
      for (const [name, link] of Object.entries(response.links)) {
        if (!operations.has(link.operationId))
          throw new Error(
            `OpenAPI link ${operationId}.${name} targets missing ${link.operationId}.`,
          );
        if (Object.hasOwn(links, name))
          throw new Error(`OpenAPI link ${operationId}.${name} is declared twice.`);
        links[name] = structuredClone(link);
      }
      responses[String(response.status)] = { ...declared, links };
      operation['responses'] = responses;
    }
  }
  return { ...document, paths };
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
    transform: (document) => {
      const transformed = jsonSchemaTransform(document);
      const schema: Record<string, unknown> = { ...transformed.schema };
      for (const container of PARAMETER_CONTAINERS) {
        const declared = parameterSchema(document.schema, container);
        if (declared !== null) schema[container] = inlineParameterSchema(declared);
      }
      schema['security'] ??= securityFor(declaredAuth(document.route));
      // An operation outside the `/api/v1` mount resolves against the origin, not the API base.
      if (!document.url.startsWith(`${API_PREFIX}/`)) schema['servers'] = originServers();
      return {
        ...transformed,
        schema: withErrorResponses(withIfMatchParameter(withEtagHeaders(schema))),
      };
    },
    transformObject: (document) =>
      withResponseLinks(
        removeRedundantUuidFormats(pruneUnusedSchemas(jsonSchemaTransformObject(document))),
      ),
  });
}

/** Whether `@fastify/swagger` is already registered on this instance. */
export function hasOpenApi(app: FastifyInstance): boolean {
  return typeof (app as { swagger?: unknown }).swagger === 'function';
}
