/**
 * `setpw-link.integration` (04-auth-and-access-control.md section 3.3; 09-api-reference.md section
 * 2.1; D04-02; D04-20): a set-password link is single use, expires at its TTL, is superseded by a
 * newer link, is refused (`410 invalid_link`) once consumed, lapsed or superseded — one answer for
 * every unusable link — refuses a policy-violating password (`422`) and leaves the link intact for a
 * second attempt, and on success writes the credential, revokes every live session of the user,
 * leaves the user's tokens alone, and audits `user.password.set` with the link's purpose.
 */
import { idFromBytes, mintToken, parseToken, type UserId } from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emailKeyHash } from '../../src/auth/credentials/throttle.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { authzMutations } from '../../src/authz/mutations.ts';
import { resetUserPassword } from '../../src/users/service.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { auditRows, insertUser, seedUser, signInDesktop } from '../support/seed.ts';

const NEW_PASSWORD = 'a brand new long passphrase 7';

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

/** The raw `irid_spl_…` credential from a freshly issued link (the fragment after `#`). */
async function issueLink(userId: UserId): Promise<string> {
  const issued = await context.app.auth.setpw.issue(context.db, {
    userId,
    purpose: 'reset',
    issuedBy: userId,
  });
  return issued.link.slice(issued.link.indexOf('#') + 1);
}

describe('setpw-link.integration [area:auth]', () => {
  it('rolls back credential, session, throttle, and link changes if the reset audit cannot commit', async () => {
    const user = await seedUser(context, { email: 'reset-rollback@example.test' });
    const session = await signInDesktop(context, user);
    const older = await issueLink(user.id);
    await context.app.auth.throttle.recordFailure(user.email, '198.51.100.21');
    const before = await context.db
      .selectFrom('password_setup_tokens')
      .selectAll()
      .where('user_id', '=', idBytes(user.id))
      .execute();
    await expect(
      resetUserPassword(
        {
          db: context.db,
          mutations: authzMutations(context.app),
          setpw: context.app.auth.setpw,
          throttle: context.app.auth.throttle,
          sessionRepository: (trx) => context.app.auth.sessionRepository(trx),
          audit: {
            record: async () => {
              throw new Error('audit storage refused reset');
            },
          },
        },
        {
          userId: user.id,
          actor: { kind: 'cli' },
          context: {},
          now: new Date(context.clock.now()),
        },
      ),
    ).rejects.toThrow('audit storage refused reset');
    expect(
      await context.db
        .selectFrom('password_setup_tokens')
        .selectAll()
        .where('user_id', '=', idBytes(user.id))
        .execute(),
    ).toEqual(before);
    expect((await desktopClient(context, session.token).get('/auth/me')).status).toBe(200);
    const accountRows = await context.db
      .selectFrom('login_throttle')
      .select('key')
      .where('key', 'like', `login:${emailKeyHash(user.email)}|%`)
      .execute();
    expect(accountRows).toHaveLength(1);
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: user.email, password: user.password, client: 'desktop' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token: older, password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(204);
    expect(await auditRows(context.db, 'admin.user.password_reset')).toHaveLength(0);
  });

  it('creates five accounts concurrently with distinct ordinals and matching link and audit rows', async () => {
    const admin = await seedUser(context, {
      email: 'issuer-admin@example.test',
      isServerAdmin: true,
    });
    const { token: bearer } = await signInDesktop(context, admin);
    const client = desktopClient(context, bearer);
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        client.post<{ user: { id: UserId; colorHue: number }; setPasswordLink: string }>(
          '/admin/users',
          {
            json: {
              email: `parallel-created-${index}@example.test`,
              displayName: `Parallel account ${index}`,
              isServerAdmin: false,
            },
          },
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toStrictEqual([201, 201, 201, 201, 201]);
    // The administrator is ordinal zero; serialization assigns the next five whole ordinals.
    // Literal expected hues make this a contract check, independent of the product color helper.
    expect(
      responses.map((response) => response.body.user.colorHue).toSorted((a, b) => a - b),
    ).toEqual([53, 138, 190, 275, 328]);
    const users = responses.map((response) => idBytes(response.body.user.id));
    const links = await context.db
      .selectFrom('password_setup_tokens')
      .select(['id', 'user_id', 'token_id', 'purpose', 'issued_by', 'consumed_at'])
      .where('user_id', 'in', users)
      .execute();
    const audits = await context.db
      .selectFrom('audit_events')
      .select(['actor_id', 'target_id', 'credential_type', 'outcome', 'metadata'])
      .where('action', '=', 'admin.user.created')
      .execute();
    expect(links).toHaveLength(5);
    expect(audits).toHaveLength(5);
    for (const response of responses) {
      const userBytes = idBytes(response.body.user.id);
      const link = links.find((row) => row.user_id.equals(userBytes));
      if (link === undefined) throw new Error('Each created account must have one initial link.');
      expect(link).toMatchObject({
        purpose: 'initial',
        issued_by: idBytes(admin.id),
        consumed_at: null,
      });
      const raw = response.body.setPasswordLink.split('#')[1] ?? '';
      expect(parseToken(raw)?.tokenId).toBe(link.token_id);
      expect(audits.find((row) => row.target_id?.equals(userBytes))).toMatchObject({
        actor_id: idBytes(admin.id),
        credential_type: 'session',
        outcome: 'success',
        metadata: { setPasswordTokenId: idFromBytes(link.id) },
      });
    }
    const consumed = await Promise.all(
      responses.map((response) =>
        desktopClient(context).post('/auth/set-password', {
          json: { token: response.body.setPasswordLink.split('#')[1], password: NEW_PASSWORD },
        }),
      ),
    );
    expect(consumed.map((response) => response.status)).toStrictEqual([204, 204, 204, 204, 204]);
    expect(await auditRows(context.db, 'admin.user.created')).toHaveLength(5);
  });

  it('keeps exactly one active link after parallel issuance for the same user across purposes', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'parallel-links@example.test' },
      context.clock.now(),
    );
    const issued = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        context.app.auth.setpw.issue(context.db, {
          userId,
          issuedBy: userId,
          purpose: index % 2 === 0 ? 'initial' : 'reset',
        }),
      ),
    );
    const rows = await context.db
      .selectFrom('password_setup_tokens')
      .select(['expires_at', 'consumed_at'])
      .where('user_id', '=', idBytes(userId))
      .execute();
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.expires_at.getTime() > context.clock.now())).toHaveLength(1);
    expect(rows.map((row) => row.consumed_at)).toStrictEqual([null, null, null, null, null]);
    const consumed = await Promise.all(
      issued.map((link) =>
        desktopClient(context).post('/auth/set-password', {
          json: { token: link.link.split('#')[1], password: NEW_PASSWORD },
        }),
      ),
    );
    expect(
      consumed.map((response) => response.status).toSorted((left, right) => left - right),
    ).toStrictEqual([204, 410, 410, 410, 410]);
  });

  it('orders parallel consumption and reissue without a deadlock or reviving the old link', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'consume-reissue@example.test' },
      context.clock.now(),
    );
    const token = await issueLink(userId);
    const [consumed, newer] = await Promise.all([
      desktopClient(context).post('/auth/set-password', {
        json: { token, password: NEW_PASSWORD },
      }),
      issueLink(userId),
    ]);
    // Either operation can acquire the user row first; both legal serial orders have one final link.
    expect([204, 410]).toContain(consumed.status);
    const old = await desktopClient(context).post('/auth/set-password', {
      json: { token, password: NEW_PASSWORD },
    });
    expect(old.status).toBe(410);
    const current = await desktopClient(context).post('/auth/set-password', {
      json: { token: newer, password: NEW_PASSWORD },
    });
    expect(current.status).toBe(204);
    const rows = await context.db
      .selectFrom('password_setup_tokens')
      .select(['expires_at', 'consumed_at'])
      .where('user_id', '=', idBytes(userId))
      .execute();
    expect(
      rows.filter(
        (row) => row.consumed_at === null && row.expires_at.getTime() > context.clock.now(),
      ),
    ).toHaveLength(0);
  });

  it('sets a credential for an account that had none, then signs in with it', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'invited@example.test' },
      context.clock.now(),
    );
    const token = await issueLink(userId);
    const consumed = await desktopClient(context).post('/auth/set-password', {
      json: { token, password: NEW_PASSWORD },
    });
    expect(consumed.status).toBe(204);
    const signedIn = await desktopClient(context).post('/auth/sessions', {
      json: { email: 'invited@example.test', password: NEW_PASSWORD, client: 'desktop' },
    });
    expect(signedIn.status).toBe(201);
    expect(await auditRows(context.db, 'user.password.set')).toHaveLength(1);
  });

  it('is single use: a second consumption of the same link is 410', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'once@example.test' },
      context.clock.now(),
    );
    const token = await issueLink(userId);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token, password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(204);
    const second = await desktopClient(context).post('/auth/set-password', {
      json: { token, password: NEW_PASSWORD },
    });
    expect(second.status).toBe(410);
    expect(second.body).toMatchObject({ code: 'invalid_link' });
  });

  it('is refused once expired', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'expired-link@example.test' },
      context.clock.now(),
    );
    const token = await issueLink(userId);
    // The default link TTL is 24 h; a day later the link is expired at consumption.
    context.clock.jump(context.clock.now() + 25 * 60 * 60 * 1000);
    const response = await desktopClient(context).post('/auth/set-password', {
      json: { token, password: NEW_PASSWORD },
    });
    expect(response.status).toBe(410);
  });

  it('refuses a policy-violating password with 422', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'policy-link@example.test' },
      context.clock.now(),
    );
    const token = await issueLink(userId);
    const response = await desktopClient(context).post('/auth/set-password', {
      // 15+ characters, so it passes the schema, but names the product — a context-word violation.
      json: { token, password: 'my iridium account passphrase' },
    });
    expect(response.status).toBe(422);
    const link = await issueLink(userId);
    expect(link).not.toBe(token);
  });

  it('revokes every live session of the user when the credential is reset', async () => {
    const user = await seedUser(context, { email: 'reset-sessions@example.test' });
    const { token: bearer } = await signInDesktop(context, user);
    const link = await issueLink(user.id);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token: link, password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(204);
    // The pre-existing session is revoked; the new password signs in.
    expect((await desktopClient(context, bearer).get('/auth/me')).status).toBe(401);
    expect(
      (
        await desktopClient(context).post('/auth/sessions', {
          json: { email: user.email, password: NEW_PASSWORD, client: 'desktop' },
        })
      ).status,
    ).toBe(201);
  });

  it('is superseded by a newer link of the same user, and the newer one still works', async () => {
    const userId = await insertUser(
      context.db,
      { email: 'superseded@example.test' },
      context.clock.now(),
    );
    const older = await issueLink(userId);
    const newer = await issueLink(userId);
    const stale = await desktopClient(context).post('/auth/set-password', {
      json: { token: older, password: NEW_PASSWORD },
    });
    expect(stale.status).toBe(410);
    expect(
      (
        await desktopClient(context).post('/auth/set-password', {
          json: { token: newer, password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(204);
  });

  it('is refused for an unknown link id and for a disabled account, with the one answer', async () => {
    const unknown = await desktopClient(context).post('/auth/set-password', {
      json: { token: mintToken('spl').raw, password: NEW_PASSWORD },
    });
    expect(unknown.status).toBe(410);
    expect(unknown.body).toMatchObject({ code: 'invalid_link' });
    const userId = await insertUser(
      context.db,
      { email: 'disabled-link@example.test', status: 'disabled' },
      context.clock.now(),
    );
    const token = await issueLink(userId);
    const disabled = await desktopClient(context).post('/auth/set-password', {
      json: { token, password: NEW_PASSWORD },
    });
    expect(disabled.status).toBe(410);
    expect(disabled.body).toMatchObject({ code: 'invalid_link' });
    expect(await auditRows(context.db, 'user.password.set')).toHaveLength(0);
  });
});
