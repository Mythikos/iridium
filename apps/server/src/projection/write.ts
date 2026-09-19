/**
 * The M1 projection writer — the text half of `note_projections` (12-milestones.md §5.2, the
 * `projection` row; 03-data-model.md §9.2, "The monotonic write contract").
 *
 * Two statements, both guarded so an older writer can never overwrite a newer row:
 *
 *  - `upsertProjection`: `INSERT … VALUES (…) AS new ON DUPLICATE KEY UPDATE col = IF(new.revision
 *    > note_projections.revision, new.col, note_projections.col)` — the row-alias spelling, because the
 *    function form of the same name is deprecated on both supported MySQL lines and
 *    `db.dialect-floor.guard` refuses its token. `strict` (a live compaction) keeps the row when the
 *    revisions are equal; a non-strict call (an idempotent re-run, M2's `reindex`) rewrites it.
 *  - `markProjectionInvalid`: the A22 outcome — `status = 'invalid_content'` and `projected_at` on the
 *    existing row, nothing else, so readers keep the last valid `revision` and `markdown`.
 *
 * The derived columns (`headings`, `frontmatter`, `fm_tags`, `tasks`, `code_langs`, `word_count`,
 * `line_count`, `obsidian_findings`), `note_search` and `note_links` are M2's; this writer leaves them
 * `NULL` and writes `status = 'ok'`, which is what makes `GET /notes/:noteId/markdown` and the M3 tools
 * truthful about what exists. `note_docs.projected_seq` is written by the compaction transaction
 * after this statement, last, so a crash leaves it behind and never ahead.
 */
import { sql, type Kysely } from 'kysely';

import type { Database } from '../db/schema.ts';

/** One projection write. `contentHash` is `contentHash(markdown)`; the writer does not recompute it. */
export interface ProjectionWrite {
  readonly noteId: Buffer;
  readonly revision: number;
  readonly markdown: string;
  readonly contentHash: Buffer;
  readonly pipelineVersion: number;
  readonly now: Date;
  /**
   * `true` (a live compaction): the row is replaced only when `revision` is strictly newer.
   * `false` (an idempotent re-run): a row at the same revision is rewritten too.
   */
  readonly strict: boolean;
}

/** Writes or replaces the text projection, guarded by revision. */
export async function upsertProjection(
  db: Kysely<Database>,
  write: ProjectionWrite,
): Promise<void> {
  // MySQL evaluates assignments left to right. Keep revision LAST so every guarded payload
  // assignment compares with the previous revision, not the revision this statement just wrote.
  // Both supported engines exercise strict, equal-revision rebuild, and stale writes in integration.
  const newer = write.strict
    ? sql`new.revision > note_projections.revision`
    : sql`new.revision >= note_projections.revision`;
  await sql`
    INSERT INTO note_projections
      (note_id, revision, markdown, content_hash, heading_title, frontmatter_raw, frontmatter,
       frontmatter_error, fm_tags, fm_aliases, headings, tasks, code_langs, obsidian_findings,
       word_count, line_count, status, pipeline_version, projected_at)
    VALUES
      (${write.noteId}, ${write.revision}, ${write.markdown}, ${write.contentHash}, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, 'ok', ${write.pipelineVersion}, ${write.now}) AS new
    ON DUPLICATE KEY UPDATE
      markdown = IF(${newer}, new.markdown, note_projections.markdown),
      content_hash = IF(${newer}, new.content_hash, note_projections.content_hash),
      status = IF(${newer}, new.status, note_projections.status),
      pipeline_version = IF(${newer}, new.pipeline_version, note_projections.pipeline_version),
      projected_at = IF(${newer}, new.projected_at, note_projections.projected_at),
      revision = IF(${newer}, new.revision, note_projections.revision)
  `.execute(db);
}

/** The A22 outcome: flags the existing row invalid and touches nothing else (03 §9.2). */
export async function markProjectionInvalid(
  db: Kysely<Database>,
  noteId: Buffer,
  now: Date,
): Promise<void> {
  await db
    .updateTable('note_projections')
    .set({ status: 'invalid_content', projected_at: now })
    .where('note_id', '=', noteId)
    .execute();
}
