/**
 * `auth.session-verify-parity.unit` (04-auth-and-access-control.md sections 4.2 and 14; D04-23):
 * table-driven over the six session row states — live, revoked, idle-expired, absolute-expired,
 * owner disabled, owner deleted — `verifySession` and `loadLiveSession` accept and reject the
 * identical set, so the shared `checkLiveRow` cannot drift between them; `loadLiveSession` never
 * accepts a raw `irid_ses_…` string and `verifySession` never accepts a bare session id. The
 * channel binding of D04-06 and the `last_seen_at` write interval are asserted beside them.
 */
import { mintToken, SessionId, UserId, type SessionId as SessionIdType } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { withOtherSecret } from '../../../test/support/credentials.ts';
import { InMemorySessionRepository } from '../../../test/support/in-memory-session-repository.ts';
import { idBytes } from '../ids.ts';
import { secretHash } from '../secret-hash.ts';
import { type SessionRow } from './repository.ts';
import { sessionTtlsFromConfig, type SessionTtls } from './ttl.ts';
import {
  isDeadSession,
  LAST_SEEN_WRITE_INTERVAL_MS,
  SessionVerifier,
  type LiveSessionCheck,
} from './verify.ts';

const NOW_MS = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const USER: UserId = UserId.parse('019948c4-0000-7000-8000-000000000001');
const TTLS: SessionTtls = sessionTtlsFromConfig({
  sessionWebIdleHours: 24,
  sessionWebAbsoluteDays: 14,
  sessionDesktopIdleDays: 30,
  sessionDesktopAbsoluteDays: 90,
  stepUpWindowMinutes: 10,
});

interface Fixture {
  readonly repository: InMemorySessionRepository;
  readonly verifier: SessionVerifier;
  readonly raw: string;
  readonly sessionId: SessionIdType;
  now: number;
}

async function fixture(
  kind: 'web' | 'desktop' = 'web',
  row: Partial<SessionRow> = {},
): Promise<Fixture> {
  const repository = new InMemorySessionRepository();
  const state = { now: NOW_MS };
  const verifier = new SessionVerifier(repository, TTLS, () => state.now);
  const minted = mintToken('ses');
  const sessionId = SessionId.parse('019948c4-0000-7000-8000-0000000000aa');
  const created = new Date(NOW_MS - HOUR_MS);
  await repository.insert({
    id: idBytes(sessionId),
    token_id: minted.tokenId,
    secret_hash: secretHash(minted.secret),
    user_id: idBytes(USER),
    kind,
    created_at: created,
    last_seen_at: created,
    idle_expires_at: new Date(NOW_MS + HOUR_MS),
    absolute_expires_at: new Date(NOW_MS + DAY_MS),
    last_authenticated_at: created,
    ip: null,
    user_agent: null,
    client_name: kind,
    device_name: null,
    client_version: null,
    revoked_at: null,
    revoked_reason: null,
    ...row,
  });
  return {
    repository,
    verifier,
    raw: minted.raw,
    sessionId,
    get now() {
      return state.now;
    },
    set now(value: number) {
      state.now = value;
    },
  };
}

const STATES = [
  'live',
  'revoked',
  'idle-expired',
  'absolute-expired',
  'owner-disabled',
  'owner-deleted',
] as const;
type State = (typeof STATES)[number];

async function inState(state: State): Promise<Fixture> {
  switch (state) {
    case 'live':
      return fixture();
    case 'revoked':
      return fixture('web', { revoked_at: new Date(NOW_MS - 1), revoked_reason: 'logout' });
    case 'idle-expired':
      return fixture('web', { idle_expires_at: new Date(NOW_MS - 1) });
    case 'absolute-expired':
      return fixture('web', { absolute_expires_at: new Date(NOW_MS - 1) });
    case 'owner-disabled': {
      const built = await fixture();
      built.repository.setUser(USER, { status: 'disabled' });
      return built;
    }
    case 'owner-deleted': {
      const built = await fixture();
      built.repository.setUser(USER, { status: 'deleted' });
      return built;
    }
    default: {
      const unreachable: never = state;
      throw new Error(`unknown state ${String(unreachable)}`);
    }
  }
}

/** One word per answer, so both paths are compared by one unconditional assertion. */
function outcomeOf(check: LiveSessionCheck | null): string {
  if (check === null) return 'refused';
  return isDeadSession(check) ? check.dead : 'accept';
}

const EXPECTED: Readonly<Record<State, 'accept' | 'revoked' | 'expired' | 'user_inactive'>> = {
  live: 'accept',
  revoked: 'revoked',
  'idle-expired': 'expired',
  'absolute-expired': 'expired',
  'owner-disabled': 'user_inactive',
  'owner-deleted': 'user_inactive',
};

describe('auth.session-verify-parity.unit [area:auth]', () => {
  describe.each(STATES)('row state %s', (state) => {
    it('is accepted or refused identically by verifySession and loadLiveSession', async () => {
      const http = await inState(state);
      const collab = await inState(state);
      const viaHttp = await http.verifier.verifySession(http.raw, 'cookie');
      const viaCollab = await collab.verifier.loadLiveSession(collab.sessionId);
      const expected = EXPECTED[state];
      // The HTTP path answers a principal or nothing; the collab path names the dead reason.
      expect(outcomeOf(viaHttp)).toBe(expected === 'accept' ? 'accept' : 'refused');
      expect(outcomeOf(viaCollab)).toBe(expected);
      expect(viaHttp).toStrictEqual(expected === 'accept' ? viaCollab : null);
    });
  });

  it('finalises an expired row with revoked_reason=expired on both paths, exactly once', async () => {
    const http = await inState('idle-expired');
    await http.verifier.verifySession(http.raw, 'cookie');
    expect(http.repository.row(http.sessionId)?.revoked_reason).toBe('expired');
    // A second look sees the row as revoked rather than expiring it again.
    await expect(http.verifier.loadLiveSession(http.sessionId)).resolves.toStrictEqual({
      dead: 'revoked',
    });
  });

  it('answers the principal with the user columns the join supplied', async () => {
    const built = await fixture();
    built.repository.setUser(USER, { is_server_admin: true, authz_version: 7 });
    const principal = await built.verifier.verifySession(built.raw, 'cookie');
    expect(principal).toMatchObject({
      kind: 'user',
      userId: USER,
      sessionId: built.sessionId,
      sessionKind: 'web',
      isServerAdmin: true,
      authzVersion: 7,
    });
    expect(principal?.lastAuthenticatedAt).toStrictEqual(new Date(NOW_MS - HOUR_MS));
  });

  it('never accepts a bare session id as a credential, nor a raw credential as a session id', async () => {
    const built = await fixture();
    await expect(built.verifier.verifySession(built.sessionId, 'cookie')).resolves.toBeNull();
    await expect(
      built.verifier.verifySession('irid_tkt_' + built.raw.slice(9), 'bearer'),
    ).resolves.toBeNull();
    // A raw credential is not a UUID: the id lookup finds nothing rather than parsing the secret.
    const notAnId = SessionId.safeParse(built.raw);
    expect(notAnId.success).toBe(false);
    await expect(
      built.verifier.loadLiveSession(SessionId.parse('019948c4-0000-7000-8000-0000000000ff')),
    ).resolves.toBeNull();
  });

  it('refuses a wrong secret for a real id, and an unknown id, without touching the row', async () => {
    const built = await fixture();
    await expect(
      built.verifier.verifySession(withOtherSecret(built.raw), 'cookie'),
    ).resolves.toBeNull();
    // A damaged CRC never reaches the store either.
    await expect(
      built.verifier.verifySession(`${built.raw.slice(0, -1)}!`, 'cookie'),
    ).resolves.toBeNull();
    const other = mintToken('ses');
    await expect(built.verifier.verifySession(other.raw, 'cookie')).resolves.toBeNull();
    expect(built.repository.row(built.sessionId)?.last_seen_at).toStrictEqual(
      new Date(NOW_MS - HOUR_MS),
    );
  });

  it('binds a web session to the cookie and a desktop session to the bearer (D04-06)', async () => {
    const web = await fixture('web');
    await expect(web.verifier.verifySession(web.raw, 'bearer')).resolves.toBeNull();
    await expect(web.verifier.verifySession(web.raw, 'cookie')).resolves.not.toBeNull();
    const desktop = await fixture('desktop');
    await expect(desktop.verifier.verifySession(desktop.raw, 'cookie')).resolves.toBeNull();
    await expect(desktop.verifier.verifySession(desktop.raw, 'bearer')).resolves.not.toBeNull();
  });

  it('writes last_seen_at at most once per interval, sliding idle expiry under the absolute cap', async () => {
    const built = await fixture('web', {
      last_seen_at: new Date(NOW_MS - LAST_SEEN_WRITE_INTERVAL_MS),
    });
    await built.verifier.verifySession(built.raw, 'cookie');
    let row = built.repository.row(built.sessionId);
    expect(row?.last_seen_at).toStrictEqual(new Date(NOW_MS));
    expect(row?.idle_expires_at).toStrictEqual(new Date(NOW_MS + TTLS.webIdleMs));

    built.now = NOW_MS + LAST_SEEN_WRITE_INTERVAL_MS - 1;
    await built.verifier.loadLiveSession(built.sessionId);
    row = built.repository.row(built.sessionId);
    expect(row?.last_seen_at).toStrictEqual(new Date(NOW_MS));

    // Near the absolute cap the idle expiry never passes it.
    built.repository.patch(built.sessionId, {
      absolute_expires_at: new Date(NOW_MS + 2 * HOUR_MS),
    });
    built.now = NOW_MS + HOUR_MS;
    await built.verifier.loadLiveSession(built.sessionId);
    expect(built.repository.row(built.sessionId)?.idle_expires_at).toStrictEqual(
      new Date(NOW_MS + 2 * HOUR_MS),
    );
  });
});
