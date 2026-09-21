/** The derived half of projection/write: search and references commit with their exact source. */
import { idFromBytes, LIMITS, NoteId, VaultId } from '@iridium/contracts';
import type { NoteProjection } from '@iridium/markdown';
import type { Insertable, Transaction } from 'kysely';

import type { Database, NoteLinksTable } from '../db/schema.ts';
import { linkColumns } from '../links/columns.ts';
import type { ServerLogger } from '../ops/logging.ts';
import type { SearchIndexWrites } from '../search/index.ts';
import { projectionIndex } from './index-snapshot.ts';
import { replaceProjectionTerms } from './terms.ts';

/** Writes derived data only after the caller has serialized and accepted this revision. */
export async function writeDerivedProjection(
  db: Transaction<Database>,
  input: {
    readonly noteId: Buffer;
    readonly revision: number;
    readonly now: Date;
    readonly prepared: NoteProjection;
    readonly logger?: Pick<ServerLogger, 'warn'> | undefined;
  },
  searchIndex: SearchIndexWrites,
): Promise<void> {
  const { prepared, noteId, revision, now } = input;
  const ok = prepared.status === 'ok';
  await db
    .updateTable('note_projections')
    .set({
      heading_title: ok ? prepared.headingTitle : null,
      frontmatter_raw: ok ? (prepared.frontmatter?.raw ?? null) : null,
      frontmatter:
        ok && prepared.frontmatter?.data != null ? JSON.stringify(prepared.frontmatter.data) : null,
      frontmatter_error: ok ? (prepared.frontmatter?.error ?? null) : null,
      fm_tags: ok ? JSON.stringify(prepared.fmTags) : null,
      fm_aliases: ok ? JSON.stringify(prepared.fmAliases) : null,
      headings: ok ? JSON.stringify(prepared.headings) : null,
      tasks: ok ? JSON.stringify(prepared.tasks) : null,
      code_langs: ok ? JSON.stringify(prepared.codeLangs) : null,
      obsidian_findings: ok
        ? JSON.stringify({
            counts: prepared.obsidian.counts,
            sample: prepared.obsidian.findings.slice(0, LIMITS.OBSIDIAN_SAMPLE_MAX),
          })
        : null,
      word_count: ok ? prepared.wordCount : null,
      line_count: ok ? prepared.lineCount : null,
      status: prepared.status,
    })
    .where('note_id', '=', noteId)
    .where('revision', '=', revision)
    .execute();

  const source = await db
    .selectFrom('nodes')
    .select(['vault_id', 'name'])
    .where('id', '=', noteId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (source === undefined) {
    await db.deleteFrom('note_projection_terms').where('note_id', '=', noteId).execute();
    await searchIndex.remove(NoteId.parse(idFromBytes(noteId)), db);
    await db.deleteFrom('note_links').where('from_note_id', '=', noteId).execute();
    return;
  }
  await replaceProjectionTerms(
    db,
    noteId,
    source.vault_id,
    ok ? prepared.fmTags : [],
    ok ? prepared.fmAliases : [],
  );
  const search = {
    note_id: noteId,
    vault_id: source.vault_id,
    title: prepared.headingTitle ?? source.name,
    body_text: ok ? prepared.bodyText : '',
    revision,
    updated_at: now,
  };
  await searchIndex.index(
    {
      noteId: NoteId.parse(idFromBytes(noteId)),
      vaultId: VaultId.parse(idFromBytes(source.vault_id)),
      title: search.title,
      bodyText: search.body_text,
      revision,
      updatedAt: now,
    },
    db,
  );
  await db.deleteFrom('note_links').where('from_note_id', '=', noteId).execute();
  if (!ok || prepared.links.length === 0) return;
  const context = await projectionIndex(db, noteId, input.logger);
  if (context === null) return;
  context.note.headingSlugs = prepared.headings.map((heading) => heading.slug);
  context.note.headingTexts = prepared.headings.map((heading) => heading.text);
  const rows: Insertable<NoteLinksTable>[] = [];
  for (const link of prepared.links) {
    // eslint-disable-next-line no-await-in-loop -- lazy resolution admits one bounded indexed lookup at a time
    const resolved = await context.resolve(link.rawTarget, {
      wikilink: link.kind === 'wikilink' || link.kind === 'embed',
    });
    const columns = linkColumns(resolved, noteId);
    rows.push({
      from_note_id: noteId,
      vault_id: search.vault_id,
      revision,
      ordinal: link.ordinal,
      kind: link.kind,
      raw_target: Array.from(link.rawTarget).slice(0, LIMITS.LINK_TARGET_MAX_CHARS).join(''),
      start_offset: link.startOffset,
      end_offset: link.endOffset,
      line: link.line,
      resolved_node_id: columns.resolved_node_id,
      resolved_attachment_id: columns.resolved_attachment_id,
      fragment: columns.fragment,
      status: columns.status,
    });
  }
  if (rows.length > 0) await db.insertInto('note_links').values(rows).execute();
}
