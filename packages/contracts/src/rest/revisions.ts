/** Retained checkpoints and restore responses (09 section 2.9). */
import { z } from 'zod';

import { REVISION_KINDS, type RevisionKind } from '../collab.ts';
import { NoteId, TokenId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { Timestamp } from '../time.ts';
import { Sha256Hex, UserRef, type UserRef as UserReference } from './common.ts';

/** The durable checkpoint kinds. Only checkpoint and unload are eligible for thinning. */
/** Durable attribution never derives a user identity from document content. */
export type RevisionAuthor =
  | { readonly kind: 'user'; readonly user: UserReference }
  | { readonly kind: 'token'; readonly tokenId: string; readonly name: string }
  | { readonly kind: 'system' };
/** One immutable checkpoint. */
export interface NoteRevision {
  readonly id: number;
  readonly noteId: string;
  readonly revision: number;
  readonly kind: RevisionKind;
  readonly label: string | null;
  readonly contentHash: string;
  readonly sizeChars: number;
  readonly author: RevisionAuthor;
  readonly restoredFromRevisionId: number | null;
  readonly hasSnapshot: boolean;
  readonly createdAt: string;
}
/** One immutable checkpoint's public metadata. */
const revisionFields = {
  id: z.int().positive(),
  noteId: NoteId,
  revision: z.int().positive(),
  kind: z.enum(REVISION_KINDS),
  label: z.string().nullable(),
  contentHash: Sha256Hex,
  sizeChars: z.int().nonnegative(),
  author: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('user'), user: UserRef }),
    z.strictObject({ kind: z.literal('token'), tokenId: TokenId, name: z.string() }),
    z.strictObject({ kind: z.literal('system') }),
  ]),
  restoredFromRevisionId: z.int().positive().nullable(),
  hasSnapshot: z.boolean(),
  createdAt: Timestamp,
};
export const NoteRevision: z.ZodType<NoteRevision> = z
  .strictObject(revisionFields)
  .meta({ id: 'NoteRevision' });
/** The checkpoint with its source. */
export interface RevisionContent extends NoteRevision {
  readonly markdown: string;
}
/** The checkpoint with its source. */
export const RevisionContent: z.ZodType<RevisionContent> = z
  .strictObject({ ...revisionFields, markdown: z.string() })
  .meta({ id: 'RevisionContent' });
/** Checkpoint listing inputs. */
export interface ListRevisionsQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly kinds?: readonly RevisionKind[] | undefined;
}
/** Checkpoint listing query. */
export const ListRevisionsQuery: z.ZodType<ListRevisionsQuery> = z
  .strictObject({
    cursor: z.string().max(LIMITS.CURSOR_MAX_CHARS).meta({ format: 'iridium-cursor' }).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.REVISION_LIST_MAX)
      .default(LIMITS.REVISION_LIST_DEFAULT),
    kinds: z
      .codec(
        z.union([z.enum(REVISION_KINDS), z.array(z.enum(REVISION_KINDS))]),
        z.array(z.enum(REVISION_KINDS)),
        {
          decode: (value) => (typeof value === 'string' ? [value] : value),
          encode: (value) => value,
        },
      )
      .optional(),
  })
  .meta({ id: 'ListRevisionsQuery' });
/** The policy echoed beside gaps so callers can explain retained history. */
export interface RetentionPolicy {
  readonly thinned: true;
  readonly rule: 'all for 24h, hourly for 30d, daily thereafter';
  readonly neverThinned: readonly RevisionKind[];
}
/** The policy echoed beside gaps. */
export const RetentionPolicy: z.ZodType<RetentionPolicy> = z
  .strictObject({
    thinned: z.literal(true),
    rule: z.literal('all for 24h, hourly for 30d, daily thereafter'),
    neverThinned: z.array(z.enum(REVISION_KINDS)),
  })
  .meta({ id: 'RetentionPolicy' });
/** Default immutable policy, shared with the maintenance job. */
export const REVISION_RETENTION: RetentionPolicy = {
  thinned: true,
  rule: 'all for 24h, hourly for 30d, daily thereafter',
  neverThinned: ['create', 'import', 'named', 'pre_restore', 'restore', 'trash'],
};
/** One page, newest sequence and row id first. */
export interface RevisionPage {
  readonly items: readonly NoteRevision[];
  readonly nextCursor?: string | undefined;
  readonly headRevision: number;
  readonly retention: RetentionPolicy;
}
/** One page. */
export const RevisionPage: z.ZodType<RevisionPage> = z
  .strictObject({
    items: z.array(NoteRevision),
    nextCursor: z.string().optional(),
    headRevision: z.int().nonnegative(),
    retention: RetentionPolicy,
  })
  .meta({ id: 'RevisionPage' });
/** Identifies an immutable row, not a sequence. */
export const RevisionParams: z.ZodType<{ readonly noteId: string; readonly revisionId: number }> = z
  .strictObject({ noteId: NoteId, revisionId: z.coerce.number().int().positive() })
  .meta({ id: 'RevisionParams' });
/** Names the state captured by the writer. */
export const CreateRevisionBody: z.ZodType<{ readonly label: string }> = z
  .strictObject({ label: z.string().min(1).max(LIMITS.REVISION_LABEL_MAX) })
  .meta({ id: 'CreateRevisionBody' });
/** The explicit content-restore confirmation. */
export const RestoreRevisionBody: z.ZodType<{ readonly confirm: true }> = z
  .strictObject({ confirm: z.literal(true) })
  .meta({ id: 'RestoreRevisionBody' });
/** Both ends of the reversible restore. */
export type RestoredRevision = { readonly revision: number; readonly contentHash: string } & (
  | { readonly changed: false }
  | { readonly changed: true; readonly restored: NoteRevision; readonly preRestore: NoteRevision }
);
/** Both ends of the reversible restore. */
export const RestoredRevision: z.ZodType<RestoredRevision> = z
  .discriminatedUnion('changed', [
    z.strictObject({
      changed: z.literal(false),
      revision: z.int().positive(),
      contentHash: Sha256Hex,
    }),
    z.strictObject({
      changed: z.literal(true),
      restored: NoteRevision,
      preRestore: NoteRevision,
      revision: z.int().positive(),
      contentHash: Sha256Hex,
    }),
  ])
  .meta({ id: 'RestoredRevision' });
