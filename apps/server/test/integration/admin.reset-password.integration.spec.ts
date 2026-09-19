/** Administrator reset uses the real HTTP, session, credential and audit boundaries. */
import type { UserId } from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emailKeyHash } from '../../src/auth/credentials/throttle.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { auditRows, insertToken, seedUser, signInDesktop } from '../support/seed.ts';

const NEW_PASSWORD = 'a brand new long passphrase 7';
let context: AuthTestServer;
beforeAll(async () => {
  context = await startAuthServer();
});
afterAll(async () => {
  await context.stop();
});
async function issueLink(userId: UserId): Promise<string> {
  const issued = await context.app.auth.setpw.issue(context.db, {
    userId,
    purpose: 'reset',
    issuedBy: userId,
  });
  return issued.link.slice(issued.link.indexOf('#') + 1);
}

describe('admin.reset-password.integration [area:admin]', () => {
  it('administrator reset immediately removes credentials, revokes every session, clears account blocks and preserves PATs', async () => {
    const admin = await seedUser(context, {
      email: 'reset-admin@example.test',
      isServerAdmin: true,
    });
    const user = await seedUser(context, { email: 'reset-target@example.test' });
    const sessions = await Promise.all([
      signInDesktop(context, user, 'laptop'),
      signInDesktop(context, user, 'phone'),
    ]);
    const pat = await insertToken(
      context.db,
      {
        ownerId: user.id,
        expiresAt: new Date(context.clock.now() + 3_600_000),
      },
      context.clock.now(),
    );
    const older = await issueLink(user.id);
    for (let failure = 0; failure < 5; failure += 1) {
      // eslint-disable-next-line no-await-in-loop -- consecutive account failures create a block
      await context.app.auth.throttle.recordFailure(user.email, '198.51.100.19');
    }
    expect(await context.app.auth.throttle.check(user.email, '198.51.100.19')).toMatchObject({
      allowed: false,
      scope: 'account_source',
    });
    const signedAdmin = await signInDesktop(context, admin);
    const reset = await desktopClient(context, signedAdmin.token).post<{
      setPasswordLink: string;
      expiresAt: string;
    }>(`/admin/users/${user.id}/reset-password`);
    expect(reset.status).toBe(201);
    expect(reset.body.setPasswordLink).toMatch(/\/set-password#irid_spl_/);
    expect(Date.parse(reset.body.expiresAt)).toBe(context.clock.now() + 24 * 3_600_000);
    const credential = await context.db
      .selectFrom('user_credentials')
      .select('user_id')
      .where('user_id', '=', idBytes(user.id))
      .executeTakeFirst();
    expect(credential).toBeUndefined();
    const revoked = await context.db
      .selectFrom('sessions')
      .select(['revoked_at', 'revoked_reason'])
      .where('user_id', '=', idBytes(user.id))
      .execute();
    expect(revoked).toHaveLength(2);
    expect(revoked.every((row) => row.revoked_at !== null && row.revoked_reason === 'admin')).toBe(
      true,
    );
    const accountRows = await context.db
      .selectFrom('login_throttle')
      .select('key')
      .where('key', 'like', `%:${emailKeyHash(user.email)}|%`)
      .execute();
    expect(accountRows).toEqual([]);
    const source = await context.db
      .selectFrom('login_throttle')
      .select('points')
      .where('key', '=', 'loginip:198.51.100.19')
      .executeTakeFirstOrThrow();
    expect(source.points).toBe(5);
    expect(await context.app.auth.throttle.check(user.email, '198.51.100.19')).toEqual({
      allowed: true,
    });
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: user.email, password: user.password, client: 'desktop' },
        })
      ).status,
    ).toBe(401);
    const responses = await Promise.all(
      sessions.map((session) => desktopClient(context, session.token).get('/auth/me')),
    );
    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect((await desktopClient(context, pat.raw).get('/auth/me')).status).toBe(200);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token: older, password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(410);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token: reset.body.setPasswordLink.split('#')[1], password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token: reset.body.setPasswordLink.split('#')[1], password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(410);
    expect((await desktopClient(context, pat.raw).get('/auth/me')).status).toBe(200);
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: user.email, password: NEW_PASSWORD, client: 'desktop' },
        })
      ).status,
    ).toBe(201);
    const audit = await auditRows(context.db, 'admin.user.password_reset');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ sessionsRevoked: 2 });
  });
});
