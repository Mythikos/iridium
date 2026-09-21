/** Attachment lifecycle, metadata and reference queries (03 §10; 08 §9; 09 §2.11). */
import {
  ATTACHMENT_TYPES,
  AttachmentId,
  idFromBytes,
  LIMITS,
  newId,
  NoteId,
  VaultId,
  type Attachment,
  type AttachmentPage,
  type AttachmentReference,
  type AttachmentUploaded,
  type AttachmentUploadFields,
  type ListAttachmentsQuery,
  type Principal,
  type SessionId,
  type UserId,
} from '@iridium/contracts';
import type { Kysely, Selectable, Transaction } from 'kysely';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { Authorizer } from '../authz/authorize.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { assertVersionedUpdate, requireIfMatch } from '../db/cas.ts';
import type { AttachmentsTable, Database } from '../db/schema.ts';
import { withVaultLock } from '../db/withVaultLock.ts';
import { cursorInvalid, type CursorCodec } from '../mcp/cursor.ts';
import type { Clock } from '../ops/clock.ts';
import { fetchOnePage } from '../rest/pagination.ts';
import { ProblemError } from '../security/problem.ts';
import { derivePath } from '../tree/paths.ts';
import {
  attachmentMarkdownReference,
  sanitizeAttachmentName,
  validateAttachmentPath,
} from './names.ts';
import type { StagedAttachment } from './staging.ts';
import { assertStorageKey, type ByteRange, type StorageDriver } from './storage.ts';

type Executor = Kysely<Database> | Transaction<Database>;
/** Metadata plus the non-sensitive attribution fields, shared by the report projection. */
export type AttachmentRow = Selectable<AttachmentsTable> & {
  readonly uploader_name: string | null;
  readonly uploader_hue: number | null;
};

/** The authenticated audit actor for uploads and soft deletion. */
export interface AttachmentActor {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly displayName: string;
}
/** Dependencies have process lifetime; request fences are passed per mutation. */
export interface AttachmentServiceDeps {
  readonly database: () => Kysely<Database>;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
  readonly authorize: Authorizer['authorize'];
  readonly storage: StorageDriver;
}

/** Request-specific mutation context, preserving the generation admitted before upload I/O. */
export interface AttachmentWriteContext {
  readonly principal: Principal;
  readonly actor: AttachmentActor;
  readonly context: AuditEventContext;
  readonly ownerFence: OwnerFence;
}

/** The canonical metadata select; every surface uses the same attribution join. */
export function attachmentRows(db: Executor) {
  return db
    .selectFrom('attachments')
    .leftJoin('users as uploader', 'uploader.id', 'attachments.uploaded_by')
    .selectAll('attachments')
    .select(['uploader.display_name as uploader_name', 'uploader.color_hue as uploader_hue']);
}

/** The canonical public representation of a persisted attachment. */
export function attachmentDto(row: AttachmentRow): Attachment {
  if (row.path_hint === null) throw new AttachmentMetadataError(idFromBytes(row.id));
  return {
    id: idFromBytes(row.id),
    vaultId: idFromBytes(row.vault_id),
    sha256: row.sha256.toString('hex'),
    sizeBytes: row.size_bytes,
    mime: row.mime,
    originalName: row.original_name,
    pathHint: row.path_hint,
    inlineable: ATTACHMENT_TYPES[row.mime]?.inline === true,
    uploadedBy: {
      id: idFromBytes(row.uploaded_by),
      displayName: row.uploader_name ?? 'unknown',
      colorHue: row.uploader_hue ?? 0,
    },
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
    version: row.version,
  };
}

/** A committed attachment always has a path (I-15). */
export class AttachmentMetadataError extends Error {
  constructor(id: string) {
    super(`Attachment '${id}' has no path_hint; repair invariant I-15 before serving it.`);
    this.name = 'AttachmentMetadataError';
  }
}

/** Pure metadata and streamed bytes share one current authorization check. */
export class AttachmentService {
  readonly #deps: AttachmentServiceDeps;
  constructor(deps: AttachmentServiceDeps) {
    this.#deps = deps;
  }

  async #authorize(
    principal: Principal,
    vaultId: string,
    write: boolean,
    trx?: Transaction<Database>,
  ): Promise<void> {
    const scope = { vaultId: VaultId.parse(vaultId) };
    if (trx === undefined) {
      const decision = await this.#deps.authorize(
        principal,
        write ? 'attachment:write' : 'attachment:read',
        scope,
      );
      if (decision !== 'allow') throw new ProblemError(decision.deny);
      return;
    }
    const userId = principal.kind === 'system' ? null : principal.userId;
    const [vault, member] = await Promise.all([
      trx
        .selectFrom('vaults')
        .select(['status', 'mcp_enabled'])
        .where('id', '=', idBytes(vaultId))
        .executeTakeFirstOrThrow(),
      userId === null
        ? Promise.resolve(undefined)
        : trx
            .selectFrom('vault_members')
            .select(['role', 'version'])
            .where('vault_id', '=', idBytes(vaultId))
            .where('user_id', '=', idBytes(userId))
            .executeTakeFirst(),
    ]);
    const decision = await this.#deps.authorize(
      principal,
      write ? 'attachment:write' : 'attachment:read',
      { ...scope, vault: { id: scope.vaultId, ...vault }, member: member ?? null },
    );
    if (decision !== 'allow') throw new ProblemError(decision.deny);
  }

  async #row(
    db: Executor,
    vaultId: string,
    attachmentId: string,
    includeDeleted = false,
  ): Promise<AttachmentRow> {
    let query = attachmentRows(db)
      .where('attachments.id', '=', idBytes(attachmentId))
      .where('attachments.vault_id', '=', idBytes(vaultId));
    if (!includeDeleted) query = query.where('attachments.deleted_at', 'is', null);
    const row = await query.executeTakeFirst();
    if (row === undefined) throw new ProblemError('not_found');
    return row;
  }

  async #references(
    db: Executor,
    vaultId: string,
    attachmentId: string,
    limit: number,
  ): Promise<{
    readonly referencedBy: readonly AttachmentReference[];
    readonly referencedByTotal: number;
  }> {
    const query = db
      .selectFrom('note_links as link')
      .innerJoin('nodes as note', 'note.id', 'link.from_note_id')
      .where('link.vault_id', '=', idBytes(vaultId))
      .where('link.resolved_attachment_id', '=', idBytes(attachmentId))
      .where('note.vault_id', '=', idBytes(vaultId))
      .where('note.deleted_at', 'is', null);
    const [sample, count] = await Promise.all([
      query
        .select('link.from_note_id')
        .distinct()
        .orderBy('link.from_note_id')
        .limit(limit)
        .execute(),
      query
        .select((expression) =>
          expression.fn.count<number>('link.from_note_id').distinct().as('count'),
        )
        .executeTakeFirstOrThrow(),
    ]);
    const referencedBy = await Promise.all(
      sample.map(async (row) => ({
        noteId: idFromBytes(row.from_note_id),
        path: (await derivePath(db, row.from_note_id)).path,
      })),
    );
    return { referencedBy, referencedByTotal: count.count };
  }

  /** Reads one live attachment, including a bounded list of its live note references. */
  async metadata(principal: Principal, vaultId: string, attachmentId: string): Promise<Attachment> {
    await this.#authorize(principal, vaultId, false);
    const db = this.#deps.database();
    const row = await this.#row(db, vaultId, attachmentId);
    return {
      ...attachmentDto(row),
      ...(await this.#references(
        db,
        vaultId,
        attachmentId,
        LIMITS.ATTACHMENT_REFERENCE_SAMPLE_MAX,
      )),
    };
  }

  /** Content access checks the requested vault against the stored key as well as the row. */
  async content(
    principal: Principal,
    vaultId: string,
    attachmentId: string,
  ): Promise<{
    readonly attachment: Attachment;
    readonly open: (range?: ByteRange) => ReturnType<StorageDriver['get']>;
  }> {
    await this.#authorize(principal, vaultId, false);
    const row = await this.#row(this.#deps.database(), vaultId, attachmentId);
    assertStorageKey(row.storage_key, vaultId);
    return {
      attachment: attachmentDto(row),
      open: (range) => this.#deps.storage.get(row.storage_key, range),
    };
  }

  /** A keyset page constrained in SQL to the already-authorized vault. */
  async list(
    principal: Principal,
    vaultId: string,
    query: ListAttachmentsQuery,
    codec: CursorCodec,
    principalKey: string,
  ): Promise<AttachmentPage> {
    await this.#authorize(principal, vaultId, false);
    const db = this.#deps.database();
    const filter = {
      vaultId,
      noteId: query.noteId ?? null,
      includeReferences: query.includeReferences,
      includeDeleted: query.includeDeleted,
    };
    const expectation = { kind: 'attachments' as const, filter, principalKey };
    let listing = attachmentRows(db).where('attachments.vault_id', '=', idBytes(vaultId));
    if (!query.includeDeleted) listing = listing.where('attachments.deleted_at', 'is', null);
    if (query.noteId !== undefined) {
      await this.#notePath(db, vaultId, query.noteId);
      listing = listing.where(
        'attachments.id',
        'in',
        db
          .selectFrom('note_links')
          .select('resolved_attachment_id')
          .where('from_note_id', '=', idBytes(query.noteId))
          .where('vault_id', '=', idBytes(vaultId))
          .where('resolved_attachment_id', 'is not', null),
      );
    }
    if (query.cursor !== undefined) {
      const after = codec.parse(query.cursor, expectation).a;
      const path = after[0];
      const id = AttachmentId.safeParse(after[1]);
      if (typeof path !== 'string' || !id.success || after.length !== 2)
        throw cursorInvalid('Invalid attachment page key.');
      listing = listing.where((expression) =>
        expression.or([
          expression('attachments.path_hint', '>', path),
          expression.and([
            expression('attachments.path_hint', '=', path),
            expression('attachments.id', '>', idBytes(id.data)),
          ]),
        ]),
      );
    }
    const page = await fetchOnePage(query.limit, (count) =>
      listing.orderBy('attachments.path_hint').orderBy('attachments.id').limit(count).execute(),
    );
    const items = await Promise.all(
      page.items.map(async (row) =>
        query.includeReferences
          ? {
              ...attachmentDto(row),
              ...(await this.#references(
                db,
                vaultId,
                idFromBytes(row.id),
                LIMITS.ATTACHMENT_REFERENCE_SAMPLE_MAX,
              )),
            }
          : attachmentDto(row),
      ),
    );
    const last = items.at(-1);
    return {
      items,
      ...(page.hasMore && last !== undefined
        ? { nextCursor: codec.issue({ ...expectation, after: [last.pathHint, last.id] }) }
        : {}),
    };
  }

  async #notePath(db: Executor, vaultId: string, noteId: string): Promise<string> {
    const note = await db
      .selectFrom('nodes')
      .select('id')
      .where('id', '=', idBytes(noteId))
      .where('vault_id', '=', idBytes(vaultId))
      .where('kind', '=', 'note')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (note === undefined) throw new ProblemError('not_found');
    return (await derivePath(db, note.id)).path;
  }

  async #availablePath(
    trx: Transaction<Database>,
    vaultId: string,
    attachmentId: string,
    filename: string,
    explicit?: string,
  ): Promise<string> {
    const vault = await trx
      .selectFrom('vaults')
      .select('attachment_folder')
      .where('id', '=', idBytes(vaultId))
      .executeTakeFirstOrThrow();
    for (let attempt = 1; attempt <= LIMITS.ATTACHMENT_NAME_COLLISION_ATTEMPTS; attempt += 1) {
      const suffix = attempt === 1 ? '' : ` (${attempt})`;
      const path = validateAttachmentPath(
        explicit ?? `${vault.attachment_folder}/${sanitizeAttachmentName(filename, suffix)}`,
      );
      // eslint-disable-next-line no-await-in-loop -- the database collation decides each candidate in order
      const conflict = await trx
        .selectFrom('attachments')
        .select('id')
        .where('vault_id', '=', idBytes(vaultId))
        .where('path_hint', '=', path)
        .where('deleted_at', 'is', null)
        .where('id', '!=', idBytes(attachmentId))
        .executeTakeFirst();
      if (conflict === undefined) return path;
      if (explicit !== undefined) break;
    }
    throw new ProblemError('name_conflict', {
      detail: 'The attachment path is already occupied; choose another name.',
    });
  }

  /** Stores before inserting; a failed transaction can leave an inert orphan, never a dangling row. */
  async upload(
    vaultId: string,
    staged: StagedAttachment,
    fields: AttachmentUploadFields,
    write: AttachmentWriteContext,
  ): Promise<AttachmentUploaded> {
    if (fields.pathHint !== undefined) validateAttachmentPath(fields.pathHint);
    const db = this.#deps.database();
    const uploaded = await withVaultLock(
      { db, clock: this.#deps.clock, vaultId, ownerFence: write.ownerFence, mode: 'metadata' },
      async ({ trx }) => {
        await this.#authorize(write.principal, vaultId, true, trx);
        const notePath =
          fields.noteId === undefined
            ? undefined
            : await this.#notePath(trx, vaultId, fields.noteId);
        const existing = await attachmentRows(trx)
          .where('attachments.vault_id', '=', idBytes(vaultId))
          .where('attachments.sha256', '=', Buffer.from(staged.sha256, 'hex'))
          .executeTakeFirst();
        const id = existing === undefined ? newId() : idFromBytes(existing.id);
        const deduplicated = existing !== undefined;
        if (existing === undefined || existing.deleted_at !== null) {
          const name = existing?.original_name ?? sanitizeAttachmentName(staged.originalName);
          const oldPath = existing?.path_hint;
          const oldPathOccupied =
            oldPath === undefined || oldPath === null
              ? undefined
              : await trx
                  .selectFrom('attachments')
                  .select('id')
                  .where('vault_id', '=', idBytes(vaultId))
                  .where('path_hint', '=', oldPath)
                  .where('deleted_at', 'is', null)
                  .where('id', '!=', idBytes(id))
                  .executeTakeFirst();
          // Reviving content preserves its original path whenever possible, so retained Markdown
          // starts resolving again even when the re-upload used a different client filename.
          const preferred =
            oldPath !== null && oldPath !== undefined && oldPathOccupied === undefined
              ? oldPath
              : fields.pathHint;
          const path = await this.#availablePath(trx, vaultId, id, name, preferred);
          const key = `${vaultId}/${staged.sha256.slice(0, 2)}/${staged.sha256}`;
          await this.#deps.storage.put(key, staged.open(), {
            sizeBytes: staged.sizeBytes,
            mime: staged.mime,
          });
          if (existing === undefined) {
            await trx
              .insertInto('attachments')
              .values({
                id: idBytes(id),
                vault_id: idBytes(vaultId),
                sha256: Buffer.from(staged.sha256, 'hex'),
                size_bytes: staged.sizeBytes,
                mime: staged.mime,
                original_name: name,
                path_hint: path,
                storage_key: key,
                encryption: 'none',
                key_version: null,
                iv: null,
                auth_tag: null,
                uploaded_by: idBytes(write.actor.userId),
                created_at: this.#deps.clock.date(),
                deleted_at: null,
              })
              .execute();
          } else {
            const updated = await trx
              .updateTable('attachments')
              .set({
                deleted_at: null,
                version: existing.version + 1,
                path_hint: path,
                original_name: name,
              })
              .where('id', '=', existing.id)
              .where('version', '=', existing.version)
              .executeTakeFirstOrThrow();
            assertVersionedUpdate(updated, {
              table: 'attachments',
              id,
              expected: existing.version,
            });
          }
        }
        const attachment = attachmentDto(await this.#row(trx, vaultId, id));
        await this.#deps.audit.record(trx, {
          action: 'attachment.uploaded',
          actorType: 'user',
          actorId: write.actor.userId,
          actorDisplay: write.actor.displayName,
          credentialType: 'session',
          credentialId: write.actor.sessionId,
          vaultId,
          targetType: 'attachment',
          targetId: id,
          outcome: 'success',
          context: write.context,
          metadata: {
            sha256: staged.sha256,
            sizeBytes: staged.sizeBytes,
            pathHint: attachment.pathHint,
            deduplicated,
          },
        });
        return {
          attachment,
          markdownReference: attachmentMarkdownReference(
            attachment.originalName,
            attachment.pathHint,
            attachment.mime,
            notePath,
          ),
          deduplicated,
        };
      },
    );
    return uploaded;
  }

  /** Soft deletion preserves bytes and retained history; no heuristic collector runs here. */
  async delete(
    vaultId: string,
    attachmentId: string,
    version: number | undefined,
    force: boolean,
    write: AttachmentWriteContext,
  ): Promise<void> {
    await withVaultLock(
      {
        db: this.#deps.database(),
        clock: this.#deps.clock,
        vaultId,
        ownerFence: write.ownerFence,
        mode: 'metadata',
      },
      async ({ trx }) => {
        await this.#authorize(write.principal, vaultId, true, trx);
        const row = await this.#row(trx, vaultId, attachmentId);
        const expected = requireIfMatch(version, 'an attachment');
        if (expected !== row.version)
          throw new ProblemError('stale_version', { current: attachmentDto(row) });
        const references = await this.#references(
          trx,
          vaultId,
          attachmentId,
          LIMITS.ATTACHMENT_DELETE_REFERENCE_SAMPLE_MAX,
        );
        if (!force && references.referencedByTotal > 0)
          throw new ProblemError('attachment_referenced', {
            detail: `${references.referencedByTotal} live notes reference this attachment.`,
            references: references.referencedBy.map((reference) => ({
              ...reference,
              noteId: NoteId.parse(reference.noteId),
            })),
          });
        const updated = await trx
          .updateTable('attachments')
          .set({ deleted_at: this.#deps.clock.date(), version: row.version + 1 })
          .where('id', '=', row.id)
          .where('version', '=', expected)
          .executeTakeFirstOrThrow();
        assertVersionedUpdate(
          updated,
          { table: 'attachments', id: attachmentId, expected },
          { current: attachmentDto(row) },
        );
        await this.#deps.audit.record(trx, {
          action: 'attachment.deleted',
          actorType: 'user',
          actorId: write.actor.userId,
          actorDisplay: write.actor.displayName,
          credentialType: 'session',
          credentialId: write.actor.sessionId,
          vaultId,
          targetType: 'attachment',
          targetId: attachmentId,
          outcome: 'success',
          context: write.context,
          metadata: {
            pathHint: row.path_hint,
            referenceCount: references.referencedByTotal,
            references: references.referencedBy,
            force,
          },
        });
      },
    );
  }
}
