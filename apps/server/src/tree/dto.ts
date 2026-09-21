/**
 * `nodes` rows as the wire renders them (09-api-reference.md §2.0 `Node` and `NoteSummary`).
 *
 * A node carries its **derived** path, never a stored one (03-data-model.md §6.3), and a note node
 * carries the `NoteSummary` block so a tree can show the title, the staleness dot
 * (`revision < headRevision`) and the oversize and invalid badges without a second request.
 *
 * Projection fields describe the committed pipeline result. A client reads `projectionStatus`
 * rather than interpreting a missing heading or an empty tag list as a projection failure.
 */
import type { Node, NoteSummary, UserRef } from '@iridium/contracts';

import { userIdFromBytes, vaultIdFromBytes } from '../auth/ids.ts';
import type { NodeKind, ProjectionStatus } from '../db/schema.ts';
import { nodeIdFromBytes } from './ids.ts';

/** The `nodes` columns every node read selects. */
export interface NodeRow {
  readonly id: Buffer;
  readonly vault_id: Buffer;
  readonly parent_id: Buffer;
  readonly kind: NodeKind;
  readonly name: string;
  readonly deleted_at: Date | null;
  readonly version: number;
  readonly created_by: Buffer;
  readonly updated_by: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The note-side columns a `kind: 'note'` row joins in. */
export interface NoteSummaryRow {
  readonly size_chars: number;
  readonly oversize: boolean;
  readonly content_invalid: boolean;
  readonly last_edited_at: Date | null;
  readonly last_edited_by: Buffer | null;
  readonly last_edited_name: string | null;
  readonly last_edited_hue: number | null;
  readonly head_seq: number | null;
  readonly revision: number | null;
  readonly content_hash: Buffer | null;
  readonly heading_title: string | null;
  readonly projection_status: ProjectionStatus | null;
  readonly fm_tags?: readonly string[] | null;
  readonly fm_aliases?: readonly string[] | null;
}

/** An actor as `UserRef` renders one. */
export interface UserRefRow {
  readonly id: Buffer;
  readonly display_name: string;
  readonly color_hue: number;
}

/** The columns every `nodes` read selects, so two reads cannot diverge on one. */
export const NODE_COLUMNS = [
  'nodes.id',
  'nodes.vault_id',
  'nodes.parent_id',
  'nodes.kind',
  'nodes.name',
  'nodes.deleted_at',
  'nodes.version',
  'nodes.created_by',
  'nodes.updated_by',
  'nodes.created_at',
  'nodes.updated_at',
] as const;

function toUserRef(row: UserRefRow): UserRef {
  return {
    id: userIdFromBytes(row.id),
    displayName: row.display_name,
    colorHue: row.color_hue,
  };
}

/**
 * The note block of a node.
 *
 * `title` is `COALESCE(heading_title, nodes.name)` — the first H1 when the projection found one, and
 * the filename otherwise — which is the rule `note_search.title` follows too, so a rename and a
 * heading change cannot make the two disagree.
 */
export function toNoteSummary(name: string, row: NoteSummaryRow): NoteSummary {
  return {
    title: row.heading_title ?? name,
    revision: row.revision ?? 0,
    headRevision: row.head_seq ?? 0,
    contentHash: row.content_hash === null ? null : row.content_hash.toString('hex'),
    sizeChars: row.size_chars,
    oversize: row.oversize,
    contentInvalid: row.content_invalid,
    projectionStatus: row.projection_status ?? 'pending',
    fmTags: row.fm_tags ?? [],
    fmAliases: row.fm_aliases ?? [],
    lastEditedBy:
      row.last_edited_by === null
        ? null
        : toUserRef({
            id: row.last_edited_by,
            display_name: row.last_edited_name ?? 'unknown',
            color_hue: row.last_edited_hue ?? 0,
          }),
    lastEditedAt: row.last_edited_at === null ? null : row.last_edited_at.toISOString(),
  };
}

/** One `nodes` row on the wire. */
export function toNodeDto(
  row: NodeRow,
  parts: {
    readonly path: string;
    readonly createdBy: UserRefRow;
    readonly updatedBy: UserRefRow;
    readonly note?: NoteSummaryRow | undefined;
  },
): Node {
  return {
    id: nodeIdFromBytes(row.id),
    vaultId: vaultIdFromBytes(row.vault_id),
    parentId: nodeIdFromBytes(row.parent_id),
    kind: row.kind,
    name: row.name,
    path: parts.path,
    deletedAt: row.deleted_at === null ? null : row.deleted_at.toISOString(),
    version: row.version,
    createdBy: toUserRef(parts.createdBy),
    updatedBy: toUserRef(parts.updatedBy),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(parts.note === undefined ? {} : { note: toNoteSummary(row.name, parts.note) }),
  };
}
