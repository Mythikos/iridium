/** Resumable rebuilds from durable source, without loading or changing an editing document. */
import { idFromBytes, LIMITS, NoteId, type JobProgress } from '@iridium/contracts';
import { PIPELINE_VERSION } from '@iridium/markdown';
import { sql, type Kysely } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Database } from '../db/schema.ts';
import { captureStoredState } from '../notes/committed-state.ts';
import { lockNoteParents } from '../notes/lock-parents.ts';
import type { Clock } from '../ops/clock.ts';
import type { ServerLogger } from '../ops/logging.ts';
import type { SearchIndexWrites } from '../search/index.ts';
import { lockProjectionVault } from './lock-vault.ts';
import type { PrepareProjection } from './prepare.ts';
import { upsertProjection } from './write.ts';

/** The validated job payload also serves the CLI's explicit selection. */
export interface ReindexSelection {
  readonly vaultId?: string | undefined;
  readonly stale?: boolean | undefined;
  readonly pipelineVersion?: boolean | undefined;
  readonly noteIds?: readonly string[] | undefined;
  readonly mode?: 'all' | 'stale' | 'pipeline-version' | undefined;
  readonly fromNoteId?: string | undefined;
}

/** The scheduler owns cancellation, the durable cursor and the captured process fence. */
export interface ReindexContext {
  readonly ownerFence: OwnerFence;
  readonly progress: JobProgress | null;
  checkpoint(progress: JobProgress): Promise<void>;
  assertActive(): Promise<void>;
}

/** A process-owned worker adapter with no document or socket lifetime of its own. */
export interface ReindexDependencies {
  readonly logger?: Pick<ServerLogger, 'warn'>;
  readonly searchIndex: SearchIndexWrites;
  readonly database: () => Kysely<Database>;
  readonly prepare: PrepareProjection;
  readonly clock: Clock;
  readonly ratePerSecond: number;
  /** Commit the loaded writer's accepted prefix before reading durable source; unloaded is a no-op. */
  readonly drainAccepted: (noteId: NoteId) => Promise<void>;
  readonly projected: (noteId: NoteId, revision: number) => void;
}

/** Selection and persistence are shared by timer, administrator and CLI entry points. */
export class ReindexService {
  readonly #deps: ReindexDependencies;
  constructor(deps: ReindexDependencies) {
    this.#deps = deps;
  }

  #selection(selection: ReindexSelection, database: Kysely<Database> = this.#deps.database()) {
    let query = database
      .selectFrom('nodes as n')
      .innerJoin('vaults as v', 'v.id', 'n.vault_id')
      .innerJoin('notes as t', 't.node_id', 'n.id')
      .innerJoin('note_docs as d', 'd.note_id', 'n.id')
      .leftJoin('note_projections as p', 'p.note_id', 'n.id')
      .where('n.kind', '=', 'note')
      .where('n.deleted_at', 'is', null)
      .where('v.status', 'in', ['active', 'archived'])
      .where('t.initialized_at', 'is not', null)
      .where('t.content_invalid', '=', false)
      .where((eb) => eb.or([eb('p.status', 'is', null), eb('p.status', '!=', 'invalid_content')]));
    if (selection.vaultId !== undefined)
      query = query.where('n.vault_id', '=', idBytes(selection.vaultId));
    if (selection.noteIds !== undefined)
      query = query.where('n.id', 'in', selection.noteIds.map(idBytes));
    const mode =
      selection.mode ??
      (selection.pipelineVersion
        ? 'pipeline-version'
        : selection.stale
          ? 'stale'
          : selection.vaultId !== undefined || selection.noteIds !== undefined
            ? 'all'
            : 'stale');
    if (mode === 'stale')
      query = query.where((eb) =>
        eb.or([
          eb('p.note_id', 'is', null),
          eb('d.projected_seq', '<', eb.ref('d.head_seq')),
          eb('p.status', 'in', ['pending', 'timeout', 'error']),
        ]),
      );
    if (mode === 'pipeline-version')
      query = query.where((eb) =>
        eb.or([
          eb('p.note_id', 'is', null),
          eb('p.pipeline_version', '<', PIPELINE_VERSION),
          eb('p.status', 'in', ['pending', 'timeout', 'error']),
        ]),
      );
    return query;
  }

  /** Walk a bounded id keyset; a crash resumes after the last committed unit. */
  async run(
    selection: ReindexSelection,
    context: ReindexContext,
  ): Promise<Record<string, unknown>> {
    let cursor = context.progress?.cursor ?? selection.fromNoteId;
    let done = context.progress?.done ?? 0;
    let rebuilt = 0;
    let skipped = 0;
    let remainingSelection = this.#selection(selection);
    if (cursor !== undefined)
      remainingSelection = remainingSelection.where('n.id', '>', idBytes(cursor));
    const remaining = await remainingSelection
      .select((eb) => eb.fn.countAll<number | string>().as('count'))
      .executeTakeFirstOrThrow();
    const total = Math.max(context.progress?.total ?? 0, done + Number(remaining.count));
    let nextStart = this.#deps.clock.monotonic();
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- cancellation and claim ownership gate every page
      await context.assertActive();
      let page = this.#selection(selection)
        .select('n.id')
        .orderBy('n.id')
        .limit(LIMITS.JOB_BATCH_SIZE);
      if (cursor !== undefined) page = page.where('n.id', '>', idBytes(cursor));
      // eslint-disable-next-line no-await-in-loop -- each SQL keyset depends on the prior durable cursor
      const rows = await page.execute();
      if (rows.length === 0) break;
      for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop -- the rate budget bounds actual worker admission
        await this.#waitUntil(nextStart);
        // eslint-disable-next-line no-await-in-loop -- each bounded unit cooperates with cancellation
        await context.assertActive();
        const noteId = NoteId.parse(idFromBytes(row.id));
        // eslint-disable-next-line no-await-in-loop -- projections are throttled and checkpointed individually
        const result = await this.#rebuild(noteId, context.ownerFence);
        if (result === 'rebuilt') rebuilt += 1;
        else skipped += 1;
        done += 1;
        cursor = noteId;
        // eslint-disable-next-line no-await-in-loop -- durable progress must follow the projection commit
        await context.checkpoint({ phase: 'reindex', done, total: Math.max(total, done), cursor });
        nextStart = this.#deps.clock.monotonic() + 1000 / this.#deps.ratePerSecond;
      }
    }
    if (
      (selection.pipelineVersion === true || selection.mode === 'pipeline-version') &&
      selection.vaultId === undefined &&
      selection.noteIds === undefined
    ) {
      // eslint-disable-next-line no-await-in-loop -- one final marker follows the complete walk
      await this.#deps
        .database()
        .transaction()
        .execute(async (trx) => {
          await context.ownerFence.assertCurrent(trx);
          // A suffix resume, concurrent edit or skipped preparation is not a global upgrade.
          // Re-read the full eligible set, independent of the job cursor, before advancing the marker.
          const outstanding = await this.#selection({ mode: 'pipeline-version' }, trx)
            .select('n.id')
            .limit(1)
            .executeTakeFirst();
          if (outstanding !== undefined) return;
          await trx
            .updateTable('schema_meta')
            .set({ value: String(PIPELINE_VERSION) })
            .where('key', '=', 'pipeline_version')
            .where(sql<boolean>`CAST(value AS UNSIGNED) < ${PIPELINE_VERSION}`)
            .execute();
        });
    }
    return { rebuilt, skipped, processed: done, pipelineVersion: PIPELINE_VERSION };
  }

  async #waitUntil(target: number): Promise<void> {
    const remaining = target - this.#deps.clock.monotonic();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => {
      this.#deps.clock.after(remaining, resolve);
    });
  }

  async #rebuild(noteId: NoteId, fence: OwnerFence): Promise<'rebuilt' | 'skipped'> {
    await this.#deps.drainAccepted(noteId);
    const db = this.#deps.database();
    const id = idBytes(noteId);
    const source = await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const row = await trx
          .selectFrom('note_docs as d')
          .innerJoin('nodes as n', 'n.id', 'd.note_id')
          .innerJoin('notes as t', 't.node_id', 'd.note_id')
          .leftJoin('note_projections as p', 'p.note_id', 'd.note_id')
          .select([
            'd.head_seq',
            'p.revision',
            'p.markdown',
            'p.content_hash',
            't.content_invalid',
            'n.deleted_at',
            'n.vault_id',
          ])
          .where('d.note_id', '=', id)
          .executeTakeFirst();
        if (row === undefined || row.deleted_at !== null || row.content_invalid) return null;
        if (row.revision === row.head_seq && row.markdown !== null && row.content_hash !== null) {
          return {
            vaultId: row.vault_id,
            revision: row.head_seq,
            markdown: row.markdown,
            contentHash: row.content_hash,
          };
        }
        const captured = await captureStoredState(trx, noteId, false);
        if (!captured.scan.ok) return null;
        return {
          vaultId: row.vault_id,
          revision: captured.throughSeq,
          markdown: captured.markdown,
          contentHash: captured.contentHash,
        };
      });
    if (source === null) return 'skipped';
    const prepared = await this.#deps.prepare(source.markdown);
    const now = this.#deps.clock.date();
    const written = await db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await fence.assertCurrent(trx);
        await lockProjectionVault(trx, source.vaultId);
        const parents = await lockNoteParents(trx, id);
        if (parents === null || parents.deletedAt !== null) return false;
        const head = await trx
          .selectFrom('note_docs')
          .select('head_seq')
          .where('note_id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (head === undefined || head.head_seq < source.revision) return false;
        const live = await trx
          .selectFrom('nodes as n')
          .innerJoin('notes as t', 't.node_id', 'n.id')
          .select(['n.deleted_at', 't.content_invalid'])
          .where('n.id', '=', id)
          .executeTakeFirst();
        if (live === undefined || live.deleted_at !== null || live.content_invalid) return false;
        const previous = await trx
          .selectFrom('note_projections')
          .select(['revision', 'pipeline_version'])
          .where('note_id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (
          previous !== undefined &&
          (previous.revision > source.revision || previous.pipeline_version > PIPELINE_VERSION)
        )
          return false;
        await upsertProjection(
          trx,
          {
            noteId: id,
            logger: this.#deps.logger,
            ...source,
            pipelineVersion: PIPELINE_VERSION,
            now,
            strict: false,
            prepared,
          },
          this.#deps.searchIndex,
        );
        await trx
          .updateTable('note_docs')
          .set({ projected_seq: source.revision, updated_at: now })
          .where('note_id', '=', id)
          .where('projected_seq', '<', source.revision)
          .execute();
        return true;
      });
    if (written) this.#deps.projected(noteId, source.revision);
    return written ? 'rebuilt' : 'skipped';
  }
}
