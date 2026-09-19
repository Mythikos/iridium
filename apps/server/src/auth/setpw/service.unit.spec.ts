/**
 * `auth.setpw.unit` (04-auth-and-access-control.md section 3.3; D04-02): the link is the public
 * origin plus the `/set-password` route with the credential in the fragment; consumption refuses a
 * string that is not a set-password link before any statement runs, so a ticket, a session or a
 * malformed value costs no lookup; and issuing supersedes the user's outstanding links before the
 * insert. The database-facing half is `setpw-link.integration`.
 */
import { mintToken, UserId } from '@iridium/contracts';
import { describe, expect, it, onTestFinished } from 'vitest';

import { fakeDatabase } from '../../../test/support/fake-driver.ts';
import { ManualClock } from '../../../test/support/manual-clock.ts';
import { ownedFakeDatabase } from '../../../test/support/owned-fake-database.ts';
import { AuthzMutations } from '../../authz/mutations.ts';
import { SessionCommandFence } from '../../authz/session-command-fence.ts';
import { PasswordHasher } from '../credentials/hasher.ts';
import { PasswordPolicy } from '../credentials/policy.ts';
import { idBytes } from '../ids.ts';
import { secretHash } from '../secret-hash.ts';
import {
  SET_PASSWORD_PATH,
  SetPasswordLinks,
  SETUP_LINK_HOURS_DEFAULT,
  SetupLinkTransactionError,
} from './service.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const NOW_MS = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR_MS = 3_600_000;

function service() {
  const hasher = new PasswordHasher({
    memoryKib: 8_192,
    timeCost: 1,
    concurrency: 1,
    peppers: new Map([[1, new Uint8Array(32).fill(1)]]),
    currentPepperVersion: async () => 1,
    fillRandom: (bytes) => bytes.fill(1),
  });
  const policy = new PasswordPolicy({
    minLength: 15,
    maxLength: 128,
    blocklist: new Set(),
    checkBreachedList: true,
  });
  let ids = 0;
  return new SetPasswordLinks({
    publicOrigin: new URL('https://iridium.example/'),
    hasher,
    policy,
    now: () => NOW_MS,
    newId: () => {
      ids += 1;
      return `019948c4-0000-7000-8000-${ids.toString(16).padStart(12, '0')}`;
    },
  });
}

describe('auth.setpw.unit [area:auth]', () => {
  it.each(['malformed', 'wrong-kind', 'missing', 'wrong-secret', 'consumed', 'expired', 'valid'])(
    'only resolves a verified live recipient before fencing: %s',
    async (kind) => {
      const minted = mintToken('spl');
      const token =
        kind === 'malformed'
          ? 'invalid'
          : kind === 'wrong-kind'
            ? mintToken('ses').raw
            : minted.raw;
      const fake = fakeDatabase({
        script: () => ({
          rows:
            kind === 'missing'
              ? []
              : [
                  {
                    user_id: idBytes(USER),
                    secret_hash: secretHash(
                      kind === 'wrong-secret' ? 'a different secret' : minted.secret,
                    ),
                    consumed_at: kind === 'consumed' ? new Date(NOW_MS) : null,
                    expires_at: new Date(NOW_MS + (kind === 'expired' ? 0 : HOUR_MS)),
                  },
                ],
        }),
      });
      onTestFinished(() => fake.db.destroy());
      expect(await service().recipient(fake.db, token)).toBe(kind === 'valid' ? USER : null);
      expect(fake.executed).toHaveLength(kind === 'malformed' || kind === 'wrong-kind' ? 0 : 1);
    },
  );

  it('keeps issuance READ COMMITTED inside the owner barrier and delivers only after commit', async () => {
    const isolations: Array<string | undefined> = [];
    const fake = await ownedFakeDatabase({
      script: (query) =>
        query.sql.startsWith('select')
          ? { rows: [{ id: idBytes(USER) }] }
          : { numAffectedRows: 1n },
      transaction: (phase, settings) => {
        if (phase === 'begin') isolations.push(settings?.isolationLevel);
      },
    });
    const fence = new SessionCommandFence();
    const deliveries: Array<{ readonly blocked: boolean; readonly phase: string | undefined }> = [];
    const mutations = new AuthzMutations({
      database: () => fake.db,
      owner: () => fake.owner,
      fence,
      clock: new ManualClock(),
      settleWrites: async () => undefined,
      deliver: async () => {
        deliveries.push({ blocked: fence.blocked(USER), phase: fake.lifecycle.at(-2) });
        return true;
      },
      revalidate: async () => undefined,
      uncertain: () => undefined,
    });
    onTestFinished(async () => {
      await mutations.stop();
      await fake.close();
    });
    const issued = await service().withIssuanceMutation(
      mutations,
      USER,
      ({ issue }) =>
        issue({
          userId: USER,
          issuedBy: USER,
          purpose: 'reset',
        }),
      () => [{ type: 'user.password_changed', userId: USER }],
    );
    expect(issued.link).toContain('#irid_spl_');
    expect(isolations.at(-1)).toBe('read committed');
    expect(fake.executed[0]?.sql).toContain('from `collab_owner_fence`');
    expect(fake.executed[1]?.sql).toContain('from `users`');
    expect(deliveries).toEqual([{ blocked: true, phase: 'commit' }]);
    expect(fence.blocked(USER)).toBe(false);
  });

  it.each(['token removed', 'token secret changed'])(
    'refuses a previously verified token when transaction discovery finds %s',
    async (race) => {
      const minted = mintToken('spl');
      const fake = fakeDatabase({
        script: () => ({
          rows:
            race === 'token removed'
              ? []
              : [
                  {
                    id: idBytes(USER),
                    user_id: idBytes(USER),
                    secret_hash: secretHash('replacement secret'),
                  },
                ],
        }),
      });
      onTestFinished(() => fake.db.destroy());
      expect(
        await service().consume(fake.db, {
          token: minted.raw,
          password: 'a long accepted passphrase',
        }),
      ).toEqual({ ok: false, failure: 'invalid_link' });
      expect(fake.executed).toHaveLength(1);
      expect(fake.executed[0]?.sql).toContain('from `password_setup_tokens`');
      expect(fake.executed[0]?.sql).not.toContain('for update');
    },
  );

  it.each(['user removed', 'token removed', 'token secret changed'])(
    'refuses discovery authority after the locked reread observes %s',
    async (race) => {
      const minted = mintToken('spl');
      const candidate = {
        id: idBytes(USER),
        user_id: idBytes(USER),
        secret_hash: secretHash(minted.secret),
      };
      const fake = fakeDatabase({
        script: (_query, ordinal) => {
          if (ordinal === 1) return { rows: [candidate] };
          if (ordinal === 2)
            return {
              rows:
                race === 'user removed' ? [] : [{ email: 'member@example.test', status: 'active' }],
            };
          return {
            rows:
              race === 'token removed'
                ? []
                : [{ ...candidate, secret_hash: secretHash('different secret') }],
          };
        },
      });
      expect(
        await service().consume(fake.db, {
          token: minted.raw,
          password: 'a long accepted passphrase',
        }),
      ).toEqual({ ok: false, failure: 'invalid_link' });
      expect(fake.executed.every((query) => query.sql.startsWith('select'))).toBe(true);
    },
  );

  it('rejects an arbitrary caller transaction before making any issuance statement', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    await expect(
      fake.db.transaction().execute((trx) =>
        service().issue(trx, {
          userId: USER,
          purpose: 'initial',
          issuedBy: USER,
        }),
      ),
    ).rejects.toThrow(SetupLinkTransactionError);
    expect(fake.executed).toStrictEqual([]);
    expect(fake.lifecycle).toContain('rollback');
  });

  it('rolls supersession back when inserting the replacement fails', async () => {
    const fake = fakeDatabase({
      script: (query) => {
        if (query.sql.startsWith('select')) return { rows: [{ id: idBytes(USER) }] };
        if (query.sql.startsWith('insert'))
          return { throws: new Error('replacement insert failed') };
        return { numAffectedRows: 1n };
      },
    });
    await expect(
      service().issue(fake.db, {
        userId: USER,
        purpose: 'reset',
        issuedBy: USER,
      }),
    ).rejects.toThrow('replacement insert failed');
    expect(fake.lifecycle).toStrictEqual(['acquire', 'begin', 'rollback', 'release']);
  });

  it('discovers the owner without locking, then locks the user before rereading the token', async () => {
    const minted = mintToken('spl');
    const row = {
      id: idBytes(USER),
      user_id: idBytes(USER),
      secret_hash: secretHash(minted.secret),
      purpose: 'initial',
      expires_at: new Date(NOW_MS + HOUR_MS),
      consumed_at: null,
    };
    const fake = fakeDatabase({
      script: (_query, ordinal) => ({
        rows: ordinal === 2 ? [{ email: 'member@example.test', status: 'active' }] : [row],
      }),
    });
    const result = await service().consume(fake.db, { token: minted.raw, password: 'short' });
    expect(result).toMatchObject({ ok: false, failure: 'policy' });
    expect(fake.executed).toHaveLength(3);
    expect(fake.executed[0]?.sql).not.toContain('for update');
    expect(fake.executed[1]?.sql).toContain('from `users`');
    expect(fake.executed[1]?.sql).toContain('for update');
    expect(fake.executed[2]?.sql).toContain('from `password_setup_tokens`');
    expect(fake.executed[2]?.sql).toContain('for update');
  });

  it('renders the link with the credential in the fragment of the set-password route', () => {
    const raw = mintToken('spl').raw;
    expect(service().linkFor(raw)).toBe(`https://iridium.example${SET_PASSWORD_PATH}#${raw}`);
    expect(SET_PASSWORD_PATH).toBe('/set-password');
  });

  it('refuses a value that is not a set-password link before any statement runs', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    const subject = service();
    for (const token of ['not a link', mintToken('tkt').raw, mintToken('ses').raw, '']) {
      // eslint-disable-next-line no-await-in-loop -- one refusal per shape, in order
      await expect(
        subject.consume(fake.db, { token, password: 'a perfectly fine passphrase' }),
      ).resolves.toStrictEqual({ ok: false, failure: 'invalid_link' });
    }
    expect(fake.executed).toStrictEqual([]);
  });

  it('supersedes the outstanding links of the user, then inserts the new row with the default TTL', async () => {
    const fake = fakeDatabase({
      script: (query) =>
        query.sql.startsWith('select')
          ? { rows: [{ id: idBytes(USER) }] }
          : { numAffectedRows: 1n },
    });
    const issued = await service().issue(fake.db, {
      userId: USER,
      purpose: 'reset',
      issuedBy: USER,
    });
    expect(issued.link.startsWith('https://iridium.example/set-password#irid_spl_')).toBe(true);
    expect(issued.expiresAt).toStrictEqual(new Date(NOW_MS + SETUP_LINK_HOURS_DEFAULT * HOUR_MS));
    expect(fake.executed.map((query) => query.sql.split(' ')[0])).toStrictEqual([
      'select',
      'update',
      'insert',
    ]);
    expect(fake.executed[1]?.sql).toContain('`consumed_at` is null');
    expect(fake.executed[2]?.sql).toContain('`password_setup_tokens`');
    // The link secret itself is never a parameter: only its hash reaches the row.
    const secret = issued.link.slice(issued.link.indexOf('#') + 1);
    expect(JSON.stringify(fake.executed[2]?.parameters)).not.toContain(secret.slice(26, 60));
  });
});
