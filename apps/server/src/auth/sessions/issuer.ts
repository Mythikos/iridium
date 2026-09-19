/**
 * `SessionIssuer.issue()` — the single function every present and future login method finishes
 * through (04-auth-and-access-control.md section 4.1; D04-01; section 13 rule 1).
 *
 * A fresh row on every login, so there is no pre-login session and fixation is structurally
 * impossible; `last_authenticated_at = created_at`; and the per-user cap: at most
 * `LIMITS.SESSIONS_PER_USER_PER_KIND` live sessions per user per kind, the oldest by
 * `last_seen_at` revoked with `revoked_reason='replaced'` when exceeded. A desktop login with the
 * same `deviceName` for the same user also replaces that device's previous session.
 *
 * The secret is minted here and returned exactly once; only its hash is stored.
 */
import { LIMITS, mintToken, type SessionId, type UserId } from '@iridium/contracts';

import type { SessionKind } from '../../db/schema.ts';
import { idBytes } from '../ids.ts';
import { ipToBytes } from '../ip.ts';
import { secretHash } from '../secret-hash.ts';
import { truncateUserAgent } from '../user-agent.ts';
import { sessionIdOf, type SessionRepository, type SessionRow } from './repository.ts';
import { absoluteMs, idleMs, type SessionTtls } from './ttl.ts';

/**
 * Characters of `sessions.client_version` (03, `VARCHAR(32)`). The header parser caps the value it
 * reads at 64 characters (`security/client-header.ts`), which is wider than this column, so the
 * issuer cuts it to the column. A column width, not a product limit, registered in
 * `limits.single-source.allowlist.json`. `device_name` needs no cut: `CreateSessionBody.deviceName`
 * is bounded to the column's 120 characters by the wire schema, and `user_agent` goes through the
 * one truncation every writer of that column shares (`auth/user-agent.ts`).
 */
const CLIENT_VERSION_MAX_CHARS = 32;

/** What a login hands the issuer. */
export interface IssueSessionInput {
  readonly userId: UserId;
  readonly kind: SessionKind;
  readonly ip: string | null;
  /** The `User-Agent` header as received; `truncateUserAgent` is what the column records. */
  readonly userAgent: string | undefined | null;
  readonly deviceName: string | null;
  readonly clientVersion: string | null;
  /** The login method, recorded in the audit event by the caller (`password` at M1). */
  readonly method: 'password';
}

/** What the issuer answers: the credential (shown once), the row, and the sessions it replaced. */
export interface IssuedSession {
  /** `irid_ses_…`, the whole credential. Never stored, never logged. */
  readonly raw: string;
  readonly sessionId: SessionId;
  readonly row: SessionRow;
  /** Sessions revoked as `replaced` by the cap or by the device rule, for the bus events. */
  readonly replaced: readonly SessionId[];
}

/** Issues a session. Runs inside the caller's transaction when the repository is bound to one. */
export async function issueSession(
  repository: SessionRepository,
  ttls: SessionTtls,
  nowMs: number,
  newId: () => string,
  input: IssueSessionInput,
): Promise<IssuedSession> {
  const minted = mintToken('ses');
  const now = new Date(nowMs);
  const id = newId();
  const absoluteExpiresAt = new Date(nowMs + absoluteMs(ttls, input.kind));
  const idleExpiresAt = new Date(
    Math.min(nowMs + idleMs(ttls, input.kind), absoluteExpiresAt.getTime()),
  );
  const deviceName = input.deviceName;

  const row: SessionRow = {
    id: idBytes(id),
    token_id: minted.tokenId,
    secret_hash: secretHash(minted.secret),
    user_id: idBytes(input.userId),
    kind: input.kind,
    created_at: now,
    last_seen_at: now,
    idle_expires_at: idleExpiresAt,
    absolute_expires_at: absoluteExpiresAt,
    last_authenticated_at: now,
    ip: ipToBytes(input.ip),
    user_agent: truncateUserAgent(input.userAgent),
    client_name: input.kind,
    device_name: deviceName,
    client_version:
      input.clientVersion === null ? null : input.clientVersion.slice(0, CLIENT_VERSION_MAX_CHARS),
    revoked_at: null,
    revoked_reason: null,
  };

  // Replacement before insertion, so the new row can never be the one the cap evicts.
  const live = await repository.listLive(input.userId, input.kind);
  const replaced: SessionId[] = [];
  const survivors: SessionRow[] = [];
  for (const existing of live) {
    if (input.kind === 'desktop' && deviceName !== null && existing.device_name === deviceName) {
      replaced.push(sessionIdOf(existing));
    } else {
      survivors.push(existing);
    }
  }
  // `listLive` is ordered oldest `last_seen_at` first, so the excess is the head of the list.
  const excess = survivors.length + 1 - LIMITS.SESSIONS_PER_USER_PER_KIND;
  for (const oldest of survivors.slice(0, Math.max(0, excess))) {
    replaced.push(sessionIdOf(oldest));
  }
  for (const victim of replaced) {
    // Sequential by design: each revocation is one primary-key update inside one transaction.
    // eslint-disable-next-line no-await-in-loop -- one row per iteration inside the caller's transaction
    await repository.revoke(victim, now, 'replaced');
  }

  await repository.insert({ ...row, mfa_verified_at: null });
  return { raw: minted.raw, sessionId: sessionIdOf(row), row, replaced };
}
