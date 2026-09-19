/**
 * `authz.rest-viewer.integration` — the REST half of the viewer-enforcement row
 * (10-testing-and-quality.md, "Authorization"; 04-auth-and-access-control.md §5.4; A30).
 *
 * **Scoped by permission, never by verb.** A blanket "a viewer is refused every mutation" would
 * contradict the permission matrix, which grants a viewer real writes at later milestones
 * (`POST /vaults/:vaultId/exports` is a viewer route). So each vault-scoped route of `M1_ROUTES` is
 * driven as the viewer and its expectation is computed from `matrixAllows('viewer', permission)`:
 * a permission the viewer holds must answer the documented success, and one it does not must answer
 * `403 forbidden` — never `404`, because the viewer *can* see the vault and hiding it would be a
 * different claim.
 *
 * **The case table is exhaustive by construction.** It is declared `satisfies Record<K, Case>` over
 * the vault-scoped operation ids of the milestone, so a route added to `M1_ROUTES` without a case
 * here does not compile. That is the mechanism the plan asks for, and it is why this file does not
 * need to be remembered when the route set grows.
 *
 * **Nothing is written by a refusal.** Every refused call is bracketed by a row-count snapshot of the
 * tables an M1 write can touch: a `403` that still inserted a row would otherwise look identical to a
 * `403` that did not.
 */
import { matrixAllows, M1_ROUTES, VaultId, type Permission } from '@iridium/contracts';
import type { RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import type { Database } from '../../src/db/index.ts';
import {
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';
import { documentedApiRoutes, servedApiRoutes } from '../support/route-sources.ts';
import { insertMembership, seedUser, signInWeb, type SeededUser } from '../support/seed.ts';

/** The vault-scoped operations M1 registers; the case table is keyed by exactly these. */
type VaultScopedOperation =
  | 'vaults.get'
  | 'members.list'
  | 'members.put'
  | 'members.delete'
  | 'nodes.create'
  | 'notes.get'
  | 'notes.getMarkdown'
  | 'notes.participants';

/** What one route needs to be driven, and what a permitted call should answer. */
interface Case {
  readonly permission: Permission;
  /** The documented success status when the caller holds the permission. */
  readonly allowed: number;
  request(client: RestClient, fixture: Fixture): Promise<{ status: number }>;
}

/** The rows every case addresses. */
interface Fixture {
  readonly vaultId: string;
  readonly rootNodeId: string;
  readonly noteId: string;
  readonly otherUserId: string;
}

/** The tables an M1 write can touch; a refusal must leave every one of them alone. */
const WRITABLE_TABLES = [
  'nodes',
  'notes',
  'vault_members',
  'note_updates',
  'audit_events',
] as const satisfies readonly (keyof Database)[];

const CASES = {
  'vaults.get': {
    permission: 'vault:read',
    allowed: 200,
    request: (client, fixture) => client.get(`/vaults/${fixture.vaultId}`),
  },
  'members.list': {
    permission: 'vault:read',
    allowed: 200,
    request: (client, fixture) => client.get(`/vaults/${fixture.vaultId}/members`),
  },
  'members.put': {
    permission: 'vault:manage_members',
    allowed: 201,
    request: (client, fixture) =>
      client.put(`/vaults/${fixture.vaultId}/members/${fixture.otherUserId}`, {
        json: { role: 'editor' },
      }),
  },
  'members.delete': {
    permission: 'vault:manage_members',
    allowed: 204,
    request: (client, fixture) =>
      client.del(`/vaults/${fixture.vaultId}/members/${fixture.otherUserId}`, {
        headers: { 'if-match': '"1"' },
      }),
  },
  'nodes.create': {
    permission: 'node:create',
    allowed: 201,
    request: (client, fixture) =>
      client.post(`/vaults/${fixture.vaultId}/nodes`, {
        json: { kind: 'note', parentId: fixture.rootNodeId, name: 'Viewer Attempt' },
      }),
  },
  'notes.get': {
    permission: 'note:read',
    allowed: 200,
    request: (client, fixture) => client.get(`/notes/${fixture.noteId}`),
  },
  'notes.getMarkdown': {
    permission: 'note:read',
    allowed: 200,
    request: (client, fixture) => client.get(`/notes/${fixture.noteId}/markdown`),
  },
  'notes.participants': {
    permission: 'note:read',
    allowed: 200,
    request: (client, fixture) => client.get(`/notes/${fixture.noteId}/participants`),
  },
} as const satisfies Record<VaultScopedOperation, Case>;

/** The cases split by what the matrix grants a viewer, so neither assertion is conditional. */
const ENTRIES = Object.entries(CASES);
const PERMITTED = ENTRIES.filter(([, testCase]) => matrixAllows('viewer', testCase.permission));
const REFUSED = ENTRIES.filter(([, testCase]) => !matrixAllows('viewer', testCase.permission));

let context: AuthTestServer;
let admin: SeededUser;
let viewer: SeededUser;
let adminClient: RestClient;
let viewerClient: RestClient;
let fixture: Fixture;

/** One row count per table an M1 write can touch. */
async function rowCounts(): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const table of WRITABLE_TABLES) {
    // Sequential by design: five counts against one connection, and the order makes the failure
    // message name the table rather than a promise index.
    // eslint-disable-next-line no-await-in-loop -- five counting statements, in a named order
    const row = await context.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll().as('rows'))
      .executeTakeFirstOrThrow();
    counts[table] = Number(row.rows);
  }
  return counts;
}

// Registered at collection time; see `support/openapi-coverage.ts` for why it cannot go in a hook.
registerRecordingOpenApiMatcher();

beforeAll(async () => {
  context = await startAuthServer();
});

beforeEach(async () => {
  admin = await seedUser(context, { email: 'viewer-admin@example.test', isServerAdmin: true });
  viewer = await seedUser(context, { email: 'viewer-member@example.test' });
  const spare = await seedUser(context, { email: 'viewer-spare@example.test' });
  adminClient = webClient(context, await signInWeb(context, admin));
  viewerClient = webClient(context, await signInWeb(context, viewer));

  const vault = await adminClient.post<{ id: string; rootNodeId: string }>('/vaults', {
    json: { name: 'Viewer Vault' },
    headers: webHeaders(context.origin),
  });
  if (vault.status !== 201) throw new Error(`POST /vaults answered ${String(vault.status)}`);

  await insertMembership(
    context.db,
    {
      vaultId: VaultId.parse(vault.body.id),
      userId: viewer.id,
      role: 'viewer',
      grantedBy: admin.id,
    },
    context.clock.now(),
  );
  await insertMembership(
    context.db,
    {
      vaultId: VaultId.parse(vault.body.id),
      userId: spare.id,
      role: 'editor',
      grantedBy: admin.id,
    },
    context.clock.now(),
  );

  const note = await adminClient.post<{ id: string }>(`/vaults/${vault.body.id}/nodes`, {
    json: { kind: 'note', parentId: vault.body.rootNodeId, name: 'Viewer Note', markdown: '# n\n' },
    headers: webHeaders(context.origin),
  });
  if (note.status !== 201) throw new Error(`POST nodes answered ${String(note.status)}`);

  fixture = {
    vaultId: vault.body.id,
    rootNodeId: vault.body.rootNodeId,
    noteId: note.body.id,
    otherUserId: spare.id,
  };
});

afterAll(async () => {
  await context.stop();
});

describe('authz.rest-viewer.integration [spec:viewer-enforcement]', () => {
  it('drives a route set both sources agree on (D10-26)', () => {
    // The live instance and the committed document fail in opposite directions — the instance grows
    // a route nobody documented, the document keeps one nobody registered — and either alone is
    // satisfied by an incomplete table. So the two are compared before any member below is exercised.
    expect(servedApiRoutes(context.app)).toStrictEqual(documentedApiRoutes());
  });

  it('drives every vault-scoped route of the milestone', () => {
    // The table is the enumeration; this asserts it is the *same* enumeration the manifest carries,
    // so a route that gained a vault permission cannot slip past a `satisfies` that still compiles.
    const scoped = M1_ROUTES.filter(
      (row) => typeof row.auth === 'object' && 'vaultFrom' in row.auth,
    ).map((row) => row.operationId);
    expect(scoped.toSorted()).toStrictEqual(Object.keys(CASES).toSorted());
  });

  it.each(PERMITTED)(
    '%s answers its documented success for a viewer',
    async (operationId: string, testCase: Case) => {
      const response = await testCase.request(viewerClient, fixture);
      expect(response.status, `${operationId} refused a permission the viewer holds`).toBe(
        testCase.allowed,
      );
    },
  );

  it.each(REFUSED)(
    '%s refuses a viewer with 403 and writes nothing',
    async (operationId: string, testCase: Case) => {
      const before = await rowCounts();
      // One client for both halves: the harness's cookie client sends `Origin` and `Sec-Fetch-Site`
      // on every unsafe method, so a refusal here is the route policy's and never the CSRF guard's.
      const response = await testCase.request(viewerClient, fixture);

      // A member who cannot do the thing is `403`; a non-member is `404`. Answering `404` here would
      // hide a vault the caller can plainly read (04 section 5.4).
      expect(response.status, `${operationId} did not refuse a viewer`).toBe(403);
      expect(await rowCounts(), `${operationId} wrote a row while refusing`).toStrictEqual(before);
    },
  );

  it('still lets the viewer read the vault it belongs to', async () => {
    const response = await viewerClient.get<{ role: string; effectiveRole: string }>(
      `/vaults/${fixture.vaultId}`,
    );
    expect(response.status).toBe(200);
    await expect(response).toMatchOpenApi('vaults.get', 200);
    expect(response.body.role).toBe('viewer');
    expect(response.body.effectiveRole).toBe('viewer');
  });

  it('refuses a viewer the routes that create content, with the documented body', async () => {
    const refused = await viewerClient.post(`/vaults/${fixture.vaultId}/nodes`, {
      json: { kind: 'note', parentId: fixture.rootNodeId, name: 'Nope' },
      headers: webHeaders(context.origin),
    });
    expect(refused.status).toBe(403);
    await expect(refused).toMatchOpenApi('nodes.create', 403);
  });

  it('answers a server administrator as a manager without a membership row', async () => {
    const response = await adminClient.get<{ role: string | null; effectiveRole: string }>(
      `/vaults/${fixture.vaultId}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.role).toBeNull();
    expect(response.body.effectiveRole).toBe('manager');

    const rows = await context.db
      .selectFrom('vault_members')
      .select('user_id')
      .where('vault_id', '=', idBytes(fixture.vaultId))
      .where('user_id', '=', idBytes(admin.id))
      .execute();
    expect(rows).toStrictEqual([]);
  });
});
