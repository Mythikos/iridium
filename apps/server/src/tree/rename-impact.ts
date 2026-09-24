/** Target-side warnings aggregate in SQL; only bounded samples or the requested page cross the DB boundary. */
import { LIMITS, type AffectedLinks, type Link } from '@iridium/contracts';
import { sql, type RawBuilder } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import { linkDto, type IndexedLinkRow } from '../links/dto.ts';
import { childLookupHint, pathsCte, type TreeExecutor } from './queries.ts';

/** One SQL aggregate bucket; the runtime guard also refuses corrupt or unrecognized statuses. */
export interface AffectedLinkCount {
  readonly status: Link['status'];
  readonly total: number | string;
}

/** Counts describe the whole target set even when SQL supplies only its first 50 samples. */
export function summariseAffectedLinks(
  counts: readonly AffectedLinkCount[],
  samples: readonly Link[],
): AffectedLinks {
  const byStatus: Record<Link['status'], number> = {
    resolved: 0,
    ambiguous: 0,
    broken: 0,
    external: 0,
  };
  let total = 0;
  for (const group of counts) {
    if (!Object.hasOwn(byStatus, group.status))
      throw new Error(`Unknown link status: ${group.status}`);
    const count = Number(group.total);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid affected-link count.');
    byStatus[group.status] += count;
    total += count;
  }
  return {
    total,
    byStatus,
    samples: samples
      .slice(0, LIMITS.AFFECTED_LINK_SAMPLE_MAX)
      .map(({ fromNoteId, fromPath, line, rawTarget }) => ({
        fromNoteId,
        fromPath,
        line,
        rawTarget,
      })),
  };
}

function affectedNodesCte(vaultId: Buffer, nodeId: Buffer): RawBuilder<unknown> {
  return sql`affected_nodes AS (
    SELECT id, parent_id, 0 AS depth FROM nodes WHERE id = ${nodeId} AND vault_id = ${vaultId}
    UNION ALL
    SELECT ${childLookupHint('child')} child.id, child.parent_id, parent.depth + 1
    FROM nodes child JOIN affected_nodes parent ON child.parent_id = parent.id
    WHERE child.id <> child.parent_id AND child.vault_id = ${vaultId}
      AND parent.depth < ${sql.lit(LIMITS.TREE_MAX_DEPTH)}
  )`;
}

function affectedLinksFrom(vaultId: Buffer): RawBuilder<unknown> {
  return sql`FROM note_links links
    JOIN affected_nodes ON affected_nodes.id = links.resolved_node_id
    JOIN tree_paths ON tree_paths.id = links.from_note_id
    WHERE links.vault_id = ${vaultId}`;
}

/** The warning always sees every status but never materializes all inbound references in Node. */
export async function renameImpact(
  db: TreeExecutor,
  vaultId: string,
  nodeId: string,
): Promise<AffectedLinks> {
  const vault = idBytes(vaultId);
  const ctes = sql`${pathsCte(vault, true)}, ${affectedNodesCte(vault, idBytes(nodeId))}`;
  const counts = await sql<AffectedLinkCount>`WITH RECURSIVE ${ctes}
    SELECT links.status, COUNT(*) AS total ${affectedLinksFrom(vault)} GROUP BY links.status`.execute(
    db,
  );
  const samples = await sql<IndexedLinkRow>`WITH RECURSIVE ${ctes}
    SELECT links.*, tree_paths.path AS from_path ${affectedLinksFrom(vault)}
    ORDER BY CAST(tree_paths.path AS BINARY), links.id LIMIT ${sql.lit(LIMITS.AFFECTED_LINK_SAMPLE_MAX)}`.execute(
    db,
  );
  return summariseAffectedLinks(counts.rows, samples.rows.map(linkDto));
}

/** How many nodes a rename or move of `nodeId` reaches; shared with plan inspection. */
export function affectedNodeCount(
  vaultId: Buffer,
  nodeId: Buffer,
): RawBuilder<{ readonly total: number | string }> {
  return sql<{
    readonly total: number | string;
  }>`WITH RECURSIVE ${affectedNodesCte(vaultId, nodeId)}
    SELECT COUNT(*) AS total FROM affected_nodes`;
}

/** SQL owns filtering and the keyset order. The caller supplies one repeatable-read transaction. */
export async function readAffectedLinkPage(
  db: TreeExecutor,
  vaultId: string,
  nodeId: string,
  options: {
    readonly limit: number;
    readonly status?: readonly Link['status'][] | undefined;
    readonly after?: readonly [string, number] | undefined;
  },
): Promise<{ readonly rows: readonly Link[]; readonly subtreeNodeIds: number }> {
  const vault = idBytes(vaultId);
  const subtree = affectedNodesCte(vault, idBytes(nodeId));
  const count = await affectedNodeCount(vault, idBytes(nodeId)).execute(db);
  const after = options.after;
  const result = await sql<IndexedLinkRow>`WITH RECURSIVE ${pathsCte(vault, true)}, ${subtree}
    SELECT links.*, tree_paths.path AS from_path ${affectedLinksFrom(vault)}
    ${options.status === undefined ? sql`` : sql`AND links.status IN (${sql.join(options.status)})`}
    ${
      after === undefined
        ? sql``
        : sql`AND (CAST(tree_paths.path AS BINARY) > CAST(${after[0]} AS BINARY)
      OR (CAST(tree_paths.path AS BINARY) = CAST(${after[0]} AS BINARY) AND links.id > ${after[1]}))`
    }
    ORDER BY CAST(tree_paths.path AS BINARY), links.id LIMIT ${sql.lit(options.limit)}`.execute(db);
  return { rows: result.rows.map(linkDto), subtreeNodeIds: Number(count.rows[0]?.total ?? 0) };
}
