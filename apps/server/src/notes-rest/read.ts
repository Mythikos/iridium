/**
 * The committed note reads behind `GET /notes/:noteId` and `GET /notes/:noteId/markdown`
 * (09-api-reference.md §2.8; skeleton A37).
 *
 * **Every read here is of committed rows, never of the live `Y.Doc`.** `revision` is the projected
 * `note_updates.seq` and `headRevision` is `note_docs.head_seq`, so a client that sees
 * `revision < headRevision` knows the text is up to `COMPACTION_MAX_DEBOUNCE_MS` behind the editors
 * and shows the "index updating" hint rather than pretending the projection is current.
 *
 * ContentReadCore owns authorization and the shared committed Markdown/revision reads. This module
 * assembles the REST metadata DTO from the same committed projection, including headings,
 * frontmatter, tags, tasks and counts. A failed projection leaves its derived members null or empty;
 * projectionStatus identifies that state while the canonical raw source remains readable.
 */
import type { NoteMeta, OriginalEol, ProjectionStatus } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { idBytes, userIdFromBytes, vaultIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/index.ts';
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
      eb.ref('note_projections.frontmatter').as('frontmatter'),
      eb.ref('note_projections.fm_tags').as('fm_tags'),
      eb.ref('note_projections.fm_aliases').as('fm_aliases'),
      eb.ref('note_projections.headings').as('headings'),
      eb.ref('note_projections.tasks').as('tasks'),
      eb.ref('note_projections.code_langs').as('code_langs'),
      eb
        .selectFrom('note_links')
        .select((links) => links.fn.countAll<number>().as('count'))
        .whereRef('note_links.from_note_id', '=', 'nodes.id')
        .as('links_count'),
      eb
        .selectFrom('note_links as incoming')
        .innerJoin('nodes as source', 'source.id', 'incoming.from_note_id')
        .select((links) => links.fn.countAll<number>().as('count'))
        .whereRef('incoming.resolved_node_id', '=', 'nodes.id')
        .where('source.deleted_at', 'is', null)
        .as('backlinks_count'),
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
    fmTags: row.fm_tags ?? [],
    fmAliases: row.fm_aliases ?? [],
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
    // Parsed metadata belongs to the published projection; status distinguishes a refusal
    // or parse failure while the durable Markdown remains readable.
    frontmatter: isRecord(row.frontmatter) ? row.frontmatter : null,
    frontmatterError: row.frontmatter_error,
    headings: row.headings ?? [],
    tasks: row.tasks ?? [],
    codeLangs: row.code_langs ?? [],
    linksCount: row.links_count ?? 0,
    backlinksCount: row.backlinks_count ?? 0,
    pipelineVersion: row.pipeline_version ?? 0,
    projectedAt: row.projected_at === null ? null : row.projected_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
