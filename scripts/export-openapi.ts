/**
 * Step 1 of `pnpm gen`: export `packages/contracts/openapi/openapi.json` from the live server
 * (12-milestones.md §4.3, "Codegen pipeline"; 09-api-reference.md §6).
 *
 * The document comes from `app.swagger()` on a real Fastify instance built by the product's own
 * `buildApp({ mode: 'in-process' })` with `database: 'none'` — no container, no socket, no listen.
 * That is the whole reason `database: 'none'` exists (`apps/server/src/boot/db.ts`): the drift gate
 * runs in the `static` CI job, which has no Docker.
 *
 * **The environment is fixed here, not inherited.** `buildApp` takes the environment by parameter, so
 * the export passes a canonical one instead of `process.env`. A document whose bytes depended on the
 * exporting machine's `PUBLIC_ORIGIN` would make `gen.drift.guard` fail on a developer's machine and
 * pass in CI, which is worse than no gate. The server URL in the document is templated
 * (`{publicOrigin}/api/v1`), so the value below never reaches the artefact — it only satisfies
 * `EnvSchema`, which requires the key.
 *
 * **Undocumented routes are reported.** `@fastify/swagger` documents routes registered after it, and
 * from M1 the `rest` plugin registers it as its own first statement (`apps/server/src/ops/openapi.ts`),
 * so every route of the plugin tree reaches the document. What remains on the list is what a route
 * deliberately hid: the `/collab` upgrade, which is a WebSocket and not an operation, and the Swagger
 * UI's own bundle, which §2.17 lists as a static surface. The step prints the list rather than
 * emitting an artefact whose omissions nobody can see.
 *
 * The comparison is made in the **document's** spelling: `stripBasePath` removes `/api/v1` from every
 * documented path and renders `:param` as `{param}`, so a registered url is normalised the same way
 * before it is looked up.
 */
import { buildApp } from '../apps/server/src/app.ts';
import { applyOpenApiPlugin, hasOpenApi } from '../apps/server/src/index.ts';
import { isRecord, recordMember } from './lib/json.ts';
import { ARTEFACTS } from './lib/paths.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { writeJsonOrCompare } from './lib/write.ts';

/**
 * Thirty-two zero bytes, base64. `EnvSchema` requires 32 bytes of key material for each keyring, and
 * the export needs a value that parses and is unmistakably not a secret.
 *
 * The fixture markers `@iridium/testkit` uses (`…not-a-secret`) are deliberately unusable here:
 * `EnvSchema` refuses them when `NODE_ENV=production`, and the export runs as `production` so the
 * document records the production shape of every route policy rather than the relaxed development
 * one (ARCH-27 relaxes `/docs` and `/openapi.json` in development). Nothing in this process signs,
 * hashes or stores anything — no route is served and no pool is opened.
 */
const ZERO_KEY: string = Buffer.alloc(32).toString('base64');

/**
 * The canonical export environment. Every value is a documentation placeholder; none reaches the
 * artefact. `DATABASE_URL` is required by `EnvSchema` and never dialled, because `database: 'none'`
 * opens no pool.
 */
const EXPORT_ENV: Readonly<Record<string, string>> = {
  NODE_ENV: 'production',
  PUBLIC_ORIGIN: 'https://iridium.example',
  DATABASE_URL: 'mysql://iridium_app@127.0.0.1:3306/iridium',
  AUTH_PASSWORD_PEPPER: ZERO_KEY,
  AUDIT_HMAC_KEY: ZERO_KEY,
  MCP_CURSOR_KEY: ZERO_KEY,
  LOG_LEVEL: 'fatal',
  LOG_FORMAT: 'json',
};

/**
 * `app.swagger()` through the decorator `@fastify/swagger` adds.
 *
 * Fastify's own `FastifyInstance` type does not know about a plugin's decorators, and the plugin's
 * module augmentation is not in scope from a script, so the accessor is narrowed from `unknown` here
 * rather than asserted.
 */
function readOpenApiDocument(app: unknown): unknown {
  const swagger = isRecord(app) ? app['swagger'] : undefined;
  if (typeof swagger !== 'function') {
    throw new Error(
      '`app.swagger()` is not available: `@fastify/swagger` did not register. See ' +
        'apps/server/src/ops/openapi.ts.',
    );
  }
  return Reflect.apply(swagger, app, []);
}

/** One documented or registered operation, as `GET /path`. */
function methodPath(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/**
 * The path prefix `@fastify/swagger` strips from every documented url.
 *
 * The document's single server is `{publicOrigin}/api/v1`, and `stripBasePath` (the default) removes
 * that pathname from each route's url before writing it into `paths`. A comparison that did not do
 * the same would report every `/api/v1` route as undocumented.
 */
const DOCUMENT_BASE_PATH = '/api/v1';

/** A registered url in the document's spelling: the base path stripped, `:param` as `{param}`. */
function asDocumentPath(url: string): string {
  const stripped = url.startsWith(`${DOCUMENT_BASE_PATH}/`)
    ? url.slice(DOCUMENT_BASE_PATH.length)
    : url;
  return stripped.replaceAll(/:([^/]+)/g, '{$1}');
}

const DOCUMENTABLE_METHODS = new Set(['get', 'put', 'post', 'patch', 'delete', 'head', 'options']);

function documentedOperations(document: unknown): Set<string> {
  const operations = new Set<string>();
  const paths = recordMember(document, 'paths');
  if (paths === undefined) return operations;
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of Object.keys(item)) {
      if (DOCUMENTABLE_METHODS.has(method.toLowerCase())) operations.add(methodPath(method, path));
    }
  }
  return operations;
}

/** Every route the instance actually registered, the way the route-policy guard reads them. */
function registeredOperations(routes: Iterable<unknown>): Set<string> {
  const operations = new Set<string>();
  for (const entry of routes) {
    if (!isRecord(entry)) continue;
    const url = entry['url'] ?? entry['path'];
    if (typeof url !== 'string') continue;
    const declared = entry['method'];
    const methods = Array.isArray(declared) ? declared : [declared ?? 'GET'];
    for (const method of methods) {
      if (typeof method === 'string') operations.add(methodPath(method, url));
    }
  }
  return operations;
}

/** Build the app, ready it, and return the OpenAPI document plus the routes it does not cover. */
export async function exportOpenApiDocument(): Promise<{
  document: unknown;
  undocumented: readonly string[];
}> {
  const app = await buildApp({ mode: 'in-process', env: EXPORT_ENV, database: 'none' });
  try {
    if (!hasOpenApi(app)) await applyOpenApiPlugin(app);
    await app.ready();
    const document = readOpenApiDocument(app);
    const documented = documentedOperations(document);
    const undocumented = [...registeredOperations(app.routes())]
      .map((operation) => {
        const [method = '', url = ''] = operation.split(' ');
        return methodPath(method, asDocumentPath(url));
      })
      // A `HEAD` twin is synthesised from its `GET` and is never a documented operation of its own.
      .filter((operation) => !operation.startsWith('HEAD ') && !documented.has(operation))
      .toSorted((a, b) => a.localeCompare(b));
    return { document, undocumented };
  } finally {
    await app.close();
  }
}

export const step: Step = {
  name: 'openapi export',
  produces: 'packages/contracts/openapi/openapi.json',
  async run(context: StepContext): Promise<StepResult> {
    const { document, undocumented } = await exportOpenApiDocument();
    const outcome = writeJsonOrCompare(ARTEFACTS.openapi, document, context.check);
    const operationCount = documentedOperations(document).size;
    const details =
      undocumented.length === 0
        ? []
        : [
            `${String(undocumented.length)} registered route(s) are not in the document. Each ` +
              'declares `schema.hide` deliberately — the `/collab` upgrade is a WebSocket and not an ' +
              "operation, and the Swagger UI's own bundle is a static surface of " +
              '09-api-reference.md §2.17 rather than a route of the API:',
            ...undocumented.map((operation) => `  ${operation}`),
          ];
    return {
      summary: `${String(operationCount)} operation(s), ${String(outcome.bytes)} bytes`,
      writes: [outcome],
      details,
    };
  },
};

if (import.meta.main) await runAsMain(step);
