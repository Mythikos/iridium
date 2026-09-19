/**
 * Session revocation (04-auth-and-access-control.md sections 3.8 and 4.7).
 *
 * Every path sets `revoked_at` and a `revoked_reason` rather than deleting the row, so the admin
 * sessions view and the audit trail can show what happened; the sweep job removes rows 30 days
 * after their absolute expiry. The functions answer what they revoked so the caller can publish one
 * `session.revoked` bus event per session **after** its transaction commits (section 8.3).
 */
import type { SessionId, UserId } from '@iridium/contracts';

import type { SessionRevokedReason } from '../../db/schema.ts';
import type { SessionRepository } from './repository.ts';

/**
 * Revokes one of a user's own sessions. Answers `false` when no live row of that user carries the
 * id — unknown, foreign and already revoked are one answer, so a handler cannot tell them apart.
 */
export function revokeOwnSession(
  repository: SessionRepository,
  sessionId: SessionId,
  userId: UserId,
  reason: SessionRevokedReason,
  nowMs: number,
): Promise<boolean> {
  return repository.revokeOwned(sessionId, userId, new Date(nowMs), reason);
}

/** Revokes every live session of a user except `keep`, answering the ids it revoked. */
export function revokeUserSessions(
  repository: SessionRepository,
  userId: UserId,
  reason: SessionRevokedReason,
  nowMs: number,
  keep?: SessionId,
): Promise<readonly SessionId[]> {
  return repository.revokeAllForUser(userId, new Date(nowMs), reason, keep);
}
