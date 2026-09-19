/**
 * `authz.vault-isolation.integration` — knowing an identifier grants nothing
 * (10-testing-and-quality.md, "Authorization"; 04-auth-and-access-control.md §5.4; skeleton F13).
 *
 * `outsider` holds a valid session and no membership anywhere. Every route of the milestone that
 * takes a vault, node or note id is driven twice: once with the **real** ids of a vault they are not
 * a member of, and once with syntactically valid random ids that name nothing. Both must answer
 * `404 not_found`, and the two answers must be indistinguishable — a `403` on the real id would tell
 * the caller the row exists, which is the whole of what this row is about.
 *
 * **The enumeration is the manifest's, not a list here.** The routes are taken from `M1_ROUTES` by
 * their `vaultFrom` member, and the case table is `satisfies Record<K, Case>` over the same ids, so a
 * route that gains an id parameter without a case does not compile.
 *
 * A mutating route is driven too, with its CSRF headers, because the refusal must come from the route
 * policy rather than from the guard in front of it.
 */
import { M1_ROUTES, newId } from '@iridium/contracts';
import type { RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';
import { documentedApiRoutes, servedApiRoutes } from '../support/route-sources.ts';
import { seedUser, signInWeb, type SeededUser } from '../support/seed.ts';

/** The id-bearing operations M1 registers. */
type IdBearingOperation =
  | 'vaults.get'
  | 'members.list'
  | 'members.put'
  | 'members.delete'
  | 'nodes.create'
  | 'notes.get'
  | 'notes.getMarkdown'
  | 'notes.participants';

/** The ids one drive addresses: either the real rows, or ids that name nothing. */
interface Target {
  readonly vaultId: string;
  readonly rootNodeId: string;
  readonly noteId: string;
  readonly userId: string;
}

interface Case {
  request(client: RestClient, target: Target): Promise<{ status: number }>;
}

const CASES = {
  'vaults.get': { request: (client, t) => client.get(`/vaults/${t.vaultId}`) },
  'members.list': { request: (client, t) => client.get(`/vaults/${t.vaultId}/members`) },
  'members.put': {
    request: (client, t) =>
      client.put(`/vaults/${t.vaultId}/members/${t.userId}`, { json: { role: 'editor' } }),
  },
  'members.delete': {
    request: (client, t) =>
      client.del(`/vaults/${t.vaultId}/members/${t.userId}`, { headers: { 'if-match': '"1"' } }),
  },
  'nodes.create': {
    request: (client, t) =>
      client.post(`/vaults/${t.vaultId}/nodes`, {
        json: { kind: 'note', parentId: t.rootNodeId, name: 'Outsider Attempt' },
      }),
  },
  'notes.get': { request: (client, t) => client.get(`/notes/${t.noteId}`) },
  'notes.getMarkdown': { request: (client, t) => client.get(`/notes/${t.noteId}/markdown`) },
  'notes.participants': { request: (client, t) => client.get(`/notes/${t.noteId}/participants`) },
} as const satisfies Record<IdBearingOperation, Case>;

let context: AuthTestServer;
let outsiderClient: RestClient;
let memberClient: RestClient;
let real: Target;

/** Ids that are well-formed and name nothing. */
function absent(): Target {
  return { vaultId: newId(), rootNodeId: newId(), noteId: newId(), userId: newId() };
}

// Registered at collection time; see `support/openapi-coverage.ts` for why it cannot go in a hook.
registerRecordingOpenApiMatcher();

beforeAll(async () => {
  context = await startAuthServer();
});

beforeEach(async () => {
  const admin: SeededUser = await seedUser(context, {
    email: 'isolation-admin@example.test',
    isServerAdmin: true,
  });
  const outsider = await seedUser(context, { email: 'isolation-outsider@example.test' });
  const adminClient = webClient(context, await signInWeb(context, admin));
  outsiderClient = webClient(context, await signInWeb(context, outsider));
  memberClient = adminClient;

  const vault = await adminClient.post<{ id: string; rootNodeId: string }>('/vaults', {
    json: { name: 'Isolation Vault' },
    headers: webHeaders(context.origin),
  });
  if (vault.status !== 201) throw new Error(`POST /vaults answered ${String(vault.status)}`);

  const note = await adminClient.post<{ id: string }>(`/vaults/${vault.body.id}/nodes`, {
    json: { kind: 'note', parentId: vault.body.rootNodeId, name: 'Secret', markdown: '# s\n' },
    headers: webHeaders(context.origin),
  });
  if (note.status !== 201) throw new Error(`POST nodes answered ${String(note.status)}`);

  real = {
    vaultId: vault.body.id,
    rootNodeId: vault.body.rootNodeId,
    noteId: note.body.id,
    userId: outsider.id,
  };
});

afterAll(async () => {
  await context.stop();
});

describe('authz.vault-isolation.integration [spec:viewer-enforcement]', () => {
  it('drives a route set both sources agree on (D10-26)', () => {
    // The live instance and the committed document fail in opposite directions — the instance grows
    // a route nobody documented, the document keeps one nobody registered — and either alone is
    // satisfied by an incomplete table. So the two are compared before any member below is exercised.
    expect(servedApiRoutes(context.app)).toStrictEqual(documentedApiRoutes());
  });

  it('drives every id-bearing route of the milestone', () => {
    const idBearing = M1_ROUTES.filter(
      (row) => typeof row.auth === 'object' && 'vaultFrom' in row.auth,
    ).map((row) => row.operationId);
    expect(idBearing.toSorted()).toStrictEqual(Object.keys(CASES).toSorted());
  });

  it.each(Object.entries(CASES))(
    '%s answers 404 for a non-member, on a real id and on one that names nothing',
    async (operationId: string, testCase: Case) => {
      const onReal = await testCase.request(outsiderClient, real);
      const onAbsent = await testCase.request(outsiderClient, absent());

      expect(onReal.status, `${operationId} leaked the existence of a real row`).toBe(404);
      expect(onAbsent.status, `${operationId} answered an unknown id with something else`).toBe(
        404,
      );
      // The point of the row: the two are the same answer, so an id is not an oracle.
      expect(onReal.status).toBe(onAbsent.status);
    },
  );

  it('answers the same for a member, so the fixture proves the routes work at all', async () => {
    // Without this, a route that answered 404 to *everyone* would satisfy every case above.
    const vault = await memberClient.get(`/vaults/${real.vaultId}`);
    expect(vault.status).toBe(200);
    const note = await memberClient.get(`/notes/${real.noteId}`);
    expect(note.status).toBe(200);
    await expect(note).toMatchOpenApi('notes.get', 200);
  });

  it('shows the outsider an empty vault listing rather than a refusal', async () => {
    // `GET /vaults` is not id-bearing: the accessible set is built in SQL (§5.7), so a principal with
    // no membership sees an empty page and never a `403`.
    const listing = await outsiderClient.get<{ items: unknown[] }>('/vaults');
    expect(listing.status).toBe(200);
    await expect(listing).toMatchOpenApi('vaults.list', 200);
    expect(listing.body.items).toStrictEqual([]);
  });

  it('refuses an outsider the administrative surface with `forbidden`, not `not_found`', async () => {
    // `/admin/*` is server-scoped: there is no row to hide, and the honest answer to "may I
    // administer this server" is no (04 §5.4).
    const refused = await outsiderClient.get('/admin/users');
    expect(refused.status).toBe(403);
    await expect(refused).toMatchOpenApi('admin.users.list', 403);
  });
});
