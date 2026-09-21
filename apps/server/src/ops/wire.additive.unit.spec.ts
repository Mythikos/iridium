/** Adversarial changes prove the compatibility checker rejects actual breaking edits. */
import { describe, expect, it } from 'vitest';

import { openApiChanges, schemaChanges } from '../../test/support/wire-compatibility.ts';

const record = {
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 40 },
    role: { type: 'string', enum: ['viewer', 'editor'] },
  },
  required: ['id'],
  additionalProperties: true,
};
function api(schema: unknown): Record<string, unknown> {
  return {
    paths: {
      '/notes': {
        get: {
          operationId: 'notes.list',
          responses: { '200': { content: { 'application/json': { schema } } } },
        },
      },
    },
  };
}

describe('wire.additive.unit [area:contracts]', () => {
  it.each([
    ['removed field', { ...record, properties: { id: record.properties.id } }, 'response'],
    [
      'changed type',
      { ...record, properties: { ...record.properties, id: { type: 'number' } } },
      'response',
    ],
    [
      'tightened length',
      {
        ...record,
        properties: { ...record.properties, id: { ...record.properties.id, maxLength: 20 } },
      },
      'request',
    ],
    ['new required field', { ...record, required: ['id', 'role'] }, 'request'],
    ['lost required response', { ...record, required: [] }, 'response'],
    [
      'enum removal',
      {
        ...record,
        properties: { ...record.properties, role: { type: 'string', enum: ['editor'] } },
      },
      'response',
    ],
    ['closed request extras', { ...record, additionalProperties: false }, 'request'],
  ] as const)('rejects %s', (_name, changed, direction) => {
    expect(schemaChanges(record, changed, direction).length).toBeGreaterThan(0);
  });
  it('permits optional additions, descriptions and widened request bounds', () => {
    expect(
      schemaChanges(
        record,
        {
          ...record,
          description: 'New docs',
          properties: {
            ...record.properties,
            id: { ...record.properties.id, maxLength: 80 },
            extra: { type: 'boolean' },
          },
        },
        'request',
      ),
    ).toEqual([]);
  });
  it('recognizes const-to-enum widening and rejects its narrowing inverse', () => {
    const old = { type: 'string', const: 'note' };
    const current = { type: 'string', enum: ['note', 'category'] };
    expect(schemaChanges(old, current, 'request')).toEqual([]);
    expect(schemaChanges(current, old, 'request')).toEqual(['$: restricted enum or const']);
    expect(schemaChanges({}, { type: 'string', pattern: '^x$' }, 'request')).toEqual([
      '$: introduced a type restriction',
      '$: changed validation keyword pattern',
    ]);
  });
  it('matches discriminator branches independently of their order and refuses a removed message', () => {
    const a = { type: 'object', properties: { t: { const: 'a' } } };
    const b = { type: 'object', properties: { t: { const: 'b' } } };
    expect(schemaChanges({ oneOf: [a, b] }, { oneOf: [b, a] }, 'response')).toEqual([]);
    expect(schemaChanges({ oneOf: [a, b] }, { oneOf: [a] }, 'response')).toEqual([
      '$: removed or narrowed oneOf[1]',
    ]);
  });
  it('dereferences recursive components while still checking fields below each reference', () => {
    const baseline = {
      $ref: '#/$defs/Node',
      $defs: {
        Node: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            children: { type: 'array', items: { $ref: '#/$defs/Node' } },
          },
        },
      },
    };
    expect(schemaChanges(baseline, structuredClone(baseline), 'response')).toEqual([]);
    const changed = structuredClone(baseline);
    changed.$defs.Node.properties.id.type = 'number';
    expect(schemaChanges(baseline, changed, 'response')).toEqual([
      '$.properties.id: removed or changed a type',
    ]);
  });
  it('does not accept a removed path, response, or required query parameter', () => {
    expect(openApiChanges(api(record), { paths: {} })).toEqual(['/notes: removed path']);
    expect(
      openApiChanges(api(record), {
        paths: { '/notes': { get: { operationId: 'notes.list', responses: {} } } },
      }),
    ).toEqual(['GET /notes: removed response 200']);
    const withParameter = {
      paths: {
        '/notes': {
          get: {
            operationId: 'notes.list',
            parameters: [
              { name: 'cursor', in: 'query', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { content: { 'application/json': { schema: record } } } },
          },
        },
      },
    };
    expect(openApiChanges(api(record), withParameter)).toEqual([
      'GET /notes: added required parameter cursor',
    ]);
  });
});
