/**
 * The committed note reads behind `GET /notes/:noteId` and `GET /notes/:noteId/markdown`
 * (09-api-reference.md §2.8; skeleton A37).
 *
 * **Every read here is of committed rows, never of the live `Y.Doc`.** `revision` is the projected
 * `note_updates.seq` and `headRevision` is `note_docs.head_seq`, so a client that sees
 * `revision < headRevision` knows the text is up to `COMPACTION_MAX_DEBOUNCE_MS` behind the editors
 * and shows the "index updating" hint rather than pretending the projection is current.
 *
 * **Why this lives beside the routes and not in `notes/`.** `apps/server/src/notes/` is the note
 * *kernel* — initialisation, lifecycle, repair and the one committed-Markdown accessor the MCP tools
 * will share. What this module owns is the REST rendering of a note: the `NoteMeta` assembly, the
 * line slice and the retained-revision read, none of which any other surface consumes. The kernel's
 * `markdownOf()` is called, never re-implemented.
 *
 * Every derived projection member is `null` or empty at M1 and `projectionStatus` is what says so:
 * the M1 compactor writes `markdown`, `content_hash`, `revision`, `status` and `pipeline_version`,
 * and the headings, frontmatter, tags, tasks and counts arrive with M2 (12-milestones.md §5.2).
 */
import type { NoteMeta, OriginalEol, ProjectionStatus } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes, userIdFromBytes, vaultIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/index.ts';
import { ProblemError } from '../security/problem.ts';
import { nodeIdFromBytes, noteIdFromBytes } from '../tree/ids.ts';
import { derivePath } from '../tree/paths.ts';

/** A retained checkpoint, as `?revision=` reads it. */
export interface RetainedRevision {
  readonly markdown: string;
  readonly revision: number;
  readonly contentHash: string;
}

/**
 * One note's full metadata, or `null` when the id names no live note.
 *
 * A trashed note is `null` here: §2.8 answers `404 not_found` for a trashed, foreign or unknown
 * note, and the three are deliberately indistinguishable — knowing an identifier grants nothing.
 */
export async function readNoteMeta(db: Kysely<Database>, noteId: string): Promise<NoteMeta | null> {
  const row = await db
    .selectFrom('nodes')
    .innerJoin('notes', 'notes.node_id', 'nodes.id')
    .leftJoin('note_docs', 'note_docs.note_id', 'nodes.id')
    .leftJoin('note_projections', 'note_projections.note_id', 'nodes.id')
    .leftJoin('users as editor', 'editor.id', 'notes.last_edited_by')
    .select((eb) => [
      eb.ref('nodes.id').as('id'),
      eb.ref('nodes.vault_id').as('vault_id'),
      eb.ref('nodes.parent_id').as('parent_id'),
      eb.ref('nodes.name').as('name'),
      eb.ref('nodes.version').as('version'),
      eb.ref('nodes.created_at').as('created_at'),
      eb.ref('nodes.updated_at').as('updated_at'),
      eb.ref('notes.original_eol').as('original_eol'),
      eb.ref('notes.had_bom').as('had_bom'),
      eb.ref('notes.size_chars').as('size_chars'),
      eb.ref('notes.oversize').as('oversize'),
      eb.ref('notes.content_invalid').as('content_invalid'),
      eb.ref('notes.last_edited_at').as('last_edited_at'),
      eb.ref('notes.last_edited_by').as('last_edited_by'),
      eb.ref('editor.display_name').as('last_edited_name'),
      eb.ref('editor.color_hue').as('last_edited_hue'),
      eb.ref('note_docs.head_seq').as('head_seq'),
      eb.ref('note_projections.revision').as('revision'),
      eb.ref('note_projections.content_hash').as('content_hash'),
      eb.ref('note_projections.heading_title').as('heading_title'),
      eb.ref('note_projections.status').as('projection_status'),
      eb.ref('note_projections.pipeline_version').as('pipeline_version'),
      eb.ref('note_projections.projected_at').as('projected_at'),
      eb.ref('note_projections.line_count').as('line_count'),
      eb.ref('note_projections.word_count').as('word_count'),
      eb.ref('note_projections.frontmatter_error').as('frontmatter_error'),
    ])
    .where('nodes.id', '=', idBytes(noteId))
    .where('nodes.kind', '=', 'note')
    .where('nodes.deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) return null;

  const path = await derivePath(db, row.id);
  const status: ProjectionStatus = row.projection_status ?? 'pending';
  const eol: OriginalEol = row.original_eol;

  return {
    id: noteIdFromBytes(row.id),
    vaultId: vaultIdFromBytes(row.vault_id),
    parentId: nodeIdFromBytes(row.parent_id),
    name: row.name,
    path: path.path,
    version: row.version,
    title: row.heading_title ?? row.name,
    revision: row.revision ?? 0,
    headRevision: row.head_seq ?? 0,
    contentHash: row.content_hash === null ? null : row.content_hash.toString('hex'),
    sizeChars: row.size_chars,
    oversize: row.oversize,
    contentInvalid: row.content_invalid,
    projectionStatus: status,
    fmTags: [],
    fmAliases: [],
    lastEditedBy:
      row.last_edited_by === null
        ? null
        : {
            id: userIdFromBytes(row.last_edited_by),
            displayName: row.last_edited_name ?? 'unknown',
            colorHue: row.last_edited_hue ?? 0,
          },
    lastEditedAt: row.last_edited_at === null ? null : row.last_edited_at.toISOString(),
    lineCount: row.line_count,
    wordCount: row.word_count,
    originalEol: eol,
    hadBom: row.had_bom,
    // The parsed frontmatter object, its tags and aliases, the headings, the tasks, the code
    // languages and the link counts are M2's projection work; `projectionStatus` is what tells a
    // client that an absent value is a milestone and not a parse failure.
    frontmatter: null,
    frontmatterError: row.frontmatter_error,
    headings: [],
    tasks: [],
    codeLangs: [],
    linksCount: 0,
    backlinksCount: 0,
    pipelineVersion: row.pipeline_version ?? 0,
    projectedAt: row.projected_at === null ? null : row.projected_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `nodes.name` for the `Content-Disposition` filename of a Markdown read. */
export async function readNoteName(db: Kysely<Database>, noteId: string): Promise<string | null> {
  const row = await db
    .selectFrom('nodes')
    .select('name')
    .where('nodes.id', '=', idBytes(noteId))
    .executeTakeFirst();
  return row?.name ?? null;
}

/**
 * One retained checkpoint of a note (`?revision=`), or `null` when the seq was thinned away.
 *
 * A thinned revision is `404 not_found` rather than an empty body: the client asked for a specific
 * state of the text, and answering with a different one silently would be worse than refusing.
 */
export async function readRetainedRevision(
  db: Kysely<Database>,
  noteId: string,
  seq: number,
): Promise<RetainedRevision | null> {
  const row = await db
    .selectFrom('note_revisions')
    .select(['markdown', 'seq', 'content_hash'])
    .where('note_id', '=', idBytes(noteId))
    .where('seq', '=', seq)
    .orderBy('id', 'desc')
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    markdown: row.markdown,
    revision: row.seq,
    contentHash: row.content_hash.toString('hex'),
  };
}

/** A 1-based inclusive line slice of the LF-normalised source, as `?lines=` names one. */
export interface LineSlice {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly lineCount: number;
}

/**
 * The slice `?lines=<start>-<end>` names.
 *
 * @throws ProblemError `422 validation_failed` when the range is inverted or starts past the end of
 * the note; a range that merely *ends* past it is clamped, because "give me from line 400 on" is an
 * ordinary request and refusing it would make paging a note require knowing its length first.
 */
export function sliceLines(markdown: string, range: string): LineSlice {
  const lines = markdown.split('\n');
  const [rawStart, rawEnd] = range.split('-');
  const start = Number(rawStart);
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new ProblemError('validation_failed', {
      detail: 'lines must be a 1-based inclusive range such as 120-260.',
      errors: [{ path: 'query.lines', message: 'lines_invalid', code: 'lines_invalid' }],
    });
  }
  if (start > lines.length) {
    throw new ProblemError('validation_failed', {
      detail: `lines starts at ${String(start)} and the note has ${String(lines.length)} line(s).`,
      errors: [{ path: 'query.lines', message: 'lines_out_of_range', code: 'lines_out_of_range' }],
    });
  }
  const last = Math.min(end, lines.length);
  return {
    text: lines.slice(start - 1, last).join('\n'),
    start,
    end: last,
    lineCount: lines.length,
  };
}
