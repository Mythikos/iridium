/**
 * The `users` rows the auth routes read, and the `User` DTO they answer with (03-data-model.md
 * section 3; 09-api-reference.md section 2.0).
 *
 * Login reads the user and its credential in one statement (section 3.7 step 5); every other route
 * reads the user by primary key. `hasCredentials` is the presence of the `user_credentials` row —
 * an account created by an administrator cannot log in until its set-password link is consumed.
 */
import type { UserId } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import type { Database } from '../db/index.ts';
import type { UserStatus } from '../db/schema.ts';
import { idBytes, userIdFromBytes } from './ids.ts';

/** A user row with the credential columns login needs (`null` when no credential exists). */
export interface UserWithCredential {
  readonly id: Buffer;
  readonly email: string;
  readonly email_key: string;
  readonly display_name: string;
  readonly is_server_admin: boolean;
  readonly status: UserStatus;
  readonly color_hue: number;
  readonly authz_version: number;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_login_at: Date | null;
  readonly password_hash: string | null;
  readonly pepper_version: number | null;
}

/** The `User` DTO of 09 section 2.0. */
export interface UserDto {
  readonly id: UserId;
  readonly email: string;
  readonly displayName: string;
  readonly isServerAdmin: boolean;
  readonly status: UserStatus;
  readonly colorHue: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
  readonly hasCredentials: boolean;
  readonly version: number;
}

const USER_COLUMNS = [
  'users.id',
  'users.email',
  'users.email_key',
  'users.display_name',
  'users.is_server_admin',
  'users.status',
  'users.color_hue',
  'users.authz_version',
  'users.version',
  'users.created_at',
  'users.updated_at',
  'users.last_login_at',
  'user_credentials.password_hash',
  'user_credentials.pepper_version',
] as const;

function withCredential(db: Kysely<Database>) {
  return db
    .selectFrom('users')
    .leftJoin('user_credentials', 'user_credentials.user_id', 'users.id')
    .select(USER_COLUMNS);
}

/** `email_key = LOWER(email)`: the login lookup is case-insensitive without a collation dependency. */
export function emailKeyOf(email: string): string {
  return email.toLowerCase();
}

/** Step 5 of the login path: the user and its credential by `email_key`. */
export async function loadUserByEmail(
  db: Kysely<Database>,
  email: string,
): Promise<UserWithCredential | null> {
  const row = await withCredential(db)
    .where('users.email_key', '=', emailKeyOf(email))
    .executeTakeFirst();
  return row ?? null;
}

/** A user and its credential by primary key. */
export async function loadUserById(
  db: Kysely<Database>,
  userId: UserId,
): Promise<UserWithCredential | null> {
  const row = await withCredential(db).where('users.id', '=', idBytes(userId)).executeTakeFirst();
  return row ?? null;
}

/**
 * Thrown when an authenticated principal's `users` row cannot be read. Every session and token row
 * references its user, so this is an operator's direct deletion or a restore from a partial dump;
 * the auth plugin maps it to `401 unauthenticated` (09-api-reference.md section 1.5).
 */
export class PrincipalUserMissingError extends Error {
  readonly userId: UserId;

  constructor(userId: UserId) {
    super(
      `the authenticated principal's user ${userId} has no users row; sessions and tokens reference ` +
        'their user, so restore the row (or revoke the credentials that name it) and check the dump ' +
        'the schema was restored from (11-operations-and-deployment.md, restore)',
    );
    this.name = 'PrincipalUserMissingError';
    this.userId = userId;
  }
}

/** The user row a principal names; throws `PrincipalUserMissingError` when it is gone. */
export async function requireUserRow(
  db: Kysely<Database>,
  userId: UserId,
): Promise<UserWithCredential> {
  const row = await loadUserById(db, userId);
  if (row === null) throw new PrincipalUserMissingError(userId);
  return row;
}

/** The wire form. Timestamps are RFC 3339 UTC (09 section 1.1). */
export function toUserDto(row: UserWithCredential): UserDto {
  return {
    id: userIdFromBytes(row.id),
    email: row.email,
    displayName: row.display_name,
    isServerAdmin: row.is_server_admin,
    status: row.status,
    colorHue: row.color_hue,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastLoginAt: row.last_login_at === null ? null : row.last_login_at.toISOString(),
    hasCredentials: row.password_hash !== null,
    version: row.version,
  };
}
