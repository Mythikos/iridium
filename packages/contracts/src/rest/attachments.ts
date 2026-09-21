/** Attachment route DTOs and schemas (09-api-reference.md §2.11 and §2.15). */
import { z } from 'zod';

import { AttachmentId, JobId, NoteId, VaultId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { Timestamp } from '../time.ts';
import { QueryBoolean, Sha256Hex, UserRef, Version } from './common.ts';

/** One live note referencing a file. */
export interface AttachmentReference {
  readonly noteId: string;
  readonly path: string;
}
/** One live note referencing a file. */
export const AttachmentReference: z.ZodType<AttachmentReference> = z
  .strictObject({ noteId: NoteId, path: z.string() })
  .meta({ id: 'AttachmentReference' });

/** The public metadata representation; storage keys never leave the server. */
export interface Attachment {
  readonly id: string;
  readonly vaultId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly originalName: string;
  readonly pathHint: string;
  readonly inlineable: boolean;
  readonly uploadedBy: UserRef;
  readonly createdAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
  readonly referencedBy?: readonly AttachmentReference[] | undefined;
  readonly referencedByTotal?: number | undefined;
}
const ATTACHMENT_FIELDS = {
  id: AttachmentId,
  vaultId: VaultId,
  sha256: Sha256Hex,
  sizeBytes: z.int().nonnegative(),
  mime: z.string(),
  originalName: z.string(),
  pathHint: z.string().max(LIMITS.ATTACHMENT_PATH_MAX_CHARS),
  inlineable: z.boolean(),
  uploadedBy: UserRef,
  createdAt: Timestamp,
  deletedAt: Timestamp.nullable(),
  version: Version,
  referencedBy: z.array(AttachmentReference).optional(),
  referencedByTotal: z.int().nonnegative().optional(),
} as const;
/** The public metadata representation. */
export const Attachment: z.ZodType<Attachment> = z
  .strictObject(ATTACHMENT_FIELDS)
  .meta({ id: 'Attachment' });

/** Addressing an attachment always includes its owning vault. */
export const AttachmentParams: z.ZodType<{
  readonly vaultId: string;
  readonly attachmentId: string;
}> = z
  .strictObject({ vaultId: VaultId, attachmentId: AttachmentId })
  .meta({ id: 'AttachmentParams' });

/** Optional reference expansion and the opaque keyset continuation. */
export interface ListAttachmentsQuery {
  readonly noteId?: string | undefined;
  readonly includeReferences: boolean;
  readonly includeDeleted: boolean;
  readonly cursor?: string | undefined;
  readonly limit: number;
}
/** Optional reference expansion and the opaque keyset continuation. */
export const ListAttachmentsQuery: z.ZodType<ListAttachmentsQuery> = z
  .strictObject({
    noteId: NoteId.optional(),
    includeReferences: QueryBoolean.default(false),
    includeDeleted: QueryBoolean.default(false),
    cursor: z.string().optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.ATTACHMENT_LIST_MAX)
      .default(LIMITS.ATTACHMENT_LIST_DEFAULT),
  })
  .meta({ id: 'ListAttachmentsQuery' });

/** A page ordered by the path collation and then id. */
export interface AttachmentPage {
  readonly items: readonly Attachment[];
  readonly nextCursor?: string | undefined;
}
/** A page ordered by the path collation and then id. */
export const AttachmentPage: z.ZodType<AttachmentPage> = z
  .strictObject({ items: z.array(Attachment), nextCursor: z.string().optional() })
  .meta({ id: 'AttachmentPage' });

/** Non-file multipart fields; the route consumes streams before committing metadata. */
export interface AttachmentUploadFields {
  readonly pathHint?: string | undefined;
  readonly noteId?: string | undefined;
}
/** Non-file multipart fields. */
export const AttachmentUploadFields: z.ZodType<AttachmentUploadFields> = z
  .strictObject({
    pathHint: z.string().min(1).max(LIMITS.ATTACHMENT_PATH_MAX_CHARS).optional(),
    noteId: NoteId.optional(),
  })
  .meta({ id: 'AttachmentUploadFields' });

/** OpenAPI's multipart shape; runtime file validation is streaming. */
export const AttachmentUploadBody: z.ZodType = z
  .strictObject({
    file: z.string().meta({ format: 'binary' }),
    pathHint: z.string().optional(),
    noteId: NoteId.optional(),
  })
  .meta({ id: 'AttachmentUploadBody' });

/** Upload returns the path actually selected by content deduplication. */
export interface AttachmentUploaded {
  readonly attachment: Attachment;
  readonly markdownReference: string;
  readonly deduplicated: boolean;
}
/** Upload returns the path actually selected by content deduplication. */
export const AttachmentUploaded: z.ZodType<AttachmentUploaded> = z
  .strictObject({
    attachment: Attachment,
    markdownReference: z.string(),
    deduplicated: z.boolean(),
  })
  .meta({ id: 'AttachmentUploaded' });

/** Force hides a referenced attachment only after an explicit retry. */
export const DeleteAttachmentQuery: z.ZodType<{ readonly force: boolean }> = z
  .strictObject({ force: QueryBoolean.default(false) })
  .meta({ id: 'DeleteAttachmentQuery' });

/** The administrator reads the most recent durable worker result. */
export interface UnreferencedAttachmentsQuery {
  readonly vaultId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}
/** The administrator reads the most recent durable worker result. */
export const UnreferencedAttachmentsQuery: z.ZodType<UnreferencedAttachmentsQuery> = z
  .strictObject({
    vaultId: VaultId.optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .meta({ id: 'UnreferencedAttachmentsQuery' });

/** A retained revision reference always excludes a row from the candidate set. */
export interface UnreferencedAttachment extends Attachment {
  readonly lastReferencedRevision: number | null;
}
/** The administrator-facing result of the last completed report job. */
export interface UnreferencedAttachmentPage {
  readonly items: readonly UnreferencedAttachment[];
  readonly nextCursor?: string | undefined;
  readonly scannedAt: string;
  readonly jobId: string;
}
/** The administrator-facing result of the last completed report job. */
export const UnreferencedAttachmentPage: z.ZodType<UnreferencedAttachmentPage> = z
  .strictObject({
    items: z.array(
      z.strictObject({ ...ATTACHMENT_FIELDS, lastReferencedRevision: z.int().nullable() }),
    ),
    nextCursor: z.string().optional(),
    scannedAt: Timestamp,
    jobId: JobId,
  })
  .meta({ id: 'UnreferencedAttachmentPage' });
