/** Cursored tree views, bound to the principal, filters and first-page tree version. */
import {
  idFromBytes,
  type InboundLinksPage,
  type ListChildrenQuery,
  type ListInboundLinksQuery,
  type ListNodesQuery,
  type ListTrashQuery,
  type Node,
  type NodePage,
  type TrashPage,
  type TreePage,
} from '@iridium/contracts';
import { sql, type Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { cursorInvalid, type CursorCodec, type CursorKeyPart } from '../mcp/cursor.ts';
import { ProblemError } from '../security/problem.ts';
import { readNodeRows } from './queries.ts';
import { readAffectedLinkPage } from './rename-impact.ts';
import { readTrashEntry } from './trash.ts';

/** A listing always binds its cursor to a canonical vault and authenticated principal. */
export interface TreeReadScope {
  readonly vaultId: string;
  readonly principalKey: string;
}

function validIdKey(value: CursorKeyPart | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function escapeLike(value: string): string {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}

const NATURAL_NAMES = new Intl.Collator('en', { numeric: true, sensitivity: 'accent' });

function compareChildren(
  left: Pick<Node, 'kind' | 'name' | 'id'>,
  right: Pick<Node, 'kind' | 'name' | 'id'>,
): number {
  const kind = (left.kind === 'category' ? 0 : 1) - (right.kind === 'category' ? 0 : 1);
  return kind || NATURAL_NAMES.compare(left.name, right.name) || left.id.localeCompare(right.id);
}

/** One display page. A single root-down query provides parent breadcrumbs and child summaries. */
export async function listChildren(
  db: Kysely<Database>,
  codec: CursorCodec,
  scope: TreeReadScope,
  query: ListChildrenQuery,
): Promise<TreePage> {
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const vault = await trx
        .selectFrom('vaults')
        .select(['root_node_id', 'tree_version'])
        .where('id', '=', idBytes(scope.vaultId))
        .executeTakeFirst();
      if (vault?.root_node_id === null || vault === undefined) throw new ProblemError('not_found');
      const parentBytes = query.parent === undefined ? vault.root_node_id : idBytes(query.parent);
      const filter = { vaultId: scope.vaultId, parent: idFromBytes(parentBytes) };
      const cursor =
        query.cursor === undefined
          ? null
          : codec.parse(query.cursor, {
              kind: 'tree',
              filter,
              principalKey: scope.principalKey,
            });
      let after: Pick<Node, 'kind' | 'name' | 'id'> | null = null;
      if (cursor !== null) {
        const [kind, name, id] = cursor.a;
        if (
          (kind !== 0 && kind !== 1) ||
          typeof name !== 'string' ||
          !validIdKey(id) ||
          cursor.a.length !== 3
        ) {
          throw cursorInvalid('The tree cursor has an invalid key.');
        }
        after = {
          kind: kind === 0 ? 'category' : 'note',
          name,
          id: idFromBytes(Buffer.from(id, 'hex')),
        };
      }
      const rows = await readNodeRows(trx, idBytes(scope.vaultId), {
        where: sql`tree_paths.id = ${parentBytes} OR (tree_paths.parent_id = ${parentBytes} AND tree_paths.id <> tree_paths.parent_id)`,
      });
      const parent = rows.find((row) => idBytes(row.id).equals(parentBytes));
      if (parent === undefined || parent.kind !== 'category' || parent.deletedAt !== null)
        throw new ProblemError('not_found');
      const children = rows.filter((row) => row.id !== parent.id).toSorted(compareChildren);
      const boundary = after;
      const remaining =
        boundary === null ? children : children.filter((row) => compareChildren(row, boundary) > 0);
      const items = remaining.slice(0, query.limit);
      const last = items.at(-1);
      return {
        parent,
        items,
        treeVersion: vault.tree_version,
        ...(remaining.length > query.limit && last !== undefined
          ? {
              nextCursor: codec.issue({
                kind: 'tree',
                filter,
                principalKey: scope.principalKey,
                treeVersion: cursor?.tv ?? vault.tree_version,
                after: [
                  last.kind === 'category' ? 0 : 1,
                  last.name,
                  idBytes(last.id).toString('hex'),
                ],
              }),
            }
          : {}),
      };
    });
}

/** One flat page; SQL filtering, ordering and the cursor all use the database's path collation. */
export async function listNodes(
  db: Kysely<Database>,
  codec: CursorCodec,
  scope: TreeReadScope,
  query: ListNodesQuery,
): Promise<NodePage> {
  const prefix = (query.pathPrefix ?? '').replace(/\/$/, '');
  const normalizedPrefix = prefix === '' || prefix.startsWith('/') ? prefix : `/${prefix}`;
  const kinds = [...new Set(query.kinds)].toSorted();
  const filter = {
    vaultId: scope.vaultId,
    pathPrefix: normalizedPrefix,
    kinds,
    recursive: query.recursive,
    includeTrashed: query.includeTrashed,
  };
  const cursor =
    query.cursor === undefined
      ? null
      : codec.parse(query.cursor, {
          kind: 'notes',
          filter,
          principalKey: scope.principalKey,
        });
  const after = cursor?.a;
  if (
    after !== undefined &&
    (after.length !== 2 || typeof after[0] !== 'string' || !validIdKey(after[1]))
  ) {
    throw cursorInvalid('The node cursor has an invalid key.');
  }
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const vault = await trx
        .selectFrom('vaults')
        .select('tree_version')
        .where('id', '=', idBytes(scope.vaultId))
        .executeTakeFirst();
      if (vault === undefined) throw new ProblemError('not_found');
      const conditions = [
        sql`tree_paths.id <> tree_paths.parent_id`,
        kinds.length === 0 ? sql`FALSE` : sql`tree_paths.kind IN (${sql.join(kinds)})`,
      ];
      if (normalizedPrefix !== '')
        conditions.push(
          sql`(tree_paths.path = ${normalizedPrefix} OR tree_paths.path LIKE ${`${escapeLike(normalizedPrefix)}/%`} ESCAPE '!')`,
        );
      if (!query.recursive)
        conditions.push(
          sql`tree_paths.depth = ${normalizedPrefix.split('/').filter(Boolean).length + 1}`,
        );
      if (after !== undefined && typeof after[0] === 'string' && validIdKey(after[1])) {
        conditions.push(
          sql`(tree_paths.path > ${after[0]} OR (tree_paths.path = ${after[0]} AND tree_paths.id > ${Buffer.from(after[1], 'hex')}))`,
        );
      }
      const rows = await readNodeRows(trx, idBytes(scope.vaultId), {
        includeTrashed: query.includeTrashed,
        where: sql.join(conditions, sql` AND `),
        limit: query.limit + 1,
      });
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items,
        treeVersion: vault.tree_version,
        ...(cursor?.tv !== undefined && cursor.tv !== vault.tree_version ? { stale: true } : {}),
        ...(rows.length > query.limit && last !== undefined
          ? {
              nextCursor: codec.issue({
                kind: 'notes',
                filter,
                principalKey: scope.principalKey,
                treeVersion: cursor?.tv ?? vault.tree_version,
                after: [last.path, idBytes(last.id).toString('hex')],
              }),
            }
          : {}),
      };
    });
}

/** Newest-first cascade roots; every entry contains the current restore/purge validator. */
export async function listTrash(
  db: Kysely<Database>,
  codec: CursorCodec,
  scope: TreeReadScope,
  query: ListTrashQuery,
): Promise<TrashPage> {
  const filter = { vaultId: scope.vaultId };
  const cursor =
    query.cursor === undefined
      ? null
      : codec.parse(query.cursor, {
          kind: 'trash',
          filter,
          principalKey: scope.principalKey,
        });
  const after = cursor?.a;
  if (
    after !== undefined &&
    (after.length !== 2 ||
      typeof after[0] !== 'string' ||
      !Number.isFinite(Date.parse(after[0])) ||
      !validIdKey(after[1]))
  ) {
    throw cursorInvalid('The trash cursor has an invalid key.');
  }
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const vault = await trx
        .selectFrom('vaults')
        .select('trash_retention_days')
        .where('id', '=', idBytes(scope.vaultId))
        .executeTakeFirst();
      if (vault === undefined) throw new ProblemError('not_found');
      let statement = trx
        .selectFrom('trash_entries')
        .select(['node_id', 'deleted_at'])
        .where('vault_id', '=', idBytes(scope.vaultId))
        .whereRef('node_id', '=', 'cascade_root_id')
        .orderBy('deleted_at', 'desc')
        .orderBy('node_id', 'asc')
        .limit(query.limit + 1);
      if (after !== undefined && typeof after[0] === 'string' && validIdKey(after[1])) {
        const deletedAt = new Date(after[0]);
        const nodeId = Buffer.from(after[1], 'hex');
        statement = statement.where((eb) =>
          eb.or([
            eb('deleted_at', '<', deletedAt),
            eb.and([eb('deleted_at', '=', deletedAt), eb('node_id', '>', nodeId)]),
          ]),
        );
      }
      const rows = await statement.execute();
      const items = (
        await Promise.all(rows.slice(0, query.limit).map((row) => readTrashEntry(trx, row.node_id)))
      ).filter((row) => row !== null);
      const last = rows.slice(0, query.limit).at(-1);
      return {
        items,
        retentionDays: vault.trash_retention_days,
        ...(rows.length > query.limit && last !== undefined
          ? {
              nextCursor: codec.issue({
                kind: 'trash',
                filter,
                principalKey: scope.principalKey,
                after: [last.deleted_at.toISOString(), last.node_id.toString('hex')],
              }),
            }
          : {}),
      };
    });
}

/** Incoming rows page the same target-side set the warning summarizes. */
export async function listInboundLinks(
  db: Kysely<Database>,
  codec: CursorCodec,
  scope: TreeReadScope,
  nodeId: string,
  query: ListInboundLinksQuery,
): Promise<InboundLinksPage> {
  const filter = {
    vaultId: scope.vaultId,
    nodeId,
    status: query.status === undefined ? null : query.status.toSorted(),
  };
  const after =
    query.cursor === undefined
      ? undefined
      : codec.parse(query.cursor, {
          kind: 'links',
          filter,
          principalKey: scope.principalKey,
        }).a;
  let afterKey: readonly [string, number] | undefined;
  if (after !== undefined) {
    const [path, id] = after;
    if (
      after.length !== 2 ||
      typeof path !== 'string' ||
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1
    ) {
      throw cursorInvalid('The links cursor has an invalid key.');
    }
    afterKey = [path, id];
  }
  const affected = await db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute((trx) =>
      readAffectedLinkPage(trx, scope.vaultId, nodeId, {
        limit: query.limit + 1,
        status: query.status,
        after: afterKey,
      }),
    );
  const rows = affected.rows;
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    subtreeNodeIds: affected.subtreeNodeIds,
    ...(rows.length > query.limit && last !== undefined
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
