/**
 * `openapi.contract` — the document-level half of the OpenAPI contract (10-testing-and-quality.md,
 * "REST — OpenAPI contract"; scheduled over the M1 route set by 12-milestones.md §5.4).
 *
 * `toMatchOpenApi(operationId, status)` holds each *response* to the document. This file holds the
 * **document** to the conventions of 09-api-reference.md §6, over the committed artefact rather than
 * over a freshly exported one: the artefact is what the clients' types, the msw handlers and the
 * Redocly lane are generated from, and a check that re-exported first could pass on a document
 * nothing else ever sees. `gen.drift.guard` is what keeps the artefact equal to the live route set.
 *
 * Each case is one sentence of §6:
 *
 *  - every operation is named, and named `<domain>.<verb>`;
 *  - every operation documents a success status and the `ProblemDetails` codes its row declares;
 *  - every request and response object refuses unknown members, because a client that sends one
 *    should learn so from the server rather than from a silently dropped field;
 *  - every versioned read declares its `ETag` and every `If-Match` route its header;
 *  - the two security schemes are used, and a `public` operation says it needs neither.
 *
 * Two operations are deliberately exempt from the `additionalProperties` rule and are named here
 * rather than filtered by shape: `meta.openapi` serves the OpenAPI document itself, which is
 * described by its own meta-schema, and `ops.metrics` serves the Prometheus exposition format.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ERROR_CODES, API_ROUTES, routeKey, type RouteSpec } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

const DOCUMENT_PATH = fileURLToPath(
  new URL('../../../../packages/contracts/openapi/openapi.json', import.meta.url),
);

/** The methods an OpenAPI path item can carry. `head` is synthesised and never documented alone. */
const METHODS: readonly string[] = ['get', 'put', 'post', 'patch', 'delete', 'options', 'head'];

/** Operations whose body is not an Iridium schema, so `additionalProperties` says nothing about it. */
const OPAQUE_BODY_OPERATIONS: ReadonlySet<string> = new Set(['meta.openapi', 'ops.metrics']);

/** `<domain>.<verb>`, the operation-id convention of §6. */
const OPERATION_ID_PATTERN = /^[a-z][\da-zA-Z]*(?:\.[a-z][\da-zA-Z]*)+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One documented operation, flattened out of the `paths` object. */
interface DocumentedOperation {
  readonly path: string;
  readonly method: string;
  readonly operationId: string | undefined;
  readonly operation: Record<string, unknown>;
}

const document: unknown = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8'));

function operations(source: unknown = document): readonly DocumentedOperation[] {
  const paths = isRecord(source) ? source['paths'] : undefined;
  if (!isRecord(paths)) return [];
  const found: DocumentedOperation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const operationId = operation['operationId'];
      found.push({
        path,
        method,
        operationId: typeof operationId === 'string' ? operationId : undefined,
        operation,
      });
    }
  }
  return found;
}

const DOCUMENTED = operations();

/** The document's spelling of a manifest row's path: the mount stripped, `:param` as `{param}`. */
function documentPath(row: RouteSpec): string {
  return row.path.replaceAll(/:([^/]+)/g, '{$1}');
}

/** Every object schema reachable from a value, so the `additionalProperties` rule is exhaustive. */
function objectSchemas(value: unknown, depth: number = 0): readonly Record<string, unknown>[] {
  if (depth > 12 || !isRecord(value)) return [];
  const here = value['type'] === 'object' && isRecord(value['properties']) ? [value] : [];
  const nested = Object.values(value).flatMap((child) =>
    Array.isArray(child)
      ? child.flatMap((entry: unknown) => objectSchemas(entry, depth + 1))
      : objectSchemas(child, depth + 1),
  );
  return [...here, ...nested];
}

function problemList(problems: readonly string[]): string {
  return problems.filter((problem) => problem !== '').join('\n');
}

/**
 * Whether one documented response really describes a body.
 *
 * `@fastify/swagger` fills a response that declared no schema with a placeholder media type whose
 * schema is `{description: 'Default Response'}` — present, and empty. A body asserted against that
 * validates whatever it is, so "has a `content` key" is not the question; "has a schema that says
 * something" is.
 */
function describesABody(declared: unknown): boolean {
  if (!isRecord(declared) || !isRecord(declared['content'])) return false;
  return Object.values(declared['content']).some((media) => {
    const schema = isRecord(media) ? media['schema'] : undefined;
    return isRecord(schema) && (typeof schema['$ref'] === 'string' || 'type' in schema);
  });
}

/**
 * Whether the document describes every response a row declares, body included.
 *
 * A status that is present but describes no body is only half documented: `toMatchOpenApi` would
 * assert a real response against nothing at all. The `empty` rows are the exception — for them, no
 * content *is* the description.
 */
function isFullyDocumented(row: RouteSpec, entry: DocumentedOperation): boolean {
  const responses = isRecord(entry.operation['responses']) ? entry.operation['responses'] : {};
  return row.responses.every((response) => {
    const declared = responses[String(response.status)];
    if (!isRecord(declared)) return false;
    return response.body.kind === 'empty' ? true : describesABody(declared);
  });
}

/** Resolve a local schema reference against the artifact under test, with a cycle refusal. */
function resolvedSchema(root: unknown, value: unknown): Record<string, unknown> | undefined {
  let current = value;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current['$ref'] === 'string') {
    const reference = current['$ref'];
    if (!reference.startsWith('#/') || seen.has(reference)) return undefined;
    seen.add(reference);
    current = root;
    for (const token of decodeURIComponent(reference.slice(2)).split('/')) {
      current = isRecord(current)
        ? current[token.replaceAll('~1', '/').replaceAll('~0', '~')]
        : undefined;
    }
  }
  return isRecord(current) ? current : undefined;
}

function schemaAtPointer(
  root: unknown,
  value: unknown,
  tokens: readonly string[],
): Record<string, unknown> | undefined {
  let schema = resolvedSchema(root, value);
  for (const token of tokens) {
    if (schema === undefined) return undefined;
    const child =
      schema['type'] === 'array' && /^(?:0|[1-9][0-9]*)$/.test(token)
        ? schema['items']
        : isRecord(schema['properties'])
          ? schema['properties'][token]
          : undefined;
    schema = resolvedSchema(root, child);
  }
  return schema;
}

function jsonBodySchema(value: unknown): unknown {
  const content = isRecord(value) ? value['content'] : undefined;
  const media = isRecord(content) ? content['application/json'] : undefined;
  return isRecord(media) ? media['schema'] : undefined;
}

function assertLinkExpression(root: unknown, sourceSchema: unknown, value: unknown): void {
  if (typeof value === 'string' && value.startsWith('$')) {
    if (!value.startsWith('$response.body#/'))
      throw new Error('Unsupported link runtime expression: ' + value);
    const tokens = decodeURIComponent(value.slice('$response.body#/'.length))
      .split('/')
      .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (schemaAtPointer(root, sourceSchema, tokens) === undefined)
      throw new Error('Unresolved link runtime expression: ' + value);
  } else if (isRecord(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) assertLinkExpression(root, sourceSchema, child);
  }
}

/** Each manifest edge must survive export and resolve at both its source and its target. */
function assertPublishedLinks(root: unknown): void {
  const published = operations(root);
  for (const row of API_ROUTES) {
    for (const response of row.responses) {
      if (response.links === undefined) continue;
      const source = published.find((entry) => entry.operationId === row.operationId);
      const responses = source?.operation['responses'];
      const declared = isRecord(responses) ? responses[String(response.status)] : undefined;
      if (!isRecord(declared))
        throw new Error(
          'Missing link source response: ' + row.operationId + ' ' + String(response.status),
        );
      const links = declared['links'];
      for (const [name, link] of Object.entries(response.links)) {
        expect(
          isRecord(links) ? links[name] : undefined,
          row.operationId + '.' + name,
        ).toStrictEqual(link);
        const target = published.find((entry) => entry.operationId === link.operationId);
        if (target === undefined) throw new Error('Missing link target: ' + link.operationId);
        const parameters = target.operation['parameters'];
        for (const parameter of Object.keys(link.parameters ?? {})) {
          if (
            !Array.isArray(parameters) ||
            !parameters.some((entry: unknown) => isRecord(entry) && entry['name'] === parameter)
          )
            throw new Error('Missing linked parameter: ' + link.operationId + '.' + parameter);
        }
        for (const field of Object.keys(link.requestBody ?? {})) {
          if (
            schemaAtPointer(root, jsonBodySchema(target.operation['requestBody']), [field]) ===
            undefined
          )
            throw new Error('Missing linked body field: ' + link.operationId + '.' + field);
        }
        assertLinkExpression(root, jsonBodySchema(declared), link.parameters);
        assertLinkExpression(root, jsonBodySchema(declared), link.requestBody);
      }
    }
  }
}

describe('openapi.contract [area:contracts]', () => {
  it('publishes the shipped M1 link graph without requiring future operations', () => {
    const edges = DOCUMENTED.flatMap((entry) => {
      const responses = isRecord(entry.operation['responses']) ? entry.operation['responses'] : {};
      return Object.entries(responses).flatMap(([status, response]) => {
        const links = isRecord(response) && isRecord(response['links']) ? response['links'] : {};
        return Object.values(links).map((link) => [
          entry.operationId,
          status,
          isRecord(link) ? link['operationId'] : undefined,
        ]);
      });
    });
    // Independent from manifest link metadata: deleting an edge in both exporter and manifest is red.
    expect(edges).toEqual(
      expect.arrayContaining([
        ['vaults.list', '200', 'vaults.get'],
        ['vaults.create', '201', 'vaults.get'],
        ['vaults.create', '201', 'members.put'],
        ['vaults.get', '200', 'nodes.create'],
        ['nodes.create', '201', 'notes.get'],
        ['notes.get', '200', 'notes.getMarkdown'],
        ['notes.get', '200', 'notes.participants'],
      ]),
    );
    assertPublishedLinks(document);
  });

  it('refuses a missing linked source status, target, parameter or runtime-expression field', () => {
    const mutations = [
      {
        pointer: ['paths', '/vaults', 'post', 'responses', '201'],
        reason: 'Missing link source response',
      },
      { pointer: ['paths', '/notes/{noteId}', 'get'], reason: 'Missing link target: notes.get' },
      {
        pointer: ['paths', '/notes/{noteId}', 'get', 'parameters'],
        reason: 'Missing linked parameter',
      },
      {
        pointer: ['components', 'schemas', 'Vault', 'properties', 'rootNodeId'],
        reason: 'Unresolved link runtime expression',
      },
      {
        pointer: ['components', 'schemas', 'CreateNodeBodyInput', 'properties', 'parentId'],
        reason: 'Missing linked body field',
      },
    ];
    for (const { pointer, reason } of mutations) {
      const broken: unknown = structuredClone(document);
      let parent = broken;
      for (const token of pointer.slice(0, -1))
        parent = isRecord(parent) ? parent[token] : undefined;
      const key = pointer.at(-1);
      if (!isRecord(parent) || key === undefined || !Object.hasOwn(parent, key))
        throw new Error('Regression fixture does not locate ' + pointer.join('/'));
      delete parent[key];
      expect(() => assertPublishedLinks(broken), pointer.join('/')).toThrow(reason);
    }
  });

  it('advertises note creation without narrowing the shared node response kind', () => {
    const create = DOCUMENTED.find((entry) => entry.operationId === 'nodes.create');
    expect(create).toBeDefined();
    const body = jsonBodySchema(create?.operation['requestBody']);
    expect(schemaAtPointer(document, body, ['kind'])).toMatchObject({
      type: 'string',
      const: 'note',
    });
    expect(resolvedSchema(document, body)?.['required']).toContain('kind');
    const responses = create?.operation['responses'];
    const created = isRecord(responses) ? responses['201'] : undefined;
    expect(schemaAtPointer(document, jsonBodySchema(created), ['kind'])?.['enum']).toStrictEqual([
      'category',
      'note',
    ]);
  });

  it('is an OpenAPI 3.1 document with the conventions of section 6', () => {
    expect(isRecord(document)).toBe(true);
    const root = isRecord(document) ? document : {};
    expect(root['openapi']).toBe('3.1.0');
    const info = isRecord(root['info']) ? root['info'] : {};
    expect(info['title']).toBe('Iridium API');
    expect(typeof info['version']).toBe('string');
    const servers = Array.isArray(root['servers']) ? root['servers'] : [];
    expect(servers).toHaveLength(1);
    const server = isRecord(servers[0]) ? servers[0] : {};
    // Templated on purpose: a baked-in origin would be wrong on every other deployment and would
    // make the drift gate depend on the exporting machine.
    expect(server['url']).toBe('{publicOrigin}/api/v1');
  });

  it('names every operation, in the `<domain>.<verb>` spelling of section 6', () => {
    const unnamed = DOCUMENTED.filter((entry) => entry.operationId === undefined).map(
      (entry) => `${entry.method.toUpperCase()} ${entry.path}`,
    );
    const misnamed = DOCUMENTED.filter(
      (entry) => entry.operationId !== undefined && !OPERATION_ID_PATTERN.test(entry.operationId),
    ).map((entry) => entry.operationId ?? '');
    expect(
      problemList([
        unnamed.length === 0
          ? ''
          : `${unnamed.join(', ')} carry no operationId, so no test can record covering them ` +
            'and `toMatchOpenApi` cannot locate them (D10-10).',
        misnamed.length === 0 ? '' : `${misnamed.join(', ')} are not <domain>.<verb>.`,
      ]),
    ).toBe('');
  });

  it('gives every operation a unique id', () => {
    const seen = new Map<string, number>();
    for (const entry of DOCUMENTED) {
      if (entry.operationId === undefined) continue;
      seen.set(entry.operationId, (seen.get(entry.operationId) ?? 0) + 1);
    }
    expect([...seen].filter(([, count]) => count > 1).map(([id]) => id)).toStrictEqual([]);
  });

  it('documents every `rest` row of the manifest at its own path', () => {
    const documented = new Set(DOCUMENTED.map((entry) => entry.operationId));
    const missing = API_ROUTES.filter(
      (row) => row.plugin === 'rest' && !documented.has(row.operationId),
    ).map(routeKey);
    expect(missing).toStrictEqual([]);

    const misplaced = API_ROUTES.filter((row) => row.plugin === 'rest').flatMap((row) => {
      const entry = DOCUMENTED.find((candidate) => candidate.operationId === row.operationId);
      if (entry === undefined) return [];
      return entry.path === documentPath(row) && entry.method === row.method.toLowerCase()
        ? []
        : [`${row.operationId} is documented at ${entry.method.toUpperCase()} ${entry.path}`];
    });
    expect(misplaced).toStrictEqual([]);
  });

  it('documents every success status its row declares', () => {
    const problems = API_ROUTES.flatMap((row) => {
      const entry = DOCUMENTED.find((candidate) => candidate.operationId === row.operationId);
      if (entry === undefined) return [];
      const responses = isRecord(entry.operation['responses']) ? entry.operation['responses'] : {};
      return row.responses
        .filter((response) => !Object.hasOwn(responses, String(response.status)))
        .map((response) => `${row.operationId} does not document ${String(response.status)}`);
    });
    expect(problemList(problems)).toBe('');
  });

  it('declares the two security schemes and uses them', () => {
    const components =
      isRecord(document) && isRecord(document['components']) ? document['components'] : {};
    const schemes = isRecord(components['securitySchemes']) ? components['securitySchemes'] : {};
    expect(Object.keys(schemes).toSorted()).toStrictEqual(['bearer', 'sessionCookie']);

    const undeclared = DOCUMENTED.filter(
      (entry) => !Array.isArray(entry.operation['security']),
    ).map((entry) => entry.operationId ?? `${entry.method} ${entry.path}`);
    expect(undeclared).toStrictEqual([]);
  });

  it('says a public operation needs neither scheme, and an authenticated one accepts both', () => {
    const problems = API_ROUTES.flatMap((row) => {
      const entry = DOCUMENTED.find((candidate) => candidate.operationId === row.operationId);
      if (entry === undefined) return [];
      const security = Array.isArray(entry.operation['security'])
        ? entry.operation['security']
        : [];
      const isPublic = typeof row.auth === 'object' && Object.hasOwn(row.auth, 'public');
      if (isPublic) {
        return security.length === 0 ? [] : [`${row.operationId} is public but lists a scheme`];
      }
      return security.length === 2 ? [] : [`${row.operationId} does not list both schemes`];
    });
    expect(problemList(problems)).toBe('');
  });

  it('refuses unknown members on every request and response object', () => {
    const problems = DOCUMENTED.flatMap((entry) => {
      if (entry.operationId !== undefined && OPAQUE_BODY_OPERATIONS.has(entry.operationId)) {
        return [];
      }
      const open = objectSchemas(entry.operation['requestBody'])
        .concat(objectSchemas(entry.operation['responses']))
        .filter((schema) => schema['additionalProperties'] !== false);
      return open.length === 0
        ? []
        : [
            `${entry.operationId ?? entry.path} has ${String(open.length)} object schema(s) that ` +
              'accept unknown members; every DTO is a `z.strictObject` (09-api-reference.md §1.1).',
          ];
    });
    expect(problemList(problems)).toBe('');
  });

  it('declares an ETag on every versioned read the manifest marks', () => {
    const problems = API_ROUTES.flatMap((row) =>
      row.responses
        .filter((response) => response.etag !== undefined)
        .flatMap((response) => {
          const entry = DOCUMENTED.find((candidate) => candidate.operationId === row.operationId);
          if (entry === undefined) return [];
          const responses = isRecord(entry.operation['responses'])
            ? entry.operation['responses']
            : {};
          const declared = responses[String(response.status)];
          const headers =
            isRecord(declared) && isRecord(declared['headers']) ? declared['headers'] : {};
          return Object.keys(headers).some((name) => name.toLowerCase() === 'etag')
            ? []
            : [
                `${row.operationId} ${String(response.status)} carries a ${String(response.etag)} ` +
                  'validator in the manifest but documents no ETag header',
              ];
        }),
    );
    expect(problemList(problems)).toBe('');
  });

  it('documents an If-Match parameter on every route the manifest marks', () => {
    const problems = API_ROUTES.filter((row) => row.ifMatch !== undefined).flatMap((row) => {
      const entry = DOCUMENTED.find((candidate) => candidate.operationId === row.operationId);
      if (entry === undefined) return [];
      const parameters = Array.isArray(entry.operation['parameters'])
        ? entry.operation['parameters']
        : [];
      const hasIfMatch = parameters.some(
        (parameter: unknown) =>
          isRecord(parameter) &&
          typeof parameter['name'] === 'string' &&
          parameter['name'].toLowerCase() === 'if-match',
      );
      return hasIfMatch || row.ifMatch === 'conditional'
        ? []
        : [`${row.operationId} requires If-Match but documents no such parameter`];
    });
    expect(problemList(problems)).toBe('');
  });

  it('fully documents every M1 response without placeholder schemas', () => {
    const undocumented = API_ROUTES.flatMap((row) => {
      const entry = DOCUMENTED.find((candidate) => candidate.operationId === row.operationId);
      return entry !== undefined && isFullyDocumented(row, entry) ? [] : [row.operationId];
    });
    expect(undocumented).toStrictEqual([]);
  });

  it('uses only codes from the closed vocabulary in its row declarations', () => {
    const unknown = API_ROUTES.flatMap((row) =>
      row.errors
        .filter((code) => !ERROR_CODES.includes(code))
        .map((code) => `${row.operationId}: ${code}`),
    );
    expect(unknown).toStrictEqual([]);
  });
});
