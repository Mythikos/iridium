/**
 * `/vaults/:vaultId/members` (09-api-reference.md section 2.6): everyone who can read a vault can see
 * who else can, and a manager can change who can.
 *
 * `If-Match` is required on `PUT` only when a row already exists, which is why `API_ROUTES` marks that
 * route `conditional` rather than `required`: a first add has no version to compare, and demanding one
 * would make adding a member a two-request operation.
 */

import { z } from 'zod';

import { Role } from '../authz.ts';
import { Member } from './common.ts';

/** `GET /vaults/:vaultId/members` — ordered by display name, capped at 1 000 rows. */
export interface MemberList {
  readonly items: readonly Member[];
}

/** `GET /vaults/:vaultId/members`. */
export const MemberList: z.ZodType<MemberList> = z
  .strictObject({ items: z.array(Member).max(1000) })
  .meta({ id: 'MemberList' });

/** `PUT /vaults/:vaultId/members/:userId` — add a membership or change its role. */
export interface PutMemberBody {
  readonly role: Role;
}

/** `PUT /vaults/:vaultId/members/:userId`. */
export const PutMemberBody: z.ZodType<PutMemberBody> = z
  .strictObject({ role: Role })
  .meta({ id: 'PutMemberBody' });
