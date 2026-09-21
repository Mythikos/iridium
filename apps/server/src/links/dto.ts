/** Public link rows retain source offsets and resolve only ids already recorded by the projection. */
import { idFromBytes, type Link } from '@iridium/contracts';
import type { Selectable } from 'kysely';

import type { NoteLinksTable } from '../db/schema.ts';

/** The stored reference with its source's current derived path. */
export type IndexedLinkRow = Selectable<NoteLinksTable> & { readonly from_path: string };

/** Renders storage ids once for outgoing and incoming reads. */
export function linkDto(row: IndexedLinkRow): Link {
  return {
    id: row.id,
    fromNoteId: idFromBytes(row.from_note_id),
    fromPath: row.from_path,
    revision: row.revision,
    ordinal: row.ordinal,
    kind: row.kind,
    rawTarget: row.raw_target,
    resolvedNodeId: row.resolved_node_id === null ? null : idFromBytes(row.resolved_node_id),
    resolvedAttachmentId:
      row.resolved_attachment_id === null ? null : idFromBytes(row.resolved_attachment_id),
    fragment: row.fragment,
    status: row.status,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    line: row.line,
  };
}
