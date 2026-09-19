/**
 * Branded node ids at the database boundary (02-system-architecture.md, "Identifiers"; ARCH-13).
 *
 * The same rule `auth/ids.ts` states for users, sessions, tokens and vaults, for the two ids this
 * area addresses: the brand is applied by the id schema's `parse`, which is one regex and also the
 * assertion that the 16 bytes rendered canonically. A cast would claim the same thing with nothing
 * checking it.
 *
 * `NoteId` is the `NodeId` of a node whose `kind` is `'note'` — one row, two brands — so the two
 * converters read the same bytes and differ only in what they promise the caller.
 */
import { idFromBytes, NodeId, NoteId } from '@iridium/contracts';

/** A `nodes.id` buffer as a branded node id. */
export function nodeIdFromBytes(bytes: Uint8Array): NodeId {
  return NodeId.parse(idFromBytes(bytes));
}

/** A `nodes.id` buffer whose row is a note, as a branded note id. */
export function noteIdFromBytes(bytes: Uint8Array): NoteId {
  return NoteId.parse(idFromBytes(bytes));
}
