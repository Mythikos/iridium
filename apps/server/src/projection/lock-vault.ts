/** Projection publication reads target structure under the same vault gate as structural writers. */
import type { Transaction } from 'kysely';

import type { Database } from '../db/schema.ts';

/**
 * Call immediately after the owner fence, before any consistent read or note/child lock. The caller
 * already knows the immutable vault id, so waiting for this shared lock cannot retain an older tree
 * snapshot. Raw update appends and explicit revision checkpoints do not acquire this gate.
 */
export async function lockProjectionVault(
  trx: Transaction<Database>,
  vaultId: Buffer,
): Promise<void> {
  await trx
    .selectFrom('vaults')
    .select('id')
    .where('id', '=', vaultId)
    .forShare()
    .executeTakeFirstOrThrow();
}
