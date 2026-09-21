/** Pure committed history queries. This module has no live-document dependencies. */
import {
  idFromBytes,
  REVISION_RETENTION,
  type ListRevisionsQuery,
  type NoteRevision,
  type RevisionContent,
  type RevisionPage,
} from '@iridium/contracts';
import { sql, type Kysely, type Selectable } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database, NoteRevisionsTable } from '../db/schema.ts';
import { cursorInvalid, type CursorCodec } from '../mcp/cursor.ts';
import { ProblemError } from '../security/problem.ts';

/** Joins only durable attribution, never a session or awareness payload. */
export interface RevisionRow extends Pick<
  Selectable<NoteRevisionsTable>,
  | 'id'
  | 'note_id'
  | 'seq'
  | 'kind'
  | 'label'
  | 'content_hash'
  | 'size_chars'
  | 'actor_type'
  | 'actor_id'
  | 'restored_from_revision_id'
  | 'created_at'
> {
  readonly has_snapshot: number;
  readonly author_name: string | null;
  readonly author_hue: number | null;
  readonly token_name: string | null;
}

/** The one DTO assembly used by reads and checkpoint mutations. */
export function revisionDto(row: RevisionRow): NoteRevision {
  return {
    id: row.id,
    noteId: idFromBytes(row.note_id),
    revision: row.seq,
    kind: row.kind,
    label: row.label,
    contentHash: row.content_hash.toString('hex'),
    sizeChars: row.size_chars,
    author:
      row.actor_type === 'user' && row.actor_id !== null
        ? {
            kind: 'user',
            user: {
              id: idFromBytes(row.actor_id),
              displayName: row.author_name ?? 'Deleted user',
              colorHue: row.author_hue ?? 0,
            },
          }
        : row.actor_type === 'token' && row.actor_id !== null
          ? {
              kind: 'token',
              tokenId: idFromBytes(row.actor_id),
              name: row.token_name ?? 'Deleted token',
            }
          : { kind: 'system' },
    restoredFromRevisionId: row.restored_from_revision_id,
    hasSnapshot: row.has_snapshot === 1,
    createdAt: row.created_at.toISOString(),
  };
}

function rows(db: Kysely<Database>) {
  return db
    .selectFrom('note_revisions as r')
    .leftJoin('users as u', (join) =>
      join.onRef('u.id', '=', 'r.actor_id').on('r.actor_type', '=', 'user'),
    )
    .leftJoin('access_tokens as t', (join) =>
      join.onRef('t.id', '=', 'r.actor_id').on('r.actor_type', '=', 'token'),
    )
    .select([
      'r.id',
      'r.note_id',
      'r.seq',
      'r.kind',
      'r.label',
      'r.content_hash',
      'r.size_chars',
      'r.actor_type',
      'r.actor_id',
      'r.restored_from_revision_id',
      'r.created_at',
    ])
    .select(sql<number>`r.snapshot IS NOT NULL`.as('has_snapshot'))
    .select(['u.display_name as author_name', 'u.color_hue as author_hue', 't.name as token_name']);
}

/** Immutable row lookup. The caller has already authorized this note. */
export async function readRevision(
  db: Kysely<Database>,
  noteId: string,
  revisionId: number,
): Promise<RevisionContent | null> {
  const row = await rows(db)
    .select('r.markdown')
    .where('r.note_id', '=', idBytes(noteId))
    .where('r.id', '=', revisionId)
    .executeTakeFirst();
  return row === undefined ? null : { ...revisionDto(row), markdown: row.markdown };
}

/** Called only after note authorization; two bounded neighbors explain a gap without substituting content. */
export async function revisionNotFound(
  db: Kysely<Database>,
  noteId: string,
  revisionId: number,
): Promise<ProblemError> {
  const scope = db
    .selectFrom('note_revisions')
    .select(['id', 'seq'])
    .where('note_id', '=', idBytes(noteId));
  const neighbors = await Promise.all([
    scope.where('id', '<', revisionId).orderBy('id', 'desc').limit(1).executeTakeFirst(),
    scope.where('id', '>', revisionId).orderBy('id', 'asc').limit(1).executeTakeFirst(),
  ]);
  const retained = neighbors.flatMap((row) =>
    row === undefined ? [] : [`${String(row.id)} (revision ${String(row.seq)})`],
  );
  const hint =
    retained.length === 0
      ? 'This note has no retained revisions.'
      : `Nearest retained revisions: ${retained.join(', ')}.`;
  return new ProblemError('not_found', {
    detail: `Revision ${String(revisionId)} is unknown or no longer retained. ${hint}`,
  });
}

/** Descending (seq,id) keyset, bound to the requesting principal and exact filters. */
export async function listRevisions(
  db: Kysely<Database>,
  codec: CursorCodec,
  scope: { readonly noteId: string; readonly principalKey: string },
  query: ListRevisionsQuery,
): Promise<RevisionPage> {
  const kinds = query.kinds === undefined ? null : [...new Set(query.kinds)].toSorted();
  const filter = { noteId: scope.noteId, kinds };
  const cursor =
    query.cursor === undefined
      ? null
      : codec.parse(query.cursor, { kind: 'revisions', filter, principalKey: scope.principalKey });
  const after = cursor?.a;
  if (
    after !== undefined &&
    (after.length !== 2 ||
      !after.every(
        (value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
      ))
  )
    throw cursorInvalid('Invalid revision keyset.');
  let statement = rows(db)
    .where('r.note_id', '=', idBytes(scope.noteId))
    .orderBy('r.seq', 'desc')
    .orderBy('r.id', 'desc')
    .limit(query.limit + 1);
  if (kinds !== null) {
    if (kinds.length === 0)
      throw new ProblemError('validation_failed', {
        detail: 'At least one revision kind is required.',
      });
    statement = statement.where('r.kind', 'in', kinds);
  }
  if (after !== undefined && typeof after[0] === 'number' && typeof after[1] === 'number') {
    const [seq, id] = after;
    statement = statement.where((eb) =>
      eb.or([eb('r.seq', '<', seq), eb.and([eb('r.seq', '=', seq), eb('r.id', '<', id)])]),
    );
  }
  const [found, head] = await Promise.all([
    statement.execute(),
    db
      .selectFrom('note_docs')
      .select('head_seq')
      .where('note_id', '=', idBytes(scope.noteId))
      .executeTakeFirst(),
  ]);
  if (head === undefined) throw new ProblemError('not_found');
  const items = found.slice(0, query.limit).map(revisionDto);
  const last = items.at(-1);
  return {
    items,
    headRevision: head.head_seq,
    retention: REVISION_RETENTION,
    ...(found.length > query.limit && last !== undefined
      ? {
          nextCursor: codec.issue({
            kind: 'revisions',
            filter,
            principalKey: scope.principalKey,
            after: [last.revision, last.id],
          }),
        }
      : {}),
  };
}
