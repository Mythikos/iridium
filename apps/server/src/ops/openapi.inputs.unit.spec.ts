/**
 * The live OpenAPI input shapes must retain the runtime constraints a schema-based client needs
 * (09-api-reference.md sections 1.1, 1.2 and 6). This builds the normal app without a database and
 * reads app.swagger(); the separate openapi.contract suite checks the committed artifact.
 */
import { API_ROUTES, mintToken } from '@iridium/contracts';
import { createOpenApiOracle } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildWithoutDatabase, type NoDatabaseApp } from '../../test/support/no-database-app.ts';

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

function child(value: unknown, key: string): Record<string, unknown> {
  return record(record(value)[key]);
}

describe('ops.openapi-inputs.unit [area:ops]', () => {
  let booted: NoDatabaseApp;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    booted = await buildWithoutDatabase();
    await booted.app.ready();
    document = record(booted.app.swagger());
  });

  afterAll(async () => {
    await booted.close();
  });

  function operation(path: string, method: string): Record<string, unknown> {
    return child(child(child(document, 'paths'), path), method);
  }

  it('documents raw attachment media as OpenAPI 3.1 bytes and validates the real wire shape', async () => {
    const response = child(
      child(operation('/vaults/{vaultId}/attachments/{attachmentId}', 'get'), 'responses'),
      '200',
    );
    expect(child(response, 'content')['image/png']).toEqual({ schema: {} });
    const oracle = createOpenApiOracle({ source: document });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
    expect(
      await oracle.check(
        { status: 200, contentType: 'image/png', body: bytes },
        'attachments.download',
        200,
      ),
    ).toMatchObject({ pass: true });
    expect(
      await oracle.check(
        { status: 200, contentType: 'application/x-iridium-undocumented', body: bytes },
        'attachments.download',
        200,
      ),
    ).toMatchObject({ pass: false });
  });

  function resolveSchema(value: unknown): Record<string, unknown> {
    const schema = record(value);
    const reference = schema['$ref'];
    if (reference === undefined) return schema;
    const name = z.string().startsWith('#/components/schemas/').parse(reference).split('/')[3];
    return child(child(child(document, 'components'), 'schemas'), z.string().parse(name));
  }

  function parameter(path: string, method: string, name: string): Record<string, unknown> {
    const parameters = z
      .array(z.record(z.string(), z.unknown()))
      .parse(operation(path, method)['parameters']);
    return record(parameters.find((entry) => entry['name'] === name));
  }

  function bodyProperty(path: string, method: string, name: string): Record<string, unknown> {
    const media = child(
      child(child(operation(path, method), 'requestBody'), 'content'),
      'application/json',
    );
    const body = resolveSchema(media['schema']);
    return resolveSchema(child(body, 'properties')[name]);
  }

  it('exports the M1 link values while leaving names and Markdown available for generation', () => {
    const links = (path: string, method: string, status: string): Record<string, unknown> =>
      child(child(child(operation(path, method), 'responses'), status), 'links');
    expect(links('/vaults', 'get', '200')).toEqual({
      getVault: {
        operationId: 'vaults.get',
        parameters: { vaultId: '$response.body#/items/0/id' },
      },
    });
    expect(links('/vaults', 'post', '201')).toEqual({
      getVault: { operationId: 'vaults.get', parameters: { vaultId: '$response.body#/id' } },
      putMember: {
        operationId: 'members.put',
        parameters: {
          vaultId: '$response.body#/id',
          userId: '$response.body#/createdBy/id',
        },
      },
    });
    expect(links('/vaults/{vaultId}', 'get', '200')).toEqual({
      createNote: {
        operationId: 'nodes.create',
        parameters: { vaultId: '$response.body#/id' },
        requestBody: { kind: 'note', parentId: '$response.body#/rootNodeId' },
      },
    });
    expect(links('/vaults/{vaultId}/nodes', 'post', '201')).toEqual({
      getNote: { operationId: 'notes.get', parameters: { noteId: '$response.body#/id' } },
    });
    expect(links('/notes/{noteId}', 'get', '200')).toEqual({
      getMarkdown: {
        operationId: 'notes.getMarkdown',
        parameters: { noteId: '$response.body#/id' },
      },
      getParticipants: {
        operationId: 'notes.participants',
        parameters: { noteId: '$response.body#/id' },
      },
    });
  });

  it('publishes the two accepted spellings of every query flag', () => {
    for (const [path, name] of [
      ['/vaults', 'includeArchived'],
      ['/notes/{noteId}/markdown', 'fresh'],
      ['/admin/users', 'isServerAdmin'],
    ]) {
      const declared = parameter(z.string().parse(path), 'get', z.string().parse(name));
      expect(declared['required']).not.toBe(true);
      expect(resolveSchema(declared['schema'])).toMatchObject({
        type: 'string',
        enum: ['true', 'false'],
      });
    }
  });

  it('documents positive line-range syntax and its ordering and safe-integer format', () => {
    const schema = resolveSchema(parameter('/notes/{noteId}/markdown', 'get', 'lines')['schema']);
    expect(schema).toMatchObject({ type: 'string', format: 'iridium-line-range' });
    const pattern = new RegExp(z.string().parse(schema['pattern']));
    for (const value of ['1-1', '001-007', '120-260'])
      expect(pattern.test(value), value).toBe(true);
    for (const value of ['0-0', '0-1', '1-0', '1', '-1-2'])
      expect(pattern.test(value), value).toBe(false);
  });

  it('derives every If-Match parameter from its strong version contract', () => {
    const rows = API_ROUTES.filter((row) => row.ifMatch !== undefined);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const path = row.path.replaceAll(/:([^/]+)/g, '{$1}');
      const declared = parameter(path, row.method.toLowerCase(), 'if-match');
      expect(declared['required'] === true).toBe(row.ifMatch === 'required');
      const schema = resolveSchema(declared['schema']);
      expect(schema).toMatchObject({ type: 'string', format: 'iridium-strong-etag' });
      const pattern = new RegExp(z.string().parse(schema['pattern']));
      for (const value of ['"1"', '"007"', ' "7" ']) expect(pattern.test(value), value).toBe(true);
      for (const value of ['', '0', '"0"', 'W/"1"', '*', '"1", "2"']) {
        expect(pattern.test(value), value).toBe(false);
      }
    }
  });

  it('retains the exact UUIDv7 pattern in parameters and nested component schemas', () => {
    const schemas: Record<string, unknown>[] = [];
    const inspect = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      if (Reflect.get(value, 'pattern') === z.regexes.uuid7.source) {
        schemas.push(record(value));
      }
      for (const nested of Object.values(value)) inspect(nested);
    };
    inspect(document);
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      expect(schema['type']).toBe('string');
      expect(schema['format']).toBeUndefined();
    }
    const id = resolveSchema(parameter('/vaults/{vaultId}', 'get', 'vaultId')['schema']);
    expect(id['pattern']).toBe(z.regexes.uuid7.source);
    const parentId = bodyProperty('/vaults/{vaultId}/nodes', 'post', 'parentId');
    expect(parentId['pattern']).toBe(z.regexes.uuid7.source);
    const pattern = new RegExp(z.string().parse(id['pattern']));
    expect(pattern.test('018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091')).toBe(true);
    expect(pattern.test('018F3A2E-7B1C-7D3E-9A4B-2C5D6E7F8091')).toBe(true);
    expect(pattern.test('018f3a2e-7b1c-4d3e-9a4b-2c5d6e7f8091')).toBe(false);
  });

  it('describes name character constraints and the custom Unicode and path rules', () => {
    for (const path of ['/vaults', '/vaults/{vaultId}/nodes']) {
      const schema = bodyProperty(path, 'post', 'name');
      expect(schema).toMatchObject({ type: 'string', format: 'iridium-node-name', minLength: 1 });
      const pattern = new RegExp(z.string().parse(schema['pattern']));
      for (const name of ['Handbook', 'Équipe', '计划', '🧪'])
        expect(pattern.test(name), name).toBe(true);
      for (const name of ['bad\u0002name', 'bad\u001fname', 'bad\u0083name', 'CON', 'a/b', 'a.']) {
        expect(pattern.test(name), name).toBe(false);
      }
    }
  });

  it('identifies CRC-protected password-link credentials without dropping their shape', () => {
    const schema = bodyProperty('/auth/set-password', 'post', 'token');
    expect(schema).toMatchObject({
      type: 'string',
      format: 'iridium-credential-spl',
      minLength: 75,
      maxLength: 75,
    });
    const pattern = new RegExp(z.string().parse(schema['pattern']));
    expect(pattern.test(mintToken('spl').raw)).toBe(true);
    expect(pattern.test(mintToken('ses').raw)).toBe(false);
  });

  it('preserves independent standard formats', () => {
    expect(bodyProperty('/auth/sessions', 'post', 'email')['format']).toBe('email');
  });
});
