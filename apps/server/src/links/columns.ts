/** Map resolver outcomes into the committed reference row without inventing target identities. */
import { idToBytes } from '@iridium/contracts';
import type { ResolvedLink } from '@iridium/markdown';
import type { Selectable } from 'kysely';

import type { NoteLinksTable } from '../db/schema.ts';

export function linkColumns(
  resolved: ResolvedLink,
  noteId: Buffer,
): Pick<
  Selectable<NoteLinksTable>,
  'resolved_node_id' | 'resolved_attachment_id' | 'fragment' | 'status'
> {
  const empty = { resolved_node_id: null, resolved_attachment_id: null, fragment: null };
  switch (resolved.kind) {
    case 'vault':
      return {
        ...empty,
        resolved_node_id: Buffer.from(idToBytes(resolved.nodeId)),
        fragment: resolved.fragment,
        status: 'resolved',
      };
    case 'attachment':
      return {
        ...empty,
        resolved_attachment_id: Buffer.from(idToBytes(resolved.attachmentId)),
        fragment: resolved.fragment,
        status: 'resolved',
      };
    case 'anchor':
      return {
        ...empty,
        resolved_node_id: resolved.valid ? noteId : null,
        fragment: resolved.fragment,
        status: resolved.valid ? 'resolved' : 'broken',
      };
    case 'external':
      return { ...empty, status: 'external' };
    case 'ambiguous':
      return { ...empty, status: 'ambiguous' };
    case 'broken':
    case 'blocked':
      return { ...empty, status: 'broken' };
    default:
      throw new Error('Unknown link result: ' + String(resolved satisfies never));
  }
}
