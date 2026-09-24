/** The fuzz adapter never retains a fixture when setup, execution or report collection fails. */
import { TOKEN_KINDS } from '@iridium/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({
  mkdir: vi.fn<(...args: readonly unknown[]) => Promise<void>>(),
  writeFile: vi.fn<(...args: readonly unknown[]) => Promise<void>>(),
  startEnv: vi.fn<(options: unknown) => Promise<unknown>>(),
  startServer: vi.fn<(options: unknown) => Promise<unknown>>(),
  startContainer: vi.fn<() => Promise<unknown>>(),
  expose: vi.fn<(port: number) => Promise<void>>(),
  exec: vi.fn<(args: readonly string[]) => Promise<{ exitCode: number; output: string }>>(),
  stopContainer: vi.fn<() => Promise<void>>(),
  startNetwork: vi.fn<() => Promise<unknown>>(),
  stopNetwork: vi.fn<() => Promise<void>>(),
  network: vi.fn<(value: unknown) => void>(),
  stopServer: vi.fn<() => Promise<void>>(),
  stopEnv: vi.fn<() => Promise<void>>(),
  environment: vi.fn<(values: Record<string, string>) => void>(),
  schema: vi.fn<(path: string) => Promise<{ status: number; body?: unknown }>>(),
  kernel: vi.fn<() => Promise<unknown>>(),
  rows: vi.fn<(sql: string) => Promise<readonly (readonly string[])[]>>(),
  networkName: vi.fn<() => string>(),
  fuzzIp: vi.fn<(network: string) => string>(),
  copy: vi.fn<(files: unknown) => void>(),
}));
vi.mock('node:fs/promises', () => ({ mkdir: io.mkdir, writeFile: io.writeFile }));
vi.mock('./env/start-test-env.ts', () => ({ startTestEnv: io.startEnv }));
vi.mock('./server/start-server.ts', () => ({ startServer: io.startServer }));
vi.mock('testcontainers', () => {
  const container = {
    withEntrypoint: () => container,
    withNetwork: (value: unknown) => {
      io.network(value);
      return container;
    },
    withEnvironment: (values: Record<string, string>) => {
      io.environment(values);
      return container;
    },
    withCommand: () => container,
    withCopyContentToContainer: (files: unknown) => {
      io.copy(files);
      return container;
    },
    withWaitStrategy: () => container,
    withStartupTimeout: () => container,
    start: io.startContainer,
  };
  return {
    Network: vi.fn<() => { start: typeof io.startNetwork }>(function () {
      return { start: io.startNetwork };
    }),
    GenericContainer: vi.fn<() => typeof container>(function () {
      return container;
    }),
    TestContainers: { exposeHostPorts: io.expose },
    Wait: { forLogMessage: vi.fn<(message: string) => void>() },
  };
});

import { prepareSchemathesisSchema, SCHEMATHESIS_CONFIG } from './contract/schemathesis-schema.ts';
import { runSchemathesis } from './contract/schemathesis.ts';

const AUTH_PROOF = { controlLogins: 1, protectedSuccesses: 3, authenticationFailed: false };
function proofOutput(text: string): string {
  return `${text}\nIRIDIUM_SCHEMATHESIS_AUTH_PROOF ${JSON.stringify(AUTH_PROOF)}`;
}

beforeEach(() => {
  vi.resetAllMocks();
  io.networkName.mockReturnValue('isolated-fuzz');
  io.fuzzIp.mockReturnValue('172.28.0.3');
  io.rows.mockResolvedValue([['172.28.0.1']]);
  io.startNetwork.mockResolvedValue({ stop: io.stopNetwork, getName: io.networkName });
  io.startEnv.mockResolvedValue({
    mysql: { image: 'mysql:8.4.11', templateSchema: 'iridium_tpl' },
    serverEnv: {},
    admin: { rows: io.rows },
    stop: io.stopEnv,
  });
  io.startServer.mockResolvedValue({
    port: 4007,
    origin: 'http://127.0.0.1:4007',
    seed: { kernel: io.kernel },
    stop: io.stopServer,
  });
  io.kernel.mockResolvedValue({
    admin: {
      id: 'admin',
      email: 'admin@iridium.test',
      password: 'synthetic-admin-password',
      isServerAdmin: true,
      client: { get: io.schema },
    },
    editorA: {
      id: 'editor',
      email: 'editor@iridium.test',
      password: 'synthetic-editor-password',
      isServerAdmin: false,
    },
    editorC: {
      id: 'editorC',
      email: 'editorC@iridium.test',
      password: 'synthetic-editor-c-password',
      isServerAdmin: false,
    },
    outsider: {
      id: 'outsider',
      email: 'outsider@iridium.test',
      password: 'synthetic-outsider-password',
      isServerAdmin: false,
    },
  });
  io.schema.mockResolvedValue({ status: 200, body: { openapi: '3.1.0', paths: {} } });
  io.startContainer.mockResolvedValue({
    exec: io.exec,
    stop: io.stopContainer,
    getIpAddress: io.fuzzIp,
  });
  io.exec
    .mockResolvedValueOnce({ exitCode: 0, output: proofOutput('Passed irid_ses_fixture-token') })
    .mockResolvedValueOnce({
      exitCode: 0,
      output: '<testsuite>irid_ses_fixture-token</testsuite>',
    });
});

describe('testkit.schemathesis.unit [area:testkit]', () => {
  it('resolves document, path and operation servers without losing constraints or mutating input', () => {
    const document = {
      openapi: '3.1.0',
      servers: [
        {
          url: '{publicOrigin}/api/v1',
          variables: { publicOrigin: { default: 'https://example.test' } },
        },
      ],
      components: { schemas: { Example: { type: 'string', minLength: 1 } } },
      paths: {
        '/notes/{id}': {
          parameters: [{ name: 'id', in: 'path' }],
          get: { operationId: 'notes.get', responses: { 200: { description: 'ok' } } },
        },
        '/healthz': { get: { operationId: 'ops.healthz', servers: [{ url: '/' }] } },
        '/scoped': { servers: [{ url: '/special' }], post: { operationId: 'scoped.post' } },
      },
    };
    const original = structuredClone(document);
    const result = prepareSchemathesisSchema(document, 'http://fixture.test:4007');
    expect(result['servers']).toEqual([{ url: 'http://fixture.test:4007' }]);
    expect(result['paths']).toEqual({
      '/api/v1/notes/{id}': document.paths['/notes/{id}'],
      '/healthz': { get: { operationId: 'ops.healthz' } },
      '/special/scoped': { post: { operationId: 'scoped.post' } },
    });
    expect(result['components']).toEqual(document.components);
    expect(document).toEqual(original);
  });

  it('rewrites local links with each target operation server and JSON Pointer escaping', () => {
    const getReference = '#/paths/~1nodes~1~01draft~1{id}/get';
    const postReference = '#%2Fpaths%2F~1nodes~1~01draft~1%7Bid%7D%2Fpost';
    const response = {
      description: 'linked',
      links: { get: { operationRef: getReference }, post: { operationRef: postReference } },
    };
    const document = {
      servers: [{ url: '/api/v1' }],
      paths: {
        '/links': { get: { responses: { 200: response } } },
        '/nodes/~1draft/{id}': {
          servers: [{ url: '/scoped' }],
          get: { operationId: 'getNode', servers: [{ url: '/read' }] },
          post: { operationId: 'postNode' },
        },
      },
      components: {
        links: { reusable: { operationRef: getReference } },
        responses: { reusable: response },
      },
    };
    const original = structuredClone(document);
    const result = prepareSchemathesisSchema(document, 'http://fixture.test');
    const resolvedResponse = {
      description: 'linked',
      links: {
        get: { operationRef: '#/paths/~1read~1nodes~1~01draft~1%7Bid%7D/get' },
        post: { operationRef: '#/paths/~1scoped~1nodes~1~01draft~1%7Bid%7D/post' },
      },
    };
    expect(result['paths']).toEqual({
      '/api/v1/links': { get: { responses: { 200: resolvedResponse } } },
      '/read/nodes/~1draft/{id}': { get: { operationId: 'getNode' } },
      '/scoped/nodes/~1draft/{id}': { post: { operationId: 'postNode' } },
    });
    expect(result['components']).toEqual({
      links: { reusable: resolvedResponse.links.get },
      responses: { reusable: resolvedResponse },
    });
    expect(document).toEqual(original);
  });

  it('rewrites links in callbacks, webhooks and reusable path items', () => {
    const response = { links: { next: { operationRef: '#/paths/~1next/get' } } };
    const item = { post: { responses: { 200: response } } };
    const callback = { '{$request.body#/callbackUrl}': item };
    const result = prepareSchemathesisSchema(
      {
        servers: [{ url: '/api' }],
        paths: {
          '/next': { get: {} },
          '/subscribe': { post: { callbacks: { changed: callback } } },
        },
        webhooks: { changed: item },
        components: { callbacks: { changed: callback }, pathItems: { changed: item } },
      },
      'http://fixture.test',
    );
    const expectedItem = {
      post: {
        responses: { 200: { links: { next: { operationRef: '#/paths/~1api~1next/get' } } } },
      },
    };
    const expectedCallback = { '{$request.body#/callbackUrl}': expectedItem };
    expect(result['paths']).toMatchObject({
      '/api/subscribe': { post: { callbacks: { changed: expectedCallback } } },
    });
    expect(result['webhooks']).toEqual({ changed: expectedItem });
    expect(result['components']).toEqual({
      callbacks: { changed: expectedCallback },
      pathItems: { changed: expectedItem },
    });
  });

  it('preserves external links, operationId links and operationRef fields in arbitrary data', () => {
    const data = { operationRef: '#/paths/~1missing/get' };
    const links = {
      absolute: { operationRef: 'https://external.test/openapi.json#/paths/~1next/get' },
      relative: { operationRef: '../other.json#/paths/~1next/get' },
      byId: { operationId: 'next', parameters: { example: data }, requestBody: data },
      byRef: { $ref: '#/components/links/absolute' },
    };
    const document = {
      servers: [{ url: '/api' }],
      paths: {
        '/next': {
          get: {
            operationId: 'next',
            responses: {
              200: { links, content: { 'application/json': { example: data } } },
              'x-example': { links: { example: data } },
            },
          },
        },
      },
      components: { links, schemas: { Example: { default: data } } },
      'x-example': data,
    };
    const result = prepareSchemathesisSchema(document, 'http://fixture.test');
    expect(result['paths']).toEqual({ '/api/next': document.paths['/next'] });
    expect(result['components']).toEqual(document.components);
    expect(result['x-example']).toEqual(data);
  });

  it.each([
    '',
    '#/paths/~1missing/get',
    '#/paths/~1next/post',
    '#/paths/~1next/get/responses',
    '#/paths/~2next/get',
    '#/paths/~1next%/get',
    '#/components/pathItems/next/get',
    '#next',
    42,
  ])('rejects a broken or unsupported local operationRef: %s', (operationRef) => {
    expect(() =>
      prepareSchemathesisSchema(
        {
          paths: { '/next': { get: {} } },
          components: { links: { invalid: { operationRef } } },
        },
        'http://fixture.test',
      ),
    ).toThrow('operationRef');
  });
  it('rejects invalid or colliding schema paths instead of silently losing coverage', () => {
    expect(() => prepareSchemathesisSchema({}, 'https://fixture.test')).toThrow('paths object');
    expect(() =>
      prepareSchemathesisSchema({ paths: { '/x': { $ref: '#/bad' } } }, 'https://fixture.test'),
    ).toThrow('resolved path');
    expect(() =>
      prepareSchemathesisSchema(
        { servers: [{ url: '{absent}' }], paths: { '/x': { get: {} } } },
        'https://fixture.test',
      ),
    ).toThrow('no default');
    expect(() =>
      prepareSchemathesisSchema(
        { servers: [{}], paths: { '/x': { get: {} } } },
        'https://fixture.test',
      ),
    ).toThrow('invalid OpenAPI server');
    expect(() =>
      prepareSchemathesisSchema({ paths: { '/x': { get: null } } }, 'https://fixture.test'),
    ).toThrow('Invalid fuzz operation');
    expect(() =>
      prepareSchemathesisSchema(
        { paths: { '/x': { get: { servers: [{ url: '/api' }] } }, '/api/x': { get: {} } } },
        'https://fixture.test',
      ),
    ).toThrow('Duplicate fuzz operation');
  });

  it('keeps checks enabled and scopes the expired-token response to its operation', () => {
    expect(SCHEMATHESIS_CONFIG).not.toContain('enabled = false');
    expect(SCHEMATHESIS_CONFIG).toContain('include-name = "POST /api/v1/auth/set-password"');
    expect(SCHEMATHESIS_CONFIG).toContain('400, 401, 403, 404, 406, 409, 415, 422, 428, 429');
    expect(SCHEMATHESIS_CONFIG.split('[[operations]]')[0]).not.toContain('410');
  });

  it.each(['light', 'full'] as const)(
    'configures the %s budget and removes all resources',
    async (profile) => {
      const result = await runSchemathesis({ profile });
      const args = io.exec.mock.calls[0]?.[0] ?? [];
      expect(args).toContain(profile === 'light' ? '50' : '250');
      expect(args).toContain('examples,coverage,fuzzing,stateful');
      expect(args).toContain('all');
      expect(args).toContain('--origin');
      expect(args).toContain('Host: 127.0.0.1:4007');
      expect(args).toContain('X-Iridium-Client: desktop');
      expect(io.startEnv).toHaveBeenCalledWith({ productionCredentials: true });
      expect(io.expose).toHaveBeenCalledWith(4007);
      expect(result.output).toBe(proofOutput('Passed [REDACTED]'));
      expect(result.reportPath).toContain(
        `${profile}-${profile === 'light' ? 'editorA' : 'admin'}.xml`,
      );
      expect(args).toContain(
        profile === 'light'
          ? '^/(?:api/v1/)?(?:admin|__test__)(?:/|$)'
          : '^/(?:api/v1/)?__test__(?:/|$)',
      );
      expect(io.writeFile.mock.calls.every((call) => !String(call[1]).includes('irid_ses_'))).toBe(
        true,
      );
      expect(io.stopContainer).toHaveBeenCalledOnce();
      expect(io.stopServer).toHaveBeenCalledOnce();
      expect(io.stopEnv).toHaveBeenCalledOnce();
    },
  );

  it('separates fuzz traffic from fixture logins using actual network paths', async () => {
    await runSchemathesis({ profile: 'light' });
    expect(io.network).toHaveBeenCalledExactlyOnceWith({
      stop: io.stopNetwork,
      getName: io.networkName,
    });
    expect(io.startServer).toHaveBeenCalledWith(
      expect.objectContaining({
        containerNetwork: {
          network: { stop: io.stopNetwork, getName: io.networkName },
          aliases: ['iridium-fuzz-server'],
        },
      }),
    );
    expect(io.exec.mock.calls[0]?.[0]).toContain('http://iridium-fuzz-server:4000');
    expect(io.stopNetwork).toHaveBeenCalledOnce();
    expect(io.copy.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: '/tmp/iridium-auth.json',
          content: expect.stringContaining(
            'http://host.testcontainers.internal:4007/api/v1/auth/sessions',
          ),
        }),
      ]),
    );
  });

  it.each([{ sources: [] }, { sources: [['172.28.0.3']] }])(
    'refuses an unproven authentication control source: %j',
    async ({ sources }) => {
      io.rows.mockResolvedValue(sources);
      const result = await runSchemathesis({ profile: 'light' });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('source isolation was not established');
      expect(io.stopNetwork).toHaveBeenCalledOnce();
      expect(io.stopEnv).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'missing proof',
    'IRIDIUM_SCHEMATHESIS_AUTH_PROOF not-json',
    'IRIDIUM_SCHEMATHESIS_AUTH_PROOF null',
    'IRIDIUM_SCHEMATHESIS_AUTH_PROOF {"controlLogins":1,"protectedSuccesses":0,"authenticationFailed":false}',
    'IRIDIUM_SCHEMATHESIS_AUTH_PROOF {"controlLogins":1,"protectedSuccesses":3,"authenticationFailed":true}',
  ])('refuses a nominal pass without authenticated coverage: %s', async (output) => {
    io.exec
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, output })
      .mockResolvedValueOnce({ exitCode: 0, output: '<testsuite />' });
    const result = await runSchemathesis({ profile: 'light' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Authenticated fuzz coverage was not established.');
    expect(io.stopEnv).toHaveBeenCalledOnce();
  });

  it('uses a non-admin editor for light requests and the admin only for schema export', async () => {
    await runSchemathesis({ profile: 'light' });
    expect(io.schema).toHaveBeenCalledExactlyOnceWith('/openapi.json');
    expect(io.copy).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining([
        {
          target: '/tmp/iridium-auth.json',
          content: JSON.stringify({
            url: 'http://host.testcontainers.internal:4007/api/v1/auth/sessions',
            host: '127.0.0.1:4007',
            email: 'editor@iridium.test',
            password: 'synthetic-editor-password',
            userId: 'editor',
            spareUserId: 'editorc',
          }),
        },
      ]),
    );
    expect(JSON.stringify(io.copy.mock.calls)).not.toContain('synthetic-admin-password');
  });

  it('refuses a light fixture whose editor was promoted to server admin', async () => {
    io.kernel.mockResolvedValue({ editorA: { isServerAdmin: true } });
    await expect(runSchemathesis({ profile: 'light' })).rejects.toThrow('non-admin editor');
    expect(io.copy).not.toHaveBeenCalled();
    expect(io.startContainer).not.toHaveBeenCalled();
    expect(io.stopServer).toHaveBeenCalledOnce();
    expect(io.stopEnv).toHaveBeenCalledOnce();
  });

  it('uses the outsider only in an independently owned synthetic deployment', async () => {
    const result = await runSchemathesis({ profile: 'full', principal: 'outsider' });
    expect(io.copy.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: '/tmp/iridium-auth.json',
          content: expect.stringContaining('outsider@iridium.test'),
        }),
      ]),
    );
    expect(result.reportPath).toContain('full-outsider.xml');
  });

  it('loads refreshable fixture authentication without credentials in command arguments or reports', async () => {
    io.exec
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, output: proofOutput('synthetic-editor-password') })
      .mockResolvedValueOnce({
        exitCode: 0,
        output: '<testsuite>synthetic-editor-password</testsuite>',
      });
    const result = await runSchemathesis({ profile: 'light' });
    expect(io.environment).toHaveBeenCalledExactlyOnceWith({
      SCHEMATHESIS_HOOKS: 'iridium_auth',
      PYTHONPATH: '/tmp',
    });
    expect(io.copy.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: '/tmp/iridium_auth.py',
          content: expect.stringContaining('refresh_interval=None'),
        }),
        expect.objectContaining({
          target: '/tmp/iridium-auth.json',
          content: expect.stringContaining(
            'http://host.testcontainers.internal:4007/api/v1/auth/sessions',
          ),
        }),
      ]),
    );
    expect(io.exec.mock.calls.flat(2).join(' ')).not.toContain('synthetic-editor-password');
    expect(io.exec.mock.calls.flat(2).join(' ')).not.toContain('Authorization: Bearer');
    expect(result.output).toBe(proofOutput('[REDACTED]'));
    for (const call of io.writeFile.mock.calls)
      expect(String(call[1])).not.toContain('synthetic-editor-password');
  });

  it('keeps the administrator profile from fuzzing away the identity it signs in with', async () => {
    await runSchemathesis({ profile: 'full', principal: 'admin' });
    expect(io.copy.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: '/tmp/iridium-auth.json',
          // The spare is a real seeded account, so both operations still run against a live user.
          content: expect.stringContaining('"userId":"admin","spareUserId":"editorc"'),
        }),
        expect.objectContaining({
          target: '/tmp/iridium_auth.py',
          // Named operations only, redirected in `before_call` so a stateful link is covered too.
          content: expect.stringContaining('"/api/v1/admin/users/{userId}/reset-password"'),
        }),
        expect.objectContaining({
          target: '/tmp/iridium_auth.py',
          content: expect.stringContaining('"/api/v1/admin/users/{userId}/disable"'),
        }),
        expect.objectContaining({
          target: '/tmp/iridium_auth.py',
          content: expect.stringContaining('def before_call(context, case, kwargs):'),
        }),
        expect.objectContaining({
          target: '/tmp/iridium_auth.py',
          content: expect.stringContaining('_fixture_sessions.protect(case)'),
        }),
        expect.objectContaining({
          target: '/tmp/iridium_auth.py',
          // A recorded null redrawn into a path renders /vaults/None; the case is filtered out
          // before it is sent, not raised from a call hook, which aborts the stateful phase.
          content: expect.stringContaining('def filter_case(context, case):'),
        }),
      ]),
    );
  });

  it.each(TOKEN_KINDS)('redacts %s credentials from both retained reports', async (kind) => {
    const token = `irid_${kind}_fixture-secret`;
    io.exec
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, output: proofOutput(`response: ${token}`) })
      .mockResolvedValueOnce({ exitCode: 0, output: `<testsuite>${token}</testsuite>` });
    const result = await runSchemathesis({ profile: 'light' });
    expect(result.output).toBe(proofOutput('response: [REDACTED]'));
    expect(io.writeFile.mock.calls).toHaveLength(3);
    for (const call of io.writeFile.mock.calls) {
      expect(String(call[1])).not.toContain(token);
    }
  });

  it('retains a failing fuzzer exit and its sanitized report', async () => {
    io.exec
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 1, output: proofOutput('Failure irid_pat_fixture') })
      .mockResolvedValueOnce({ exitCode: 0, output: '<testsuite failures="1" />' });
    const result = await runSchemathesis({ profile: 'light' });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe(proofOutput('Failure [REDACTED]'));
    expect(io.stopEnv).toHaveBeenCalledOnce();
  });

  it.each([
    { operation: 'startServer', serverStops: 0, containerStops: 0 },
    { operation: 'startNetwork', serverStops: 0, containerStops: 0 },
    { operation: 'stopNetwork', serverStops: 1, containerStops: 1 },
    { operation: 'startContainer', serverStops: 1, containerStops: 0 },
    { operation: 'exec', serverStops: 1, containerStops: 1 },
    { operation: 'stopContainer', serverStops: 1, containerStops: 1 },
    { operation: 'stopServer', serverStops: 1, containerStops: 1 },
  ] as const)(
    'joins remaining cleanup when $operation fails',
    async ({ operation, serverStops, containerStops }) => {
      io[operation].mockReset().mockRejectedValue(new Error(operation));
      await expect(runSchemathesis({ profile: 'light' })).rejects.toThrow(operation);
      expect(io.stopEnv).toHaveBeenCalledOnce();
      expect(io.stopServer).toHaveBeenCalledTimes(serverStops);
      expect(io.stopContainer).toHaveBeenCalledTimes(containerStops);
    },
  );

  it('refuses an unavailable schema before starting the fuzzer', async () => {
    io.schema.mockResolvedValue({ status: 403 });
    await expect(runSchemathesis({ profile: 'light' })).rejects.toThrow('OpenAPI document');
    expect(io.startContainer).not.toHaveBeenCalled();
    expect(io.stopEnv).toHaveBeenCalledOnce();
  });

  it('refuses a missing report even if the process claims success', async () => {
    io.exec
      .mockReset()
      .mockResolvedValueOnce({ exitCode: 0, output: proofOutput('done') })
      .mockResolvedValueOnce({ exitCode: 1, output: 'missing' });
    await expect(runSchemathesis({ profile: 'light' })).rejects.toThrow('no JUnit report');
    expect(io.stopContainer).toHaveBeenCalledOnce();
    expect(io.stopEnv).toHaveBeenCalledOnce();
  });
});
