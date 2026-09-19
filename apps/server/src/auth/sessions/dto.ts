/**
 * The `Session` representation of 09-api-reference.md section 2.3, rendered from a `sessions` row.
 *
 * One mapper serves the login response, `GET /me/sessions` and — at M7 — the administrator's
 * sessions view, which is the one surface that lists revoked rows: `revokedAt` and `revokedReason`
 * are part of the wire shape today so that view needs no second representation. The secret and
 * the MFA column are never rendered; the address is restored from its binary form.
 */
import type { Session, SessionId } from '@iridium/contracts';

import { ipFromBytes } from '../ip.ts';
import { sessionIdOf, type SessionRow } from './repository.ts';

/** Renders a row; `current` marks the session the caller presented. */
export function toSessionDto(row: SessionRow, current: SessionId): Session {
  const id = sessionIdOf(row);
  return {
    id,
    kind: row.kind,
    current: id === current,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    idleExpiresAt: row.idle_expires_at.toISOString(),
    absoluteExpiresAt: row.absolute_expires_at.toISOString(),
    lastAuthenticatedAt: row.last_authenticated_at.toISOString(),
    ip: ipFromBytes(row.ip),
    userAgent: row.user_agent,
    clientName: row.client_name,
    deviceName: row.device_name,
    clientVersion: row.client_version,
    revokedAt: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    revokedReason: row.revoked_reason,
  };
}
