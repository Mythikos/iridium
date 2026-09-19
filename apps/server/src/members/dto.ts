/**
 * `vault_members` rows as `GET /vaults/:vaultId/members` renders them (09-api-reference.md §2.6).
 *
 * A member row carries the user's e-mail and status as well as the name and colour, because the
 * people who manage a vault need to tell two "Alex" apart and to see that one of them can no longer
 * sign in. That is also why the shape is `MemberUser` and not `UserRef`: `UserRef` is the embedded
 * *attribution* shape and deliberately carries no address.
 *
 * `version` is the row's `If-Match` validator for `PUT` and `DELETE`, so a members list gives a
 * client everything it needs to change a role without a second read.
 */
import type { Member } from '@iridium/contracts';

import { userIdFromBytes } from '../auth/ids.ts';
import type { UserStatus, VaultRole } from '../db/schema.ts';

/** One joined `vault_members` row with its user and the user who granted it. */
export interface MemberRow {
  readonly user_id: Buffer;
  readonly role: VaultRole;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly display_name: string;
  readonly color_hue: number;
  readonly email: string;
  readonly status: UserStatus;
  readonly granted_by_id: Buffer | null;
  readonly granted_by_name: string | null;
  readonly granted_by_hue: number | null;
}

/** One `vault_members` row on the wire. */
export function toMemberDto(row: MemberRow): Member {
  return {
    user: {
      id: userIdFromBytes(row.user_id),
      displayName: row.display_name,
      colorHue: row.color_hue,
      email: row.email,
      status: row.status,
    },
    role: row.role,
    // `granted_by` is a foreign key into `users`, so a null join is a restore from a partial dump
    // rather than an ordinary state; the grant itself is still true and is still shown.
    grantedBy: {
      id:
        row.granted_by_id === null
          ? userIdFromBytes(row.user_id)
          : userIdFromBytes(row.granted_by_id),
      displayName: row.granted_by_name ?? 'unknown',
      colorHue: row.granted_by_hue ?? 0,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}
