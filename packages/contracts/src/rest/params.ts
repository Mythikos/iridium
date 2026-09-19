/**
 * The path-parameter schemas the M1 routes share (09-api-reference.md section 2).
 *
 * They are their own module because several domains address the same row: a vault id is a parameter
 * of `/vaults/:vaultId`, of its members and of its nodes, and one schema for it is what keeps the
 * `404 not_found` for a malformed id identical everywhere.
 */

import { z } from 'zod';

import { NoteId, SessionId, UserId, VaultId } from '../ids.ts';

/** `/vaults/:vaultId` and everything nested under it. */
export const VaultIdParams: z.ZodType<{ readonly vaultId: string }> = z
  .strictObject({ vaultId: VaultId })
  .meta({ id: 'VaultIdParams' });

/** `/vaults/:vaultId/members/:userId`. */
export const VaultMemberParams: z.ZodType<{
  readonly vaultId: string;
  readonly userId: string;
}> = z.strictObject({ vaultId: VaultId, userId: UserId }).meta({ id: 'VaultMemberParams' });

/** `/notes/:noteId`. */
export const NoteIdParams: z.ZodType<{ readonly noteId: string }> = z
  .strictObject({ noteId: NoteId })
  .meta({ id: 'NoteIdParams' });

/** `/me/sessions/:sessionId`. */
export const SessionIdParams: z.ZodType<{ readonly sessionId: string }> = z
  .strictObject({ sessionId: SessionId })
  .meta({ id: 'SessionIdParams' });

/** `/admin/users/:userId`. */
export const UserIdParams: z.ZodType<{ readonly userId: string }> = z
  .strictObject({ userId: UserId })
  .meta({ id: 'UserIdParams' });
