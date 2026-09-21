/**
 * `authz.route-policy.integration` (04-auth-and-access-control.md sections 5.4, 5.6, 5.7, 6.2, 6.3,
 * 6.8 and 9.3; D04-08; D04-10; D04-12): the route policy `preHandler` over a real database, driven
 * by synthetic probe routes because the M1 route set carries no vault-scoped route of its own (those
 * are the wave-2 `kernel-rest` stream's). It proves every `vaultFrom` resolution — the path
 * parameter, the body, a node, a note, an attachment nested under its vault, a job with its
 * requester rule — the deny mapping (`not_found` for a non-member or an unknown row, `forbidden`
 * for an insufficient role, `vault_archived` for a write to a frozen vault while reads pass,
 * `token_scope_insufficient` for a token on a user-only route), the server-admin policies with and
 * without a permission and with step-up evaluated last, the rows attached to the request, and
 * `accessibleVaultIds()`.
 */
import { READ_BUNDLE, SessionId, VaultId, type Principal } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { API_PREFIX } from '../../src/authz/route-policy.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import {
  insertAttachment,
  insertJob,
  insertMembership,
  insertNode,
  insertToken,
  insertVault,
  seedUser,
  signInDesktop,
  type SeededUser,
} from '../support/seed.ts';

const HOUR_MS = 3_600_000;
const STEP_UP_WINDOW_MS = 600_000;

let context: AuthTestServer;

const PROBE_PRINCIPAL: Principal = { kind: 'system', job: 'probe' };

interface MeBody {
  readonly sessionId: string;
}

/** Probe routes under `/api/v1`, registered before the auth routes; each echoes what the policy set. */
function probeRoutes(api: FastifyInstance): void {
  api.route({
    method: ['GET', 'POST'],
    url: '/__probe__/many',
    config: { auth: { session: true } },
    preHandler: [
      async (_request, reply) => {
        reply.header('x-probe-prehandler', 'ran');
      },
    ],
    handler: async () => ({ ok: true }),
  });

  api.get(
    '/__probe__/vault/:vaultId',
    { config: { auth: { permission: 'note:read', vaultFrom: 'params.vaultId' } } },
    async (request, reply) =>
      reply.send({ vaultId: request.vault?.id ?? null, role: request.vaultRole }),
  );
  api.get(
    '/__probe__/vault-star/:vaultId',
    {
      config: {
        auth: {
          permission: 'note:read',
          vaultFrom: 'params.vaultId',
          principalKinds: ['user', 'token'],
        },
      },
    },
    async (request, reply) =>
      reply.send({
        principalKind: request.principal?.kind ?? null,
        role: request.vaultRole,
        explicitRole: request.vault?.role ?? null,
        status: request.vault?.status ?? null,
      }),
  );
  api.post(
    '/__probe__/vault/:vaultId',
    { config: { auth: { permission: 'note:write', vaultFrom: 'params.vaultId' } } },
    async (_request, reply) => reply.code(204).send(),
  );
  api.get(
    '/__probe__/node/:nodeId',
    { config: { auth: { permission: 'note:read', vaultFrom: 'node:params.nodeId' } } },
    async (request, reply) =>
      reply.send({ vaultId: request.vault?.id ?? null, node: request.resolvedNode }),
  );
  api.get(
    '/__probe__/note/:noteId',
    { config: { auth: { permission: 'note:read', vaultFrom: 'note:params.noteId' } } },
    async (request, reply) =>
      reply.send({ vaultId: request.vault?.id ?? null, node: request.resolvedNode }),
  );
  api.get(
    '/__probe__/vault/:vaultId/attachment/:attachmentId',
    {
      config: {
        auth: { permission: 'attachment:read', vaultFrom: 'attachment:params.attachmentId' },
      },
    },
    async (request, reply) => reply.send({ vaultId: request.vault?.id ?? null }),
  );
  api.get(
    '/__probe__/attachment/:attachmentId',
    {
      config: {
        auth: { permission: 'attachment:read', vaultFrom: 'attachment:params.attachmentId' },
      },
    },
    async (request, reply) => reply.send({ vaultId: request.vault?.id ?? null }),
  );
  api.get(
    '/__probe__/job/:jobId',
    { config: { auth: { permission: 'export:read', vaultFrom: 'job:params.jobId' } } },
    async (request, reply) => reply.send({ vaultId: request.vault?.id ?? null }),
  );
  api.post(
    '/__probe__/import',
    { config: { auth: { permission: 'import:commit', vaultFrom: 'body.vaultId' } } },
    async (request, reply) => reply.send({ vaultId: request.vault?.id ?? null }),
  );
  api.get(
    '/__probe__/admin',
    { config: { auth: { serverAdmin: true, permission: 'server:users' } } },
    async (_request, reply) => reply.send({ ok: true }),
  );
  api.get(
    '/__probe__/admin-stepup',
    { config: { auth: { serverAdmin: true, permission: 'server:users', stepUp: true } } },
    async (_request, reply) => reply.send({ ok: true }),
  );
  api.get(
    '/__probe__/accessible',
    { config: { auth: { session: true, principalKinds: ['user', 'token'] } } },
    async (request, reply) => {
      const vaultIds = await request.server.authz.accessibleVaultIds(
        request.principal ?? PROBE_PRINCIPAL,
        { permission: 'vault:read', surface: 'rest' },
      );
      return reply.send({ vaultIds });
    },
  );
  // A member of the closed `ALLOW_ARCHIVED_ROUTES` set, as a probe until `kernel-rest` registers
  // the real operation: the one write the archived freeze must let through (section 5.6, D04-12).
  if (!api.routes().some((route) => route.url === `${API_PREFIX}/vaults/:vaultId/unarchive`)) {
    api.post(
      '/vaults/:vaultId/unarchive',
      {
        config: {
          auth: { permission: 'vault:archive', vaultFrom: 'params.vaultId', allowArchived: true },
        },
      },
      async (request, reply) =>
        reply.send({ vaultId: request.vault?.id ?? null, status: request.vault?.status ?? null }),
    );
  }
}

/**
 * The two flag-only administrator operations of `ADMIN_FLAG_ONLY_ROUTES`, as probes at the root.
 * Registered only while `buildApp` does not serve them itself (the `rest` plugin registers the real
 * ones with `@fastify/swagger`), so the suite keeps proving the policy after they land.
 */
function rootProbes(app: FastifyInstance): void {
  const registered = new Set(app.routes().map((route) => route.url));
  if (!registered.has('/docs')) {
    app.get('/docs', { config: { auth: { serverAdmin: true } } }, async (_request, reply) =>
      reply.send({ ok: true }),
    );
  }
  if (!registered.has('/openapi.json')) {
    app.get(
      '/openapi.json',
      { config: { auth: { serverAdmin: true, stepUp: true } } },
      async (_request, reply) => reply.send({ ok: true }),
    );
  }
}

beforeAll(async () => {
  context = await startAuthServer({ extraRoutes: probeRoutes, rootRoutes: rootProbes });
});

afterAll(async () => {
  await context.stop();
});

interface Member {
  readonly user: SeededUser;
  readonly vault: VaultId;
  readonly token: string;
}

async function memberOf(
  email: string,
  role: 'viewer' | 'editor' | 'manager' | null,
  status: 'active' | 'archived' | 'importing' = 'active',
  isServerAdmin: boolean = false,
): Promise<Member> {
  const user = await seedUser(context, { email, isServerAdmin });
  const vault = await insertVault(
    context.db,
    { name: `v-${email}`, createdBy: user.id, status },
    context.clock.now(),
  );
  if (role !== null) {
    await insertMembership(
      context.db,
      { vaultId: vault, userId: user.id, role, grantedBy: user.id },
      context.clock.now(),
    );
  }
  const { token } = await signInDesktop(context, user);
  return { user, vault, token };
}

async function patFor(user: SeededUser, vaultIds: readonly VaultId[]): Promise<string> {
  const minted = await insertToken(
    context.db,
    { ownerId: user.id, vaultIds, expiresAt: new Date(context.clock.now() + HOUR_MS) },
    context.clock.now(),
  );
  return minted.raw;
}

describe('authz.route-policy.integration [area:authz]', () => {
  it('enforces a multi-method session policy before route-local preHandlers, then permits a real session', async () => {
    const anonymous = desktopClient(context);
    const refused = await Promise.all([
      anonymous.get('/__probe__/many'),
      anonymous.post('/__probe__/many'),
    ]);
    for (const response of refused) {
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'unauthenticated' });
      expect(response.headers.get('x-probe-prehandler')).toBeNull();
    }
    const user = await seedUser(context, { email: 'multi-method@example.test' });
    const session = await signInDesktop(context, user);
    const client = desktopClient(context, session.token);
    for (const response of await Promise.all([
      client.get('/__probe__/many'),
      client.post('/__probe__/many'),
    ])) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(response.headers.get('x-probe-prehandler')).toBe('ran');
    }
  });
  it('resolves the vault and attaches the caller role on an allowed read', async () => {
    const { vault, token } = await memberOf('reader@example.test', 'editor');
    const response = await desktopClient(context, token).get<{ vaultId: string; role: string }>(
      `/__probe__/vault/${vault}`,
    );
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ vaultId: vault, role: 'editor' });
  });

  it('gives a server administrator without a membership the manager role, and no explicit role', async () => {
    const { vault, token } = await memberOf('admin-reader@example.test', null, 'active', true);
    const response = await desktopClient(context, token).get(`/__probe__/vault-star/${vault}`);
    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({
      principalKind: 'user',
      role: 'manager',
      explicitRole: null,
      status: 'active',
    });
  });

  it('answers 404 for a vault the caller is not a member of, for an unknown id and for a malformed id', async () => {
    const stranger = await seedUser(context, { email: 'nonmember@example.test' });
    const owner = await seedUser(context, { email: 'vaultowner@example.test' });
    const vault = await insertVault(
      context.db,
      { name: 'private', createdBy: owner.id },
      context.clock.now(),
    );
    const token = (await signInDesktop(context, stranger)).token;
    expect((await desktopClient(context, token).get(`/__probe__/vault/${vault}`)).status).toBe(404);
    const missing = VaultId.parse('019948c4-0000-7000-8000-0000000000ee');
    expect((await desktopClient(context, token).get(`/__probe__/vault/${missing}`)).status).toBe(
      404,
    );
    expect((await desktopClient(context, token).get('/__probe__/vault/not-an-id')).status).toBe(
      404,
    );
  });

  it('answers 404 for a member of an importing vault: it is invisible until it flips to active', async () => {
    const { vault, token } = await memberOf('importing@example.test', 'manager', 'importing');
    expect((await desktopClient(context, token).get(`/__probe__/vault/${vault}`)).status).toBe(404);
  });

  it('answers 403 forbidden for a write the caller role does not grant', async () => {
    const { vault, token } = await memberOf('viewer-write@example.test', 'viewer');
    const response = await desktopClient(context, token).post(`/__probe__/vault/${vault}`, {
      json: {},
    });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'forbidden' });
  });

  it('freezes a write to an archived vault with vault_archived, while reads still pass', async () => {
    const { vault, token } = await memberOf('archived@example.test', 'manager', 'archived');
    const write = await desktopClient(context, token).post(`/__probe__/vault/${vault}`, {
      json: {},
    });
    expect(write.status).toBe(409);
    expect(write.body).toMatchObject({ code: 'vault_archived' });
    const read = await desktopClient(context, token).get(`/__probe__/vault/${vault}`);
    expect(read.status).toBe(200);
    // The closed set's write lifts the freeze for the role the matrix grants it, and only that
    // role: a viewer is refused by the matrix, as a plain 403, not by the freeze.
    // `vaults.unarchive` takes `ConfirmVaultBody` under a mandatory `If-Match` and answers with the
    // whole `Vault` (tree-routes.ts), so the lift is driven the way the published route documents it.
    const manager = desktopClient(context, token);
    const current = await manager.get<{ version: number }>(`/vaults/${vault}`);
    expect(current.status).toBe(200);
    const lifted = await manager.post<{ id: string; status: string }>(
      `/vaults/${vault}/unarchive`,
      { json: { confirm: true }, headers: { 'if-match': `"${String(current.body.version)}"` } },
    );
    expect(lifted.status).toBe(200);
    expect(lifted.body).toMatchObject({ id: vault, status: 'active' });
    // The viewer's request must be well formed, because validation runs before the matrix: an empty
    // body would be refused 422 and would prove nothing about the role this case is about.
    const viewer = await memberOf('archived-viewer@example.test', 'viewer', 'archived');
    const viewerClient = desktopClient(context, viewer.token);
    const readable = await viewerClient.get<{ version: number }>(`/vaults/${viewer.vault}`);
    expect(readable.status).toBe(200);
    const refused = await viewerClient.post(`/vaults/${viewer.vault}/unarchive`, {
      json: { confirm: true },
      headers: { 'if-match': `"${String(readable.body.version)}"` },
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'forbidden' });
  });

  it('resolves a node and a note to their vault, attaching the row, and refuses a category as a note', async () => {
    const { user, vault, token } = await memberOf('nodes@example.test', 'editor');
    const note = await insertNode(
      context.db,
      { vaultId: vault, kind: 'note', name: 'Note.md', createdBy: user.id },
      context.clock.now(),
    );
    const category = await insertNode(
      context.db,
      { vaultId: vault, kind: 'category', name: 'Folder', createdBy: user.id },
      context.clock.now(),
    );
    const trashed = await insertNode(
      context.db,
      {
        vaultId: vault,
        kind: 'note',
        name: 'Trashed.md',
        createdBy: user.id,
        deletedAt: new Date(context.clock.now()),
      },
      context.clock.now(),
    );
    const client = desktopClient(context, token);
    const asNode = await client.get(`/__probe__/node/${category}`);
    expect(asNode.status).toBe(200);
    expect(asNode.body).toStrictEqual({
      vaultId: vault,
      node: { vaultId: vault, kind: 'category', deletedAt: null },
    });
    const asNote = await client.get(`/__probe__/note/${note}`);
    expect(asNote.status).toBe(200);
    expect(asNote.body).toMatchObject({ vaultId: vault, node: { kind: 'note' } });
    // A category is not a note: the note resolution answers not_found, the node one resolves it.
    expect((await client.get(`/__probe__/note/${category}`)).status).toBe(404);
    // A trashed note still resolves — refusing it is the handler's decision, with `deletedAt`.
    const asTrashed = await client.get<{ node: { deletedAt: string | null } }>(
      `/__probe__/note/${trashed}`,
    );
    expect(asTrashed.status).toBe(200);
    expect(asTrashed.body.node.deletedAt).not.toBeNull();
    // Unknown and malformed ids are the same not_found.
    expect((await client.get('/__probe__/node/019948c4-0000-7000-8000-0000000000ee')).status).toBe(
      404,
    );
    expect((await client.get('/__probe__/note/nope')).status).toBe(404);
    // A non-member of the note's vault sees nothing, whatever id they hold.
    const stranger = await memberOf('nodes-stranger@example.test', 'manager');
    expect(
      (await desktopClient(context, stranger.token).get(`/__probe__/note/${note}`)).status,
    ).toBe(404);
  });

  it('resolves an attachment to its vault and refuses one addressed under another vault', async () => {
    const own = await memberOf('attachments@example.test', 'viewer');
    const other = await memberOf('attachments-other@example.test', 'viewer');
    const attachment = await insertAttachment(
      context.db,
      { vaultId: own.vault, uploadedBy: own.user.id },
      context.clock.now(),
    );
    const client = desktopClient(context, own.token);
    const nested = await client.get(`/__probe__/vault/${own.vault}/attachment/${attachment}`);
    expect(nested.status).toBe(200);
    expect(nested.body).toStrictEqual({ vaultId: own.vault });
    const bare = await client.get(`/__probe__/attachment/${attachment}`);
    expect(bare.status).toBe(200);
    // The same row addressed under a vault it does not belong to is a foreign row.
    expect(
      (await client.get(`/__probe__/vault/${other.vault}/attachment/${attachment}`)).status,
    ).toBe(404);
    expect(
      (await client.get('/__probe__/attachment/019948c4-0000-7000-8000-0000000000ee')).status,
    ).toBe(404);
    expect((await client.get('/__probe__/attachment/nope')).status).toBe(404);
  });

  it('resolves a job for its requester or a server administrator, and for nobody else', async () => {
    const requester = await memberOf('job-requester@example.test', 'editor');
    const colleague = await seedUser(context, { email: 'job-colleague@example.test' });
    await insertMembership(
      context.db,
      { vaultId: requester.vault, userId: colleague.id, role: 'manager', grantedBy: colleague.id },
      context.clock.now(),
    );
    const admin = await seedUser(context, { email: 'job-admin@example.test', isServerAdmin: true });
    const job = await insertJob(
      context.db,
      { vaultId: requester.vault, requestedBy: requester.user.id },
      context.clock.now(),
    );
    const orphan = await insertJob(
      context.db,
      { vaultId: null, requestedBy: requester.user.id },
      context.clock.now(),
    );
    const anonymous = await insertJob(
      context.db,
      { vaultId: requester.vault, requestedBy: null },
      context.clock.now(),
    );
    const own = desktopClient(context, requester.token);
    expect((await own.get(`/__probe__/job/${job}`)).status).toBe(200);
    const asColleague = desktopClient(context, (await signInDesktop(context, colleague)).token);
    expect((await asColleague.get(`/__probe__/job/${job}`)).status).toBe(404);
    const asAdmin = desktopClient(context, (await signInDesktop(context, admin)).token);
    expect((await asAdmin.get(`/__probe__/job/${job}`)).status).toBe(200);
    // A job with no vault has nothing to authorize against; a job with no requester belongs to nobody.
    expect((await own.get(`/__probe__/job/${orphan}`)).status).toBe(404);
    expect((await own.get(`/__probe__/job/${anonymous}`)).status).toBe(404);
    expect((await asAdmin.get(`/__probe__/job/${anonymous}`)).status).toBe(200);
    expect((await own.get('/__probe__/job/019948c4-0000-7000-8000-0000000000ee')).status).toBe(404);
    expect((await own.get('/__probe__/job/nope')).status).toBe(404);
  });

  it('resolves the vault from the body, after validation', async () => {
    const manager = await memberOf('import-manager@example.test', 'manager');
    const editor = await seedUser(context, { email: 'import-editor@example.test' });
    await insertMembership(
      context.db,
      { vaultId: manager.vault, userId: editor.id, role: 'editor', grantedBy: manager.user.id },
      context.clock.now(),
    );
    const asManager = desktopClient(context, manager.token);
    const allowed = await asManager.post('/__probe__/import', { json: { vaultId: manager.vault } });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toStrictEqual({ vaultId: manager.vault });
    const asEditor = desktopClient(context, (await signInDesktop(context, editor)).token);
    const refused = await asEditor.post('/__probe__/import', { json: { vaultId: manager.vault } });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'forbidden' });
    expect((await asManager.post('/__probe__/import', { json: {} })).status).toBe(404);
    expect((await asManager.post('/__probe__/import', { json: { vaultId: 7 } })).status).toBe(404);
  });

  it('decides server-admin routes on the flag and the permission, with step-up evaluated last', async () => {
    const admin = await seedUser(context, {
      email: 'server-admin@example.test',
      isServerAdmin: true,
    });
    const plain = await seedUser(context, { email: 'server-plain@example.test' });
    const asAdmin = desktopClient(context, (await signInDesktop(context, admin)).token);
    const asPlain = desktopClient(context, (await signInDesktop(context, plain)).token);
    expect((await asAdmin.get('/__probe__/admin')).status).toBe(200);
    expect((await asAdmin.get('/__probe__/admin-stepup')).status).toBe(200);
    const refused = await asPlain.get('/__probe__/admin');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'forbidden' });

    context.clock.jump(context.clock.now() + STEP_UP_WINDOW_MS + 1);
    const stale = await asAdmin.get('/__probe__/admin-stepup');
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ code: 'step_up_required' });
    // A caller who is not allowed at all is refused before step-up is considered (D04-09).
    const staleRefused = await asPlain.get('/__probe__/admin-stepup');
    expect(staleRefused.status).toBe(403);
    expect(staleRefused.body).toMatchObject({ code: 'forbidden' });
    // The window does not gate the route without stepUp.
    expect((await asAdmin.get('/__probe__/admin')).status).toBe(200);
  });

  it('decides the two flag-only documentation routes on the flag alone, then the window', async () => {
    const admin = await seedUser(context, {
      email: 'docs-admin@example.test',
      isServerAdmin: true,
    });
    const plain = await seedUser(context, { email: 'docs-plain@example.test' });
    const asAdmin = desktopClient(context, (await signInDesktop(context, admin)).token);
    const asPlain = desktopClient(context, (await signInDesktop(context, plain)).token);
    expect((await asAdmin.request('GET', '/docs')).status).toBe(200);
    expect((await asAdmin.request('GET', '/openapi.json')).status).toBe(200);
    const refused = await asPlain.request('GET', '/docs');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'forbidden' });
    expect((await desktopClient(context).request('GET', '/docs')).status).toBe(401);
    context.clock.jump(context.clock.now() + STEP_UP_WINDOW_MS + 1);
    expect((await asAdmin.request('GET', '/docs')).status).toBe(200);
    const stale = await asAdmin.request('GET', '/openapi.json');
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ code: 'step_up_required' });
  });

  it('refuses a token principal on a user-only route with token_scope_insufficient', async () => {
    const { user, vault } = await memberOf('token-user-only@example.test', 'manager');
    const pat = await patFor(user, [vault]);
    for (const path of ['/me/sessions', `/__probe__/vault/${vault}`, '/__probe__/admin']) {
      // eslint-disable-next-line no-await-in-loop -- one route per iteration
      const response = await desktopClient(context, pat).get<{ code: string }>(path);
      expect({ path, status: response.status, code: response.body.code }).toStrictEqual({
        path,
        status: 403,
        code: 'token_scope_insufficient',
      });
    }
  });

  it('admits a token on a starred route through scopes, allowlist and the owner explicit role', async () => {
    const owner = await memberOf('token-star@example.test', 'editor');
    const outside = await insertVault(
      context.db,
      { name: 'token-outside', createdBy: owner.user.id },
      context.clock.now(),
    );
    await insertMembership(
      context.db,
      { vaultId: outside, userId: owner.user.id, role: 'viewer', grantedBy: owner.user.id },
      context.clock.now(),
    );
    const pat = await patFor(owner.user, [owner.vault]);
    const allowed = await desktopClient(context, pat).get(`/__probe__/vault-star/${owner.vault}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toStrictEqual({
      principalKind: 'token',
      role: 'editor',
      explicitRole: 'editor',
      status: 'active',
    });
    // Outside the allowlist the vault does not exist for the token, membership or not.
    expect((await desktopClient(context, pat).get(`/__probe__/vault-star/${outside}`)).status).toBe(
      404,
    );
    // A token whose scopes lack the permission is refused as forbidden (04 section 9.3).
    const narrow = await insertToken(
      context.db,
      {
        ownerId: owner.user.id,
        scopes: READ_BUNDLE.filter((permission) => permission !== 'note:read'),
        vaultIds: [owner.vault],
        expiresAt: new Date(context.clock.now() + HOUR_MS),
      },
      context.clock.now(),
    );
    const scopeless = await desktopClient(context, narrow.raw).get(
      `/__probe__/vault-star/${owner.vault}`,
    );
    expect(scopeless.status).toBe(403);
    expect(scopeless.body).toMatchObject({ code: 'forbidden' });
    // An administrator's token never inherits the admin-implied manager role.
    const admin = await memberOf('token-admin@example.test', null, 'active', true);
    const adminPat = await patFor(admin.user, [admin.vault]);
    expect(
      (await desktopClient(context, adminPat).get(`/__probe__/vault-star/${admin.vault}`)).status,
    ).toBe(404);
  });

  it('lists exactly the vaults a caller can read through accessibleVaultIds()', async () => {
    const user = await seedUser(context, { email: 'accessible@example.test' });
    const a = await insertVault(
      context.db,
      { name: 'acc-a', createdBy: user.id },
      context.clock.now(),
    );
    const b = await insertVault(
      context.db,
      { name: 'acc-b', createdBy: user.id, status: 'archived' },
      context.clock.now(),
    );
    const importing = await insertVault(
      context.db,
      { name: 'acc-importing', createdBy: user.id, status: 'importing' },
      context.clock.now(),
    );
    const c = await insertVault(
      context.db,
      { name: 'acc-c', createdBy: user.id },
      context.clock.now(),
    );
    for (const vaultId of [a, b, importing]) {
      // eslint-disable-next-line no-await-in-loop -- three memberships, inserted in order
      await insertMembership(
        context.db,
        { vaultId, userId: user.id, role: 'viewer', grantedBy: user.id },
        context.clock.now(),
      );
    }
    const token = (await signInDesktop(context, user)).token;
    const response = await desktopClient(context, token).get<{ vaultIds: string[] }>(
      '/__probe__/accessible',
    );
    expect(response.status).toBe(200);
    // Active and archived memberships are listed; an importing one is invisible.
    expect([...response.body.vaultIds].toSorted()).toStrictEqual([a, b].toSorted());
    // A token lists the intersection with its allowlist.
    const pat = await patFor(user, [a]);
    const viaToken = await desktopClient(context, pat).get<{ vaultIds: string[] }>(
      '/__probe__/accessible',
    );
    expect(viaToken.body.vaultIds).toStrictEqual([a]);
    // A server administrator lists every visible vault, membership or not.
    const admin = await seedUser(context, {
      email: 'accessible-admin@example.test',
      isServerAdmin: true,
    });
    const viaAdmin = await desktopClient(context, (await signInDesktop(context, admin)).token).get<{
      vaultIds: string[];
    }>('/__probe__/accessible');
    expect(viaAdmin.body.vaultIds).toHaveLength(3);
    expect(viaAdmin.body.vaultIds).not.toContain(importing);

    // The helper itself, for the principals and surfaces no M1 route reaches it with.
    const helper = context.app.authz.accessibleVaultIds;
    const everyVisible = await helper(
      { kind: 'system', job: 'probe' },
      {
        permission: 'vault:read',
        surface: 'rest',
      },
    );
    expect(everyVisible).toContain(importing);
    expect(everyVisible.length).toBeGreaterThanOrEqual(4);
    const session = await desktopClient(context, token).get<MeBody>('/auth/me');
    const principal: Principal = {
      kind: 'user',
      userId: user.id,
      sessionId: SessionId.parse(session.body.sessionId),
      sessionKind: 'desktop',
      isServerAdmin: false,
      authzVersion: 1,
      lastAuthenticatedAt: new Date(context.clock.now()),
    };
    // No role grants a server permission on a vault, so the list is empty before any query.
    expect(await helper(principal, { permission: 'server:users', surface: 'rest' })).toStrictEqual(
      [],
    );
    // A manager-only permission lists only the vaults the user manages: none while every
    // membership is a viewer's, then the one vault a manager role is granted on.
    expect(
      await helper(principal, { permission: 'vault:settings', surface: 'rest' }),
    ).toStrictEqual([]);
    await insertMembership(
      context.db,
      { vaultId: c, userId: user.id, role: 'manager', grantedBy: user.id },
      context.clock.now(),
    );
    expect(
      await helper(principal, { permission: 'vault:settings', surface: 'rest' }),
    ).toStrictEqual([c]);
    const verified = await context.app.auth.tokens.verifyToken(pat, { mount: 'mcp' });
    if (!verified.ok) throw new Error('the token did not verify');
    // A scope the token lacks, or an empty allowlist, is an empty list; the MCP surface adds the
    // vault switch.
    expect(
      await helper(verified.principal, { permission: 'export:read', surface: 'mcp' }),
    ).toStrictEqual([a]);
    expect(
      await helper(
        { ...verified.principal, scopes: ['note:read'] },
        { permission: 'vault:read', surface: 'mcp' },
      ),
    ).toStrictEqual([]);
    expect(
      await helper(
        { ...verified.principal, vaultScope: { vaultIds: [] } },
        { permission: 'vault:read', surface: 'rest' },
      ),
    ).toStrictEqual([]);
    await context.db
      .updateTable('vaults')
      .set({ mcp_enabled: false })
      .where('id', '=', idBytes(a))
      .execute();
    expect(
      await helper(verified.principal, { permission: 'vault:read', surface: 'mcp' }),
    ).toStrictEqual([]);
    expect(
      await helper(verified.principal, { permission: 'vault:read', surface: 'rest' }),
    ).toStrictEqual([a]);
  });

  it('answers 401 for an anonymous request on a vault-scoped route, before any resolution', async () => {
    const owner = await seedUser(context, { email: 'anon-vault@example.test' });
    const vault = await insertVault(
      context.db,
      { name: 'anon', createdBy: owner.id },
      context.clock.now(),
    );
    expect((await desktopClient(context).get(`/__probe__/vault/${vault}`)).status).toBe(401);
    expect((await desktopClient(context).get('/__probe__/job/nope')).status).toBe(401);
    // Disabling the owner refuses the session on the next request (section 3.8).
    const token = (await signInDesktop(context, owner)).token;
    await context.db
      .updateTable('users')
      .set({ status: 'disabled' })
      .where('id', '=', idBytes(owner.id))
      .execute();
    expect((await desktopClient(context, token).get(`/__probe__/vault/${vault}`)).status).toBe(401);
  });
});
