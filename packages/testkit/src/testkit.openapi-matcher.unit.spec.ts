import { mintToken } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import {
  createOpenApiOracle,
  escapeJsonPointerSegment,
  registerOpenApiMatcher,
} from './matchers/to-match-openapi.ts';
import type { OpenApiSubject } from './matchers/to-match-openapi.ts';

/**
 * A tiny OpenAPI 3.1 document, deliberately including a self-recursive schema: a dereferenced
 * recursive schema is a circular JavaScript object graph that ajv cannot compile, which is why the
 * oracle bundles rather than dereferences.
 */
const DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Iridium testkit fixture', version: '0.0.0' },
  paths: {
    '/vaults/{vaultId}': {
      get: {
        operationId: 'vaults.get',
        responses: {
          200: {
            description: 'the vault',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Vault' } },
            },
          },
          404: {
            description: 'no such vault',
            content: {
              'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
            },
          },
        },
      },
      delete: {
        operationId: 'vaults.delete',
        responses: { 204: { description: 'gone' } },
      },
    },
    '/notes/{noteId}/text': {
      get: {
        operationId: 'notes.getText',
        responses: {
          200: { description: 'the markdown', content: { 'text/markdown': {} } },
        },
      },
    },
  },
  components: {
    schemas: {
      Vault: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          children: { type: 'array', items: { $ref: '#/components/schemas/Vault' } },
          // Optional, so every case above still describes a valid vault; present so the two cases
          // below can prove `format` asserts instead of annotating.
          createdAt: { type: 'string', format: 'date-time' },
          revision: { type: 'integer', format: 'int32' },
        },
      },
      Problem: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'code'],
        properties: {
          status: { type: 'integer' },
          code: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
  },
} as const;

function subject(status: number, contentType: string | null, body: unknown): OpenApiSubject {
  return { status, contentType, body };
}

describe('testkit.openapi-matcher.unit [area:testkit]', () => {
  const oracle = createOpenApiOracle({ source: DOCUMENT });

  it('lists every documented operationId', async () => {
    await expect(oracle.operationIds()).resolves.toStrictEqual([
      'notes.getText',
      'vaults.delete',
      'vaults.get',
    ]);
  });

  it('passes a response that matches its documented status, type and schema', async () => {
    const result = await oracle.check(
      subject(200, 'application/json', { id: 'v1', name: 'Vault one' }),
      'vaults.get',
      200,
    );
    expect(result.pass).toBe(true);
  });

  it('resolves a recursive $ref instead of failing to compile it', async () => {
    const result = await oracle.check(
      subject(200, 'application/json', {
        id: 'v1',
        name: 'root',
        children: [{ id: 'v2', name: 'child', children: [{ id: 'v3', name: 'grandchild' }] }],
      }),
      'vaults.get',
      200,
    );
    expect(result.pass).toBe(true);
  });

  it('fails an undocumented operation, and says so', async () => {
    const result = await oracle.check(
      subject(200, 'application/json', {}),
      'vaults.undocumented',
      200,
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/declares no operation "vaults.undocumented"/);
  });

  it('fails an undocumented status and names the ones that are documented', async () => {
    const result = await oracle.check(subject(500, 'application/json', {}), 'vaults.get', 500);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/does not document status 500; it documents 200, 404/);
  });

  it('fails when the response carries a different status from the one asserted', async () => {
    const result = await oracle.check(subject(404, 'application/json', {}), 'vaults.get', 200);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/expected vaults.get to answer 200, got 404/);
  });

  it('fails an undocumented content type', async () => {
    const result = await oracle.check(subject(200, 'text/plain', 'nope'), 'vaults.get', 200);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(
      /documents application\/json for status 200, but the response carried text\/plain/,
    );
  });

  it('fails a body that breaks the schema and names the offending path', async () => {
    const result = await oracle.check(
      subject(200, 'application/json', { id: 'v1', name: 42, extra: true }),
      'vaults.get',
      200,
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/body does not match its schema/);
    expect(result.message).toMatch(/\/name/);
  });

  it('requires an empty body where the document declares no content', async () => {
    await expect(
      oracle.check(subject(204, null, undefined), 'vaults.delete', 204),
    ).resolves.toMatchObject({
      pass: true,
    });
    const withBody = await oracle.check(
      subject(204, null, { surprise: true }),
      'vaults.delete',
      204,
    );
    expect(withBody.pass).toBe(false);
    expect(withBody.message).toMatch(/with no content, but the response carried a body/);
  });

  it('constrains only the content type where a media type declares no schema', async () => {
    await expect(
      oracle.check(subject(200, 'text/markdown', '# anything'), 'notes.getText', 200),
    ).resolves.toMatchObject({ pass: true });
    await expect(
      oracle.check(subject(200, 'application/json', {}), 'notes.getText', 200),
    ).resolves.toMatchObject({ pass: false });
  });

  it('fails a response with no Content-Type where one is documented', async () => {
    const result = await oracle.check(subject(200, null, 'x'), 'vaults.get', 200);
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/carried no Content-Type/);
  });

  it('asserts string formats instead of annotating them', async () => {
    await expect(
      oracle.check(
        subject(200, 'application/json', {
          id: 'v1',
          name: 'ok',
          createdAt: '2026-09-13T04:20:00Z',
        }),
        'vaults.get',
        200,
      ),
    ).resolves.toMatchObject({ pass: true });

    const result = await oracle.check(
      subject(200, 'application/json', { id: 'v1', name: 'ok', createdAt: 'yesterday' }),
      'vaults.get',
      200,
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/\/createdAt/);
    expect(result.message).toMatch(/format/);
  });

  it.each([
    { format: 'iridium-node-name', good: 'Café', bad: 'Cafe\u0301' },
    { format: 'iridium-node-name', good: 'a%20b', bad: 'a%252fb' },
    { format: 'iridium-node-name', good: 'x'.repeat(255), bad: 'x'.repeat(256) },
    { format: 'iridium-strong-etag', good: '"9007199254740991"', bad: '"9007199254740992"' },
    { format: 'iridium-line-range', good: '1-9007199254740991', bad: '2-1' },
    { format: 'iridium-line-range', good: '1-1', bad: '0-1' },
    { format: 'iridium-credential-spl', good: mintToken('spl').raw, bad: mintToken('ses').raw },
  ])('asserts the runtime refinement for $format ($bad)', async ({ format, good, bad }) => {
    const custom = createOpenApiOracle({
      source: {
        ...DOCUMENT,
        components: {
          schemas: { ...DOCUMENT.components.schemas, Vault: { type: 'string', format } },
        },
      },
    });
    await expect(
      custom.check(subject(200, 'application/json', good), 'vaults.get', 200),
    ).resolves.toMatchObject({ pass: true });
    await expect(
      custom.check(subject(200, 'application/json', bad), 'vaults.get', 200),
    ).resolves.toMatchObject({ pass: false });
  });

  it('asserts the numeric formats OpenAPI adds to JSON Schema', async () => {
    await expect(
      oracle.check(
        subject(200, 'application/json', { id: 'v1', name: 'ok', revision: 7 }),
        'vaults.get',
        200,
      ),
    ).resolves.toMatchObject({ pass: true });

    const result = await oracle.check(
      subject(200, 'application/json', { id: 'v1', name: 'ok', revision: 2_147_483_648 }),
      'vaults.get',
      200,
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/\/revision/);
  });

  it('hands configureAjv an instance the standard formats are already on', async () => {
    const custom = createOpenApiOracle({
      source: {
        ...DOCUMENT,
        components: {
          schemas: {
            ...DOCUMENT.components.schemas,
            Vault: {
              type: 'object',
              required: ['id', 'createdAt'],
              properties: {
                id: { type: 'string', format: 'iridium-id' },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      configureAjv: (ajv) => {
        ajv.addFormat('iridium-id', /^v\d+$/);
      },
    });

    // The caller's own format and `ajv-formats`' `date-time` both apply to the same body.
    await expect(
      custom.check(
        subject(200, 'application/json', { id: 'v1', createdAt: '2026-09-13T04:20:00Z' }),
        'vaults.get',
        200,
      ),
    ).resolves.toMatchObject({ pass: true });
    await expect(
      custom.check(
        subject(200, 'application/json', { id: 'nope', createdAt: '2026-09-13T04:20:00Z' }),
        'vaults.get',
        200,
      ),
    ).resolves.toMatchObject({ pass: false });
    await expect(
      custom.check(
        subject(200, 'application/json', { id: 'v1', createdAt: 'yesterday' }),
        'vaults.get',
        200,
      ),
    ).resolves.toMatchObject({ pass: false });
  });

  it('escapes JSON Pointer segments so a templated path resolves', () => {
    expect(escapeJsonPointerSegment('/vaults/{vaultId}')).toBe('~1vaults~1{vaultId}');
    expect(escapeJsonPointerSegment('a~b/c')).toBe('a~0b~1c');
  });

  it('registers as an expect matcher over the same document', async () => {
    registerOpenApiMatcher({ source: DOCUMENT });
    await expect(subject(200, 'application/json', { id: 'v1', name: 'ok' })).toMatchOpenApi(
      'vaults.get',
      200,
    );
    await expect(subject(200, 'application/json', { id: 'v1' })).not.toMatchOpenApi(
      'vaults.get',
      200,
    );
    await expect('not a response').not.toMatchOpenApi('vaults.get', 200);
  });

  it('names the missing document when the committed spec has not been generated', async () => {
    const missing = createOpenApiOracle({
      source: 'packages/contracts/openapi/does-not-exist.json',
    });
    await expect(missing.operationIds()).rejects.toThrow(/Run `pnpm gen`/);
  });
});

describe('OpenAPI fallback response precedence', () => {
  const oracle = createOpenApiOracle({
    source: {
      openapi: '3.1.0',
      info: { title: 'response precedence', version: '1' },
      paths: {
        '/probe': {
          get: {
            operationId: 'probe.get',
            responses: {
              '503': {
                description: 'exact',
                content: { 'application/json': { schema: { const: 'exact' } } },
              },
              '5XX': {
                description: 'range',
                content: { 'application/json': { schema: { const: 'range' } } },
              },
              default: {
                description: 'fallback',
                content: { 'application/json': { schema: { const: 'fallback' } } },
              },
            },
          },
        },
      },
    },
  });
  it.each([
    [503, 'exact'],
    [502, 'range'],
    [418, 'fallback'],
  ] as const)(
    'validates %i against its selected schema, never accepting a different fallback',
    async (status, body) => {
      expect(
        (await oracle.check(subject(status, 'application/json', body), 'probe.get', status)).pass,
      ).toBe(true);
      expect(
        (await oracle.check(subject(status, 'application/json', 'wrong'), 'probe.get', status))
          .pass,
      ).toBe(false);
    },
  );
  it('does not use a broader response to forgive an exact-status schema violation', async () => {
    expect(
      (await oracle.check(subject(503, 'application/json', 'range'), 'probe.get', 503)).pass,
    ).toBe(false);
    expect(
      (await oracle.check(subject(502, 'application/json', 'fallback'), 'probe.get', 502)).pass,
    ).toBe(false);
  });
});
