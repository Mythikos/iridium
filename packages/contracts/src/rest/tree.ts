/** Tree, lifecycle and link-warning wire contracts (09-api-reference.md §2.7). */
import { z } from 'zod';

import { AttachmentId, NodeId, NoteId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { Timestamp } from '../time.ts';
import { Node, NodeKind, NODE_KINDS, NodeName, QueryBoolean, UserRef } from './common.ts';

/** A category or note addressed by its stable id. */
export const NodeIdParams: z.ZodType<{ readonly nodeId: string }> = z
  .strictObject({
    nodeId: NodeId,
  })
  .meta({ id: 'NodeIdParams' });

/** Closed link-resolution vocabulary, shared by lists and rename impact. */
export type LinkStatus = 'resolved' | 'ambiguous' | 'broken' | 'external';
/** Closed link-resolution schema with the same input and output values. */
export const LinkStatus: z.ZodType<LinkStatus, LinkStatus> = z.enum([
  'resolved',
  'ambiguous',
  'broken',
  'external',
]);

/** An indexed link, with a derived source path and no source content. */
export interface Link {
  readonly id: number;
  readonly fromNoteId: string;
  readonly fromPath: string;
  readonly revision: number;
  readonly ordinal: number;
  readonly kind: 'markdown' | 'image' | 'wikilink' | 'embed' | 'definition';
  readonly rawTarget: string;
  readonly resolvedNodeId: string | null;
  readonly resolvedAttachmentId: string | null;
  readonly fragment: string | null;
  readonly status: 'resolved' | 'ambiguous' | 'broken' | 'external';
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
}

/** One indexed link. */
export const Link: z.ZodType<Link> = z
  .strictObject({
    id: z.int().positive(),
    fromNoteId: NoteId,
    fromPath: z.string(),
    revision: z.int().nonnegative(),
    ordinal: z.int().nonnegative(),
    kind: z.enum(['markdown', 'image', 'wikilink', 'embed', 'definition']),
    rawTarget: z.string(),
    resolvedNodeId: NodeId.nullable(),
    resolvedAttachmentId: AttachmentId.nullable(),
    fragment: z.string().nullable(),
    status: LinkStatus,
    startOffset: z.int().nonnegative(),
    endOffset: z.int().nonnegative(),
    line: z.int().positive(),
  })
  .meta({ id: 'Link' });

/** A page of outgoing or incoming links. */
export interface LinkPage {
  readonly items: readonly Link[];
  readonly nextCursor?: string | undefined;
}
/** A page of outgoing or incoming links. */
export const LinkPage: z.ZodType<LinkPage> = z
  .strictObject({
    items: z.array(Link),
    nextCursor: z.string().optional(),
  })
  .meta({ id: 'LinkPage' });

/** Impact counts are links, not distinct notes. All statuses are always present. */
export interface AffectedLinks {
  readonly total: number;
  readonly byStatus: Readonly<Record<Link['status'], number>>;
  readonly samples: readonly Pick<Link, 'fromNoteId' | 'fromPath' | 'line' | 'rawTarget'>[];
}

/** The warning shared by dry runs, accepted changes and rename-impact reads. */
export const AffectedLinks: z.ZodType<AffectedLinks> = z
  .strictObject({
    total: z.int().nonnegative(),
    byStatus: z.strictObject({
      resolved: z.int().nonnegative(),
      ambiguous: z.int().nonnegative(),
      broken: z.int().nonnegative(),
      external: z.int().nonnegative(),
    }),
    samples: z
      .array(
        z.strictObject({
          fromNoteId: NoteId,
          fromPath: z.string(),
          line: z.int().positive(),
          rawTarget: z.string(),
        }),
      )
      .max(LIMITS.AFFECTED_LINK_SAMPLE_MAX),
  })
  .meta({ id: 'AffectedLinks' });

/** Child-page query; an absent parent selects the vault root. */
export interface ListChildrenQuery {
  readonly parent?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}
/** Child-page query. */
export const ListChildrenQuery: z.ZodType<ListChildrenQuery> = z
  .strictObject({
    parent: NodeId.optional(),
    cursor: z.string().max(LIMITS.CURSOR_MAX_CHARS).meta({ format: 'iridium-cursor' }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .meta({ id: 'ListChildrenQuery' });

/** One parent's children in display order. */
export interface TreePage {
  readonly parent: Node;
  readonly items: readonly Node[];
  readonly nextCursor?: string | undefined;
  readonly treeVersion: number;
}
/** One parent's children in display order. */
export const TreePage: z.ZodType<TreePage> = z
  .strictObject({
    parent: Node,
    items: z.array(Node),
    nextCursor: z.string().optional(),
    treeVersion: z.int().nonnegative(),
  })
  .meta({ id: 'TreePage' });

/** Flat path listing filters. */
export interface ListNodesQuery {
  readonly pathPrefix?: string | undefined;
  readonly kinds: readonly NodeKind[];
  readonly recursive: boolean;
  readonly includeTrashed: boolean;
  readonly cursor?: string | undefined;
  readonly limit: number;
}
/** Flat path listing filters. */
export const ListNodesQuery: z.ZodType<ListNodesQuery> = z
  .strictObject({
    pathPrefix: z.string().max(LIMITS.NODE_PATH_MAX_CHARS).optional(),
    kinds: z
      .codec(
        z.union([z.enum(NODE_KINDS), z.array(z.enum(NODE_KINDS))]),
        z.array(z.enum(NODE_KINDS)),
        {
          decode: (value) => (typeof value === 'string' ? [value] : value),
          encode: (value) => value,
        },
      )
      .default(['category', 'note']),
    recursive: QueryBoolean.default(true),
    includeTrashed: QueryBoolean.default(false),
    cursor: z.string().max(LIMITS.CURSOR_MAX_CHARS).meta({ format: 'iridium-cursor' }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .meta({ id: 'ListNodesQuery' });

/** Flat path listing response. */
export interface NodePage {
  readonly items: readonly Node[];
  readonly nextCursor?: string | undefined;
  readonly treeVersion: number;
  readonly stale?: boolean | undefined;
}
/** Flat path listing response. */
export const NodePage: z.ZodType<NodePage> = z
  .strictObject({
    items: z.array(Node),
    nextCursor: z.string().optional(),
    treeVersion: z.int().nonnegative(),
    stale: z.boolean().optional(),
  })
  .meta({ id: 'NodePage' });

/** One rename, move or validation-only request. */
export interface PatchNodeBody {
  readonly name?: string | undefined;
  readonly parentId?: string | undefined;
  readonly dryRun: boolean;
}
/** One rename, move or validation-only request. */
export const PatchNodeBody: z.ZodType<PatchNodeBody> = z
  .strictObject({
    name: NodeName.optional(),
    parentId: NodeId.optional(),
    dryRun: z.boolean().default(false),
  })
  .refine((body) => body.name !== undefined || body.parentId !== undefined, {
    error: 'At least one change is required.',
    params: { code: 'no_changes' },
  })
  .meta({
    id: 'PatchNodeBody',
    // `dryRun` alone is not a change, so the published rule names the two fields that are.
    anyOf: [{ required: ['name'] }, { required: ['parentId'] }],
  });

/** The accepted or previewed node plus the same pre-change impact summary. */
export interface NodePatchResult {
  readonly node: Node;
  readonly affectedLinks: AffectedLinks;
  readonly dryRun: boolean;
}
/** The accepted or previewed node plus the same pre-change impact summary. */
export const NodePatchResult: z.ZodType<NodePatchResult> = z
  .strictObject({
    node: Node,
    affectedLinks: AffectedLinks,
    dryRun: z.boolean(),
  })
  .meta({ id: 'NodePatchResult' });

/** A read-only rename preview, available to every vault reader. */
export interface RenameImpactQuery {
  readonly name?: string | undefined;
  readonly parentId?: string | undefined;
}
/** A read-only rename preview must propose at least one field. */
export const RenameImpactQuery: z.ZodType<RenameImpactQuery> = z
  .strictObject({
    name: NodeName.optional(),
    parentId: NodeId.optional(),
  })
  .refine((value) => value.name !== undefined || value.parentId !== undefined, {
    error: 'At least one change is required.',
    params: { code: 'no_changes' },
  })
  .meta({
    id: 'RenameImpactQuery',
    anyOf: [{ required: ['name'] }, { required: ['parentId'] }],
  });

/** The proposed path and collision flag accompany the same target-side link summary. */
export interface RenameImpactResult {
  readonly affectedLinks: AffectedLinks;
  readonly wouldConflict: boolean;
  readonly newPath: string;
}
/** The proposed path and collision flag. */
export const RenameImpactResult: z.ZodType<RenameImpactResult> = z
  .strictObject({
    affectedLinks: AffectedLinks,
    wouldConflict: z.boolean(),
    newPath: z.string(),
  })
  .meta({ id: 'RenameImpactResult' });

/** Explicit subtree trash policy. */
export interface TrashNodeBody {
  readonly recursive: boolean;
}
/** Explicit subtree trash policy. */
export const TrashNodeBody: z.ZodType<TrashNodeBody> = z
  .strictObject({
    recursive: z.boolean().default(false),
  })
  .meta({ id: 'TrashNodeBody' });

/** Optional restore collision resolution. */
export interface RestoreNodeBody {
  readonly newName?: string | undefined;
  readonly newParentId?: string | undefined;
  readonly dryRun: boolean;
}
/** Optional restore collision resolution. */
export const RestoreNodeBody: z.ZodType<RestoreNodeBody> = z
  .strictObject({
    newName: NodeName.optional(),
    newParentId: NodeId.optional(),
    dryRun: z.boolean().default(false),
  })
  .meta({ id: 'RestoreNodeBody' });

/** Purge must be explicit. */
export const PurgeNodeQuery: z.ZodType<{ readonly purge: 'true' }> = z
  .strictObject({
    purge: z.literal('true'),
  })
  .meta({ id: 'PurgeNodeQuery' });

/** One trash group, with the current optimistic-concurrency validator. */
export interface TrashEntry {
  readonly nodeId: string;
  readonly cascadeRootId: string;
  readonly kind: NodeKind;
  readonly name: string;
  readonly originalPath: string;
  readonly originalParentId: string;
  readonly deletedBy: UserRef;
  readonly deletedAt: string;
  readonly expiresAt: string;
  readonly descendantCount: number;
  readonly version: number;
}
/** One trash group. */
export const TrashEntry: z.ZodType<TrashEntry> = z
  .strictObject({
    nodeId: NodeId,
    cascadeRootId: NodeId,
    kind: NodeKind,
    name: z.string(),
    originalPath: z.string(),
    originalParentId: NodeId,
    deletedBy: UserRef,
    deletedAt: Timestamp,
    expiresAt: Timestamp,
    descendantCount: z.int().nonnegative(),
    version: z.int().positive(),
  })
  .meta({ id: 'TrashEntry' });

/** Every node moved to trash, cascade root first. */
export interface TrashNodeResult {
  readonly nodes: readonly Node[];
  readonly trashEntry: TrashEntry;
  readonly treeVersion: number;
}
/** Every node moved to trash, cascade root first. */
export const TrashNodeResult: z.ZodType<TrashNodeResult> = z
  .strictObject({
    nodes: z.array(Node),
    trashEntry: TrashEntry,
    treeVersion: z.int().nonnegative(),
  })
  .meta({ id: 'TrashNodeResult' });

/** Every node restored by the request. */
export interface RestoreNodeResult {
  readonly nodes: readonly Node[];
  readonly treeVersion: number;
  readonly dryRun: boolean;
}
/** Every node restored by the request. */
export const RestoreNodeResult: z.ZodType<RestoreNodeResult> = z
  .strictObject({
    nodes: z.array(Node),
    treeVersion: z.int().nonnegative(),
    dryRun: z.boolean(),
  })
  .meta({ id: 'RestoreNodeResult' });

/** Trash-page query. */
export interface ListTrashQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
}
/** Trash-page query. */
export const ListTrashQuery: z.ZodType<ListTrashQuery> = z
  .strictObject({
    cursor: z.string().max(LIMITS.CURSOR_MAX_CHARS).meta({ format: 'iridium-cursor' }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .meta({ id: 'ListTrashQuery' });

/** Cascade roots, newest first. */
export interface TrashPage {
  readonly items: readonly TrashEntry[];
  readonly nextCursor?: string | undefined;
  readonly retentionDays: number;
}
/** Cascade roots, newest first. */
export const TrashPage: z.ZodType<TrashPage> = z
  .strictObject({
    items: z.array(TrashEntry),
    nextCursor: z.string().optional(),
    retentionDays: z.int().positive(),
  })
  .meta({ id: 'TrashPage' });

/** Incoming-link filters. */
export interface ListInboundLinksQuery {
  readonly status?: readonly Link['status'][] | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}
/** Incoming-link filters. */
export const ListInboundLinksQuery: z.ZodType<ListInboundLinksQuery> = z
  .strictObject({
    status: z
      .codec(z.union([LinkStatus, z.array(LinkStatus)]), z.array(LinkStatus), {
        decode: (value) => (typeof value === 'string' ? [value] : value),
        encode: (value) => value,
      })
      .optional(),
    cursor: z.string().max(LIMITS.CURSOR_MAX_CHARS).meta({ format: 'iridium-cursor' }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .meta({ id: 'ListInboundLinksQuery' });

/** Incoming links for the selected subtree. */
export interface InboundLinksPage {
  readonly items: readonly Link[];
  readonly nextCursor?: string | undefined;
  readonly subtreeNodeIds: number;
}
/** Incoming links for the selected subtree. */
export const InboundLinksPage: z.ZodType<InboundLinksPage> = z
  .strictObject({
    items: z.array(Link),
    nextCursor: z.string().optional(),
    subtreeNodeIds: z.int().nonnegative(),
  })
  .meta({ id: 'InboundLinksPage' });
