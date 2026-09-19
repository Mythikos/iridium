/**
 * The `sessions` rows as the session modules read and write them (03-data-model.md section 3;
 * 04-auth-and-access-control.md section 4).
 *
 * `SessionRepository` is the port: the issuer, the verifier and the revocation functions are
 * written against it and are unit-tested against an in-memory implementation, while
 * `KyselySessionRepository` is the adapter the server runs, constructed per transaction so a
 * caller that holds a `trx` keeps every session write inside it. The two queries of section 4.2
 * — by `token_id` (unique index) and by primary key — both join `users` for the three columns
 * `checkLiveRow` reads, which is what keeps session verification at one indexed lookup (A23).
 */
import type { SessionId, UserId } from '@iridium/contracts';
import type { Insertable, Kysely, Selectable } from 'kysely';

import type { Database } from '../../db/index.ts';
import type {
  SessionKind,
  SessionRevokedReason,
  SessionsTable,
  UserStatus,
} from '../../db/schema.ts';
import { idBytes, sessionIdFromBytes } from '../ids.ts';

/** The session columns M1 reads; the reserved MFA column has no reader. */
export type SessionRow = Omit<Selectable<SessionsTable>, 'mfa_verified_at'>;

/** A session row joined to the three `users` columns liveness depends on. */
export interface SessionWithUser extends SessionRow {
  readonly status: UserStatus;
  readonly is_server_admin: boolean;
  readonly authz_version: number;
}

/** What `insert` takes: every column the issuer decides. */
export type NewSessionRow = Insertable<SessionsTable>;

/** The port every session module is written against. */
export interface SessionRepository {
  /** Query 1 of section 5.5: the row for a presented credential, with its user's liveness. */
  findByTokenId(tokenId: string): Promise<SessionWithUser | null>;
  /** Query 1′: the row a consumed ticket names, by primary key. */
  findById(sessionId: SessionId): Promise<SessionWithUser | null>;
  insert(row: NewSessionRow): Promise<void>;
  /** Live rows of one user and kind, oldest `last_seen_at` first — the input of the per-user cap. */
  listLive(userId: UserId, kind: SessionKind): Promise<readonly SessionRow[]>;
  /** Every live row of one user, for `GET /me/sessions`. */
  listLiveForUser(userId: UserId): Promise<readonly SessionRow[]>;
  /** The `last_seen_at` / `idle_expires_at` refresh of `checkLiveRow`. */
  touch(sessionId: SessionId, lastSeenAt: Date, idleExpiresAt: Date): Promise<void>;
  /** Marks one live row revoked; answers whether a row was live to revoke. */
  revoke(sessionId: SessionId, revokedAt: Date, reason: SessionRevokedReason): Promise<boolean>;
  /**
   * Marks one live row of `userId` revoked, in one statement: an unknown id, another user's
   * session and an already revoked one are the same `false`, which `DELETE /me/sessions/:id`
   * answers as `not_found` (09 section 2.3) without a read that a concurrent revocation could race.
   */
  revokeOwned(
    sessionId: SessionId,
    userId: UserId,
    revokedAt: Date,
    reason: SessionRevokedReason,
  ): Promise<boolean>;
  /** Marks every live row of a user revoked, except `keep`; answers the ids it revoked. */
  revokeAllForUser(
    userId: UserId,
    revokedAt: Date,
    reason: SessionRevokedReason,
    keep?: SessionId,
  ): Promise<readonly SessionId[]>;
  /** `last_authenticated_at = now` — `POST /auth/reauthenticate` (section 4.6). */
  markAuthenticated(sessionId: SessionId, at: Date): Promise<void>;
}

const SESSION_COLUMNS = [
  'sessions.id',
  'sessions.token_id',
  'sessions.secret_hash',
  'sessions.user_id',
  'sessions.kind',
  'sessions.created_at',
  'sessions.last_seen_at',
  'sessions.idle_expires_at',
  'sessions.absolute_expires_at',
  'sessions.last_authenticated_at',
  'sessions.ip',
  'sessions.user_agent',
  'sessions.client_name',
  'sessions.device_name',
  'sessions.client_version',
  'sessions.revoked_at',
  'sessions.revoked_reason',
] as const;

/** The Kysely adapter. Construct one per executor — the app instance or a transaction. */
export class KyselySessionRepository implements SessionRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async findByTokenId(tokenId: string): Promise<SessionWithUser | null> {
    const row = await this.#withUser().where('sessions.token_id', '=', tokenId).executeTakeFirst();
    return row ?? null;
  }

  async findById(sessionId: SessionId): Promise<SessionWithUser | null> {
    const row = await this.#withUser()
      .where('sessions.id', '=', idBytes(sessionId))
      .executeTakeFirst();
    return row ?? null;
  }

  async insert(row: NewSessionRow): Promise<void> {
    await this.#db.insertInto('sessions').values(row).execute();
  }

  async listLive(userId: UserId, kind: SessionKind): Promise<readonly SessionRow[]> {
    return this.#db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('user_id', '=', idBytes(userId))
      .where('kind', '=', kind)
      .where('revoked_at', 'is', null)
      .orderBy('last_seen_at', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
  }

  async listLiveForUser(userId: UserId): Promise<readonly SessionRow[]> {
    return this.#db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('user_id', '=', idBytes(userId))
      .where('revoked_at', 'is', null)
      .orderBy('last_seen_at', 'desc')
      .execute();
  }

  async touch(sessionId: SessionId, lastSeenAt: Date, idleExpiresAt: Date): Promise<void> {
    await this.#db
      .updateTable('sessions')
      .set({ last_seen_at: lastSeenAt, idle_expires_at: idleExpiresAt })
      .where('id', '=', idBytes(sessionId))
      .execute();
  }

  async revoke(
    sessionId: SessionId,
    revokedAt: Date,
    reason: SessionRevokedReason,
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('sessions')
      .set({ revoked_at: revokedAt, revoked_reason: reason })
      .where('id', '=', idBytes(sessionId))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async revokeOwned(
    sessionId: SessionId,
    userId: UserId,
    revokedAt: Date,
    reason: SessionRevokedReason,
  ): Promise<boolean> {
    const result = await this.#db
      .updateTable('sessions')
      .set({ revoked_at: revokedAt, revoked_reason: reason })
      .where('id', '=', idBytes(sessionId))
      .where('user_id', '=', idBytes(userId))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async revokeAllForUser(
    userId: UserId,
    revokedAt: Date,
    reason: SessionRevokedReason,
    keep?: SessionId,
  ): Promise<readonly SessionId[]> {
    const live = await this.listLiveForUser(userId);
    const targets = live.filter((row) => keep === undefined || !row.id.equals(idBytes(keep)));
    if (targets.length === 0) return [];
    await this.#db
      .updateTable('sessions')
      .set({ revoked_at: revokedAt, revoked_reason: reason })
      .where(
        'id',
        'in',
        targets.map((row) => row.id),
      )
      .where('revoked_at', 'is', null)
      .execute();
    return targets.map((row) => sessionIdOf(row));
  }

  async markAuthenticated(sessionId: SessionId, at: Date): Promise<void> {
    await this.#db
      .updateTable('sessions')
      .set({ last_authenticated_at: at })
      .where('id', '=', idBytes(sessionId))
      .execute();
  }

  #withUser() {
    return this.#db
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .select([...SESSION_COLUMNS, 'users.status', 'users.is_server_admin', 'users.authz_version']);
  }
}

/** The branded id of a row. */
export function sessionIdOf(row: Pick<SessionRow, 'id'>): SessionId {
  return sessionIdFromBytes(row.id);
}
