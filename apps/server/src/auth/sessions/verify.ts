/**
 * Session verification (04-auth-and-access-control.md section 4.2; D04-06; D04-23).
 *
 * Two entry points over one shared row check, because two callers need it: an HTTP request
 * presents a raw credential (`verifySession`), while `/collab` has already proved ownership of a
 * session through a ticket and holds only its id (`loadLiveSession`). Everything that can change
 * *after* issuance — revocation, idle expiry, absolute expiry, `users.status`, `is_server_admin`,
 * `authz_version` — lives in `checkLiveRow`, so the collab path can never accept a session REST
 * would reject. `loadLiveSession` returns the dead *reason* because `/collab` maps an expired
 * session and a revoked one to different close codes; REST collapses both into `401`.
 *
 * Channel binding (D04-06): a `kind='web'` session is accepted only from the cookie, a
 * `kind='desktop'` session only as a bearer. Nothing about a session is cached in process memory.
 */
import { parseToken, type SessionId, type UserPrincipal } from '@iridium/contracts';

import { userIdFromBytes } from '../ids.ts';
import { secretMatches } from '../secret-hash.ts';
import { sessionIdOf, type SessionRepository, type SessionWithUser } from './repository.ts';
import { nextIdleExpiry, type SessionTtls } from './ttl.ts';

/** Why a row is not live. `/collab` maps `expired` to 4401 and the other two to 4403. */
export type SessionDeadReason = 'revoked' | 'expired' | 'user_inactive';

/** What the shared row check answers. */
export type LiveSessionCheck = UserPrincipal | { readonly dead: SessionDeadReason };

/** Where a credential arrived; a session kind is accepted on exactly one of them. */
export type SessionChannel = 'cookie' | 'bearer';

/**
 * `last_seen_at` is written at most once per this interval (03-data-model.md section 3), which
 * bounds write amplification on the hot path: one cheap primary-key update per minute per session.
 */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

/** Whether a row check is a dead answer. */
export function isDeadSession(
  check: LiveSessionCheck,
): check is { readonly dead: SessionDeadReason } {
  return 'dead' in check;
}

/** The four repository members verification needs: the two lookups, the refresh, the finalisation. */
export type VerifierSessionRepository = Pick<
  SessionRepository,
  'findByTokenId' | 'findById' | 'touch' | 'revoke'
>;

/** Verifies sessions. One instance per process; the repository decides which executor it reads. */
export class SessionVerifier {
  readonly #repository: VerifierSessionRepository;
  readonly #ttls: SessionTtls;
  readonly #now: () => number;

  constructor(repository: VerifierSessionRepository, ttls: SessionTtls, now: () => number) {
    this.#repository = repository;
    this.#ttls = ttls;
    this.#now = now;
  }

  /**
   * The shared check. Finalises an expired row with `revoked_reason='expired'` so the sweep job
   * and the admin view agree, and refreshes `last_seen_at` when the write interval has elapsed.
   */
  async checkLiveRow(row: SessionWithUser): Promise<LiveSessionCheck> {
    const nowMs = this.#now();
    const sessionId = sessionIdOf(row);
    if (row.revoked_at !== null) return { dead: 'revoked' };
    if (nowMs >= row.idle_expires_at.getTime() || nowMs >= row.absolute_expires_at.getTime()) {
      await this.#repository.revoke(sessionId, new Date(nowMs), 'expired');
      return { dead: 'expired' };
    }
    if (row.status !== 'active') return { dead: 'user_inactive' };
    if (nowMs - row.last_seen_at.getTime() >= LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.#repository.touch(
        sessionId,
        new Date(nowMs),
        nextIdleExpiry(this.#ttls, row.kind, nowMs, row.absolute_expires_at),
      );
    }
    return {
      kind: 'user',
      userId: userIdFromBytes(row.user_id),
      sessionId,
      sessionKind: row.kind,
      isServerAdmin: row.is_server_admin,
      authzVersion: row.authz_version,
      lastAuthenticatedAt: row.last_authenticated_at,
    };
  }

  /**
   * An HTTP credential on a channel. A malformed string costs no query; an unknown id still pays
   * one constant-time comparison; a kind on the wrong channel is refused after the secret matched,
   * so a replayed value cannot even tell that the row exists.
   */
  async verifySession(raw: string, channel: SessionChannel): Promise<UserPrincipal | null> {
    const parsed = parseToken(raw);
    if (parsed === null || parsed.kind !== 'ses') return null;
    const row = await this.#repository.findByTokenId(parsed.tokenId);
    if (!secretMatches(parsed.secret, row?.secret_hash ?? null) || row === null) return null;
    if ((row.kind === 'web') !== (channel === 'cookie')) return null;
    const check = await this.checkLiveRow(row);
    return isDeadSession(check) ? null : check;
  }

  /**
   * A session by primary key, after a ticket proved ownership (section 7.3). No secret comparison
   * and no channel binding: both were proved when the ticket was issued.
   */
  async loadLiveSession(sessionId: SessionId): Promise<LiveSessionCheck | null> {
    const row = await this.#repository.findById(sessionId);
    if (row === null) return null;
    return this.checkLiveRow(row);
  }
}
