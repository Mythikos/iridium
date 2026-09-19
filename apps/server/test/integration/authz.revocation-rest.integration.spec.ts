/** Real REST authorization observes the committed state of memberships, users, and sessions. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { insertToken, seedUser, signInDesktop } from '../support/seed.ts';

let context: AuthTestServer;
beforeAll(async () => {
  context = await startAuthServer();
});
afterAll(async () => {
  await context.stop();
});

async function actor(email: string, admin = false) {
  const user = await seedUser(context, { email, isServerAdmin: admin });
  const session = await signInDesktop(context, user);
  return { user, session, client: desktopClient(context, session.token) };
}

describe('authz.revocation-rest.integration [area:authz] [spec:live-revocation]', () => {
  it('applies downgrade and removal on the next REST call and enforces membership CAS', async () => {
    const admin = await actor('rest-admin@example.test', true);
    const member = await actor('rest-member@example.test');
    const vault = await admin.client.post<{ id: string; rootNodeId: string }>('/vaults', {
      json: { name: 'REST revocation' },
    });
    expect(vault.status).toBe(201);
    const memberPath = `/vaults/${vault.body.id}/members/${member.user.id}`;
    expect((await admin.client.put(memberPath, { json: { role: 'editor' } })).status).toBe(201);
    const note = await member.client.post<{ id: string }>(`/vaults/${vault.body.id}/nodes`, {
      json: {
        kind: 'note',
        parentId: vault.body.rootNodeId,
        name: 'Allowed before downgrade',
        markdown: 'retained\n',
      },
    });
    expect(note.status).toBe(201);
    expect((await admin.client.put(memberPath, { json: { role: 'viewer' } })).status).toBe(428);
    expect(
      (
        await admin.client.put(memberPath, {
          headers: { 'if-match': '"99"' },
          json: { role: 'viewer' },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await admin.client.put(memberPath, {
          headers: { 'if-match': '"1"' },
          json: { role: 'viewer' },
        })
      ).status,
    ).toBe(200);
    expect((await member.client.get(`/notes/${note.body.id}`)).status).toBe(200);
    expect(
      (
        await member.client.post(`/vaults/${vault.body.id}/nodes`, {
          json: { kind: 'note', parentId: vault.body.rootNodeId, name: 'Denied after downgrade' },
        })
      ).status,
    ).toBe(403);
    expect((await admin.client.del(memberPath, { headers: { 'if-match': '"2"' } })).status).toBe(
      204,
    );
    expect((await member.client.get(`/notes/${note.body.id}`)).status).toBe(404);
    expect((await member.client.get(`/vaults/${vault.body.id}/members`)).status).toBe(404);
    const row = await context.db
      .selectFrom('users')
      .select('authz_version')
      .where('id', '=', idBytes(member.user.id))
      .executeTakeFirstOrThrow();
    expect(row.authz_version).toBe(5);
  });

  it('disable blocks sessions and PATs immediately; enable restores PAT access without reviving sessions', async () => {
    const admin = await actor('disable-admin@example.test', true);
    const target = await actor('disable-target@example.test');
    const pat = await insertToken(
      context.db,
      { ownerId: target.user.id, expiresAt: new Date(context.clock.now() + 3_600_000) },
      context.clock.now(),
    );
    const tokenClient = desktopClient(context, pat.raw);
    expect((await tokenClient.get('/auth/me')).status).toBe(200);
    expect(
      (
        await admin.client.post(`/admin/users/${target.user.id}/disable`, {
          json: { reason: 'Access withdrawn' },
        })
      ).status,
    ).toBe(200);
    expect((await target.client.get('/auth/me')).status).toBe(401);
    expect((await tokenClient.get('/auth/me')).status).toBe(401);
    expect((await admin.client.post(`/admin/users/${target.user.id}/enable`)).status).toBe(200);
    expect((await tokenClient.get('/auth/me')).status).toBe(200);
    expect((await target.client.get('/auth/me')).status).toBe(401);
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: target.user.email, password: target.user.password, client: 'desktop' },
        })
      ).status,
    ).toBe(201);
  });

  it('serializes concurrent last-administrator decisions without losing the final active admin', async () => {
    const admins = await Promise.all([
      actor('last-a@example.test', true),
      actor('last-b@example.test', true),
    ]);
    const responses = await Promise.all(
      admins.map((admin) =>
        admin.client.post(`/admin/users/${admin.user.id}/disable`, { json: {} }),
      ),
    );
    expect(
      responses.map((response) => response.status).toSorted((left, right) => left - right),
    ).toEqual([200, 422]);
    expect(responses.find((response) => response.status === 422)?.body).toMatchObject({
      code: 'validation_failed',
      errors: [{ code: 'last_admin' }],
    });
    const remaining = await context.db
      .selectFrom('users')
      .select('id')
      .where('is_server_admin', '=', true)
      .where('status', '=', 'active')
      .execute();
    expect(remaining).toHaveLength(1);
  });

  it('serializes concurrent same-device logins so only the latest replacement remains live', async () => {
    const user = await seedUser(context, { email: 'parallel-device@example.test' });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        desktopClient(context).post('/auth/sessions', {
          json: {
            email: user.email,
            password: user.password,
            client: 'desktop',
            deviceName: 'one device',
          },
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201, 201]);
    const sessions = await context.db
      .selectFrom('sessions')
      .select(['revoked_at', 'revoked_reason'])
      .where('user_id', '=', idBytes(user.id))
      .execute();
    expect(sessions.filter((session) => session.revoked_at === null)).toHaveLength(1);
    expect(sessions.filter((session) => session.revoked_reason === 'replaced')).toHaveLength(4);
  });
});
