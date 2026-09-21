/**
 * `auth.step-up.integration` (04-auth-and-access-control.md sections 3.8, 4.6 and 6.2; D04-07;
 * D04-09; 09-api-reference.md sections 2.1 and 2.3): re-authentication refreshes the step-up window
 * and reports its new expiry; a wrong password on re-authentication is the generic
 * `invalid_credentials` and consumes login limiter A; the window is measured against the server's
 * clock and lapses after `STEP_UP_WINDOW_MIN`; and every route the running server marks `stepUp`
 * refuses a lapsed window with `403 step_up_required` and admits a refreshed one — data-driven from
 * `app.routes()`, so a route that later declares `stepUp: true` without a driver here fails this
 * suite rather than going unproven. The password change itself revokes every other session, keeps
 * the caller's own, leaves the user's tokens alone, and audits `user.password.changed`.
 */
import { requiresStepUp } from '@iridium/contracts';
import type { RestClient, RestResponse } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { apiRelativePath } from '../../src/authz/route-policy.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import {
  auditRows,
  insertJob,
  insertMembership,
  insertToken,
  insertVault,
  seedUser,
  signInDesktop,
  SEED_PASSWORD,
  type SeededUser,
} from '../support/seed.ts';

const MINUTE_MS = 60_000;
/** `STEP_UP_WINDOW_MIN` as the harness configures it (the `EnvSchema` default). */
const STEP_UP_WINDOW_MS = 10 * MINUTE_MS;
const NEW_PASSWORD = 'a different long passphrase 99';

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

/**
 * A vault the acting user manages, so the guarded call is refused by the window rather than by the
 * matrix. Each driver seeds its own, because a driver runs twice — once outside the window and once
 * inside it — and the second run must be able to succeed.
 */
/** Every driver runs twice — once outside the window, once inside it — so its fixtures must differ. */
let fixtureSequence = 0;

async function managedVault(
  user: SeededUser,
  status: 'active' | 'archived' = 'active',
): Promise<string> {
  fixtureSequence += 1;
  const vault = await insertVault(
    context.db,
    {
      name: `stepup ${status} ${String(fixtureSequence)} ${user.email}`,
      createdBy: user.id,
      status,
    },
    context.clock.now(),
  );
  await insertMembership(
    context.db,
    { vaultId: vault, userId: user.id, role: 'manager', grantedBy: user.id },
    context.clock.now(),
  );
  return vault;
}

/** The vault as the published read route reports it: the strong `If-Match` and the tree root. */
async function readVault(
  client: RestClient,
  vaultId: string,
): Promise<{ version: number; rootNodeId: string }> {
  const current = await client.get<{ version: number; rootNodeId: string }>(`/vaults/${vaultId}`);
  if (current.status !== 200) throw new Error(`vault read failed: ${String(current.status)}`);
  return { version: current.body.version, rootNodeId: current.body.rootNodeId };
}

/** A note created through the product write path, so it has the rows a revision needs. */
async function seedNote(
  client: RestClient,
  vaultId: string,
): Promise<{ id: string; version: number }> {
  const { rootNodeId } = await readVault(client, vaultId);
  const created = await client.post<{ id: string; version: number }>(`/vaults/${vaultId}/nodes`, {
    json: {
      kind: 'note',
      name: `Step-up ${String((fixtureSequence += 1))}.md`,
      parentId: rootNodeId,
    },
  });
  if (created.status !== 201) throw new Error(`note create failed: ${String(created.status)}`);
  return { id: created.body.id, version: created.body.version };
}

/**
 * One well-formed request per step-up route, keyed `METHOD /path` relative to `/api/v1`. The body
 * must pass validation, because the route policy runs after it: a schema failure would be `422`
 * before the window was ever consulted. A step-up route without a driver fails the suite.
 */
const STEP_UP_DRIVERS: Readonly<
  Record<
    string,
    (client: RestClient, user: SeededUser, target: SeededUser) => Promise<RestResponse>
  >
> = {
  'POST /admin/users': (client, user) =>
    client.post('/admin/users', {
      json: { email: `created-${user.email}`, displayName: 'Step-up invite', isServerAdmin: false },
    }),
  'POST /admin/users/:userId/disable': (client, _user, target) =>
    client.post(`/admin/users/${target.id}/disable`, { json: {} }),
  'POST /admin/users/:userId/enable': (client, _user, target) =>
    client.post(`/admin/users/${target.id}/enable`),
  'POST /admin/users/:userId/reset-password': (client, _user, target) =>
    client.post(`/admin/users/${target.id}/reset-password`),
  'POST /me/password': (client, user) =>
    client.post('/me/password', {
      json: { currentPassword: user.password, newPassword: NEW_PASSWORD },
    }),
  'POST /admin/jobs/:type/run': (client) =>
    client.post('/admin/jobs/session_ticket_sweep/run', { json: { payload: {} } }),
  // Only a `queued` job can be cancelled through REST, and a job queued through the run route is
  // racing the scheduler that the run route wakes. The seeded row is queued and carries a type the
  // scheduler has no handler for, so it stays claimable for exactly as long as this drive needs.
  'POST /admin/jobs/:jobId/cancel': async (client, user) => {
    const jobId = await insertJob(
      context.db,
      { vaultId: null, requestedBy: user.id },
      context.clock.now(),
    );
    return client.post(`/admin/jobs/${jobId}/cancel`);
  },
  'POST /vaults/:vaultId/archive': async (client, user) => {
    const vaultId = await managedVault(user);
    return client.post(`/vaults/${vaultId}/archive`, {
      json: { confirm: true },
      ifMatch: (await readVault(client, vaultId)).version,
    });
  },
  'POST /vaults/:vaultId/unarchive': async (client, user) => {
    const vaultId = await managedVault(user, 'archived');
    return client.post(`/vaults/${vaultId}/unarchive`, {
      json: { confirm: true },
      ifMatch: (await readVault(client, vaultId)).version,
    });
  },
  'DELETE /nodes/:nodeId': async (client, user) => {
    const vaultId = await managedVault(user);
    const note = await seedNote(client, vaultId);
    const trashed = await client.post<{ trashEntry: { version: number } }>(
      `/nodes/${note.id}/trash`,
      { json: {}, ifMatch: note.version },
    );
    if (trashed.status !== 200) throw new Error(`trash failed: ${String(trashed.status)}`);
    // `PurgeNodeQuery` takes the literal string, and the validator is the trash entry's version.
    return client.del(`/nodes/${note.id}`, {
      query: { purge: 'true' },
      ifMatch: trashed.body.trashEntry.version,
    });
  },
  'POST /notes/:noteId/revisions/:revisionId/restore': async (client, user) => {
    const vaultId = await managedVault(user);
    const note = await seedNote(client, vaultId);
    const named = await client.post<{ id: number }>(`/notes/${note.id}/revisions`, {
      json: { label: 'Step-up checkpoint' },
    });
    if (named.status !== 201) throw new Error(`revision create failed: ${String(named.status)}`);
    return client.post(`/notes/${note.id}/revisions/${String(named.body.id)}/restore`, {
      json: { confirm: true },
    });
  },
};

function stepUpRoutes(): readonly string[] {
  return context.app
    .routes()
    .filter((route) => route.method !== 'HEAD' && route.auth !== undefined)
    .filter((route) => route.auth !== undefined && requiresStepUp(route.auth))
    .map((route) => `${route.method} ${apiRelativePath(route.url)}`)
    .toSorted();
}

describe('auth.step-up.integration [area:auth]', () => {
  it('refreshes the step-up window and reports the new expiry as now plus the window', async () => {
    const user = await seedUser(context, { email: 'reauth@example.test' });
    const { token, sessionId } = await signInDesktop(context, user);
    context.clock.jump(context.clock.now() + 5 * MINUTE_MS);
    const response = await desktopClient(context, token).post<{
      lastAuthenticatedAt: string;
      stepUpExpiresAt: string;
    }>('/auth/reauthenticate', { json: { password: SEED_PASSWORD } });
    expect(response.status).toBe(200);
    expect(new Date(response.body.lastAuthenticatedAt).getTime()).toBe(context.clock.now());
    expect(new Date(response.body.stepUpExpiresAt).getTime()).toBe(
      context.clock.now() + STEP_UP_WINDOW_MS,
    );
    const row = await context.db
      .selectFrom('sessions')
      .select('last_authenticated_at')
      .where('id', '=', idBytes(sessionId))
      .executeTakeFirstOrThrow();
    expect(row.last_authenticated_at.getTime()).toBe(context.clock.now());
    expect(await auditRows(context.db, 'user.reauth.succeeded')).toHaveLength(1);
  });

  it('refuses re-authentication with the wrong password, generically, and counts it against limiter A', async () => {
    const user = await seedUser(context, { email: 'reauth-bad@example.test' });
    const { token } = await signInDesktop(context, user);
    const client = desktopClient(context, token);
    const response = await client.post('/auth/reauthenticate', {
      json: { password: 'not my password at all' },
    });
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'invalid_credentials' });
    // A stolen session is not an offline password oracle (D04-07): the failures accumulate on the
    // same `email|ip` key the login uses, and the fifth one blocks the pair.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- consecutive failures are sequential by definition
      await client.post('/auth/reauthenticate', { json: { password: 'not my password at all' } });
    }
    const blocked = await client.post('/auth/reauthenticate', {
      json: { password: SEED_PASSWORD },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
    expect(blocked.response.headers.get('retry-after')).not.toBeNull();
    expect(await auditRows(context.db, 'user.reauth.succeeded')).toHaveLength(0);
  });

  it('gates every route marked stepUp on the window, data-driven from the registered routes', async () => {
    const routes = stepUpRoutes();
    expect(routes.length).toBeGreaterThan(0);
    const undriven = routes.filter((route) => !(route in STEP_UP_DRIVERS));
    expect(
      undriven,
      `every step-up route needs a driver in STEP_UP_DRIVERS: ${undriven.join(', ')}`,
    ).toStrictEqual([]);

    for (const route of routes) {
      const drive = STEP_UP_DRIVERS[route];
      if (drive === undefined) throw new Error(`no driver for ${route}`);
      // eslint-disable-next-line no-await-in-loop -- one route at a time, each with its own user
      const user = await seedUser(context, {
        email: `stepup-${routes.indexOf(route)}@example.test`,
        isServerAdmin: true,
      });
      // eslint-disable-next-line no-await-in-loop -- each route owns its target account
      const target = await seedUser(context, {
        email: `target-${routes.indexOf(route)}@example.test`,
      });
      if (route.endsWith('/enable')) {
        // eslint-disable-next-line no-await-in-loop -- fixture state must precede the guarded call
        await context.db
          .updateTable('users')
          .set({ status: 'disabled' })
          .where('id', '=', idBytes(target.id))
          .execute();
      }
      // eslint-disable-next-line no-await-in-loop -- the sign-in precedes the drive
      const { token } = await signInDesktop(context, user);
      const client = desktopClient(context, token);

      // A fresh login satisfies the window; one millisecond past it does not.
      context.clock.jump(context.clock.now() + STEP_UP_WINDOW_MS + 1);
      // eslint-disable-next-line no-await-in-loop -- the stale drive precedes the refresh
      const stale = await drive(client, user, target);
      expect({ route, status: stale.status }).toStrictEqual({ route, status: 403 });
      expect(stale.body).toMatchObject({
        code: 'step_up_required',
        detail: 'Re-authenticate to continue',
      });

      // eslint-disable-next-line no-await-in-loop -- the refresh precedes the fresh drive
      const refreshed = await client.post('/auth/reauthenticate', {
        json: { password: user.password },
      });
      expect({ route, status: refreshed.status }).toStrictEqual({ route, status: 200 });
      // Exactly at the boundary the window is still open (inclusive, section 4.6).
      context.clock.jump(context.clock.now() + STEP_UP_WINDOW_MS);
      // eslint-disable-next-line no-await-in-loop -- the fresh drive is the last step per route
      const fresh = await drive(client, user, target);
      expect({ route, admitted: fresh.status < 400 }).toStrictEqual({ route, admitted: true });
    }
  });

  it('changes the password under a fresh window, revokes every other session and keeps the caller current', async () => {
    const user = await seedUser(context, { email: 'changepw-revoke@example.test' });
    const other = await signInDesktop(context, user, 'phone');
    const current = await signInDesktop(context, user, 'laptop');
    const pat = await insertToken(
      context.db,
      { ownerId: user.id, expiresAt: new Date(context.clock.now() + 60 * MINUTE_MS) },
      context.clock.now(),
    );
    const changed = await desktopClient(context, current.token).post('/me/password', {
      json: { currentPassword: SEED_PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.status).toBe(204);
    // The other session is revoked; the caller's own still authenticates.
    expect((await desktopClient(context, other.token).get('/auth/me')).status).toBe(401);
    expect((await desktopClient(context, current.token).get('/auth/me')).status).toBe(200);
    const revoked = await context.db
      .selectFrom('sessions')
      .select('revoked_reason')
      .where('id', '=', idBytes(other.sessionId))
      .executeTakeFirstOrThrow();
    expect(revoked.revoked_reason).toBe('password_change');
    // The new password signs in; the old one does not.
    const withNew = await desktopClient(context).post('/auth/sessions', {
      json: { email: user.email, password: NEW_PASSWORD, client: 'desktop' },
    });
    expect(withNew.status).toBe(201);
    const withOld = await desktopClient(context).post('/auth/sessions', {
      json: { email: user.email, password: SEED_PASSWORD, client: 'desktop' },
    });
    expect(withOld.status).toBe(401);
    // Tokens are untouched by a password change (A28): the PAT still authenticates its owner.
    expect((await desktopClient(context, pat.raw).get('/auth/me')).status).toBe(200);
    const events = await auditRows(context.db, 'user.password.changed');
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ revokedSessionCount: 1 });
    // The bump of `users.authz_version` is what makes every live epoch stale (section 8.2).
    const bumped = await context.db
      .selectFrom('users')
      .select('authz_version')
      .where('id', '=', idBytes(user.id))
      .executeTakeFirstOrThrow();
    expect(bumped.authz_version).toBe(3);
  });

  it('refuses a password change whose current password is wrong, and one that fails the policy', async () => {
    const user = await seedUser(context, { email: 'changepw-bad@example.test' });
    const { token } = await signInDesktop(context, user);
    const wrong = await desktopClient(context, token).post('/me/password', {
      json: { currentPassword: 'wrong current password!!', newPassword: NEW_PASSWORD },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ code: 'invalid_credentials' });
    // Below the schema's minimum: refused by validation before any credential work.
    const short = await desktopClient(context, token).post('/me/password', {
      json: { currentPassword: SEED_PASSWORD, newPassword: 'short' },
    });
    expect(short.status).toBe(422);
    // Long enough for the schema, refused by the policy: the rule ids are the validation codes.
    const contextWord = await desktopClient(context, token).post('/me/password', {
      json: { currentPassword: SEED_PASSWORD, newPassword: 'my iridium passphrase is long' },
    });
    expect(contextWord.status).toBe(422);
    expect(contextWord.body).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'body.password', code: 'context_word' }],
    });
    // Nothing changed: the old password still signs in.
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: user.email, password: SEED_PASSWORD, client: 'desktop' },
        })
      ).status,
    ).toBe(201);
  });
});
