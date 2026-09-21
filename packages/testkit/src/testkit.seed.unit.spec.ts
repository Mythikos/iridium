import { newId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { restClient } from './clients/rest-client.ts';
import { KERNEL_NOTE_NAME, KERNEL_VAULT_NAME } from './seed/kernel.ts';
import { SEED_PASSWORD, createSeedApi, setPasswordTokenFrom } from './seed/seed.ts';
import type { CliResult } from './server/cli.ts';

/**
 * `seed.kernel()` against a scripted server.
 *
 * What this pins is the plan's rule that *"state enters the system through product paths"*: the
 * assertion is the exact sequence of routes and CLI commands the seed drives, so a seed that started
 * inserting rows directly, or that stopped consuming a set-password link, fails here rather than
 * silently making every later suite prove less than it claims.
 *
 * The server is scripted rather than mocked: `restClient` takes its `fetch` by injection, which is
 * the host seam the plan allows a `unit` test to replace.
 */

const ORIGIN = 'http://127.0.0.1:4000';

/** A JSON response, the shape every scripted route answers with. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

function scriptedServer(): {
  calls: RecordedCall[];
  cliArgs: string[][];
  fetch: typeof globalThis.fetch;
  cli: (args: readonly string[]) => Promise<CliResult>;
} {
  const calls: RecordedCall[] = [];
  const cliArgs: string[][] = [];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : '';
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) headers[key] = value;
    calls.push({
      method,
      path: url.pathname,
      body: raw === '' ? undefined : JSON.parse(raw),
      headers,
    });

    if (url.pathname === '/api/v1/auth/set-password') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname === '/api/v1/auth/sessions') {
      return Promise.resolve(
        json(
          201,
          { user: { id: newId() }, session: { id: newId(), kind: 'web' } },
          { 'set-cookie': '__Host-iridium_session=fixture; Path=/; Secure; HttpOnly' },
        ),
      );
    }
    if (url.pathname === '/api/v1/auth/reauthenticate') {
      return Promise.resolve(
        json(200, {
          lastAuthenticatedAt: '2026-09-14T00:00:00.000Z',
          stepUpExpiresAt: '2026-09-14T00:10:00.000Z',
        }),
      );
    }
    if (url.pathname === '/api/v1/admin/users') {
      return Promise.resolve(
        json(201, {
          user: { id: newId() },
          setPasswordLink: `${ORIGIN}/set-password#irid_spl_${'a'.repeat(16)}_${'b'.repeat(43)}123456`,
          expiresAt: '2026-09-15T00:00:00.000Z',
        }),
      );
    }
    if (url.pathname === '/api/v1/vaults') {
      return Promise.resolve(json(201, { id: newId(), rootNodeId: newId(), version: 1 }));
    }
    if (url.pathname.includes('/members/')) {
      return Promise.resolve(json(201, { role: 'editor', version: 1 }));
    }
    if (url.pathname.endsWith('/nodes')) {
      return Promise.resolve(json(201, { id: newId() }));
    }
    return Promise.resolve(json(404, { title: 'not found' }));
  };

  const cli = (args: readonly string[]): Promise<CliResult> => {
    cliArgs.push([...args]);
    return Promise.resolve({
      code: 0,
      signal: null,
      stdout: `Created user.\nSet password: ${ORIGIN}/set-password#irid_spl_${'c'.repeat(16)}_${'d'.repeat(43)}654321\n`,
      stderr: '',
    });
  };

  return { calls, cliArgs, fetch: fetchImpl, cli };
}

function seedFor(server: ReturnType<typeof scriptedServer>): ReturnType<typeof createSeedApi> {
  return createSeedApi({
    client: () => restClient({ origin: ORIGIN, fetch: server.fetch }),
    cli: server.cli,
  });
}

describe('testkit.seed.unit [area:testkit]', () => {
  it('bootstraps the first administrator through the CLI, not through a route', async () => {
    const server = scriptedServer();
    await seedFor(server).admin();

    expect(server.cliArgs).toStrictEqual([
      [
        'admin',
        'create-user',
        '--email',
        'admin@iridium.test',
        '--display-name',
        'Seed Admin',
        '--server-admin',
      ],
    ]);
    // The printed link is consumed: no plaintext password ever passes through an administrator.
    expect(server.calls[0]).toMatchObject({ method: 'POST', path: '/api/v1/auth/set-password' });
    expect(server.calls[1]).toMatchObject({ method: 'POST', path: '/api/v1/auth/sessions' });
  });

  it('creates the first administrator exactly once, however often it is asked for', async () => {
    const server = scriptedServer();
    const seed = seedFor(server);
    const [first, second] = await Promise.all([seed.admin(), seed.admin()]);

    expect(first).toBe(second);
    expect(server.cliArgs).toHaveLength(1);
  });

  it('drives the documented route for every kind of row', async () => {
    const server = scriptedServer();
    const kernel = await seedFor(server).kernel();

    const routes = server.calls.map((call) => `${call.method} ${call.path}`);
    expect(routes.filter((route) => route === 'POST /api/v1/admin/users')).toHaveLength(5);
    expect(routes).toContain('POST /api/v1/vaults');
    expect(routes.filter((route) => route.includes('/members/'))).toHaveLength(4);
    expect(routes.some((route) => route.endsWith('/nodes'))).toBe(true);
    // One set-password call per account: the bootstrap admin plus the five the admin created.
    expect(routes.filter((route) => route === 'POST /api/v1/auth/set-password')).toHaveLength(6);

    expect(kernel.vault.name).toBe(KERNEL_VAULT_NAME);
    expect(kernel.note.name).toBe(KERNEL_NOTE_NAME);
  });

  it('seeds the cast the M1 suite is written against, with the outsider a member of nothing', async () => {
    const server = scriptedServer();
    const kernel = await seedFor(server).kernel();

    expect([
      kernel.editorA.email,
      kernel.editorB.email,
      kernel.editorC.email,
      kernel.viewer.email,
      kernel.outsider.email,
    ]).toStrictEqual([
      'editorA@iridium.test',
      'editorB@iridium.test',
      'editorC@iridium.test',
      'viewer@iridium.test',
      'outsider@iridium.test',
    ]);
    expect(kernel.members.map(([user, role]) => `${user.email}:${role}`)).toStrictEqual([
      'editorA@iridium.test:editor',
      'editorB@iridium.test:editor',
      'editorC@iridium.test:editor',
      'viewer@iridium.test:viewer',
    ]);
    expect(kernel.members.some(([user]) => user.email === kernel.outsider.email)).toBe(false);
    // The administrator is a server admin and therefore an implied manager: no membership row.
    expect(kernel.members.some(([user]) => user.email === kernel.admin.email)).toBe(false);
  });

  it('seeds note N with the import marker exactly once', async () => {
    const server = scriptedServer();
    const kernel = await seedFor(server).kernel();

    expect(kernel.note.markdown).toContain('⟦IMPORT-MARK⟧');
    expect(kernel.note.markdown.split('⟦IMPORT-MARK⟧')).toHaveLength(2);
  });

  it('creates the note under the vault root the create response named', async () => {
    const server = scriptedServer();
    const kernel = await seedFor(server).kernel();

    const created = server.calls.find((call) => call.path.endsWith('/nodes'));
    expect(created?.body).toMatchObject({
      kind: 'note',
      parentId: kernel.vault.rootNodeId,
      name: KERNEL_NOTE_NAME,
    });
  });

  it('sends what a browser sends on an unsafe cookie request', async () => {
    const server = scriptedServer();
    await seedFor(server).admin();

    const login = server.calls.find((call) => call.path === '/api/v1/auth/sessions');
    expect(login?.headers['x-iridium-client']).toBe('web');
    expect(login?.headers['origin']).toBe(ORIGIN);
    expect(login?.headers['sec-fetch-site']).toBe('same-origin');
  });

  it('uses the obviously fake fixture credential everywhere', async () => {
    const server = scriptedServer();
    const kernel = await seedFor(server).kernel();

    expect(SEED_PASSWORD).toContain('not-a-secret');
    for (const user of [kernel.admin, kernel.editorA, kernel.outsider]) {
      expect(user.password).toBe(SEED_PASSWORD);
    }
  });

  it('refuses a link whose fragment is not a set-password credential', () => {
    expect(() => setPasswordTokenFrom(`${ORIGIN}/set-password`)).toThrow(/irid_spl_/);
    expect(() => setPasswordTokenFrom(`${ORIGIN}/set-password#irid_tkt_x`)).toThrow(/irid_spl_/);
  });

  it('refuses unsupported bulk seeding before creating any user or vault', async () => {
    const server = scriptedServer();
    await expect(seedFor(server).structure()).rejects.toThrow(/in-process structureWriter adapter/);
    expect(server.cliArgs).toEqual([]);
    expect(server.calls).toEqual([]);
  });
});
