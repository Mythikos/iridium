/**
 * `auth.throttle.integration` (04-auth-and-access-control.md sections 3.7 and 10.2; D04-07): the
 * login throttle over the real `login_throttle` table (`rate-limiter-flexible` on the app pool).
 * Limiter A blocks an `email|ip` pair after the configured failures — a correct password is then
 * refused too, with `Retry-After` — the block doubles per prior block, a success on a not-yet-blocked
 * pair clears the counter, and limiter B blocks every login from an address once its daily budget is
 * spent. The budgets are lowered by environment so the property is provable without hundreds of
 * requests, and each client sends its own address so a test controls its bucket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { accountSourceKey, THROTTLE_PREFIX } from '../../src/auth/credentials/throttle.ts';
import {
  nextIp,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { auditRows, seedUser, signInWeb } from '../support/seed.ts';

const MAX_FAILURES = 3;
/** Above two limiter-A blocks' worth of failures, so the doubling case never spends the day budget. */
const IP_PER_DAY = 10;
const BLOCK_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;

let context: AuthTestServer;

beforeAll(async () => {
  context = await startAuthServer({
    extraEnv: {
      LOGIN_THROTTLE_MAX_FAILURES: String(MAX_FAILURES),
      LOGIN_THROTTLE_IP_PER_DAY: String(IP_PER_DAY),
      LOGIN_THROTTLE_BLOCK_MIN: String(BLOCK_MINUTES),
    },
  });
});

afterAll(async () => {
  await context.stop();
});

async function attempt(email: string, password: string, ip: string) {
  return webClient(context, undefined, ip).post('/auth/sessions', {
    json: { email, password, client: 'web' },
    headers: webHeaders(context.origin),
  });
}

async function failTimes(email: string, ip: string, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- sequential failures build the block
    const failure = await attempt(email, 'the wrong password!!', ip);
    expect(failure.status).toBe(401);
  }
}

function retryAfterSeconds(headers: Headers): number {
  return Number(headers.get('retry-after'));
}

describe('auth.throttle.integration [area:auth]', () => {
  it('blocks a pair after the configured failures, refusing even the correct password with Retry-After', async () => {
    const user = await seedUser(context, { email: 'blocked@example.test' });
    const ip = nextIp();
    await failTimes(user.email, ip, MAX_FAILURES);
    // The pair is now blocked: the correct password is refused with 429, not 401.
    const blocked = await attempt(user.email, user.password, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
    const retryAfter = retryAfterSeconds(blocked.response.headers);
    expect(retryAfter).toBeGreaterThan(BLOCK_MINUTES * SECONDS_PER_MINUTE - 10);
    expect(retryAfter).toBeLessThanOrEqual(BLOCK_MINUTES * SECONDS_PER_MINUTE);
    // The block is recorded on the audit chain, whatever the dedupe window says (section 11.4).
    const failures = await auditRows(context.db, 'user.login.failed');
    expect(failures.some((row) => JSON.stringify(row.metadata).includes('blockedUntil'))).toBe(
      true,
    );
  });

  it('doubles the block per prior block on the same pair', async () => {
    const user = await seedUser(context, { email: 'doubling@example.test' });
    const ip = nextIp();
    await failTimes(user.email, ip, MAX_FAILURES);
    const first = await attempt(user.email, user.password, ip);
    expect(first.status).toBe(429);
    expect(retryAfterSeconds(first.response.headers)).toBeLessThanOrEqual(
      BLOCK_MINUTES * SECONDS_PER_MINUTE,
    );

    // The window ends: limiter A's row goes, the block counter's row stays (both live 24 h, and
    // the library measures them on wall time, so the row is removed the way the window would).
    const emailKey = user.email.toLowerCase();
    await context.db
      .deleteFrom('login_throttle')
      .where('key', '=', `${THROTTLE_PREFIX.accountSource}:${accountSourceKey(emailKey, ip)}`)
      .execute();
    expect((await attempt(user.email, 'the wrong password!!', ip)).status).toBe(401);
    await failTimes(user.email, ip, MAX_FAILURES - 1);
    const second = await attempt(user.email, user.password, ip);
    expect(second.status).toBe(429);
    const retryAfter = retryAfterSeconds(second.response.headers);
    expect(retryAfter).toBeGreaterThan(2 * BLOCK_MINUTES * SECONDS_PER_MINUTE - 10);
    expect(retryAfter).toBeLessThanOrEqual(2 * BLOCK_MINUTES * SECONDS_PER_MINUTE);
  });

  it('applies the pair block to the routes that present the current password, with Retry-After', async () => {
    const user = await seedUser(context, { email: 'blocked-change@example.test' });
    const jar = await signInWeb(context, user);
    const ip = nextIp();
    await failTimes(user.email, ip, MAX_FAILURES);
    const client = webClient(context, jar, ip);
    const change = await client.post('/me/password', {
      json: { currentPassword: user.password, newPassword: 'a brand new passphrase 42' },
      headers: webHeaders(context.origin),
    });
    expect(change.status).toBe(429);
    expect(change.body).toMatchObject({ code: 'rate_limited' });
    expect(retryAfterSeconds(change.response.headers)).toBeGreaterThan(0);
    const reauth = await client.post('/auth/reauthenticate', {
      json: { password: user.password },
      headers: webHeaders(context.origin),
    });
    expect(reauth.status).toBe(429);
    // Nothing changed: the old password still signs in from an address that is not blocked.
    expect((await attempt(user.email, user.password, nextIp())).status).toBe(201);
  });

  it('does not block the same account from a different address', async () => {
    const user = await seedUser(context, { email: 'other-ip@example.test' });
    const ip = nextIp();
    await failTimes(user.email, ip, MAX_FAILURES);
    // A fresh address for the same account is unaffected: the key is the pair.
    const elsewhere = await attempt(user.email, user.password, nextIp());
    expect(elsewhere.status).toBe(201);
  });

  it('clears the pair and its block counter on a successful login before the block threshold', async () => {
    const user = await seedUser(context, { email: 'cleared@example.test' });
    const ip = nextIp();
    await failTimes(user.email, ip, MAX_FAILURES - 1);
    // A success clears limiter A; the failures no longer count toward a block.
    expect((await attempt(user.email, user.password, ip)).status).toBe(201);
    await failTimes(user.email, ip, MAX_FAILURES - 1);
    expect((await attempt(user.email, user.password, ip)).status).toBe(201);
    const rows = await context.db
      .selectFrom('login_throttle')
      .select('key')
      .where('key', 'like', `%${accountSourceKey(user.email.toLowerCase(), ip)}`)
      .execute();
    expect(rows).toStrictEqual([]);
  });

  it('blocks every login from an address once its daily budget is spent, whatever the account', async () => {
    const ip = nextIp();
    // Distinct unknown accounts, so limiter A never blocks first; each failure spends the source budget.
    for (let index = 0; index < IP_PER_DAY; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential failures spend the day budget
      await attempt(`nobody-${String(index)}@example.test`, 'the wrong password!!', ip);
    }
    const user = await seedUser(context, { email: 'source-blocked@example.test' });
    const blocked = await attempt(user.email, user.password, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
    expect(retryAfterSeconds(blocked.response.headers)).toBeGreaterThan(0);
    // The same account from another address is unaffected: limiter B keys on the source alone.
    expect((await attempt(user.email, user.password, nextIp())).status).toBe(201);
  });
});
