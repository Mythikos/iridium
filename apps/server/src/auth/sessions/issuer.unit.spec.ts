/**
 * `auth.session-issuer.unit` (04-auth-and-access-control.md section 4.1; D04-01): a fresh row per
 * login with `last_authenticated_at = created_at`, the per-kind lifetimes, the per-user cap of
 * twenty with the oldest by `last_seen_at` revoked as `replaced`, the desktop device replacement,
 * and the column caps. The cookie and step-up helpers that read the same row are asserted beside it.
 */
import { LIMITS, UserId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { InMemorySessionRepository } from '../../../test/support/in-memory-session-repository.ts';
import { ipFromBytes } from '../ip.ts';
import {
  clearedSessionCookieOptions,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from './cookie.ts';
import { issueSession, type IssueSessionInput } from './issuer.ts';
import { sessionIdOf } from './repository.ts';
import { stepUpExpiresAt, stepUpSatisfied } from './stepup.ts';
import { absoluteMs, idleMs, nextIdleExpiry, sessionTtlsFromConfig } from './ttl.ts';

const NOW_MS = Date.parse('2026-09-13T12:00:00.000Z');
const USER: UserId = UserId.parse('019948c4-0000-7000-8000-000000000001');
const TTLS = sessionTtlsFromConfig({
  sessionWebIdleHours: 24,
  sessionWebAbsoluteDays: 14,
  sessionDesktopIdleDays: 30,
  sessionDesktopAbsoluteDays: 90,
  stepUpWindowMinutes: 10,
});
let counter = 0;
const newId = (): string => {
  counter += 1;
  return `019948c4-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
};

function input(overrides: Partial<IssueSessionInput> = {}): IssueSessionInput {
  return {
    userId: USER,
    kind: 'web',
    ip: '203.0.113.7',
    userAgent: 'test-agent/1.0',
    deviceName: null,
    clientVersion: '1.2.3',
    method: 'password',
    ...overrides,
  };
}

describe('auth.session-issuer.unit [area:auth]', () => {
  it('issues a fresh row whose secret is stored hashed, with the web lifetimes', async () => {
    const repository = new InMemorySessionRepository();
    const issued = await issueSession(repository, TTLS, NOW_MS, newId, input());
    expect(issued.raw.startsWith('irid_ses_')).toBe(true);
    expect(issued.replaced).toStrictEqual([]);
    const row = repository.row(issued.sessionId);
    expect(row).toBeDefined();
    expect(row?.secret_hash.length).toBe(32);
    expect(issued.raw).not.toContain(row?.secret_hash.toString('base64'));
    expect(row?.created_at).toStrictEqual(new Date(NOW_MS));
    expect(row?.last_authenticated_at).toStrictEqual(new Date(NOW_MS));
    expect(row?.idle_expires_at).toStrictEqual(new Date(NOW_MS + idleMs(TTLS, 'web')));
    expect(row?.absolute_expires_at).toStrictEqual(new Date(NOW_MS + absoluteMs(TTLS, 'web')));
    expect(row?.client_name).toBe('web');
    expect(row?.client_version).toBe('1.2.3');
    expect(ipFromBytes(row?.ip ?? null)).toBe('203.0.113.7');
  });

  it('applies the desktop lifetimes and records the device name', async () => {
    const repository = new InMemorySessionRepository();
    const issued = await issueSession(
      repository,
      TTLS,
      NOW_MS,
      newId,
      input({ kind: 'desktop', deviceName: 'laptop' }),
    );
    const row = repository.row(issued.sessionId);
    expect(row?.idle_expires_at).toStrictEqual(new Date(NOW_MS + TTLS.desktopIdleMs));
    expect(row?.absolute_expires_at).toStrictEqual(new Date(NOW_MS + TTLS.desktopAbsoluteMs));
    expect(row?.device_name).toBe('laptop');
  });

  it('caps the idle expiry at the absolute expiry when the idle window is the longer one', () => {
    const shortAbsolute = { ...TTLS, webAbsoluteMs: 1000 };
    expect(nextIdleExpiry(shortAbsolute, 'web', NOW_MS, new Date(NOW_MS + 1000))).toStrictEqual(
      new Date(NOW_MS + 1000),
    );
  });

  it('cuts the user agent and the client version to their columns, and stores the validated device name verbatim', async () => {
    const repository = new InMemorySessionRepository();
    // `deviceName` arrives bounded to its column by the wire schema (`CreateSessionBody`), so the
    // issuer stores exactly what was validated; the other two are untrusted headers it cuts itself.
    const deviceName = 'd'.repeat(120);
    const issued = await issueSession(
      repository,
      TTLS,
      NOW_MS,
      newId,
      input({
        kind: 'desktop',
        userAgent: 'é'.repeat(300),
        deviceName,
        clientVersion: 'v'.repeat(40),
      }),
    );
    const row = repository.row(issued.sessionId);
    expect(Buffer.byteLength(row?.user_agent ?? '', 'utf8')).toBeLessThanOrEqual(255);
    // The cut lands on a character boundary: a two-byte `é` is dropped whole, never split.
    expect(row?.user_agent).toMatch(/^é+$/);
    expect(row?.device_name).toBe(deviceName);
    expect(row?.client_version).toHaveLength(32);
  });

  it('keeps null columns null when nothing was supplied', async () => {
    const repository = new InMemorySessionRepository();
    const issued = await issueSession(
      repository,
      TTLS,
      NOW_MS,
      newId,
      input({ ip: null, userAgent: null, clientVersion: null }),
    );
    const row = repository.row(issued.sessionId);
    expect(row?.ip).toBeNull();
    expect(row?.user_agent).toBeNull();
    expect(row?.client_version).toBeNull();
  });

  it('revokes the oldest session by last_seen_at as replaced when the per-kind cap is exceeded', async () => {
    const repository = new InMemorySessionRepository();
    const issued = [];
    for (let index = 0; index < LIMITS.SESSIONS_PER_USER_PER_KIND; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- twenty sequential logins by design
      issued.push(await issueSession(repository, TTLS, NOW_MS + index, newId, input()));
    }
    // The desktop kind has its own cap: a desktop login evicts nothing on the web side.
    const desktop = await issueSession(
      repository,
      TTLS,
      NOW_MS + 100,
      newId,
      input({ kind: 'desktop', deviceName: 'd' }),
    );
    expect(desktop.replaced).toStrictEqual([]);

    const twentyFirst = await issueSession(repository, TTLS, NOW_MS + 200, newId, input());
    const oldest = issued[0];
    expect(oldest).toBeDefined();
    expect(twentyFirst.replaced).toStrictEqual([oldest?.sessionId]);
    expect(repository.row(oldest?.sessionId ?? twentyFirst.sessionId)?.revoked_reason).toBe(
      'replaced',
    );
    expect((await repository.listLive(USER, 'web')).length).toBe(LIMITS.SESSIONS_PER_USER_PER_KIND);
    // A freshly issued row is never the one evicted.
    expect(repository.row(twentyFirst.sessionId)?.revoked_at).toBeNull();
  });

  it('replaces the previous session of the same desktop device, whatever its age', async () => {
    const repository = new InMemorySessionRepository();
    const first = await issueSession(
      repository,
      TTLS,
      NOW_MS,
      newId,
      input({ kind: 'desktop', deviceName: 'laptop' }),
    );
    const other = await issueSession(
      repository,
      TTLS,
      NOW_MS + 1,
      newId,
      input({ kind: 'desktop', deviceName: 'phone' }),
    );
    const again = await issueSession(
      repository,
      TTLS,
      NOW_MS + 2,
      newId,
      input({ kind: 'desktop', deviceName: 'laptop' }),
    );
    expect(again.replaced).toStrictEqual([first.sessionId]);
    expect(repository.row(first.sessionId)?.revoked_reason).toBe('replaced');
    expect(repository.row(other.sessionId)?.revoked_at).toBeNull();
    // A web login never matches a device name.
    const web = await issueSession(
      repository,
      TTLS,
      NOW_MS + 3,
      newId,
      input({ deviceName: 'laptop' }),
    );
    expect(web.replaced).toStrictEqual([]);
    expect(sessionIdOf(web.row)).toBe(web.sessionId);
  });

  it('spells the __Host- cookie with Secure, HttpOnly, SameSite=Lax, Path=/ and the absolute Max-Age', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-iridium_session');
    const options = sessionCookieOptions(new Date(NOW_MS + 90_500), NOW_MS);
    expect(options).toStrictEqual({
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 90,
    });
    expect(sessionCookieOptions(new Date(NOW_MS - 1), NOW_MS).maxAge).toBe(0);
    expect(clearedSessionCookieOptions()).toStrictEqual({
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 0,
    });
  });

  it('measures the step-up window from last_authenticated_at, inclusive of the boundary', () => {
    const at = new Date(NOW_MS);
    expect(stepUpSatisfied(at, NOW_MS + TTLS.stepUpWindowMs, TTLS.stepUpWindowMs)).toBe(true);
    expect(stepUpSatisfied(at, NOW_MS + TTLS.stepUpWindowMs + 1, TTLS.stepUpWindowMs)).toBe(false);
    expect(stepUpExpiresAt(at, TTLS.stepUpWindowMs)).toStrictEqual(new Date(NOW_MS + 600_000));
  });
});
