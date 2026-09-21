/** Resolve operation-specific server paths for the pinned fuzzer's single origin override. */
const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serverPrefix(servers: unknown, origin: string): string {
  if (!Array.isArray(servers) || servers.length === 0) return '';
  const server: unknown = servers[0];
  if (!isObject(server) || typeof server['url'] !== 'string')
    throw new Error('The fuzz schema has an invalid OpenAPI server.');
  const variables = server['variables'];
  const url = server['url'].replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    const variable = isObject(variables) ? variables[name] : undefined;
    if (!isObject(variable) || typeof variable['default'] !== 'string')
      throw new Error(`The fuzz schema has no default for server variable ${name}.`);
    return variable['default'];
  });
  return new URL(url, origin).pathname.replace(/\/$/, '');
}

function decodePointerToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

function operationReference(path: string, method: string): string {
  const token = encodeURIComponent(path.replaceAll('~', '~0').replaceAll('/', '~1'));
  return `#/paths/${token}/${method}`;
}

function resolveOperationReference(
  reference: unknown,
  targets: ReadonlyMap<string, string>,
): string {
  if (typeof reference !== 'string') throw new Error('A fuzz operationRef must be a URI string.');
  if (reference !== '' && !reference.startsWith('#')) return reference;
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch (cause) {
    throw new Error(`Invalid URI fragment in fuzz operationRef: ${reference}.`, { cause });
  }
  const tokens = pointer.split('/');
  const [root, collection, path, method] = tokens;
  if (
    tokens.length !== 4 ||
    root !== '' ||
    collection !== 'paths' ||
    path === undefined ||
    method === undefined ||
    tokens.some((token) => /~(?:[^01]|$)/.test(token))
  ) {
    throw new Error(
      `Unsupported local fuzz operationRef: ${reference}. Target a resolved paths operation.`,
    );
  }
  const target = targets.get(
    operationReference(decodePointerToken(path), decodePointerToken(method)),
  );
  if (target === undefined)
    throw new Error(
      `Unresolved local fuzz operationRef: ${reference}. Target a resolved paths operation.`,
    );
  return target;
}

function rewriteOperationReferences(
  document: JsonObject,
  targets: ReadonlyMap<string, string>,
): void {
  function visitObjects(value: unknown, visit: (entry: JsonObject) => void): void {
    if (isObject(value)) {
      for (const entry of Object.values(value)) if (isObject(entry)) visit(entry);
    }
  }
  const visitedLinks = new WeakSet<JsonObject>();
  function visitLink(link: JsonObject): void {
    // Reusable objects can share identity in memory; do not remap a rewritten target twice.
    if (visitedLinks.has(link)) return;
    visitedLinks.add(link);
    if (!('$ref' in link) && 'operationRef' in link)
      link['operationRef'] = resolveOperationReference(link['operationRef'], targets);
  }
  function visitResponse(response: JsonObject): void {
    if (!('$ref' in response)) visitObjects(response['links'], visitLink);
  }
  function visitCallback(callback: JsonObject): void {
    if ('$ref' in callback) return;
    for (const [expression, item] of Object.entries(callback)) {
      if (!expression.startsWith('x-') && isObject(item)) visitPathItem(item);
    }
  }
  function visitPathItem(item: JsonObject): void {
    for (const method of METHODS) {
      const operation = item[method];
      if (!isObject(operation)) continue;
      const responses = operation['responses'];
      if (isObject(responses)) {
        for (const [status, response] of Object.entries(responses)) {
          if (!status.startsWith('x-') && isObject(response)) visitResponse(response);
        }
      }
      visitObjects(operation['callbacks'], visitCallback);
    }
  }
  // Follow OpenAPI containers only: examples, schemas and extension payloads can also contain
  // fields called operationRef, but they are data and must retain their original spelling.
  visitObjects(document['paths'], visitPathItem);
  visitObjects(document['webhooks'], visitPathItem);
  const components = document['components'];
  if (isObject(components)) {
    visitObjects(components['links'], visitLink);
    visitObjects(components['responses'], visitResponse);
    visitObjects(components['callbacks'], visitCallback);
    visitObjects(components['pathItems'], visitPathItem);
  }
}
/**
 * 4.26.1 applies --origin using the document's base path even for operation server overrides.
 * Resolve those paths into the disposable copy, retaining every operation, constraint and link.
 * The public document and generated client remain in their original OpenAPI spelling.
 */
export function prepareSchemathesisSchema(document: unknown, origin: string): JsonObject {
  if (!isObject(document) || !isObject(document['paths']))
    throw new Error('The fuzz fixture did not return an OpenAPI paths object.');
  const copy = structuredClone(document);
  const paths: JsonObject = {};
  const operationTargets = new Map<string, string>();
  for (const [path, item] of Object.entries(document['paths'])) {
    if (!isObject(item) || '$ref' in item)
      throw new Error(`The fuzz adapter requires a resolved path item: ${path}.`);
    const shared = Object.fromEntries(
      Object.entries(item).filter(([key]) => !METHODS.has(key) && key !== 'servers'),
    );
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method)) continue;
      if (!isObject(operation)) throw new Error(`Invalid fuzz operation: ${method} ${path}.`);
      const prefix = serverPrefix(
        operation['servers'] ?? item['servers'] ?? document['servers'],
        origin,
      );
      const fullPath = `${prefix}${path}`;
      const target = paths[fullPath];
      const entry = isObject(target) ? target : structuredClone(shared);
      if (method in entry) throw new Error(`Duplicate fuzz operation: ${method} ${fullPath}.`);
      const resolved = structuredClone(operation);
      delete resolved['servers'];
      entry[method] = resolved;
      paths[fullPath] = entry;
      operationTargets.set(operationReference(path, method), operationReference(fullPath, method));
    }
  }
  copy['paths'] = paths;
  copy['servers'] = [{ url: origin }];
  rewriteOperationReferences(copy, operationTargets);
  return copy;
}

/**
 * Every operation that accepts the signed keyset `cursor` (09-api-reference.md §1.6 and §4.7),
 * named as the prepared schema spells it. A cursor is a capability over the listing kind, the
 * after-key, the filter hash and the principal, so no generator can mint one the server accepts:
 * the `iridium-cursor` strategy produces the documented structure and the route answers the
 * documented `422 validation_failed` with `errors[0].code = 'cursor_invalid'`. That refusal is
 * admitted here, on these operations only, so a `422` anywhere else stays a failure.
 */
const CURSOR_OPERATIONS: readonly string[] = [
  'GET /api/v1/search',
  'GET /api/v1/vaults/{vaultId}/search',
  'GET /api/v1/vaults/{vaultId}/nodes',
  'GET /api/v1/vaults/{vaultId}/tree',
  'GET /api/v1/vaults/{vaultId}/trash',
  'GET /api/v1/vaults/{vaultId}/attachments',
  'GET /api/v1/nodes/{nodeId}/inbound-links',
  'GET /api/v1/notes/{noteId}/backlinks',
  'GET /api/v1/notes/{noteId}/revisions',
  'GET /api/v1/admin/users',
  'GET /api/v1/admin/jobs',
  'GET /api/v1/admin/attachments/unreferenced',
];

const CURSOR_OPERATION_CONFIG = CURSOR_OPERATIONS.map(
  (name) =>
    `\n[[operations]]\ninclude-name = "${name}"\n` +
    'checks.positive_data_acceptance.expected-statuses = ' +
    '["2xx", 401, 403, 404, 409, 422, 429, "5xx"]\n',
).join('');

/** Documented business refusals; every conformance, authentication and server-error check stays on. */
export const SCHEMATHESIS_CONFIG: string = `
# Rate limiting is a valid refusal, including for a schema-valid request (09 section 1.8).
[checks.positive_data_acceptance]
expected-statuses = ["2xx", 401, 403, 404, 409, 429, "5xx"]

# The limiter runs before schema validation; a 429 refuses malformed traffic as well.
[checks.negative_data_rejection]
expected-statuses = [400, 401, 403, 404, 405, 406, 409, 415, 422, 428, 429, "5xx"]

# Non-disclosure resolves an unknown/non-member resource before checking its version header.
# Existing authorized resources with a missing If-Match return the documented 428.
[checks.missing_required_header]
expected-statuses = [400, 401, 403, 404, 406, 415, 422, 428, 429]

# Attachment admission is decided by sniffing the bytes, which no JSON Schema can describe: a
# schema-valid multipart part may still carry a type outside the allow-list, and 12-milestones.md
# section 6.4 documents that answer as 415 unsupported_media.
[[operations]]
include-name = "POST /api/v1/vaults/{vaultId}/attachments"
checks.positive_data_acceptance.expected-statuses = ["2xx", 401, 403, 404, 409, 415, 429, "5xx"]

# A correctly encoded but never issued password-setup token is gone, not malformed.
[[operations]]
include-name = "POST /api/v1/auth/set-password"
checks.positive_data_acceptance.expected-statuses = ["2xx", 401, 403, 404, 409, 410, 429, "5xx"]
${CURSOR_OPERATION_CONFIG}`;

/** Text representations are JSON Schema strings and must participate in response validation. */
export const SCHEMATHESIS_RESPONSE_HOOK: string = String.raw`
import schemathesis

@schemathesis.deserializer("text/html", "text/markdown", "text/plain")
def iridium_text_response(context, response):
    return response.content.decode("utf-8", errors="strict")
`;
