/** Root-safe walks and joined tree reads. Paths exist only in recursive query results (A12). */
import { LIMITS, type Node } from '@iridium/contracts';
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { toNodeDto, type NodeRow, type NoteSummaryRow } from './dto.ts';

/** A tree read may share the caller's structural transaction. */
export type TreeExecutor = Kysely<Database> | Transaction<Database>;

/**
 * Lock exactly the subtree's existing primary keys in ascending order. MySQL may choose a full scan
 * for an IN list even with FORCE INDEX(PRIMARY); under REPEATABLE READ that also locks unrelated
 * rows. Unique-key point reads avoid that scan and make the lock acquisition order explicit.
 */
export async function lockSubtreeRows(
  trx: Transaction<Database>,
  table: 'nodes' | 'notes' | 'note_docs',
  ids: readonly Buffer[],
): Promise<void> {
  const column = table === 'nodes' ? 'id' : table === 'notes' ? 'node_id' : 'note_id';
  for (const id of ids.toSorted((left, right) => Buffer.compare(left, right))) {
    // eslint-disable-next-line no-await-in-loop -- acquire only the chosen primary keys in the declared order
    await sql`SELECT ${sql.ref(column)} FROM ${sql.table(table)}
      WHERE ${sql.ref(column)} = ${id} FOR UPDATE`.execute(trx);
  }
}

/** The immutable structure seen by one recursive traversal. */
export interface PathRow extends NodeRow {
  readonly path: string;
  readonly depth: number;
}

/**
 * The access path of every descendant walk: a node's children are read through
 * `ix_nodes_vault_parent` (03-data-model.md section 6.3), named in the recursive member's own query
 * block. The optimizer costs that member against a one-row estimate of the CTE, and in a flat vault
 * the parent index's rows-per-key is the whole vault, so from a few thousand notes it chose
 * `ix_nodes_vault_deleted` or `ix_nodes_vault_name` and re-read every live node of the vault once
 * per node already reached. At 4,880 notes that was 15 s on both MySQL lines, past the query
 * deadline, inside the structural transaction that projects a note with a link; pinned, 10 ms.
 *
 * @param alias The recursive member's alias for `nodes`.
 */
export function childLookupHint(alias: 'n' | 'child'): RawBuilder<unknown> {
  return sql.raw(`/*+ JOIN_INDEX(${alias} ix_nodes_vault_parent) */`);
}

/** A CTE from the root; a root's self-reference is never followed. */
export function pathsCte(vaultId: Buffer, includeTrashed: boolean = false): RawBuilder<unknown> {
  return sql`tree_paths AS (
    SELECT n.*, CAST('' AS CHAR(${sql.lit(LIMITS.TREE_MAX_DEPTH * (LIMITS.NODE_NAME_MAX_BYTES + 1))})) AS path, 0 AS depth
    FROM nodes n JOIN vaults v ON v.root_node_id = n.id
    WHERE v.id = ${vaultId}
    UNION ALL
    SELECT ${childLookupHint('n')} n.*, ${includeTrashed ? sql`COALESCE(trash.original_path, CONCAT(parent.path, '/', n.name))` : sql`CONCAT(parent.path, '/', n.name)`}, parent.depth + 1
    FROM nodes n JOIN tree_paths parent ON n.parent_id = parent.id
    ${includeTrashed ? sql`LEFT JOIN trash_entries trash ON trash.node_id = n.id` : sql``}
    WHERE n.id <> n.parent_id AND n.vault_id = ${vaultId}
      ${includeTrashed ? sql`` : sql`AND n.deleted_at IS NULL`}
      AND parent.depth < ${sql.lit(LIMITS.TREE_MAX_DEPTH)}
  )`;
}

/** One root-down path resolution, with no process-local path cache. */
export async function derivePaths(
  db: TreeExecutor,
  vaultId: Buffer,
  includeTrashed: boolean = false,
): Promise<readonly PathRow[]> {
  return (await derivedPathsStatement(vaultId, includeTrashed).execute(db)).rows;
}

/** The statement {@link derivePaths} runs; shared with plan inspection. */
export function derivedPathsStatement(
  vaultId: Buffer,
  includeTrashed: boolean,
): RawBuilder<PathRow> {
  return sql<PathRow>`WITH RECURSIVE ${pathsCte(vaultId, includeTrashed)}
    SELECT * FROM tree_paths WHERE id <> parent_id ORDER BY path, id`;
}

/** A node with its depth below the subtree's top. */
export type SubtreeRow = NodeRow & { readonly depth: number };

/** Descendant traversal includes the target and never follows the root self-reference. */
export async function subtreeRows(
  db: TreeExecutor,
  nodeId: Buffer,
  includeTrashed: boolean = false,
): Promise<readonly SubtreeRow[]> {
  return (await subtreeStatement(nodeId, includeTrashed).execute(db)).rows;
}

/** The statement {@link subtreeRows} runs; shared with plan inspection. */
export function subtreeStatement(nodeId: Buffer, includeTrashed: boolean): RawBuilder<SubtreeRow> {
  return sql<SubtreeRow>`WITH RECURSIVE subtree AS (
    SELECT n.*, 0 AS depth FROM nodes n WHERE n.id = ${nodeId}
    UNION ALL
    SELECT ${childLookupHint('n')} n.*, parent.depth + 1 FROM nodes n JOIN subtree parent ON n.parent_id = parent.id
    WHERE n.id <> n.parent_id AND n.vault_id = parent.vault_id
      ${includeTrashed ? sql`` : sql`AND n.deleted_at IS NULL`}
      AND parent.depth < ${sql.lit(LIMITS.TREE_MAX_DEPTH)}
  ) SELECT * FROM subtree ORDER BY depth, id`;
}

/** Cycle checks use the new parent's ancestor chain inside the vault lock. */
export async function ancestorsContain(
  db: TreeExecutor,
  parentId: Buffer,
  movingId: Buffer,
): Promise<boolean> {
  return (await ancestorsStatement(parentId, movingId).execute(db)).rows.length !== 0;
}

/**
 * The statement {@link ancestorsContain} runs; shared with plan inspection. It climbs by primary
 * key, the one recursive walk over `nodes` that is not a descendant walk.
 */
export function ancestorsStatement(
  parentId: Buffer,
  movingId: Buffer,
): RawBuilder<{ found: number }> {
  return sql<{ found: number }>`WITH RECURSIVE ancestors AS (
    SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = ${parentId}
    UNION ALL
    SELECT n.id, n.parent_id, parent.depth + 1
    FROM nodes n JOIN ancestors parent ON n.id = parent.parent_id
    WHERE parent.id <> parent.parent_id AND parent.depth < ${sql.lit(LIMITS.TREE_MAX_DEPTH)}
  ) SELECT 1 AS found FROM ancestors WHERE id = ${movingId} LIMIT 1`;
}

/** All per-note fields and attribution are joined once for the entire page. */
interface JoinedNodeRow extends PathRow, NoteSummaryRow {
  readonly created_name: string | null;
  readonly created_hue: number | null;
  readonly updated_name: string | null;
  readonly updated_hue: number | null;
  readonly category_count: number | string;
  readonly note_count: number | string;
}

/** One joined page over a caller-controlled SQL predicate and total order. */
export async function readNodeRows(
  db: TreeExecutor,
  vaultId: Buffer,
  options: {
    readonly includeTrashed?: boolean;
    readonly where?: RawBuilder<unknown>;
    readonly order?: RawBuilder<unknown>;
    readonly limit?: number;
  } = {},
): Promise<readonly Node[]> {
  const rows = (
    await sql<JoinedNodeRow>`WITH RECURSIVE ${pathsCte(vaultId, options.includeTrashed)}
    SELECT tree_paths.*, creator.display_name AS created_name, creator.color_hue AS created_hue,
      updater.display_name AS updated_name, updater.color_hue AS updated_hue,
      notes.size_chars, notes.oversize, notes.content_invalid,
      notes.last_edited_at, notes.last_edited_by, editor.display_name AS last_edited_name,
      editor.color_hue AS last_edited_hue, note_docs.head_seq,
      projection.revision, projection.content_hash, projection.heading_title,
      projection.status AS projection_status, projection.fm_tags, projection.fm_aliases,
      (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = tree_paths.id
        AND child.id <> child.parent_id AND child.deleted_at IS NULL AND child.kind = 'category') AS category_count,
      (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = tree_paths.id
        AND child.id <> child.parent_id AND child.deleted_at IS NULL AND child.kind = 'note') AS note_count
    FROM tree_paths
    LEFT JOIN users creator ON creator.id = tree_paths.created_by
    LEFT JOIN users updater ON updater.id = tree_paths.updated_by
    LEFT JOIN notes ON notes.node_id = tree_paths.id
    LEFT JOIN note_docs ON note_docs.note_id = tree_paths.id
    LEFT JOIN note_projections projection ON projection.note_id = tree_paths.id
    LEFT JOIN users editor ON editor.id = notes.last_edited_by
    WHERE ${options.where ?? sql`tree_paths.id <> tree_paths.parent_id`}
    ORDER BY ${options.order ?? sql`tree_paths.path, tree_paths.id`}
    ${options.limit === undefined ? sql`` : sql`LIMIT ${options.limit}`}
  `.execute(db)
  ).rows;
  return rows.map((row) =>
    Object.assign(
      toNodeDto(row, {
        path: row.path,
        createdBy: {
          id: row.created_by,
          display_name: row.created_name ?? 'unknown',
          color_hue: row.created_hue ?? 0,
        },
        updatedBy: {
          id: row.updated_by,
          display_name: row.updated_name ?? 'unknown',
          color_hue: row.updated_hue ?? 0,
        },
        ...(row.kind === 'note' ? { note: row } : {}),
      }),
      row.kind === 'category'
        ? {
            childCounts: {
              categories: Number(row.category_count),
              notes: Number(row.note_count),
            },
          }
        : {},
    ),
  );
}

/** A batch representation preserves the caller's order and uses one joined query. */
export async function readNodesByIds(
  db: TreeExecutor,
  vaultId: Buffer,
  ids: readonly Buffer[],
): Promise<readonly Node[]> {
  if (ids.length === 0) return [];
  const rows = await readNodeRows(db, vaultId, {
    includeTrashed: true,
    where: sql`tree_paths.id IN (${sql.join(ids)})`,
  });
  const byId = new Map(rows.map((row) => [idBytes(row.id).toString('hex'), row]));
  return ids.flatMap((id) => {
    const row = byId.get(id.toString('hex'));
    return row === undefined ? [] : [row];
  });
}
