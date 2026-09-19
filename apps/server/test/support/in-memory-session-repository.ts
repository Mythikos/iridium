/**
 * An in-memory `SessionRepository` for the unit layer (10-testing-and-quality.md, "Mocks": the
 * unit project may substitute an I/O adapter, and this is the adapter the session modules are
 * written against). It implements the port exactly — the same ordering, the same "live" predicate
 * — so `auth.session-verify-parity.unit` drives `verifySession` and `loadLiveSession` over
 * identical rows without a database.
 */
import type { SessionId, UserId } from '@iridium/contracts';

import { idBytes } from '../../src/auth/ids.ts';
import {
  sessionIdOf,
  type NewSessionRow,
  type SessionRepository,
  type SessionRow,
  type SessionWithUser,
} from '../../src/auth/sessions/repository.ts';
import type { SessionKind, SessionRevokedReason, UserStatus } from '../../src/db/schema.ts';

/** The `users` columns the join supplies, per user. */
export interface InMemoryUser {
  readonly status: UserStatus;
  readonly is_server_admin: boolean;
  readonly authz_version: number;
}

const DEFAULT_USER: InMemoryUser = { status: 'active', is_server_admin: false, authz_version: 1 };

function asRow(row: NewSessionRow): SessionRow {
  return {
    id: row.id,
    token_id: row.token_id,
    secret_hash: row.secret_hash,
    user_id: row.user_id,
    kind: row.kind,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    idle_expires_at: row.idle_expires_at,
    absolute_expires_at: row.absolute_expires_at,
    last_authenticated_at: row.last_authenticated_at,
    ip: row.ip ?? null,
    user_agent: row.user_agent ?? null,
    client_name: row.client_name ?? null,
    device_name: row.device_name ?? null,
    client_version: row.client_version ?? null,
    revoked_at: row.revoked_at ?? null,
    revoked_reason: row.revoked_reason ?? null,
  };
}

/** The in-memory adapter. Rows are keyed by the canonical session id. */
export class InMemorySessionRepository implements SessionRepository {
  readonly #rows = new Map<string, SessionRow>();
  readonly #users = new Map<string, InMemoryUser>();

  /** Sets the `users` columns for a user id; unknown users read as active, non-admin, version 1. */
  setUser(userId: UserId, user: Partial<InMemoryUser>): void {
    this.#users.set(userId, { ...DEFAULT_USER, ...this.#users.get(userId), ...user });
  }

  /** Overwrites a row's columns, the way a test ages a session out. */
  patch(sessionId: SessionId, patch: Partial<SessionRow>): void {
    const row = this.#rows.get(sessionId);
    if (row === undefined) throw new Error(`no session ${sessionId}`);
    this.#rows.set(sessionId, { ...row, ...patch });
  }

  /** The stored row, for assertions. */
  row(sessionId: SessionId): SessionRow | undefined {
    return this.#rows.get(sessionId);
  }

  /** Every stored row, insertion order. */
  get rows(): readonly SessionRow[] {
    return [...this.#rows.values()];
  }

  async findByTokenId(tokenId: string): Promise<SessionWithUser | null> {
    const row = this.rows.find((candidate) => candidate.token_id === tokenId);
    return row === undefined ? null : this.#join(row);
  }

  async findById(sessionId: SessionId): Promise<SessionWithUser | null> {
    const row = this.#rows.get(sessionId);
    return row === undefined ? null : this.#join(row);
  }

  async insert(row: NewSessionRow): Promise<void> {
    const stored = asRow(row);
    this.#rows.set(sessionIdOf(stored), stored);
  }

  async listLive(userId: UserId, kind: SessionKind): Promise<readonly SessionRow[]> {
    const user = idBytes(userId);
    return this.rows
      .filter((row) => row.user_id.equals(user) && row.kind === kind && row.revoked_at === null)
      .toSorted(
        (left, right) =>
          left.last_seen_at.getTime() - right.last_seen_at.getTime() ||
          left.created_at.getTime() - right.created_at.getTime(),
      );
  }

  async listLiveForUser(userId: UserId): Promise<readonly SessionRow[]> {
    const user = idBytes(userId);
    return this.rows
      .filter((row) => row.user_id.equals(user) && row.revoked_at === null)
      .toSorted((left, right) => right.last_seen_at.getTime() - left.last_seen_at.getTime());
  }

  async touch(sessionId: SessionId, lastSeenAt: Date, idleExpiresAt: Date): Promise<void> {
    this.patch(sessionId, { last_seen_at: lastSeenAt, idle_expires_at: idleExpiresAt });
  }

  async revoke(
    sessionId: SessionId,
    revokedAt: Date,
    reason: SessionRevokedReason,
  ): Promise<boolean> {
    const row = this.#rows.get(sessionId);
    if (row === undefined || row.revoked_at !== null) return false;
    this.patch(sessionId, { revoked_at: revokedAt, revoked_reason: reason });
    return true;
  }

  async revokeOwned(
    sessionId: SessionId,
    userId: UserId,
    revokedAt: Date,
    reason: SessionRevokedReason,
  ): Promise<boolean> {
    const row = this.#rows.get(sessionId);
    if (row === undefined || !row.user_id.equals(idBytes(userId))) return false;
    return this.revoke(sessionId, revokedAt, reason);
  }

  async revokeAllForUser(
    userId: UserId,
    revokedAt: Date,
    reason: SessionRevokedReason,
    keep?: SessionId,
  ): Promise<readonly SessionId[]> {
    const revoked: SessionId[] = [];
    for (const row of await this.listLiveForUser(userId)) {
      const id = sessionIdOf(row);
      if (id === keep) continue;
      this.patch(id, { revoked_at: revokedAt, revoked_reason: reason });
      revoked.push(id);
    }
    return revoked;
  }

  async markAuthenticated(sessionId: SessionId, at: Date): Promise<void> {
    this.patch(sessionId, { last_authenticated_at: at });
  }

  #join(row: SessionRow): SessionWithUser {
    const userId = [...this.#users.keys()].find((candidate) =>
      idBytes(candidate).equals(row.user_id),
    );
    const user = userId === undefined ? DEFAULT_USER : (this.#users.get(userId) ?? DEFAULT_USER);
    return { ...row, ...user };
  }
}
