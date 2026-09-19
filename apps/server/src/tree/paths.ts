/**
 * Derived paths (03-data-model.md §6.3; skeleton A12).
 *
 * **A path is never stored.** `nodes` carries a name and a parent, and every read that needs a path
 * derives one, so a rename or a move is one row's `UPDATE` and not a subtree rewrite. §6.3 gives the
 * descendant CTE a listing uses; this module holds the other direction — the **ancestor walk** a
 * single-row read needs (`POST /vaults/:vaultId/nodes`' `201`, `GET /notes/:noteId`), which touches
 * one row per level instead of the whole tree.
 *
 * The form is §6.3's: `'/'`-joined names excluding the root, so a top-level note is `/Onboarding` and
 * the root row itself is `''`. The walk terminates on the root's self-reference (`id = parent_id`)
 * and is bounded by `TREE_MAX_DEPTH` so a cycle introduced by a restore or a bad migration cannot
 * spin the recursion.
 *
 * `depth` is the number of levels below the root: `0` for the root row, `1` for a top-level child.
 * That is the number the depth ceiling of §6.4 step 3 is checked against, so the two readings cannot
 * drift apart.
 */
import { LIMITS } from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../db/index.ts';

/** Either executor: a path is derived inside the creating transaction and outside it alike. */
type Executor = Kysely<Database> | Transaction<Database>;

/** One ancestor row of the walk, the target itself included. */
interface AncestorRow {
  readonly name: string;
  readonly depth: number;
}

/** A node's derived path and its depth below the root. */
export interface DerivedPath {
  /** `'/'`-joined names excluding the root; `''` for the root row itself. */
  readonly path: string;
  /** Levels below the root: `0` for the root row. */
  readonly depth: number;
}

/**
 * The path and depth of one node.
 *
 * The anchor row is the node; each recursive step climbs to the parent and stops at the root, whose
 * `parent_id` equals its own `id`. The outer query drops the root (its name is the empty string and
 * §6.2 keeps it out of every path) and orders from the shallowest ancestor down, which is the order
 * the segments are joined in.
 */
export async function derivePath(db: Executor, nodeId: Buffer): Promise<DerivedPath> {
  const walked = await sql<AncestorRow>`
    WITH RECURSIVE anc AS (
      SELECT n.id, n.parent_id, n.name, 0 AS depth
      FROM nodes n
      WHERE n.id = ${nodeId}
      UNION ALL
      SELECT n.id, n.parent_id, n.name, a.depth + 1
      FROM nodes n JOIN anc a ON n.id = a.parent_id
      WHERE a.id <> a.parent_id AND a.depth < ${sql.lit(LIMITS.TREE_MAX_DEPTH)}
    )
    SELECT name, depth FROM anc WHERE id <> parent_id ORDER BY depth DESC
  `.execute(db);

  const segments = walked.rows.map((row) => row.name);
  return {
    path: segments.map((name) => `/${name}`).join(''),
    depth: segments.length,
  };
}

/**
 * The depth of the node a new child would hang from — the same walk, without building a path.
 *
 * It is a separate function rather than `derivePath(...).depth` at the call site so that the
 * creation path reads as what it checks (`assertChildDepth(await parentDepth(trx, parentId))`), and
 * so the two never disagree about whether the root counts.
 */
export async function parentDepth(db: Executor, parentId: Buffer): Promise<number> {
  const derived = await derivePath(db, parentId);
  return derived.depth;
}
