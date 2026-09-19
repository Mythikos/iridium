/** A password verified before account locking cannot authorize a later credential state. */
import { LIMITS, newId, SessionId, UserId } from '@iridium/contracts';
import { onTestFinished, describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { ownedFakeDatabase } from '../../test/support/owned-fake-database.ts';
import { AuthzMutations } from '../authz/mutations.ts';
import { SessionCommandFence } from '../authz/session-command-fence.ts';
import { createLogger } from '../ops/logging.ts';
import { DetachedAuditSink, FailureAuditGate } from './audit.ts';
import { PasswordHasher } from './credentials/hasher.ts';
import { PasswordPolicy } from './credentials/policy.ts';
import { createMemoryLimiters, LoginThrottle } from './credentials/throttle.ts';
import { idBytes } from './ids.ts';
import { changePassword, login, reauthenticate, type PasswordFlowDeps } from './login.ts';
import { SetPasswordLinks } from './setpw/service.ts';
import type { UserWithCredential } from './users.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const SESSION = SessionId.parse('019948c4-0000-7000-8000-000000000002');
const PASSWORD = 'correct horse stable battery';
const NOW = new Date('2026-09-17T18:00:00Z');
const THROTTLE = {
  maxFailures: LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE,
  blockBaseSeconds: LIMITS.LOGIN_BLOCK_BASE_SECONDS,
  blockMaxSeconds: LIMITS.LOGIN_BLOCK_MAX_SECONDS,
  sourcePerDay: 100,
};
type Race =
  | 'user_removed'
  | 'disabled'
  | 'credential_removed'
  | 'password_changed'
  | 'pepper_changed'
  | 'session_removed'
  | 'session_revoked';

async function fixture(race: Race) {
  const pepper = new Uint8Array(32).fill(7);
  const hasher = new PasswordHasher({
    memoryKib: 8192,
    timeCost: 1,
    concurrency: 1,
    peppers: new Map([[1, pepper]]),
    currentPepperVersion: async () => 1,
    fillRandom: (bytes) => bytes.fill(7),
  });
  const hashed = await hasher.hash(PASSWORD);
  const user: UserWithCredential = {
    id: idBytes(USER),
    email: 'commit@example.test',
    email_key: 'commit@example.test',
    display_name: 'Commit',
    is_server_admin: false,
    status: 'active',
    color_hue: 20,
    authz_version: 1,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    last_login_at: null,
    password_hash: hashed.phc,
    pepper_version: 1,
  };
  const fake = await ownedFakeDatabase({
    script: (query) => {
      if (query.sql.includes('left join `user_credentials`')) return { rows: [user] };
      if (query.sql.includes('from `users`'))
        return {
          rows:
            race === 'user_removed'
              ? []
              : [{ status: race === 'disabled' ? 'disabled' : 'active' }],
        };
      if (query.sql.includes('from `user_credentials`'))
        return {
          rows:
            race === 'credential_removed'
              ? []
              : [
                  {
                    password_hash:
                      race === 'password_changed' ? 'a different committed hash' : hashed.phc,
                    pepper_version: race === 'pepper_changed' ? 2 : 1,
                  },
                ],
        };
      if (query.sql.includes('from `sessions`'))
        return { rows: race === 'session_removed' ? [] : [{ revoked_at: NOW }] };
      throw new Error(`A refused operation wrote to storage: ${query.sql}`);
    },
  });
  onTestFinished(() => fake.close());
  const mutations = new AuthzMutations({
    database: () => fake.db,
    owner: () => fake.owner,
    fence: new SessionCommandFence(),
    clock: new ManualClock(),
    settleWrites: async () => undefined,
    deliver: async () => true,
    revalidate: async () => undefined,
    uncertain: () => undefined,
  });
  onTestFinished(() => mutations.stop());
  const policy = new PasswordPolicy({
    minLength: 15,
    maxLength: 128,
    blocklist: new Set(),
    checkBreachedList: true,
  });
  const deps: PasswordFlowDeps = {
    db: fake.db,
    mutations,
    ownerFence: fake.owner.captureFence(),
    hasher,
    policy,
    throttle: new LoginThrottle(createMemoryLimiters(THROTTLE), THROTTLE, () => null),
    ttls: {
      webIdleMs: 86_400_000,
      webAbsoluteMs: 1_209_600_000,
      desktopIdleMs: 2_592_000_000,
      desktopAbsoluteMs: 7_776_000_000,
      stepUpWindowMs: 600_000,
    },
    setpw: new SetPasswordLinks({
      publicOrigin: new URL('https://example.test'),
      hasher,
      policy,
      now: () => NOW.getTime(),
      newId,
    }),
    audit: {
      record: async () => {
        throw new Error('A refused operation must not audit success.');
      },
    },
    sink: new DetachedAuditSink(() => fake.db),
    loginFailureGate: new FailureAuditGate(60_000, () => NOW.getTime()),
    now: () => NOW.getTime(),
    newId,
    log: createLogger({
      level: 'silent',
      format: 'json',
      instanceId: 'password-commit-test',
      destination: { write: () => undefined },
    }),
    countLoginFailure: () => undefined,
    currentPepper: async () => pepper,
  };
  return { deps, fake };
}

const ACTOR = { userId: USER, sessionId: SESSION, ip: '198.51.100.12', context: {} };
describe('auth.password-commit.unit [area:auth]', () => {
  it.each<Race>([
    'user_removed',
    'disabled',
    'credential_removed',
    'password_changed',
    'pepper_changed',
  ])('refuses a verified login when %s commits before the account lock', async (race) => {
    const { deps, fake } = await fixture(race);
    expect(
      await login(deps, {
        email: 'commit@example.test',
        password: PASSWORD,
        client: 'desktop',
        deviceName: 'laptop',
        ip: ACTOR.ip,
        userAgent: undefined,
        clientVersion: null,
        context: {},
      }),
    ).toEqual({ kind: 'invalid' });
    expect(fake.executed.some((query) => query.sql.includes('for update'))).toBe(true);
    expect(fake.executed.every((query) => query.sql.startsWith('select'))).toBe(true);
  });
  it.each<Race>(['session_removed', 'session_revoked'])(
    'cannot refresh or change a password after %s commits',
    async (race) => {
      const { deps, fake } = await fixture(race);
      expect(await reauthenticate(deps, ACTOR, PASSWORD)).toEqual({ kind: 'invalid' });
      expect(await changePassword(deps, ACTOR, PASSWORD, 'a different stable passphrase')).toEqual({
        kind: 'invalid',
      });
      expect(fake.executed.every((query) => query.sql.startsWith('select'))).toBe(true);
    },
  );
});
