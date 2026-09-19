/**
 * The committed read — `note_projections` at its `revision`, never the live document
 * (12-milestones.md §5.2, `notes` and `projection` rows; skeleton A37; `content.read-model.integration`).
 *
 * `GET /notes/:noteId/markdown` and, from M3, `get_note` answer from this row. `headSeq` rides along
 * so a caller can say whether the projection trails the log (`revision < headSeq` is the "index
 * updating" hint) without a second query. A note that was never initialised has no row and answers
 * `null`; the route turns that into `404 not_found`.
 */
import type { Kysely } from 'kysely';

import type { Database, ProjectionStatus } from '../db/schema.ts';
import { contentHashHex } from './hash.ts';

/** What the committed read answers. */
export interface CommittedMarkdown {
  readonly markdown: string;
  /** `note_projections.revision`, the seq the text reflects. */
  readonly revision: number;
  /** Lowercase hex of `content_hash`, what `markdownEtag(revision, contentHash)` takes. */
  readonly contentHash: string;
  readonly status: ProjectionStatus;
  /** `note_docs.head_seq`, so a reader can detect a trailing projection. */
  readonly headSeq: number;
}

/** Reads the committed projection of one note, or `null` when the note has none. */
export async function readCommittedMarkdown(
  db: Kysely<Database>,
  noteId: Buffer,
): Promise<CommittedMarkdown | null> {
  const row = await db
    .selectFrom('note_projections as p')
    .innerJoin('note_docs as d', 'd.note_id', 'p.note_id')
    .select(['p.markdown', 'p.revision', 'p.content_hash', 'p.status', 'd.head_seq'])
    .where('p.note_id', '=', noteId)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    markdown: row.markdown,
    revision: row.revision,
    contentHash: contentHashHex(row.content_hash),
    status: row.status,
    headSeq: row.head_seq,
  };
}
