/** Bounded SQL link reads from committed projections; authorization belongs to ContentReadCore. */
import {
  LIMITS,
  type LinkPage,
  type ListInboundLinksQuery,
  type NoteLinks,
} from '@iridium/contracts';
import { sql, type Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { cursorInvalid, type CursorCodec } from '../mcp/cursor.ts';
import { ProblemError } from '../security/problem.ts';
import { pathsCte, readNodeRows } from '../tree/queries.ts';
import { linkDto, type IndexedLinkRow } from './dto.ts';

/** Source identity and link rows come from the same repeatable-read snapshot. */
export function readNoteLinks(
  db: Kysely<Database>,
  vaultId: string,
  noteId: string,
): Promise<NoteLinks> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const projection = await trx
        .selectFrom('note_projections')
        .select('revision')
        .where('note_id', '=', idBytes(noteId))
        .executeTakeFirst();
      const source = (
        await readNodeRows(trx, idBytes(vaultId), {
          where: sql`tree_paths.id = ${idBytes(noteId)}`,
        })
      )[0];
      if (projection === undefined || source === undefined) throw new ProblemError('not_found');
      const rows = await trx
        .selectFrom('note_links')
        .selectAll()
        .where('from_note_id', '=', idBytes(noteId))
        .where('revision', '=', projection.revision)
        .orderBy('ordinal')
        .limit(LIMITS.MARKDOWN_LINKS_MAX)
        .execute();
      return {
        items: rows.map((row) => linkDto({ ...row, from_path: source.path })),
        revision: projection.revision,
      };
    });
}

/** Both the keyset predicate and SQL ordering use binary path order, including accents and case. */
export async function readBacklinks(
  db: Kysely<Database>,
  codec: CursorCodec,
  scope: { readonly vaultId: string; readonly noteId: string; readonly principalKey: string },
  query: ListInboundLinksQuery,
): Promise<LinkPage> {
  const filter = {
    vaultId: scope.vaultId,
    nodeId: scope.noteId,
    status: query.status === undefined ? null : query.status.toSorted(),
  };
  const after =
    query.cursor === undefined
      ? undefined
      : codec.parse(query.cursor, { kind: 'links', filter, principalKey: scope.principalKey }).a;
  if (
    after !== undefined &&
    (after.length !== 2 ||
      typeof after[0] !== 'string' ||
      typeof after[1] !== 'number' ||
      !Number.isSafeInteger(after[1]) ||
      after[1] < 1)
  )
    throw cursorInvalid('The backlinks cursor has an invalid path or row id.');
  const result = await sql<IndexedLinkRow>`WITH RECURSIVE ${pathsCte(idBytes(scope.vaultId))}
    SELECT links.*, tree_paths.path AS from_path FROM note_links links
    JOIN tree_paths ON tree_paths.id = links.from_note_id
    JOIN note_projections projection ON projection.note_id = links.from_note_id AND projection.revision = links.revision
    WHERE links.vault_id = ${idBytes(scope.vaultId)} AND links.resolved_node_id = ${idBytes(scope.noteId)}
      ${query.status === undefined ? sql`` : sql`AND links.status IN (${sql.join(query.status)})`}
      ${after === undefined ? sql`` : sql`AND (CAST(tree_paths.path AS BINARY) > CAST(${after[0]} AS BINARY) OR (CAST(tree_paths.path AS BINARY) = CAST(${after[0]} AS BINARY) AND links.id > ${after[1]}))`}
    ORDER BY CAST(tree_paths.path AS BINARY), links.id LIMIT ${sql.lit(query.limit + 1)}`.execute(
    db,
  );
  const items = result.rows.slice(0, query.limit).map(linkDto);
  const last = items.at(-1);
  return {
    items,
    ...(result.rows.length > query.limit && last !== undefined
      ? {
          nextCursor: codec.issue({
            kind: 'links',
            filter,
            principalKey: scope.principalKey,
            after: [last.fromPath, last.id],
          }),
        }
      : {}),
  };
}
