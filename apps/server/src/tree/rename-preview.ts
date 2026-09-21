/** Read-only analysis shares the write path's move and sibling validation functions. */
import type { RenameImpactQuery, RenameImpactResult } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { ProblemError } from '../security/problem.ts';
import { siblingNameConflicts, validateParent } from './mutations.ts';
import { storedNodeName } from './names.ts';
import { derivePath } from './paths.ts';
import { renameImpact } from './rename-impact.ts';

/** Computes a consistent preview without creating a write lease or changing any row. */
export async function previewRename(
  db: Kysely<Database>,
  vaultId: string,
  noteId: string,
  query: RenameImpactQuery,
): Promise<RenameImpactResult> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const node = await trx
        .selectFrom('nodes')
        .selectAll()
        .where('id', '=', idBytes(noteId))
        .where('vault_id', '=', idBytes(vaultId))
        .where('kind', '=', 'note')
        .executeTakeFirst();
      if (node === undefined) throw new ProblemError('not_found');
      if (node.deleted_at !== null) throw new ProblemError('not_found');
      const name = query.name === undefined ? node.name : storedNodeName(query.name, 'note');
      const parentId = query.parentId === undefined ? node.parent_id : idBytes(query.parentId);
      await validateParent(trx, node, parentId);
      const wouldConflict = await siblingNameConflicts(trx, node.id, parentId, name);
      const parent = await derivePath(trx, parentId);
      return {
        affectedLinks: await renameImpact(trx, vaultId, noteId),
        wouldConflict,
        newPath: `${parent.path}/${name}`,
      };
    });
}
