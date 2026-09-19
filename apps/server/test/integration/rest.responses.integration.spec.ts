/** Real M1 HTTP responses, including declared refusal and validation branches. */
import { M1_ROUTES, newId, VaultId } from '@iridium/contracts';
import type { RestClient, RestRequestInit, RestResponse } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TEST_NAMESPACE_PREFIX } from '../../src/ops/test-routes.ts';
import {
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { insertToken, seedUser, signInWeb, type SeededUser } from '../support/seed.ts';

let context: AuthTestServer;
let admin: SeededUser;
let member: SeededUser;
let manager: RestClient;
let reader: RestClient;
const MISSING_ID = newId();
const METRICS_SECRET = 'response-contract-metrics-012345678901234567890';
beforeAll(async () => {
  context = await startAuthServer({ extraEnv: { METRICS_TOKEN: METRICS_SECRET } });
});
beforeEach(async () => {
  [admin, member] = await Promise.all([
    seedUser(context, { email: 'responses-admin@example.test', isServerAdmin: true }),
    seedUser(context, { email: 'responses-member@example.test' }),
  ]);
  const [adminJar, memberJar] = await Promise.all([
    signInWeb(context, admin),
    signInWeb(context, member),
  ]);
  manager = webClient(context, adminJar);
  reader = webClient(context, memberJar);
});
afterAll(async () => {
  await context.stop();
});

async function fixture(): Promise<{ vault: string; note: string }> {
  const vault = await manager.post<{ id: string; rootNodeId: string }>('/vaults', {
    json: { name: 'Response contracts' },
    headers: webHeaders(context.origin),
  });
  expect(vault.status).toBe(201);
  expect(vault.body).toMatchObject({ settings: { autoCheckpointIntervalMin: 10 } });
  const note = await manager.post<{ id: string }>(`/vaults/${vault.body.id}/nodes`, {
    json: {
      kind: 'note',
      name: 'A note',
      parentId: vault.body.rootNodeId,
      markdown: '# Contract\n',
    },
    headers: webHeaders(context.origin),
  });
  expect(note.status).toBe(201);
  return { vault: vault.body.id, note: note.body.id };
}

async function expectStatus(
  client: RestClient,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  expected: number,
  init?: RestRequestInit,
): Promise<void> {
  const response = await client.api(method, path, {
    ...init,
    headers: { ...webHeaders(context.origin), ...init?.headers },
  });
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(expected);
}

function record(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}

/** Evaluate the published response-body expressions, including array indices, against real data. */
function linkedValue(value: unknown, body: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('$')) return value;
  const fragment = z
    .string()
    .startsWith('$response.body#/')
    .parse(value)
    .slice('$response.body#/'.length);
  let current = body;
  for (const encoded of decodeURIComponent(fragment).split('/')) {
    const token = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, token))
      throw new Error('Unresolved published link expression: ' + value);
    current = Reflect.get(current, token);
  }
  return current;
}

describe('rest.responses.integration [area:contracts]', () => {
  it('follows the published M1 links from a seeded editor vault through created Markdown', async () => {
    const seeded = await manager.post('/vaults', {
      json: { name: 'Linked editor vault', members: [{ userId: member.id, role: 'editor' }] },
      headers: webHeaders(context.origin),
    });
    expect(seeded.status).toBe(201);
    const exported = await manager.get('/openapi.json');
    expect(exported.status).toBe(200);
    const paths = record(record(exported.body)['paths']);
    const operations = new Map<
      string,
      {
        path: string;
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        schema: Record<string, unknown>;
      }
    >();
    for (const [path, item] of Object.entries(paths)) {
      // The in-process harness adds unnamed fault controls that the production document omits.
      if (path.startsWith(TEST_NAMESPACE_PREFIX + '/')) continue;
      for (const [method, value] of Object.entries(record(item))) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
        const schema = record(value);
        operations.set(z.string().parse(schema['operationId']), {
          path,
          method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).parse(method.toUpperCase()),
          schema,
        });
      }
    }
    async function follow(
      sourceId: string,
      source: RestResponse,
      name: string,
      expected: number,
      generatedBody?: Record<string, unknown>,
    ): Promise<RestResponse> {
      const operation = operations.get(sourceId);
      if (operation === undefined) throw new Error('Missing published source: ' + sourceId);
      const response = record(record(operation.schema['responses'])[String(source.status)]);
      const link = record(record(response['links'])[name]);
      const targetId = z.string().parse(link['operationId']);
      const target = operations.get(targetId);
      if (target === undefined) throw new Error('Missing published target: ' + targetId);
      const parameters = record(link['parameters']);
      const path = target.path.replaceAll(/\{([^}]+)\}/g, (_match, parameter: string) =>
        encodeURIComponent(z.string().parse(linkedValue(parameters[parameter], source.body))),
      );
      const body =
        link['requestBody'] === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(record(link['requestBody'])).map(([field, expression]) => [
                field,
                linkedValue(expression, source.body),
              ]),
            );
      const result = await reader.api(target.method, path, {
        headers: webHeaders(context.origin),
        ...(body === undefined ? {} : { json: { ...generatedBody, ...body } }),
      });
      expect(result.status, targetId + ': ' + JSON.stringify(result.body)).toBe(expected);
      await expect(result).toMatchOpenApi(targetId, expected);
      return result;
    }

    const listed = await reader.get('/vaults');
    expect(listed.status).toBe(200);
    const vault = await follow('vaults.list', listed, 'getVault', 200);
    const name = 'Linked note ' + newId();
    const markdown = '# A linked note\n';
    const node = await follow('vaults.get', vault, 'createNote', 201, { name, markdown });
    expect(node.body).toMatchObject({
      name,
      kind: 'note',
      parentId: record(vault.body)['rootNodeId'],
    });
    const metadata = await follow('nodes.create', node, 'getNote', 200);
    expect(metadata.body).toMatchObject({ id: record(node.body)['id'], name });
    const content = await follow('notes.get', metadata, 'getMarkdown', 200);
    expect(content.body).toBe(markdown);
    const markdownPath = new URL(content.url).pathname;
    const line = await reader.request('GET', markdownPath, { query: { lines: '1-1' } });
    expect(line.status).toBe(200);
    expect(line.body).toBe('# A linked note');
    const outside = await reader.request('GET', markdownPath, { query: { lines: '99-100' } });
    expect(outside.status).toBe(422);
    expect(outside.body).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'query.lines', code: 'lines_out_of_range' }],
    });
    await expect(outside).toMatchOpenApi('notes.getMarkdown', 422);
    await follow('notes.get', metadata, 'getParticipants', 200);
  });

  it('requires a session on every M1 operation declaring unauthenticated', async () => {
    const routes = M1_ROUTES.filter((route) => route.errors.includes('unauthenticated'));
    expect(routes.length).toBeGreaterThan(20);
    await Promise.all(
      routes.map(async (route) => {
        const path = route.path.replace(/:[A-Za-z]+/g, MISSING_ID);
        await expectStatus(
          webClient(context),
          route.method,
          path,
          401,
          route.method === 'GET' || route.method === 'DELETE' ? undefined : { json: {} },
        );
      }),
    );
  });

  it('rejects cross-site cookie mutations on every documented CSRF surface', async () => {
    const routes = M1_ROUTES.filter((route) => route.errors.includes('csrf_rejected'));
    expect(routes.length).toBeGreaterThan(8);
    await Promise.all(
      routes.map(async (route) => {
        await expectStatus(
          manager,
          route.method,
          route.path.replace(/:[A-Za-z]+/g, MISSING_ID),
          403,
          {
            ...(route.method === 'DELETE' ? {} : { json: {} }),
            headers: { origin: 'https://foreign.example', 'sec-fetch-site': 'cross-site' },
          },
        );
      }),
    );
  });

  it('validates administration requests, rejects unknown users, and reports email conflicts', async () => {
    await expectStatus(reader, 'GET', '/admin/users', 403);
    expect((await manager.get('/admin/users')).body).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: member.id })]),
    });
    await expectStatus(manager, 'GET', '/admin/users?limit=0', 422);
    await expectStatus(manager, 'POST', '/admin/users', 422, { json: { email: 'invalid' } });
    await expectStatus(manager, 'POST', '/admin/users', 409, {
      json: { email: member.email, displayName: 'Duplicate' },
    });
    for (const action of ['disable', 'enable', 'reset-password']) {
      // Each action is a distinct endpoint with its own params validator and service lookup.
      // eslint-disable-next-line no-await-in-loop -- keep independent administrative audit writes ordered
      await expectStatus(manager, 'POST', `/admin/users/${MISSING_ID}/${action}`, 404, {
        json: {},
      });
      // eslint-disable-next-line no-await-in-loop -- verify each endpoint's malformed-id response next
      await expectStatus(manager, 'POST', `/admin/users/invalid/${action}`, 422, { json: {} });
    }
  });

  it('refuses note creation under missing or non-category parents and rejects invalid names', async () => {
    const { vault, note } = await fixture();
    const path = `/vaults/${vault}/nodes`;
    await expectStatus(manager, 'POST', path, 404, {
      json: { kind: 'note', parentId: MISSING_ID, name: 'Missing parent' },
    });
    await expectStatus(manager, 'POST', path, 409, {
      json: { kind: 'note', parentId: note, name: 'Invalid parent' },
    });
    await expectStatus(manager, 'POST', path, 422, {
      json: { kind: 'note', parentId: note, name: '' },
    });
    const unchanged = await manager.get(`/notes/${note}/markdown`);
    expect(unchanged.status).toBe(200);
    expect(unchanged.body).toBe('# Contract\n');
  });

  it('checks memberships with the live role, strong version, and target identity', async () => {
    const { vault } = await fixture();
    const path = `/vaults/${vault}/members/${member.id}`;
    await expectStatus(manager, 'GET', `/vaults/${vault}/members`, 200);
    await expectStatus(manager, 'PUT', path, 201, { json: { role: 'viewer' } });
    expect((await manager.get(`/vaults/${vault}/members`)).body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          user: expect.objectContaining({ id: member.id }),
          role: 'viewer',
        }),
      ]),
    });
    await expectStatus(reader, 'PUT', path, 403, {
      json: { role: 'editor' },
      headers: { 'if-match': '"1"' },
    });
    await expectStatus(reader, 'DELETE', path, 403, { headers: { 'if-match': '"1"' } });
    await expectStatus(manager, 'PUT', path, 422, { json: { role: 'invented' } });
    await expectStatus(manager, 'PUT', `/vaults/${vault}/members/${MISSING_ID}`, 404, {
      json: { role: 'viewer' },
    });
    await expectStatus(manager, 'DELETE', `/vaults/${vault}/members/${MISSING_ID}`, 404, {
      headers: { 'if-match': '"1"' },
    });
    await expectStatus(manager, 'DELETE', `/vaults/${vault}/members/invalid`, 422, {
      headers: { 'if-match': '"1"' },
    });
    await expectStatus(manager, 'DELETE', path, 428);
    await expectStatus(manager, 'DELETE', path, 409, { headers: { 'if-match': '"99"' } });
    await expectStatus(manager, 'DELETE', path, 204, { headers: { 'if-match': '"1"' } });
  });

  it('validates vault and profile bodies, and preserves the documentation access policy', async () => {
    const { vault } = await fixture();
    await expectStatus(manager, 'POST', '/vaults', 409, { json: { name: 'Response contracts' } });
    await expectStatus(manager, 'POST', '/vaults', 422, { json: { name: '' } });
    await expectStatus(reader, 'POST', '/vaults', 403, { json: { name: 'Not allowed' } });
    await expectStatus(manager, 'GET', '/vaults?limit=0', 422);
    await expectStatus(manager, 'GET', `/vaults/${MISSING_ID}`, 404);
    await expectStatus(manager, 'GET', `/vaults/${vault}`, 200);
    await expectStatus(manager, 'PATCH', '/me', 422, {
      json: { displayName: '' },
      headers: { 'if-match': '"1"' },
    });
    await expectStatus(reader, 'GET', '/docs', 403);
    const docs = await manager.get('/docs');
    expect(docs.status).toBe(200);
    await expect(docs).toMatchOpenApi('meta.docs', 200);
  });

  it('serves conditional Markdown and participants, refuses bad ranges, and bounds fresh projections', async () => {
    const { vault, note } = await fixture();
    const path = `/notes/${note}/markdown`;
    const first = await manager.get(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).not.toBeNull();
    await expectStatus(manager, 'GET', path, 304, { headers: { 'if-none-match': etag ?? '' } });
    await expectStatus(manager, 'GET', `${path}?lines=0-2`, 422);
    await expectStatus(manager, 'GET', `/notes/${MISSING_ID}/markdown`, 404);
    await expectStatus(manager, 'GET', `/notes/${note}/participants`, 200);
    await expectStatus(manager, 'GET', `/notes/${MISSING_ID}/participants`, 404);
    await expectStatus(manager, 'PUT', `/vaults/${vault}/members/${member.id}`, 201, {
      json: { role: 'viewer' },
    });
    const token = await insertToken(
      context.db,
      {
        ownerId: member.id,
        scopes: ['note:read'],
        vaultIds: [VaultId.parse(vault)],
        expiresAt: new Date(context.clock.now() + 60_000),
      },
      context.clock.now(),
    );
    await expectStatus(
      context.server.rest({ bearer: token.raw }),
      'GET',
      `${path}?fresh=true`,
      403,
    );
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- spend the per-principal/note budget in order
      await expectStatus(manager, 'GET', `${path}?fresh=true`, 200);
    }
    await expectStatus(manager, 'GET', `${path}?fresh=true`, 429);
  });

  it('documents the hidden metrics response when no token or CIDR is configured', async () => {
    // The worker schema admits one serving owner. Release the suite's lease before booting the
    // alternate configuration, then restore the configured server for any shuffled successor.
    expect(context.app.iridiumConfig.ops.metricsToken).toBe(METRICS_SECRET);
    await context.stop();
    context = await startAuthServer();
    try {
      expect(context.app.iridiumConfig.ops.metricsToken).toBeNull();
      expect(context.app.iridiumConfig.ops.metricsAllowCidrs).toEqual([]);
      const response = await context.server.rest().request('GET', '/metrics');
      expect(response.status).toBe(404);
      await expect(response).toMatchOpenApi('ops.metrics', 404);
    } finally {
      await context.stop();
      context = await startAuthServer({ extraEnv: { METRICS_TOKEN: METRICS_SECRET } });
    }
  });

  it('serves health and metrics, and reports draining readiness through the real HTTP surface', async () => {
    const health = await manager.request('GET', '/healthz');
    expect(health.status).toBe(200);
    await expect(health).toMatchOpenApi('ops.healthz', 200);
    const refusedMetrics = await manager.request('GET', '/metrics');
    expect(refusedMetrics.status).toBe(401);
    await expect(refusedMetrics).toMatchOpenApi('ops.metrics', 401);
    const metrics = await manager.request('GET', '/metrics', {
      headers: { authorization: `Bearer ${METRICS_SECRET}` },
    });
    expect(metrics.status).toBe(200);
    await expect(metrics).toMatchOpenApi('ops.metrics', 200);
    await context.clock.stall(2_000);
    const degraded = await manager.request('GET', '/healthz');
    expect(degraded.status).toBe(503);
    await expect(degraded).toMatchOpenApi('ops.healthz', 503);
    context.app.readiness.beginDrain();
    const readiness = await manager.request('GET', '/readyz');
    expect(readiness.status).toBe(503);
    await expect(readiness).toMatchOpenApi('ops.readyz', 503);
    await context.stop();
    context = await startAuthServer({ extraEnv: { METRICS_TOKEN: METRICS_SECRET } });
  });
});
