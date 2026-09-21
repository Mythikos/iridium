/** Named revisions and atomic content restore, both retaining the existing CRDT identity. */
import {
  LIMITS,
  NoteRevision,
  type NoteId,
  type RestoredRevision,
  type UserPrincipal,
  type VaultId,
} from '@iridium/contracts';
import { storedSv } from '@iridium/crdt';
import { normalizeSource } from '@iridium/markdown';
import type { Kysely } from 'kysely';

import type { AuditEventContext, AuditEventInput, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { CollabGateway } from '../collab/gateway.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import {
  CheckpointTimeout,
  CheckpointUnavailable,
  isCompactionRejection,
  RevisionContentRefused,
  RestoreTimeout,
} from '../collab/persistence/errors.ts';
import type { CollabPersistenceService } from '../collab/persistence/index.ts';
import { insertRevisionRow } from '../collab/persistence/kysely-store.ts';
import type { UpdateActor } from '../collab/persistence/types.ts';
import type { Database } from '../db/schema.ts';
import { captureStoredState } from '../notes/committed-state.ts';
import type { Clock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';
import { readRevision, revisionNotFound } from './read.ts';

/** The composition root supplies the existing gateway, writer, lease and audit owner. */
export interface RevisionServiceDeps {
  readonly db: () => Kysely<Database>;
  readonly gateway: Pick<CollabGateway, 'openServerEdit'>;
  readonly persistence: Pick<CollabPersistenceService, 'writerOf' | 'compactNow'>;
  readonly captureOwner: () => OwnerFence;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly logger: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
}

/** REST supplies only its already authenticated user and resolved note/vault. */
export interface RevisionMutationInput {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly principal: UserPrincipal;
  readonly actorDisplay: string;
  readonly context: AuditEventContext;
}

function actor(principal: UserPrincipal): UpdateActor {
  return { actorType: 'user', userId: principal.userId, sessionId: principal.sessionId };
}

function event(
  input: RevisionMutationInput,
  action: 'note.revision.named' | 'note.revision.restored',
): AuditEventInput {
  return {
    action,
    actorType: 'user',
    actorId: input.principal.userId,
    actorDisplay: input.actorDisplay,
    credentialType: 'session',
    credentialId: input.principal.sessionId,
    vaultId: input.vaultId,
    targetType: 'note',
    targetId: input.noteId,
    outcome: 'success',
    context: input.context,
  };
}

function translate(error: unknown): never {
  if (error instanceof RevisionContentRefused) throw new ProblemError(error.reason);
  if (
    error instanceof CheckpointTimeout ||
    error instanceof CheckpointUnavailable ||
    error instanceof RestoreTimeout ||
    isCompactionRejection(error)
  ) {
    throw new ProblemError('unavailable', {
      detail: 'The note writer cannot complete this revision operation yet.',
      retryAfterMs: 1000,
    });
  }
  throw error;
}

/** The mutation half of revisions; all GET handlers use ContentReadCore. */
export class RevisionService {
  readonly #deps: RevisionServiceDeps;
  constructor(deps: RevisionServiceDeps) {
    this.#deps = deps;
  }

  async create(input: RevisionMutationInput, label: string): Promise<NoteRevision> {
    const owner = this.#deps.captureOwner();
    try {
      const writer = this.#deps.persistence.writerOf(input.noteId);
      let id: number;
      if (writer !== undefined) {
        if (writer.contentInvalid) throw new ProblemError('content_invalid');
        const compacted = await writer.enqueueCompaction('flush');
        if (compacted.contentInvalid !== null) throw new ProblemError('content_invalid');
        if (compacted.status === 'skipped_trashed') throw new ProblemError('node_trashed');
        owner.assertActive();
        const checkpoint = await writer.enqueueCheckpoint({
          kind: 'named',
          label,
          actor: actor(input.principal),
          audit: event(input, 'note.revision.named'),
        });
        id = checkpoint.revision.id;
      } else {
        id = await this.#deps
          .db()
          .transaction()
          .execute(async (trx) => {
            await owner.assertCurrent(trx);
            // Holding the parent rows first prevents implicit revision FK locks from reversing the
            // structural node -> notes -> head order. No live document is loaded for this branch.
            const node = await trx
              .selectFrom('nodes')
              .select(['deleted_at', 'vault_id'])
              .where('id', '=', idBytes(input.noteId))
              .forShare()
              .executeTakeFirst();
            if (node === undefined || !node.vault_id.equals(idBytes(input.vaultId)))
              throw new ProblemError('not_found');
            if (node.deleted_at !== null) throw new ProblemError('node_trashed');
            const note = await trx
              .selectFrom('notes')
              .select('content_invalid')
              .where('node_id', '=', idBytes(input.noteId))
              .forUpdate()
              .executeTakeFirst();
            if (note === undefined) throw new ProblemError('not_found');
            if (note.content_invalid) throw new ProblemError('content_invalid');
            const captured = await captureStoredState(trx, input.noteId, true);
            if (!captured.scan.ok) throw new ProblemError('content_invalid');
            const revision = await insertRevisionRow(trx, idBytes(input.noteId), {
              seq: captured.throughSeq,
              kind: 'named',
              label,
              markdown: captured.markdown,
              contentHash: captured.contentHash,
              sizeChars: captured.sizeChars,
              snapshot: captured.stateV2,
              snapshotSv: storedSv(captured.sv),
              actor: actor(input.principal),
              createdAt: this.#deps.clock.date(),
            });
            if (revision.inserted)
              await this.#deps.audit.record(trx, {
                ...event(input, 'note.revision.named'),
                metadata: { label, revision: captured.throughSeq, revisionId: revision.id },
              });
            return revision.id;
          });
      }
      return await this.#metadata(input.noteId, id);
    } catch (error) {
      return translate(error);
    }
  }

  async restore(input: RevisionMutationInput, revisionId: number): Promise<RestoredRevision> {
    const retained = await readRevision(this.#deps.db(), input.noteId, revisionId);
    if (retained === null) throw await revisionNotFound(this.#deps.db(), input.noteId, revisionId);
    const target = normalizeSource(retained.markdown).text;
    if (target.length > LIMITS.NOTE_SOFT_MAX_UTF16) throw new ProblemError('note_oversized');
    const owner = this.#deps.captureOwner();
    const edit = await this.#deps.gateway.openServerEdit(input.noteId, {
      principal: input.principal,
      permission: 'history:restore',
      reason: 'restore',
      revisionId,
    });
    try {
      owner.assertActive();
      const writer = this.#deps.persistence.writerOf(input.noteId);
      if (writer === undefined) throw new ProblemError('unavailable');
      const restored = await writer.enqueueRestore({
        document: edit.document,
        target,
        revisionId,
        actor: actor(input.principal),
        audit: event(input, 'note.revision.restored'),
        apply: (diff) => edit.applyDiff(diff),
      });
      // Projection currency has a separate deadline; durability is already established above.
      await this.#deps.persistence
        .compactNow(input.noteId, { trigger: 'flush' })
        .catch((error: unknown) => {
          this.#deps.logger.warn(
            { event: 'revision.projection.delayed', noteId: input.noteId, err: error },
            'The restored content is durable; its projection is delayed.',
          );
        });
      if (!restored.changed)
        return { changed: false, revision: restored.seq, contentHash: restored.contentHash };
      const [before, after] = await Promise.all([
        this.#metadata(input.noteId, restored.preRestoreRevisionId),
        this.#metadata(input.noteId, restored.restoreRevisionId),
      ]);
      return {
        changed: true,
        preRestore: before,
        restored: after,
        revision: restored.seq,
        contentHash: restored.contentHash,
      };
    } catch (error) {
      return translate(error);
    } finally {
      await edit.disconnect().catch((error: unknown) => {
        this.#deps.logger.warn(
          { event: 'revision.disconnect.delayed', noteId: input.noteId, err: error },
          'The direct edit connection could not complete its store hook.',
        );
      });
    }
  }

  async #metadata(noteId: NoteId, revisionId: number): Promise<NoteRevision> {
    const result = await readRevision(this.#deps.db(), noteId, revisionId);
    if (result === null) throw new ProblemError('not_found');
    const { markdown: _markdown, ...metadata } = result;
    return NoteRevision.parse(metadata);
  }
}
