/**
 * `KyselyPersistenceStore` — the `PersistenceStore` over `dbPersist` (03-data-model.md §8.4, §8.6,
 * §8.7, §9.2; 05-collaboration-and-durability.md, "The transaction").
 *
 * Every statement is the one the plan spells, with its guard: the `FOR UPDATE` on `note_docs` joined
 * to `nodes` (the writer's whole lock set), the `head_seq` compare-and-set, `snapshot_through_seq <
 * ?`, the row-alias projection upsert, `INSERT … ON DUPLICATE KEY UPDATE id = id` for a revision,
 * `projected_seq < ?` last. The transaction runs at REPEATABLE READ on a connection whose
 * `innodb_lock_wait_timeout` is capped at the writer's 10 s (§7.4) and the serving session's
 * deadline-derived baseline. The previous value is restored afterward because SET SESSION
 * outlives the transaction.
 *
 * `dbPersist` is resolved per call because boot step 2 tolerates an unreachable database: a store
 * created at boot works once the pools connect, and a call before that throws
 * `PersistenceUnavailable`, which the writer reports as `db_unavailable` and retries.
 */
import type { NoteId } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuditEventInput, AuditWriter } from '../../audit/chain.ts';
import { idBytes, vaultIdFromBytes } from '../../auth/ids.ts';
import { matchedOne, monotonicGuardApplied } from '../../db/cas.ts';
import type { Database } from '../../db/schema.ts';
import { PERSIST_LOCK_WAIT_TIMEOUT_SECONDS } from '../../db/withVaultLock.ts';
import { markProjectionInvalid, upsertProjection } from '../../projection/write.ts';
import type { OwnerFence } from '../owner-lease.ts';
import { YJS_MAJOR } from './initial-state.ts';
import type { CompactionTransaction, PersistenceStore, WriteTransaction } from './store.ts';
import {
  asV1Update,
  type CheckpointPolicyInputs,
  type HeadRow,
  type LoadedDocRow,
  type NewestRevision,
  type NoteMetadataWrite,
  type ProjectionInput,
  type RevisionInsert,
  type SnapshotWrite,
  type UpdateRow,
} from './types.ts';

/** `note_revisions.markdown` is `MEDIUMTEXT`; the hard note cap cannot exceed it (03 §8.7). */
export const REVISION_MARKDOWN_COLUMN_BYTES = 16_777_215;

/** MySQL's own default, restored when the session variable read back an unusable value. */
const MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS = 50;

/** Thrown when `dbPersist` is not connected; the writer maps it to `db_unavailable`. */
export class PersistenceUnavailable extends Error {
  readonly code = 'persist.unavailable';

  constructor() {
    super(
      'the persistence writer needs dbPersist, which is not connected; the batch stays queued and ' +
        'is retried (02-system-architecture.md ARCH-02).',
    );
    this.name = 'PersistenceUnavailable';
  }
}

/** Thrown when a revision's text would not fit its column — unreachable below the hard note cap. */
export class RevisionTooLarge extends Error {
  readonly code = 'persist.revision_too_large';

  constructor(bytes: number) {
    super(
      `a note_revisions row of ${String(bytes)} UTF-8 bytes exceeds the MEDIUMTEXT column ` +
        `(${String(REVISION_MARKDOWN_COLUMN_BYTES)}); the hard note cap makes this unreachable.`,
    );
    this.name = 'RevisionTooLarge';
  }
}

/** A `Buffer` from mysql2 as a plain `Uint8Array` over the same bytes. */
function bytesOf(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function asSnapshotFormat(value: number): 1 | 2 {
  if (value === 1 || value === 2) return value;
  throw new Error(
    `note_docs.snapshot_format ${String(value)} is neither 1 (V1) nor 2 (V2); the loader dispatches ` +
      'on this column and refuses to guess (03-data-model.md §8.3).',
  );
}

async function readLockTimeout(db: Kysely<Database>): Promise<number> {
  const result = await sql<{
    value: number | string;
  }>`SELECT @@SESSION.innodb_lock_wait_timeout AS value`.execute(db);
  const raw = result.rows[0]?.value;
  const seconds =
    typeof raw === 'number' ? raw : Number(raw ?? MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS);
  return Number.isSafeInteger(seconds) && seconds >= 1
    ? seconds
    : MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS;
}

async function setLockTimeout(db: Kysely<Database>, seconds: number): Promise<void> {
  const safe =
    Number.isSafeInteger(seconds) && seconds >= 0
      ? seconds
      : MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS;
  await sql`SET SESSION innodb_lock_wait_timeout = ${sql.lit(safe)}`.execute(db);
}

/** What the store needs. */
export interface KyselyStoreOptions {
  /** `dbPersist`, resolved per call. */
  readonly db: () => Kysely<Database> | null;
  readonly audit: AuditWriter;
  /** Captured at load, so old queued work cannot adopt a successor generation. */
  readonly ownership?: OwnerFence;
}

/** The store. One per process, owned by the persistence layer. */
export class KyselyPersistenceStore implements PersistenceStore {
  readonly #db: () => Kysely<Database> | null;
  readonly #audit: AuditWriter;
  readonly #ownership: OwnerFence | undefined;

  constructor(options: KyselyStoreOptions) {
    this.#db = options.db;
    this.#audit = options.audit;
    this.#ownership = options.ownership;
  }

  /** Rejects a loaded document whose captured owner lifetime has ended. */
  assertActive(): void {
    this.#ownership?.assertActive();
  }

  #require(): Kysely<Database> {
    this.#ownership?.assertActive();
    const db = this.#db();
    if (db === null) throw new PersistenceUnavailable();
    return db;
  }

  async loadDoc(noteId: NoteId): Promise<LoadedDocRow | null> {
    const row = await this.#read((db) =>
      db
        .selectFrom('note_docs as d')
        .innerJoin('notes as t', 't.node_id', 'd.note_id')
        .innerJoin('nodes as n', 'n.id', 'd.note_id')
        .select([
          'd.head_seq',
          'd.snapshot',
          'd.snapshot_format',
          'd.snapshot_sv',
          'd.snapshot_through_seq',
          'd.snapshot_size',
          'd.projected_seq',
          'd.yjs_major',
          'n.vault_id',
          'n.deleted_at',
          't.initialized_at',
          't.content_invalid',
          't.oversize',
        ])
        .where('d.note_id', '=', idBytes(noteId))
        .executeTakeFirst(),
    );
    if (row === undefined) return null;
    return {
      headSeq: row.head_seq,
      snapshot: row.snapshot === null ? null : bytesOf(row.snapshot),
      snapshotFormat: asSnapshotFormat(row.snapshot_format),
      snapshotSv: row.snapshot_sv === null ? null : bytesOf(row.snapshot_sv),
      snapshotThroughSeq: row.snapshot_through_seq,
      snapshotSize: row.snapshot_size,
      projectedSeq: row.projected_seq,
      yjsMajor: row.yjs_major,
      vaultId: vaultIdFromBytes(row.vault_id),
      deletedAt: row.deleted_at,
      initializedAt: row.initialized_at,
      contentInvalid: row.content_invalid,
      oversize: row.oversize,
    };
  }

  async loadUpdatesAfter(noteId: NoteId, after: number): Promise<readonly UpdateRow[]> {
    const rows = await this.#read((db) =>
      db
        .selectFrom('note_updates')
        .select(['seq', 'update_v1', 'sv_after'])
        .where('note_id', '=', idBytes(noteId))
        .where('seq', '>', after)
        .orderBy('seq', 'asc')
        .execute(),
    );
    return rows.map((row) => ({
      seq: row.seq,
      updateV1: asV1Update(bytesOf(row.update_v1)),
      svAfter: bytesOf(row.sv_after),
    }));
  }

  async revisionExistsAt(noteId: NoteId, seq: number): Promise<boolean> {
    return this.#read((db) => revisionExists(db, idBytes(noteId), seq, null));
  }

  async insertRevision(
    noteId: NoteId,
    row: RevisionInsert,
  ): Promise<{ readonly id: number; readonly inserted: boolean }> {
    assertRevisionFits(row);
    return this.#transaction((trx) => insertRevisionRow(trx, idBytes(noteId), row));
  }

  async runWrite<T>(noteId: NoteId, work: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    const id = idBytes(noteId);
    return this.#transaction((trx) =>
      work({
        lockHead: () => lockHead(trx, id),
        matchesUpdates: async (expected) => {
          const first = expected[0];
          const last = expected.at(-1);
          if (first === undefined || last === undefined) return false;
          const actual = await trx
            .selectFrom('note_updates')
            .selectAll()
            .where('note_id', '=', id)
            .where('seq', '>=', first.seq)
            .where('seq', '<=', last.seq)
            .orderBy('seq', 'asc')
            .execute();
          return (
            actual.length === expected.length &&
            actual.every((row, index) => {
              const attempt = expected[index];
              return (
                attempt !== undefined &&
                row.seq === attempt.seq &&
                row.yjs_major === YJS_MAJOR &&
                row.update_v1.equals(attempt.updateV1) &&
                row.sv_after.equals(attempt.svAfter) &&
                row.actor_type === attempt.actor.actorType &&
                (row.actor_id === null
                  ? attempt.actor.userId === null
                  : attempt.actor.userId !== null &&
                    row.actor_id.equals(idBytes(attempt.actor.userId))) &&
                (row.session_id === null
                  ? attempt.actor.sessionId === null
                  : attempt.actor.sessionId !== null &&
                    row.session_id.equals(idBytes(attempt.actor.sessionId))) &&
                row.origin === attempt.origin &&
                row.created_at.getTime() === attempt.createdAt.getTime()
              );
            })
          );
        },
        insertUpdates: async (rows) => {
          if (rows.length === 0) return;
          await trx
            .insertInto('note_updates')
            .values(
              rows.map((row) => ({
                note_id: id,
                seq: row.seq,
                update_v1: Buffer.from(row.updateV1),
                yjs_major: YJS_MAJOR,
                sv_after: Buffer.from(row.svAfter),
                actor_type: row.actor.actorType,
                actor_id: row.actor.userId === null ? null : idBytes(row.actor.userId),
                session_id: row.actor.sessionId === null ? null : idBytes(row.actor.sessionId),
                origin: row.origin,
                created_at: row.createdAt,
              })),
            )
            .execute();
        },
        casHead: async (from, to, now) => {
          const result = await trx
            .updateTable('note_docs')
            .set({ head_seq: to, updated_at: now })
            .where('note_id', '=', id)
            .where('head_seq', '=', from)
            .executeTakeFirst();
          return matchedOne(result);
        },
      }),
    );
  }

  async runCompaction<T>(
    noteId: NoteId,
    work: (tx: CompactionTransaction) => Promise<T>,
  ): Promise<T> {
    const id = idBytes(noteId);
    const audit = this.#audit;
    return this.#transaction((trx) =>
      work({
        lockHead: () => lockHead(trx, id),
        updateSnapshot: async (write: SnapshotWrite) => {
          const result = await trx
            .updateTable('note_docs')
            .set({
              snapshot: Buffer.from(write.snapshot),
              snapshot_sv: Buffer.from(write.snapshotSv),
              snapshot_format: 2,
              yjs_major: YJS_MAJOR,
              snapshot_size: write.snapshotSize,
              snapshot_at: write.now,
              snapshot_through_seq: write.throughSeq,
              updated_at: write.now,
            })
            .where('note_id', '=', id)
            .where('snapshot_through_seq', '<', write.throughSeq)
            .executeTakeFirst();
          return monotonicGuardApplied(result);
        },
        writeProjection: (input: ProjectionInput) =>
          upsertProjection(trx, {
            noteId: id,
            revision: input.revision,
            markdown: input.markdown,
            contentHash: input.contentHash,
            pipelineVersion: PIPELINE_VERSION,
            now: input.now,
            strict: true,
          }),
        markProjectionInvalid: (now) => markProjectionInvalid(trx, id, now),
        newestRevision: async (): Promise<NewestRevision | null> => {
          const row = await trx
            .selectFrom('note_revisions')
            .select(['seq', 'content_hash'])
            .where('note_id', '=', id)
            .orderBy('seq', 'desc')
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
          return row === undefined
            ? null
            : { seq: row.seq, contentHash: bytesOf(row.content_hash) };
        },
        revisionExistsAt: (seq) => revisionExists(trx, id, seq, null),
        checkpointPolicyInputs: async (): Promise<CheckpointPolicyInputs> => {
          const row = await trx
            .selectFrom('notes as t')
            .innerJoin('vaults as v', 'v.id', 't.vault_id')
            .select(['t.last_checkpoint_at', 'v.auto_checkpoint_interval_min'])
            .where('t.node_id', '=', id)
            .executeTakeFirstOrThrow();
          return {
            lastCheckpointAt: row.last_checkpoint_at,
            intervalMinutes: row.auto_checkpoint_interval_min,
          };
        },
        insertRevision: (row) => insertRevisionRow(trx, id, row),
        updateNoteMetadata: async (write: NoteMetadataWrite) => {
          const editorId = write.lastEditor?.userId ?? null;
          await trx
            .updateTable('notes')
            .set({
              size_chars: write.sizeChars,
              oversize: write.oversize,
              content_invalid: write.contentInvalid,
              last_edited_by: sql`COALESCE(${editorId === null ? null : idBytes(editorId)}, last_edited_by)`,
              last_edited_at: sql`COALESCE(${write.lastEditor?.at ?? null}, last_edited_at)`,
              last_checkpoint_at: sql`COALESCE(${write.lastCheckpointAt}, last_checkpoint_at)`,
              updated_at: write.now,
            })
            .where('node_id', '=', id)
            .execute();
        },
        advanceProjectedSeq: async (seq, now) => {
          await trx
            .updateTable('note_docs')
            .set({ projected_seq: seq, updated_at: now })
            .where('note_id', '=', id)
            .where('projected_seq', '<', seq)
            .execute();
        },
        recordAudit: async (event: AuditEventInput) => {
          await audit.record(trx, event);
        },
      }),
    );
  }

  async #read<T>(work: (db: Kysely<Database>) => Promise<T>): Promise<T> {
    const db = this.#require();
    const ownership = this.#ownership;
    if (ownership === undefined) return work(db);
    return db.transaction().execute(async (trx) => {
      await ownership.assertCurrent(trx);
      return work(trx);
    });
  }

  /** One REPEATABLE READ transaction on a connection whose lock-wait timeout is the writer's. */
  async #transaction<T>(work: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
    const db = this.#require();
    return db.connection().execute(async (connection) => {
      const previousTimeout = await readLockTimeout(connection);
      await setLockTimeout(
        connection,
        Math.min(previousTimeout, PERSIST_LOCK_WAIT_TIMEOUT_SECONDS),
      );
      try {
        return await connection
          .transaction()
          .setIsolationLevel('repeatable read')
          .execute(async (trx) => {
            await this.#ownership?.assertCurrent(trx);
            return work(trx);
          });
      } finally {
        // A reset that fails must not replace the error the writer needs to classify; a broken
        // connection is discarded by the pool rather than reused.
        try {
          await setLockTimeout(connection, previousTimeout);
        } catch {
          // Deliberately ignored; see above.
        }
      }
    });
  }
}

/** The guard statement both transactions open with (03 §8.4, §8.6 step 0). */
async function lockHead(trx: Kysely<Database>, id: Buffer): Promise<HeadRow | null> {
  const row = await trx
    .selectFrom('note_docs as d')
    .innerJoin('nodes as n', 'n.id', 'd.note_id')
    .select(['d.head_seq', 'n.deleted_at'])
    .where('d.note_id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? null : { headSeq: row.head_seq, deletedAt: row.deleted_at };
}

async function revisionExists(
  db: Kysely<Database>,
  id: Buffer,
  seq: number,
  kind: RevisionInsert['kind'] | null,
): Promise<boolean> {
  let query = db
    .selectFrom('note_revisions')
    .select('id')
    .where('note_id', '=', id)
    .where('seq', '=', seq);
  if (kind !== null) query = query.where('kind', '=', kind);
  const row = await query.limit(1).executeTakeFirst();
  return row !== undefined;
}

function assertRevisionFits(row: RevisionInsert): void {
  const markdownBytes = Buffer.byteLength(row.markdown, 'utf8');
  if (markdownBytes > REVISION_MARKDOWN_COLUMN_BYTES) throw new RevisionTooLarge(markdownBytes);
}

/**
 * `INSERT … ON DUPLICATE KEY UPDATE id = id`: idempotent under `uq_revisions_note_seq_kind`, and
 * the only write the column-scoped `UPDATE (id)` grant admits (03 §8.7). The id is read back rather
 * than taken from the insert result, because the duplicate-key path reports no insert id.
 */
async function insertRevisionRow(
  db: Kysely<Database>,
  id: Buffer,
  row: RevisionInsert,
): Promise<{ readonly id: number; readonly inserted: boolean }> {
  assertRevisionFits(row);
  const existing = await db
    .selectFrom('note_revisions')
    .select('id')
    .where('note_id', '=', id)
    .where('seq', '=', row.seq)
    .where('kind', '=', row.kind)
    .executeTakeFirst();
  if (existing !== undefined) return { id: existing.id, inserted: false };
  await db
    .insertInto('note_revisions')
    .values({
      note_id: id,
      seq: row.seq,
      kind: row.kind,
      label: row.label,
      markdown: row.markdown,
      content_hash: row.contentHash,
      size_chars: row.sizeChars,
      snapshot: row.snapshot === null ? null : Buffer.from(row.snapshot),
      snapshot_format: row.snapshot === null ? null : 2,
      yjs_major: row.snapshot === null ? null : YJS_MAJOR,
      snapshot_sv: row.snapshotSv === null ? null : Buffer.from(row.snapshotSv),
      actor_type: row.actor.actorType,
      actor_id: row.actor.userId === null ? null : idBytes(row.actor.userId),
      restored_from_revision_id: null,
      created_at: row.createdAt,
    })
    .onDuplicateKeyUpdate({ id: sql`id` })
    .execute();
  const written = await db
    .selectFrom('note_revisions')
    .select('id')
    .where('note_id', '=', id)
    .where('seq', '=', row.seq)
    .where('kind', '=', row.kind)
    .executeTakeFirstOrThrow();
  return { id: written.id, inserted: true };
}
