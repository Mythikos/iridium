/** Bounded snapshot or indexed lookups from the same committing transaction (08 section 5.2). */
import { idFromBytes, LIMITS } from '@iridium/contracts';
import {
  createVaultIndex,
  foldLinkPath,
  resolveLink,
  type NoteContext,
  type ResolvedLink,
  type VaultIndexSnapshot,
} from '@iridium/markdown';
import { sql, type Kysely, type RawBuilder } from 'kysely';

import type { Database } from '../db/schema.ts';
import type { ServerLogger } from '../ops/logging.ts';
import { derivePath } from '../tree/paths.ts';
import { childLookupHint } from '../tree/queries.ts';
import { IndexedVaultIndex } from './indexed-lookups.ts';

/** One note's path, as the snapshot reads it. */
export interface PathRow {
  readonly id: Buffer;
  readonly name: string;
  readonly path: string;
}
/** Arrays exist only below the cap; the large-vault path retains requested lookup keys alone. */
export interface ProjectionIndex {
  readonly note: NoteContext;
  readonly mode: 'snapshot' | 'indexed';
  readonly entries: number;
  readonly snapshot: VaultIndexSnapshot | null;
  resolve(raw: string, options?: { wikilink?: boolean }): Promise<ResolvedLink>;
}

/** One capacity read per projection, returning only a scalar and never allocating a vault-sized array. */
async function entryCount(db: Kysely<Database>, vault: Buffer): Promise<number> {
  const maximum = LIMITS.VAULT_INDEX_MAX_ENTRIES + 1;
  const notes = await sql<{
    entries: number | string;
  }>`SELECT 2*COUNT(*) AS entries FROM (
    SELECT n.id FROM nodes n
    WHERE n.vault_id=${vault} AND n.live=1 AND n.kind='note' LIMIT ${maximum}
  ) candidates`.execute(db);
  let count = Number(notes.rows[0]?.entries ?? 0);
  if (count >= maximum) return count;
  const aliases = await sql<{ entries: number | string }>`SELECT COUNT(*) AS entries FROM (
    SELECT t.note_id FROM note_projection_terms t JOIN nodes n ON n.id=t.note_id
    WHERE t.vault_id=${vault} AND t.kind='alias' AND n.live=1 AND n.kind='note' LIMIT ${maximum - count}
  ) candidates`.execute(db);
  count += Number(aliases.rows[0]?.entries ?? 0);
  if (count >= maximum) return count;
  const attachments = await sql<{ entries: number | string }>`SELECT COUNT(*) AS entries FROM (
    SELECT id FROM attachments WHERE vault_id=${vault} AND live=1 AND path_hint IS NOT NULL LIMIT ${maximum - count}
  ) candidates`.execute(db);
  return count + Number(attachments.rows[0]?.entries ?? 0);
}

/**
 * Every live note's path below the vault root, one row past the snapshot cap so the caller can tell
 * the snapshot would not fit. Shared with plan inspection so the contract observes this statement.
 */
export function vaultNotePaths(rootId: Buffer, vaultId: Buffer): RawBuilder<PathRow> {
  return sql<PathRow>`WITH RECURSIVE paths AS (
    SELECT id,parent_id,name,kind,CAST('' AS CHAR(${sql.lit(LIMITS.NODE_PATH_MAX_CHARS)})) AS path,0 AS depth
      FROM nodes WHERE id=${rootId} AND deleted_at IS NULL
    UNION ALL
    SELECT ${childLookupHint('n')} n.id,n.parent_id,n.name,n.kind,CONCAT(p.path,IF(p.path='','','/'),n.name),p.depth+1
      FROM nodes n JOIN paths p ON n.parent_id=p.id
      WHERE n.id<>n.parent_id AND n.vault_id=${vaultId} AND n.deleted_at IS NULL
        AND p.depth<${sql.lit(LIMITS.TREE_MAX_DEPTH)}
  ) SELECT id,name,path FROM paths WHERE kind='note' ORDER BY id LIMIT ${Math.floor(LIMITS.VAULT_INDEX_MAX_ENTRIES / 2) + 1}`;
}

/** Each candidate array is independently limited; concurrent changes can only select the fallback. */
export async function projectionIndex(
  db: Kysely<Database>,
  noteId: Buffer,
  logger?: Pick<ServerLogger, 'warn'>,
): Promise<ProjectionIndex | null> {
  const source = await db
    .selectFrom('nodes as n')
    .innerJoin('vaults as v', 'v.id', 'n.vault_id')
    .select(['n.vault_id', 'n.name', 'v.root_node_id', 'v.tree_version', 'v.attachment_folder'])
    .where('n.id', '=', noteId)
    .where('n.deleted_at', 'is', null)
    .executeTakeFirst();
  if (source === undefined || source.root_node_id === null) return null;
  const rootId = source.root_node_id;
  const current = (await derivePath(db, noteId)).path.replace(/^\/+/, '');
  const note: NoteContext = {
    vaultId: idFromBytes(source.vault_id),
    noteId: idFromBytes(noteId),
    path: current,
    parentPath: current.split('/').slice(0, -1).join('/'),
    name: source.name,
    attachmentFolder: source.attachment_folder,
    headingSlugs: [],
    headingTexts: [],
  };
  const indexed = (entries: number): ProjectionIndex => {
    logger?.warn(
      {
        event: 'links.index_capacity',
        vaultId: note.vaultId,
        entries,
        limit: LIMITS.VAULT_INDEX_MAX_ENTRIES,
      },
      'Vault link index exceeds capacity; resolving requested targets through indexed queries.',
    );
    const index = new IndexedVaultIndex(db, source.vault_id, rootId);
    return {
      note,
      mode: 'indexed',
      entries,
      snapshot: null,
      resolve: (raw, options) => index.resolve(raw, note, options),
    };
  };
  const count = await entryCount(db, source.vault_id);
  if (count > LIMITS.VAULT_INDEX_MAX_ENTRIES) return indexed(count);
  const paths = await vaultNotePaths(source.root_node_id, source.vault_id).execute(db);
  let entries = paths.rows.length * 2;
  if (entries > LIMITS.VAULT_INDEX_MAX_ENTRIES) return indexed(entries);
  const aliases = await sql<{ note_id: Buffer; alias: string }>`SELECT p.note_id,a.alias
    FROM note_projections p JOIN nodes n ON n.id=p.note_id
    JOIN JSON_TABLE(p.fm_aliases,'$[*]' COLUMNS(alias VARCHAR(255) PATH '$')) a
    WHERE n.vault_id=${source.vault_id} AND n.live=1 AND n.kind='note'
    ORDER BY p.note_id LIMIT ${LIMITS.VAULT_INDEX_MAX_ENTRIES - entries + 1}`.execute(db);
  entries += aliases.rows.length;
  if (entries > LIMITS.VAULT_INDEX_MAX_ENTRIES) return indexed(entries);
  const attachments = await db
    .selectFrom('attachments')
    .select(['id', 'path_hint', 'version'])
    .where('vault_id', '=', source.vault_id)
    .where('deleted_at', 'is', null)
    .where('path_hint', 'is not', null)
    .orderBy('id')
    .limit(LIMITS.VAULT_INDEX_MAX_ENTRIES - entries + 1)
    .execute();
  entries += attachments.length;
  if (entries > LIMITS.VAULT_INDEX_MAX_ENTRIES) return indexed(entries);
  const basenames = new Map<string, string[]>(),
    aliasGroups = new Map<string, string[]>();
  const live = new Set(paths.rows.map((row) => idFromBytes(row.id)));
  for (const row of paths.rows) addTarget(basenames, foldLinkPath(row.name), idFromBytes(row.id));
  for (const row of aliases.rows) {
    const id = idFromBytes(row.note_id);
    if (live.has(id)) addTarget(aliasGroups, foldLinkPath(row.alias), id);
  }
  const snapshot: VaultIndexSnapshot = {
    vaultId: note.vaultId,
    treeVersion: source.tree_version,
    attachmentsVersion: attachments.reduce((maximum, row) => Math.max(maximum, row.version), 0),
    notes: paths.rows.map((row) => [foldLinkPath(row.path), idFromBytes(row.id)]),
    basenames: [...basenames],
    aliases: [...aliasGroups],
    attachments: attachments.flatMap((row): Array<[string, string]> =>
      row.path_hint === null ? [] : [[foldLinkPath(row.path_hint), idFromBytes(row.id)]],
    ),
  };
  const index = createVaultIndex(snapshot);
  return {
    note,
    mode: 'snapshot',
    entries,
    snapshot,
    resolve: (raw, options) => Promise.resolve(resolveLink(raw, note, index, options)),
  };
}

function addTarget(groups: Map<string, string[]>, key: string, id: string): void {
  const current = groups.get(key);
  if (current === undefined) groups.set(key, [id]);
  else if (!current.includes(id)) current.push(id);
}
