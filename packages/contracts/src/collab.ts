/**
 * The `/collab` wire contract (09-api-reference.md sections 3.2 to 3.7;
 * 05-collaboration-and-durability.md, "Stateless messages").
 *
 * Iridium adds no message type to the Hocuspocus protocol: every Iridium-specific datum is a JSON
 * string on the stateless channel, carrying `v: 1` and a `t` discriminator. There is no combined
 * `CollabMessage` union — each direction is validated against the direction that may send it, so
 * a client cannot be parsed as a server and a new server message cannot break an older client.
 *
 * An unparseable or unknown payload from a client closes that document connection with
 * `protocol-error`; an unknown message from a server is logged and ignored by the client.
 */

import { z } from 'zod';

import { Role } from './authz.ts';
import { NodeId, NoteId, UserId } from './ids.ts';
import type { EnumOf } from './schema.ts';

// ---------------------------------------------------------------------------------------------
// Shared field types
// ---------------------------------------------------------------------------------------------

/** The envelope version every stateless message carries. A new value is a breaking change. */
export const V: z.ZodLiteral<1> = z.literal(1);

/** `note_updates.seq` as a JS number — safe, because the column stays below 2^53. */
export const Seq: z.ZodNumber = z.number().int().nonnegative();

/**
 * A base64 V1 state vector. The wire always carries the **full in-memory** vector, even when the
 * writer had to store a zero-length `sv_after` because the vector was wider than the column
 * (D03-01), so the bound is the wire size — 87 400 characters, about 64 KiB of vector — and never
 * the column width. `min(4)` because an encoded vector is never shorter than one varuint, so a
 * degraded "not recorded" value can never be mistaken for a wire value (D05-19).
 */
export const Base64Sv: z.ZodString = z
  .string()
  .min(4)
  .max(87_400)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** The presence modes a participant can be in. */
export const PRESENCE_MODES = ['source', 'reading', 'split'] as const;

/** A presence mode. */
export type PresenceMode = (typeof PRESENCE_MODES)[number];

/** A presence mode. */
export const PresenceMode: EnumOf<typeof PRESENCE_MODES> = z.enum(PRESENCE_MODES);

// ---------------------------------------------------------------------------------------------
// Document names
// ---------------------------------------------------------------------------------------------

/** The two channel kinds a Hocuspocus document name can address. */
export type CollabChannel = 'note' | 'vault';

/** What a document name resolves to. */
export interface ParsedDocName {
  readonly channel: CollabChannel;
  /** The canonical lowercase UUIDv7 the name addresses. */
  readonly id: string;
}

const DOC_NAME_PATTERN =
  /^(note|vault):([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * Parses `note:<uuid>` or `vault:<uuid>`, and rejects everything else before any database access.
 * Only the canonical lowercase form is accepted: a document name is produced by Iridium's own
 * client, never pasted by a human.
 */
export function parseDocName(name: string): ParsedDocName | null {
  const match = DOC_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const [, channel, id] = match;
  if (channel === undefined || id === undefined) return null;
  // The alternation has two members, so the comparison is the narrowing: no cast is needed to
  // know which channel the name addressed.
  return { channel: channel === 'note' ? 'note' : 'vault', id };
}

/** The document name for a note channel. */
export function noteDocName(noteId: string): string {
  return `note:${noteId}`;
}

/** The document name for a vault channel. */
export function vaultDocName(vaultId: string): string {
  return `vault:${vaultId}`;
}

// ---------------------------------------------------------------------------------------------
// Server to client, document `note:<uuid>`
// ---------------------------------------------------------------------------------------------

/**
 * The one and only "Saved" signal (skeleton A19/F2): broadcast after every persistence COMMIT,
 * and sent to a single connection as the reply to `baseline`.
 */
export const PersistedMsg: z.ZodObject<
  { v: typeof V; t: z.ZodLiteral<'persisted'>; seq: typeof Seq; sv: typeof Base64Sv },
  z.core.$strict
> = z.strictObject({ v: V, t: z.literal('persisted'), seq: Seq, sv: Base64Sv });

/** Why a writer transaction did not commit. */
export const PERSIST_FAILED_REASONS = [
  'db_unavailable',
  'db_error',
  'note_trashed',
  'too_large',
  'backpressure',
  'content_invalid',
] as const;

/** Why a writer transaction did not commit. */
export type PersistFailedReason = (typeof PERSIST_FAILED_REASONS)[number];

/** Why a writer transaction did not commit. */
export const PersistFailedReason: EnumOf<typeof PERSIST_FAILED_REASONS> =
  z.enum(PERSIST_FAILED_REASONS);

/**
 * Only the `NoteWriter` emits this. No rate limiter, admission check or validation path does,
 * because a `persist-failed` newer than the last `persisted` turns the status pill red, and
 * reporting data loss that did not happen is worse than reporting nothing.
 */
export const PersistFailedMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'persist-failed'>;
    seq: z.ZodOptional<typeof Seq>;
    reason: typeof PersistFailedReason;
    retryInMs: z.ZodNumber;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('persist-failed'),
  /** The head the writer was attempting to extend, when known. */
  seq: Seq.optional(),
  reason: PersistFailedReason,
  /** When the writer will retry; `0` means it will not. */
  retryInMs: z.number().int().nonnegative(),
});

/** The committed Markdown projection now reflects this seq. Drives the "current for agents" pill. */
export const ProjectedMsg: z.ZodObject<
  { v: typeof V; t: z.ZodLiteral<'projected'>; seq: typeof Seq },
  z.core.$strict
> = z.strictObject({ v: V, t: z.literal('projected'), seq: Seq });

/** The caller's new effective role on this document, after a membership change while connected. */
export const RoleMsg: z.ZodObject<
  { v: typeof V; t: z.ZodLiteral<'role'>; role: typeof Role },
  z.core.$strict
> = z.strictObject({ v: V, t: z.literal('role'), role: Role });

/**
 * The complete, server-authoritative participant list. Names and colours come only from here;
 * awareness never carries them (skeleton A25/F6).
 */
export const ParticipantsMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'participants'>;
    users: z.ZodArray<
      z.ZodObject<
        {
          id: typeof UserId;
          name: z.ZodString;
          colorHue: z.ZodInt;
          role: typeof Role;
          mode: z.ZodOptional<typeof PresenceMode>;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('participants'),
  users: z
    .array(
      z.strictObject({
        id: UserId,
        name: z.string().min(1).max(160),
        colorHue: z.int().min(0).max(359),
        role: Role,
        mode: PresenceMode.optional(),
      }),
    )
    .max(64),
});

/** Why the server is about to close, sent before a server-initiated close. */
export const CLOSING_REASONS = ['note-trashed', 'vault-archived', 'shutdown'] as const;

/** Why the server is about to close. */
export type ClosingReason = (typeof CLOSING_REASONS)[number];

/** Why the server is about to close. */
export const ClosingReason: EnumOf<typeof CLOSING_REASONS> = z.enum(CLOSING_REASONS);

/**
 * Sent immediately before a server-initiated close, so the UI can explain what happened and the
 * user can copy unsent text out within `graceMs` (2 000 ms on shutdown, D05-12).
 */
export const ClosingMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'closing'>;
    reason: typeof ClosingReason;
    graceMs: z.ZodInt;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('closing'),
  reason: ClosingReason,
  graceMs: z.int().min(0).max(60_000),
});

/** The kinds of `note_revisions` row a checkpoint can announce. */
export const REVISION_KINDS = [
  'create',
  'import',
  'checkpoint',
  'unload',
  'named',
  'pre_restore',
  'restore',
  'trash',
] as const;

/** A `note_revisions.kind`. */
export type RevisionKind = (typeof REVISION_KINDS)[number];

/** A `note_revisions.kind`. */
export const RevisionKind: EnumOf<typeof REVISION_KINDS> = z.enum(REVISION_KINDS);

/** A revision row was created, so an open History panel updates live. */
export const CheckpointMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'checkpoint'>;
    seq: typeof Seq;
    revisionId: z.ZodInt;
    kind: typeof RevisionKind;
    label: z.ZodOptional<z.ZodString>;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('checkpoint'),
  seq: Seq,
  /** `note_revisions.id`. */
  revisionId: z.int().positive(),
  kind: RevisionKind,
  /** The revision label, present for `kind: 'named'` (D05-12). */
  label: z.string().max(200).optional(),
});

/** What the compaction scan found in the `Y.Text` (skeleton A22). */
export const CONTENT_INVALID_REASONS = ['cr', 'attributes'] as const;

/** What the compaction scan found. */
export type ContentInvalidReason = (typeof CONTENT_INVALID_REASONS)[number];

/** What the compaction scan found. */
export const ContentInvalidReason: EnumOf<typeof CONTENT_INVALID_REASONS> =
  z.enum(CONTENT_INVALID_REASONS);

/** The note is read-only until `iridium doctor --repair-content` runs. */
export const ContentInvalidMsg: z.ZodObject<
  { v: typeof V; t: z.ZodLiteral<'content-invalid'>; reason: typeof ContentInvalidReason },
  z.core.$strict
> = z.strictObject({ v: V, t: z.literal('content-invalid'), reason: ContentInvalidReason });

/** The note crossed the soft cap at compaction and is read-only until it is reduced. */
export const SizeExceededMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'size-exceeded'>;
    size: z.ZodInt;
    max: z.ZodInt;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('size-exceeded'),
  /** Measured UTF-16 units at compaction. */
  size: z.int().nonnegative(),
  /** `LIMITS.NOTE_SOFT_MAX_UTF16`. */
  max: z.int().positive(),
});

/** Every stateless message the server sends on `note:<uuid>`. */
export const ServerNoteMessage: z.ZodDiscriminatedUnion<
  [
    typeof PersistedMsg,
    typeof PersistFailedMsg,
    typeof ProjectedMsg,
    typeof RoleMsg,
    typeof ParticipantsMsg,
    typeof ClosingMsg,
    typeof CheckpointMsg,
    typeof ContentInvalidMsg,
    typeof SizeExceededMsg,
  ],
  't'
> = z.discriminatedUnion('t', [
  PersistedMsg,
  PersistFailedMsg,
  ProjectedMsg,
  RoleMsg,
  ParticipantsMsg,
  ClosingMsg,
  CheckpointMsg,
  ContentInvalidMsg,
  SizeExceededMsg,
]);

/** Every stateless message the server sends on `note:<uuid>`. */
export type ServerNoteMessage = z.infer<typeof ServerNoteMessage>;

// ---------------------------------------------------------------------------------------------
// Server to client, document `vault:<uuid>`
// ---------------------------------------------------------------------------------------------

/** What a structural transaction did to a node. */
export const TREE_CHANGE_OPS = [
  'created',
  'renamed',
  'moved',
  'trashed',
  'restored',
  'purged',
] as const;

/** What a structural transaction did to a node. */
export type TreeChangeOp = (typeof TREE_CHANGE_OPS)[number];

/** What a structural transaction did to a node. */
export const TreeChangeOp: EnumOf<typeof TREE_CHANGE_OPS> = z.enum(TREE_CHANGE_OPS);

/**
 * Sent after every structural transaction COMMIT. `treeVersion` lets a client choose between
 * applying the delta and refetching; more than 500 changes (an import commit) sends an empty
 * `changes` array with the new `treeVersion`, which means "refetch".
 */
export const TreeChangedMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'tree-changed'>;
    treeVersion: z.ZodInt;
    changes: z.ZodArray<
      z.ZodObject<
        {
          nodeId: typeof NodeId;
          parentId: typeof NodeId;
          kind: EnumOf<readonly ['category', 'note']>;
          name: z.ZodString;
          path: z.ZodString;
          op: typeof TreeChangeOp;
          version: z.ZodInt;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('tree-changed'),
  treeVersion: z.int().nonnegative(),
  changes: z
    .array(
      z.strictObject({
        nodeId: NodeId,
        parentId: NodeId,
        kind: z.enum(['category', 'note'] as const),
        name: z.string().min(1).max(200),
        path: z.string().max(4096),
        op: TreeChangeOp,
        version: z.int().positive(),
      }),
    )
    .max(500),
});

/** A membership was added, changed or removed (`role: null`). */
export const MemberChangedMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'member-changed'>;
    userId: typeof UserId;
    role: z.ZodNullable<typeof Role>;
    displayName: z.ZodString;
    colorHue: z.ZodInt;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('member-changed'),
  userId: UserId,
  /** `null` means removed from the vault. */
  role: Role.nullable(),
  displayName: z.string().min(1).max(160),
  colorHue: z.int().min(0).max(359),
});

/** Vault settings changed, the archive state changed, or a job affecting the vault finished. */
export const VaultUpdatedMsg: z.ZodObject<
  {
    v: typeof V;
    t: z.ZodLiteral<'vault-updated'>;
    version: z.ZodInt;
    changed: z.ZodOptional<z.ZodArray<z.ZodString>>;
  },
  z.core.$strict
> = z.strictObject({
  v: V,
  t: z.literal('vault-updated'),
  version: z.int().positive(),
  /** The setting keys that moved, so a client invalidates only those. */
  changed: z.array(z.string()).optional(),
});

/** Every stateless message the server sends on `vault:<uuid>`. */
export const ServerVaultMessage: z.ZodDiscriminatedUnion<
  [typeof TreeChangedMsg, typeof MemberChangedMsg, typeof VaultUpdatedMsg],
  't'
> = z.discriminatedUnion('t', [TreeChangedMsg, MemberChangedMsg, VaultUpdatedMsg]);

/** Every stateless message the server sends on `vault:<uuid>`. */
export type ServerVaultMessage = z.infer<typeof ServerVaultMessage>;

// ---------------------------------------------------------------------------------------------
// Client to server, document `note:<uuid>`
// ---------------------------------------------------------------------------------------------

/**
 * Sent after every provider `synced` event, on first connect and on every reconnect. The server
 * replies on that connection with `persisted` built from the writer's `lastPersisted`, which is
 * what closes the "opened without editing" and "crashed after COMMIT" gaps (skeleton A19).
 */
export const BaselineMsg: z.ZodObject<
  { v: typeof V; t: z.ZodLiteral<'baseline'> },
  z.core.$strict
> = z.strictObject({ v: V, t: z.literal('baseline') });

/**
 * Forces compaction and projection now (Ctrl/Cmd+S). Beyond `LIMITS.FLUSH_PER_MINUTE` the server
 * answers with the current `projected {seq}` without doing work — never `persist-failed`, and
 * never a close — so the client's indicator still settles.
 */
export const FlushMsg: z.ZodObject<{ v: typeof V; t: z.ZodLiteral<'flush'> }, z.core.$strict> =
  z.strictObject({ v: V, t: z.literal('flush') });

/** Every stateless message a client may send. Clients send nothing on `vault:<uuid>`. */
export const ClientNoteMessage: z.ZodDiscriminatedUnion<
  [typeof BaselineMsg, typeof FlushMsg],
  't'
> = z.discriminatedUnion('t', [BaselineMsg, FlushMsg]);

/** Every stateless message a client may send. */
export type ClientNoteMessage = z.infer<typeof ClientNoteMessage>;

// ---------------------------------------------------------------------------------------------
// Awareness
// ---------------------------------------------------------------------------------------------

/**
 * Note-channel awareness. Names, colours and roles are deliberately absent: the UI maps
 * `id -> {name, colorHue, role}` from the `participants` message, so a client cannot present a
 * name it chose itself. `user.id` is validated against the authenticated user on **every**
 * message; a mismatch closes the connection with `awareness-spoof`.
 */
export const AwarenessState: z.ZodObject<
  {
    user: z.ZodObject<{ id: typeof UserId }, z.core.$strict>;
    cursor: z.ZodOptional<
      z.ZodNullable<z.ZodObject<{ anchor: z.ZodUnknown; head: z.ZodUnknown }, z.core.$strict>>
    >;
    mode: z.ZodOptional<typeof PresenceMode>;
  },
  z.core.$strict
> = z.strictObject({
  user: z.strictObject({ id: UserId }),
  /** Yjs relative positions. */
  cursor: z.strictObject({ anchor: z.unknown(), head: z.unknown() }).nullable().optional(),
  mode: PresenceMode.optional(),
});

/** Note-channel awareness. */
export type AwarenessState = z.infer<typeof AwarenessState>;

/** Vault-channel awareness: which note each member is looking at, for the tree's presence dots. */
export const VaultAwarenessState: z.ZodObject<
  {
    user: z.ZodObject<{ id: typeof UserId }, z.core.$strict>;
    activeNoteId: z.ZodOptional<z.ZodNullable<typeof NoteId>>;
  },
  z.core.$strict
> = z.strictObject({
  user: z.strictObject({ id: UserId }),
  activeNoteId: NoteId.nullable().optional(),
});

/** Vault-channel awareness. */
export type VaultAwarenessState = z.infer<typeof VaultAwarenessState>;

// ---------------------------------------------------------------------------------------------
// Connection context and close reasons
// ---------------------------------------------------------------------------------------------

/**
 * The Hocuspocus connection context `onAuthenticate` returns. Authorship for
 * `note_updates.actor_id`, audit events and revisions is taken from this object and never from
 * awareness, which is why `ip`, `requestId` and `connectedAt` are part of the contract rather
 * than local variables of the hook. The member list is complete.
 */
export interface IridiumCollabContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly vaultId: string;
  /** `null` on a vault channel. */
  readonly noteId: string | null;
  /** A server administrator is resolved to `manager` here, never as a later bypass. */
  readonly role: 'viewer' | 'editor' | 'manager';
  readonly isServerAdmin: boolean;
  /** A tuple, never a sum: `beforeHandleMessage` compares both members. */
  readonly authzEpoch: { readonly userAuthzVersion: number; readonly memberVersion: number };
  readonly ip: string;
  readonly requestId: string;
  readonly connectedAt: number;
  readonly clientName: string | null;
  readonly clientVersion: string | null;
}

/**
 * The close reasons a client keys on. The Hocuspocus provider surfaces only the reason string —
 * its own close event hard-codes a code — so the client state machine never reads a numeric code.
 */
export const COLLAB_CLOSE_REASONS = [
  'unauthorized',
  'revoked',
  'note-not-found',
  'note-trashed',
  'note-closing',
  'vault-archived',
  'too-large',
  'rate-limited',
  'capacity',
  'awareness-spoof',
  'protocol-error',
  'shutdown',
] as const;

/** A per-document close reason. */
export type CollabCloseReason = (typeof COLLAB_CLOSE_REASONS)[number];

/** A per-document close reason. */
export const CollabCloseReason: EnumOf<typeof COLLAB_CLOSE_REASONS> = z.enum(COLLAB_CLOSE_REASONS);

/**
 * The Hocuspocus close code each reason travels with (09-api-reference.md section 3.6). The
 * server writes these; a client must not read them, because one reason can also arrive as
 * `PermissionDenied` with no close frame at all.
 */
export const COLLAB_CLOSE_CODES: Readonly<Record<CollabCloseReason, number>> = {
  unauthorized: 4401,
  revoked: 4403,
  'note-not-found': 4404,
  'note-trashed': 4404,
  'note-closing': 4404,
  'vault-archived': 4403,
  'too-large': 1009,
  'rate-limited': 4403,
  capacity: 4403,
  'awareness-spoof': 4403,
  'protocol-error': 4403,
  shutdown: 4205,
};

/**
 * How a close reason arrived. One reason carries two policies: `rate-limited` from a CLOSE frame
 * is the message-rate cap and reconnects once, while `rate-limited` from `PermissionDenied` is
 * the per-user document-connection cap and must not re-attach (D05-25).
 */
export type CollabCloseVia = 'close-frame' | 'auth-denied' | null;
