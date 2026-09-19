/**
 * The D10-26 precondition every route-enumerating suite asserts before it exercises a member.
 *
 * Three artefacts claim to describe one route set, and the plan's reasoning (10-testing-and-quality.md
 * D10-26) is that two of them fail in different directions: the live instance is where an
 * *undocumented* route appears — the dangerous case, because a route the specification never mentions
 * is the one nobody remembers to guard — and the committed document is where a *documented but
 * unregistered* route appears. A suite that enumerated only one source would be satisfied by an
 * incomplete table, which is exactly the failure the decision exists to refuse.
 *
 * So the comparison lives here once and both `authz.rest-viewer.integration` and
 * `authz.vault-isolation.integration` call it as their first case, rather than each carrying its own
 * copy of the same reading.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { API_PREFIX } from '../../src/authz/route-policy.ts';
import { DOCS_PREFIX } from '../../src/rest/docs.ts';

const DOCUMENT_PATH = fileURLToPath(
  new URL('../../../../packages/contracts/openapi/openapi.json', import.meta.url),
);

/** The methods an OpenAPI path item may carry as an operation. */
const DOCUMENTED_METHODS: ReadonlySet<string> = new Set([
  'get',
  'put',
  'post',
  'patch',
  'delete',
  'options',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One route in the spelling both sources are compared in: `METHOD /path`, `/api/v1`-prefixed, with
 * every parameter written the document's way (`{vaultId}` rather than `:vaultId`).
 */
function key(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** A Fastify url as the document spells it: `:param` becomes `{param}`. */
function asDocumentPath(url: string): string {
  return url.replaceAll(/:([^/]+)/g, '{$1}');
}

/**
 * Every `/api/v1` operation the committed document documents, `/api/v1`-prefixed.
 *
 * An operation that carries its own `servers` is one 09-api-reference.md §2.18 publishes at the
 * origin root (`/healthz`, `/readyz`, `/metrics`); it is documented, but it is not part of the API
 * surface these suites enumerate, so it is left out of both sides rather than of one.
 */
export function documentedApiRoutes(): readonly string[] {
  const parsed: unknown = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8'));
  const paths = isRecord(parsed) ? parsed['paths'] : undefined;
  if (!isRecord(paths)) return [];
  const keys: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!DOCUMENTED_METHODS.has(method)) continue;
      if (isRecord(operation) && operation['servers'] !== undefined) continue;
      keys.push(key(method, `${API_PREFIX}${path}`));
    }
  }
  return keys.toSorted((left, right) => left.localeCompare(right));
}

/**
 * The Swagger UI registers its index as `/` under the mount, which Fastify joins to `<prefix>/`;
 * `ignoreTrailingSlash` makes that the same route as `<prefix>`, and both the document and the route
 * index spell it without the slash.
 */
function withoutTrailingSlash(url: string): string {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Every `/api/v1` route the live instance serves, in the document's spelling.
 *
 * `HEAD` is excluded because Fastify synthesises a twin for every `GET`; the document names the `GET`
 * alone, so counting the twin would make the two sources disagree about a route neither is missing.
 * The Swagger UI's asset bundle is excluded for the reason it carries `schema.hide` in the first
 * place: 09-api-reference.md §2.17 lists it as a static surface rather than an operation. Its index
 * is **not** excluded — that one is `meta.docs`, a documented operation like any other.
 */
export function servedApiRoutes(app: FastifyInstance): readonly string[] {
  const seen = new Set<string>();
  for (const route of app.routes()) {
    if (route.method === 'HEAD') continue;
    const url = withoutTrailingSlash(route.url);
    if (!url.startsWith(`${API_PREFIX}/`)) continue;
    if (url.startsWith(`${DOCS_PREFIX}/`)) continue;
    seen.add(key(route.method, asDocumentPath(url)));
  }
  return [...seen].toSorted((left, right) => left.localeCompare(right));
}
