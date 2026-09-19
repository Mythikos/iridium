/** Security orchestration over real password, throttle, session, mutation and link services. */
import { createHmac } from 'node:crypto';

import { LIMITS, SessionId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import {
  authFlowFixture,
  FLOW_ACTOR,
  FLOW_LOGIN,
  FLOW_NEW_PASSWORD,
  FLOW_PASSWORD,
  FLOW_PEPPER,
  FLOW_SESSION,
  FLOW_USER,
} from '../../test/support/auth-flow-fixture.ts';
import { idBytes } from './ids.ts';
import { changePassword, login, reauthenticate, setPassword } from './login.ts';

const OTHER_SESSION = SessionId.parse('019948c4-0000-7000-8000-000000000103');

function storedCredential(fixture: Awaited<ReturnType<typeof authFlowFixture>>) {
  const row = fixture.state.tables.user_credentials[0];
  if (
    row === undefined ||
    typeof row['password_hash'] !== 'string' ||
    typeof row['pepper_version'] !== 'number'
  )
    throw new Error('Expected a real stored credential.');
  return { hash: row['password_hash'], pepper: row['pepper_version'] };
}

function passwordInput(token: string, password = FLOW_NEW_PASSWORD) {
  return { token, password, ip: FLOW_ACTOR.ip, context: FLOW_ACTOR.context };
}

describe('auth.password-flows.unit [area:auth]', () => {
  it.each([
    { state: 'unknown', reason: 'invalid_credentials', metric: 'unknown_user' },
    { state: 'disabled', reason: 'user_disabled', metric: 'disabled' },
    { state: 'no_credential', reason: 'no_credential', metric: 'bad_password' },
    { state: 'wrong_password', reason: 'invalid_credentials', metric: 'bad_password' },
  ])(
    'keeps $state failures indistinguishable while recording bounded, non-secret evidence',
    async ({ state, reason, metric }) => {
      const fixture = await authFlowFixture();
      if (state === 'unknown') fixture.state.tables.users.length = 0;
      if (state === 'disabled')
        Object.assign(fixture.state.tables.users[0] ?? {}, { status: 'disabled' });
      if (state === 'no_credential') fixture.state.tables.user_credentials.length = 0;
      const outcome = await login(fixture.deps, {
        ...FLOW_LOGIN,
        password: 'wrong password attempt',
      });
      expect(outcome).toEqual({ kind: 'invalid' });
      expect(fixture.state.tables.sessions).toEqual([]);
      expect(fixture.events).toEqual([]);
      expect(fixture.metrics).toEqual([metric]);
      expect(fixture.audits).toEqual([
        expect.objectContaining({
          action: 'user.login.failed',
          reason,
          outcome: 'failure',
          credentialType: 'none',
          credentialId: null,
          actorId: state === 'unknown' ? null : FLOW_USER,
          actorDisplay: state === 'unknown' ? null : 'person@example.test',
          context: FLOW_ACTOR.context,
          metadata: {
            reason,
            emailKeyHash: createHmac('sha256', FLOW_PEPPER)
              .update('person@example.test')
              .digest('hex')
              .slice(0, 32),
            attemptsInWindow: 1,
          },
        }),
      ]);
      expect(fixture.logs).toContainEqual(
        expect.objectContaining({
          event: 'auth.login.failed',
          reason,
          blocked: false,
          ip: FLOW_ACTOR.ip,
        }),
      );
      expect(JSON.stringify({ audits: fixture.audits, logs: fixture.logs })).not.toContain(
        'wrong password attempt',
      );
    },
  );

  it('deduplicates ordinary failures, always audits a newly applied block, and refuses the next mixed-case attempt before I/O', async () => {
    const fixture = await authFlowFixture({ maxFailures: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- attempts build the real sequential limiter budget
      expect(await login(fixture.deps, { ...FLOW_LOGIN, password: 'incorrect' })).toEqual({
        kind: 'invalid',
      });
    }
    expect(fixture.audits).toHaveLength(2);
    expect(fixture.audits[1]).toMatchObject({
      reason: 'blocked',
      metadata: {
        reason: 'blocked',
        attemptsInWindow: 3,
        blockedUntil: new Date(
          fixture.clock.now() + LIMITS.LOGIN_BLOCK_BASE_SECONDS * 1000,
        ).toISOString(),
      },
    });
    const queries = fixture.fake.executed.length;
    const denied = await login(fixture.deps, FLOW_LOGIN);
    expect(denied).toMatchObject({ kind: 'throttled', retryAfterMs: expect.any(Number) });
    expect(fixture.fake.executed).toHaveLength(queries);
    expect(fixture.metrics).toEqual(['bad_password', 'bad_password', 'bad_password', 'throttled']);
    expect(fixture.logs.at(-1)).toMatchObject({
      event: 'auth.login.throttled',
      scope: 'account_source',
    });
  });

  it.each(['web', 'desktop'] as const)(
    'commits a fresh %s session and audit together, with channel metadata and no stored raw secret',
    async (client) => {
      const fixture = await authFlowFixture();
      await fixture.deps.throttle.recordFailure('person@example.test', FLOW_ACTOR.ip);
      const input = {
        ...FLOW_LOGIN,
        client,
        deviceName: client === 'web' ? null : 'workstation',
        clientVersion: client === 'web' ? null : '1.2.3',
      };
      const outcome = await login(fixture.deps, input);
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') throw new Error('Expected login success.');
      expect(outcome.session.raw).toMatch(/^irid_ses_/);
      expect(outcome.session.row.kind).toBe(client);
      expect(outcome.session.row.user_id).toEqual(idBytes(FLOW_USER));
      expect(outcome.session.row.last_authenticated_at).toEqual(fixture.clock.date());
      expect(outcome.events).toEqual([]);
      expect(fixture.state.tables.sessions).toHaveLength(1);
      expect(JSON.stringify(fixture.state.tables)).not.toContain(outcome.session.raw);
      expect(fixture.state.tables.users[0]?.['last_login_at']).toEqual(fixture.clock.date());
      expect(fixture.audits).toEqual([
        expect.objectContaining({
          action: 'user.login.succeeded',
          actorId: FLOW_USER,
          actorDisplay: 'person@example.test',
          credentialType: 'session',
          credentialId: outcome.session.sessionId,
          metadata:
            client === 'web'
              ? { kind: 'web', method: 'password' }
              : {
                  kind: 'desktop',
                  method: 'password',
                  deviceName: 'workstation',
                  clientVersion: '1.2.3',
                },
        }),
      ]);
      expect(fixture.trace.indexOf('audit:user.login.succeeded')).toBeLessThan(
        fixture.trace.indexOf('tx:commit'),
      );
      expect(fixture.trace.some((entry) => entry.includes('update `user_credentials`'))).toBe(
        false,
      );
      expect(fixture.logs.at(-1)).toMatchObject({
        event: 'auth.login.succeeded',
        kind: client,
        userId: FLOW_USER,
      });
      const nextFailure = await fixture.deps.throttle.recordFailure(
        'person@example.test',
        FLOW_ACTOR.ip,
      );
      expect(nextFailure.attemptsInWindow).toBe(1);
      expect(fixture.fence.blocked(FLOW_USER)).toBe(false);
    },
  );

  it('publishes same-device session replacement only after the login audit has committed', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession('desktop', FLOW_SESSION, 'workstation');
    fixture.resetObservations();
    const outcome = await login(fixture.deps, FLOW_LOGIN);
    expect(outcome.kind).toBe('ok');
    expect(fixture.events).toEqual([
      { type: 'session.revoked', userId: FLOW_USER, sessionId: FLOW_SESSION, reason: 'replaced' },
    ]);
    expect(fixture.state.tables.sessions[0]).toMatchObject({
      revoked_at: fixture.clock.date(),
      revoked_reason: 'replaced',
    });
    expect(fixture.trace.indexOf('published:session.revoked')).toBeGreaterThan(
      fixture.trace.indexOf('tx:commit'),
    );
    expect(fixture.trace.indexOf('tx:commit')).toBeGreaterThan(
      fixture.trace.indexOf('audit:user.login.succeeded'),
    );
  });

  it.each([false, true])(
    'rehashes the old credential conditionally after login without auditing the rehash (concurrent replacement=%s)',
    async (conflict) => {
      const fixture = await authFlowFixture();
      const old = storedCredential(fixture);
      fixture.state.promotedPepper = 2;
      fixture.state.rehashConflict = conflict;
      expect((await login(fixture.deps, FLOW_LOGIN)).kind).toBe('ok');
      const updated = storedCredential(fixture);
      expect(updated.pepper).toBe(conflict ? 1 : 2);
      expect(await fixture.deps.hasher.verify(updated.hash, FLOW_PASSWORD, updated.pepper)).toBe(
        'match',
      );
      const update = fixture.fake.executed.find((query) =>
        query.sql.startsWith('update `user_credentials`'),
      );
      expect(update?.sql).toContain('where `user_id` = ? and `password_hash` = ?');
      expect(update?.parameters.slice(-2)).toEqual([idBytes(FLOW_USER), old.hash]);
      expect(
        fixture.trace.findIndex((entry) => entry.startsWith('update `user_credentials`')),
      ).toBeGreaterThan(fixture.trace.indexOf('tx:commit'));
      expect(fixture.audits.map((event) => event.action)).toEqual(['user.login.succeeded']);
      expect(fixture.logs).toContainEqual(
        expect.objectContaining({
          event: 'auth.credential.rehashed',
          userId: FLOW_USER,
          pepperVersion: 2,
          applied: !conflict,
        }),
      );
    },
  );

  it('does not issue a session or clear prior failures when the promoted pepper cannot be used', async () => {
    const fixture = await authFlowFixture({ maxFailures: 2 });
    await fixture.deps.throttle.recordFailure('person@example.test', FLOW_ACTOR.ip);
    fixture.state.promotedPepper = 9;
    await expect(login(fixture.deps, FLOW_LOGIN)).rejects.toMatchObject({
      name: 'PepperVersionMissingError',
      version: 9,
    });
    expect(fixture.state.tables.sessions).toEqual([]);
    expect(fixture.audits).toEqual([]);
    expect(fixture.events).toEqual([]);
    expect(
      (await fixture.deps.throttle.recordFailure('person@example.test', FLOW_ACTOR.ip))
        .attemptsInWindow,
    ).toBe(2);
  });

  it('rolls back the issued session and replacement without publishing when its audit fails', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession('desktop', FLOW_SESSION, 'workstation');
    fixture.resetObservations();
    fixture.state.auditFailure = true;
    await expect(login(fixture.deps, FLOW_LOGIN)).rejects.toThrow('audit storage unavailable');
    expect(fixture.state.tables.sessions).toHaveLength(1);
    expect(fixture.state.tables.sessions[0]?.['revoked_at']).toBeNull();
    expect(fixture.state.tables.users[0]?.['last_login_at']).toBeNull();
    expect(fixture.events).toEqual([]);
    expect(fixture.fence.blocked(FLOW_USER)).toBe(false);
    expect(fixture.trace).toContain('tx:rollback');
  });

  it('advances only the authenticated session step-up timestamp and audits after credential locking', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession();
    await fixture.clock.advance(60_000);
    fixture.resetObservations();
    expect(await reauthenticate(fixture.deps, FLOW_ACTOR, FLOW_PASSWORD)).toEqual({
      kind: 'ok',
      lastAuthenticatedAt: fixture.clock.date(),
      stepUpExpiresAt: new Date(fixture.clock.now() + fixture.deps.ttls.stepUpWindowMs),
    });
    expect(fixture.state.tables.sessions[0]?.['last_authenticated_at']).toEqual(
      fixture.clock.date(),
    );
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: 'user.reauth.succeeded',
        actorId: FLOW_USER,
        credentialId: FLOW_SESSION,
        metadata: {},
      }),
    ]);
    expect(fixture.trace.indexOf('audit:user.reauth.succeeded')).toBeLessThan(
      fixture.trace.indexOf('tx:commit'),
    );
    expect(fixture.logs.at(-1)).toMatchObject({
      event: 'auth.reauth.succeeded',
      userId: FLOW_USER,
    });
  });

  it.each(['reauthenticate', 'change-password'] as const)(
    'refuses a wrong password and then an exhausted budget in %s without mutating authority',
    async (flow) => {
      const fixture = await authFlowFixture({ maxFailures: 1 });
      await fixture.seedSession();
      fixture.resetObservations();
      const run = (password: string) =>
        flow === 'reauthenticate'
          ? reauthenticate(fixture.deps, FLOW_ACTOR, password)
          : changePassword(fixture.deps, FLOW_ACTOR, password, FLOW_NEW_PASSWORD);
      expect(await run('incorrect')).toEqual({ kind: 'invalid' });
      expect(await run(FLOW_PASSWORD)).toMatchObject({
        kind: 'throttled',
        retryAfterMs: expect.any(Number),
      });
      expect(fixture.metrics).toEqual(['bad_password', 'throttled']);
      expect(fixture.logs).toContainEqual(
        expect.objectContaining({ event: 'auth.reauth.failed', userId: FLOW_USER }),
      );
      expect(fixture.audits).toEqual([]);
      expect(fixture.events).toEqual([]);
      expect(fixture.trace.every((entry) => entry.startsWith('select'))).toBe(true);
    },
  );

  it('applies policy before new credential writes or revocation', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession();
    fixture.resetObservations();
    expect(await changePassword(fixture.deps, FLOW_ACTOR, FLOW_PASSWORD, 'short')).toEqual({
      kind: 'policy',
      violations: ['too_short'],
    });
    expect(fixture.trace.every((entry) => entry.startsWith('select'))).toBe(true);
    expect(fixture.audits).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it('changes the password, retains only the actor session and publishes after the audit commits', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession();
    await fixture.seedSession('web', OTHER_SESSION);
    fixture.seedToken();
    const tokens = JSON.stringify(fixture.state.tables.access_tokens);
    fixture.resetObservations();
    const expectedEvents = [
      { type: 'user.password_changed', userId: FLOW_USER, keepSessionId: FLOW_SESSION },
      {
        type: 'session.revoked',
        userId: FLOW_USER,
        sessionId: OTHER_SESSION,
        reason: 'password_change',
      },
    ];
    expect(
      await changePassword(fixture.deps, FLOW_ACTOR, FLOW_PASSWORD, FLOW_NEW_PASSWORD),
    ).toEqual({
      kind: 'ok',
      events: expectedEvents,
    });
    const changed = storedCredential(fixture);
    expect(await fixture.deps.hasher.verify(changed.hash, FLOW_NEW_PASSWORD, changed.pepper)).toBe(
      'match',
    );
    expect(await fixture.deps.hasher.verify(changed.hash, FLOW_PASSWORD, changed.pepper)).toBe(
      'mismatch',
    );
    expect(fixture.state.tables.sessions[0]?.['revoked_at']).toBeNull();
    expect(fixture.state.tables.sessions[1]).toMatchObject({
      revoked_at: fixture.clock.date(),
      revoked_reason: 'password_change',
    });
    expect(fixture.state.tables.users[0]?.['authz_version']).toBe(2);
    expect(JSON.stringify(fixture.state.tables.access_tokens)).toBe(tokens);
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: 'user.password.changed',
        credentialId: FLOW_SESSION,
        metadata: { revokedSessionCount: 1 },
      }),
    ]);
    expect(fixture.events).toEqual(expectedEvents);
    expect(fixture.trace.indexOf('published:user.password_changed')).toBeGreaterThan(
      fixture.trace.indexOf('tx:commit'),
    );
    expect(fixture.trace.indexOf('audit:user.password.changed')).toBeLessThan(
      fixture.trace.indexOf('tx:commit'),
    );
  });

  it('budgets invalid link attempts by their public identifier without any credential change', async () => {
    const fixture = await authFlowFixture({ maxFailures: 1 });
    const token = fixture.seedToken().raw;
    expect(await setPassword(fixture.deps, passwordInput(token))).toEqual({ kind: 'invalid_link' });
    expect(await setPassword(fixture.deps, passwordInput(token))).toMatchObject({
      kind: 'throttled',
      retryAfterMs: expect.any(Number),
    });
    expect(fixture.trace).toEqual([]);
    expect(fixture.audits).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it('does not consume a valid reset link rejected by password policy', async () => {
    const fixture = await authFlowFixture();
    const { token } = await fixture.seedLink();
    fixture.resetObservations();
    expect(await setPassword(fixture.deps, passwordInput(token, 'short'))).toEqual({
      kind: 'policy',
      violations: ['too_short'],
    });
    expect(fixture.state.tables.password_setup_tokens[0]?.['consumed_at']).toBeNull();
    expect(fixture.audits).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it('treats a link disappearing after discovery as invalid and consumes its failure budget', async () => {
    const fixture = await authFlowFixture({ maxFailures: 1 });
    const { token } = await fixture.seedLink();
    fixture.state.retireLinkAtLock = true;
    fixture.resetObservations();
    expect(await setPassword(fixture.deps, passwordInput(token))).toEqual({ kind: 'invalid_link' });
    const reads = fixture.fake.executed.length;
    expect(await setPassword(fixture.deps, passwordInput(token))).toMatchObject({
      kind: 'throttled',
    });
    expect(fixture.fake.executed).toHaveLength(reads);
    expect(fixture.audits).toEqual([]);
    expect(fixture.events).toEqual([]);
  });

  it('consumes reset exactly once, revokes every session but no PAT, and audits the link row rather than its secret', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession();
    await fixture.seedSession('web', OTHER_SESSION);
    fixture.seedToken();
    const tokens = JSON.stringify(fixture.state.tables.access_tokens);
    const { token, issued } = await fixture.seedLink();
    fixture.resetObservations();
    const outcome = await setPassword(fixture.deps, passwordInput(token));
    expect(outcome).toEqual({
      kind: 'ok',
      userId: FLOW_USER,
      events: [
        { type: 'user.password_changed', userId: FLOW_USER },
        {
          type: 'session.revoked',
          userId: FLOW_USER,
          sessionId: FLOW_SESSION,
          reason: 'password_change',
        },
        {
          type: 'session.revoked',
          userId: FLOW_USER,
          sessionId: OTHER_SESSION,
          reason: 'password_change',
        },
      ],
    });
    expect(
      fixture.state.tables.sessions.every((row) => row['revoked_reason'] === 'password_change'),
    ).toBe(true);
    expect(JSON.stringify(fixture.state.tables.access_tokens)).toBe(tokens);
    expect(fixture.audits).toEqual([
      expect.objectContaining({
        action: 'user.password.set',
        actorId: FLOW_USER,
        credentialType: 'setpw',
        credentialId: issued.tokenRowId,
        metadata: { purpose: 'reset' },
      }),
    ]);
    expect(fixture.logs.at(-1)).toMatchObject({
      event: 'auth.setpw.consumed',
      userId: FLOW_USER,
      purpose: 'reset',
    });
    expect(JSON.stringify({ audits: fixture.audits, logs: fixture.logs })).not.toContain(token);
    expect(fixture.trace.indexOf('published:user.password_changed')).toBeGreaterThan(
      fixture.trace.indexOf('tx:commit'),
    );
    expect(await setPassword(fixture.deps, passwordInput(token))).toEqual({ kind: 'invalid_link' });
    expect(fixture.audits).toHaveLength(1);
  });

  it('rolls back link consumption, credentials, epoch and session revocations when the audit fails', async () => {
    const fixture = await authFlowFixture();
    await fixture.seedSession();
    const original = storedCredential(fixture);
    const { token } = await fixture.seedLink();
    fixture.resetObservations();
    fixture.state.auditFailure = true;
    await expect(setPassword(fixture.deps, passwordInput(token))).rejects.toThrow(
      'audit storage unavailable',
    );
    expect(storedCredential(fixture)).toEqual(original);
    expect(fixture.state.tables.password_setup_tokens[0]?.['consumed_at']).toBeNull();
    expect(fixture.state.tables.sessions[0]?.['revoked_at']).toBeNull();
    expect(fixture.state.tables.users[0]?.['authz_version']).toBe(1);
    expect(fixture.events).toEqual([]);
    expect(fixture.fence.blocked(FLOW_USER)).toBe(false);
  });
});
