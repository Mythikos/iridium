/** Bounded retention operations. Each transaction retains the serving ownership fence. */
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { idFromBytes, LIMITS, NoteId, REVISION_RETENTION, Timestamp } from '@iridium/contracts';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { idBytes } from '../auth/ids.ts';
import { pruneUpdateLogBatch } from '../collab/persistence/prune.ts';
import type { Database } from '../db/schema.ts';
import { lockNoteParents } from '../notes/lock-parents.ts';
import { JobContinuation, type JobContext } from './scheduler.ts';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Policy bucket is UTC and independent of process time zone and daylight saving. */
export function revisionRetentionBucket(createdAt: Date, now: Date): string | null {
  const age = now.getTime() - createdAt.getTime();
  if (age < LIMITS.REVISION_KEEP_ALL_HOURS * HOUR_MS) return null;
  return age < LIMITS.REVISION_HOURLY_DAYS * DAY_MS
    ? `h:${Math.floor(createdAt.getTime() / HOUR_MS)}`
    : `d:${Math.floor(createdAt.getTime() / DAY_MS)}`;
}
const Hash = z.string().regex(/^[a-f\d]{64}$/);
const ThinningResume = z.strictObject({
  version: z.literal(1),
  note: NoteId,
  complete: z.boolean(),
  cutoff: Timestamp,
  afterTime: Timestamp.nullable(),
  afterId: z.int().positive().nullable(),
  bucket: z.string().nullable(),
  newerHash: Hash.nullable(),
  pending: z.strictObject({ id: z.int().positive(), hash: Hash }).nullable(),
  notes: z.int().nonnegative(),
  removed: z.int().nonnegative(),
  examined: z.int().nonnegative(),
});
/** Only checkpoint/unload participate; a durable constant-size cursor bounds each execution. */
export async function thinRevisions(
  db: Kysely<Database>,
  now: Date,
  context: JobContext,
): Promise<Record<string, unknown> | JobContinuation> {
  const resume =
    context.progress?.phase === 'revisions' && context.progress.cursor !== undefined
      ? ThinningResume.parse(JSON.parse(context.progress.cursor))
      : null;
  let noteCursor = resume === null ? null : idBytes(resume.note);
  let includeCursor = resume !== null && !resume.complete;
  const cutoff = resume === null ? now : new Date(resume.cutoff);
  let removed = resume?.removed ?? 0;
  let notes = resume?.notes ?? 0;
  let examined = resume?.examined ?? 0;
  let runRows = 0;
  let runNotes = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    let select = db
      .selectFrom('notes')
      .innerJoin('note_docs', 'note_docs.note_id', 'notes.node_id')
      .select(['notes.node_id', 'note_docs.head_seq'])
      .orderBy('notes.node_id')
      .limit(LIMITS.JOB_BATCH_SIZE);
    if (noteCursor !== null)
      select = select.where('node_id', includeCursor ? '>=' : '>', noteCursor);
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const page = await select.execute();
    if (page.length === 0) break;
    for (const note of page) {
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      await context.assertActive();
      runNotes += 1;
      const continuation =
        includeCursor && resume?.note === idFromBytes(note.node_id) ? resume : null;
      includeCursor = false;
      let lastTime = continuation?.afterTime == null ? null : new Date(continuation.afterTime);
      let lastId = continuation?.afterId ?? null;
      let previousBucket = continuation?.bucket ?? null;
      let newerHash: Buffer | null =
        continuation?.newerHash == null ? null : Buffer.from(continuation.newerHash, 'hex');
      let pending: { readonly id: number; readonly hash: Buffer } | null =
        continuation?.pending == null
          ? null
          : {
              id: continuation.pending.id,
              hash: Buffer.from(continuation.pending.hash, 'hex'),
            };
      const progress = (complete: boolean) => ({
        phase: 'revisions',
        done: examined,
        total: examined,
        cursor: JSON.stringify({
          version: 1,
          note: idFromBytes(note.node_id),
          complete,
          cutoff: cutoff.toISOString(),
          afterTime: complete ? null : (lastTime?.toISOString() ?? null),
          afterId: complete ? null : lastId,
          bucket: complete ? null : previousBucket,
          newerHash: complete ? null : (newerHash?.toString('hex') ?? null),
          pending:
            complete || pending === null
              ? null
              : { id: pending.id, hash: pending.hash.toString('hex') },
          notes,
          removed,
          examined,
        }),
      });
      let deletions: number[] = [];
      const flushDeletions = async (): Promise<void> => {
        if (deletions.length === 0) return;
        await context.assertActive();
        const ids = deletions;
        deletions = [];
        removed += await db.transaction().execute(async (trx) => {
          await context.ownerFence.assertCurrent(trx);
          await lockNoteParents(trx, note.node_id);
          const head = await trx
            .selectFrom('note_docs')
            .select('head_seq')
            .where('note_id', '=', note.node_id)
            .forUpdate()
            .executeTakeFirst();
          if (head === undefined) return 0;
          // Restore inserts take the same parent/head locks. Recheck the references and current
          // head here so a target selected after the scan cannot be removed by its pending batch.
          const references = await trx
            .selectFrom('note_revisions')
            .select('restored_from_revision_id')
            .where('restored_from_revision_id', 'in', ids)
            .distinct()
            .execute();
          const referenced = new Set(references.map((row) => row.restored_from_revision_id));
          const allowed = ids.filter((id) => !referenced.has(id));
          if (allowed.length === 0) return 0;
          const changed = await trx
            .deleteFrom('note_revisions')
            .where('note_id', '=', note.node_id)
            .where('id', 'in', allowed)
            .where('kind', 'in', ['checkpoint', 'unload'])
            .where('seq', '!=', head.head_seq)
            .executeTakeFirst();
          return Number(changed.numDeletedRows);
        });
      };
      for (;;) {
        let revisions = db
          .selectFrom('note_revisions')
          .select(['id', 'seq', 'created_at', 'kind', 'content_hash'])
          .where('note_id', '=', note.node_id)
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .limit(LIMITS.JOB_BATCH_SIZE);
        if (lastTime !== null && lastId !== null) {
          const at = lastTime;
          const id = lastId;
          revisions = revisions.where((eb) =>
            eb.or([
              eb('created_at', '<', at),
              eb.and([eb('created_at', '=', at), eb('id', '<', id)]),
            ]),
          );
        }
        // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
        const rows = await revisions.execute();
        if (rows.length === 0) break;
        // eslint-disable-next-line no-await-in-loop -- one bounded reference lookup protects the source page before classification
        const targets = await db
          .selectFrom('note_revisions')
          .select('restored_from_revision_id')
          .where(
            'restored_from_revision_id',
            'in',
            rows.map((row) => row.id),
          )
          .distinct()
          .execute();
        const restored = new Set(targets.map((row) => row.restored_from_revision_id));
        for (const row of rows) {
          const eligible = !REVISION_RETENTION.neverThinned.includes(row.kind);
          const bucket = revisionRetentionBucket(row.created_at, cutoff);
          const keep =
            !eligible ||
            bucket === null ||
            bucket !== previousBucket ||
            row.seq === note.head_seq ||
            restored.has(row.id);
          if (eligible) previousBucket = bucket;
          if (keep) {
            if (pending !== null && pending.hash.equals(row.content_hash))
              deletions.push(pending.id);
            pending = null;
            newerHash = row.content_hash;
          } else if (pending !== null && pending.hash.equals(row.content_hash)) {
            deletions.push(row.id);
          } else {
            // At most the newest row of one equal-hash run is pending. A different older state
            // proves that pending state differs from both retained neighbours and must survive.
            if (pending !== null) newerHash = pending.hash;
            pending = null;
            if (newerHash?.equals(row.content_hash) === true) deletions.push(row.id);
            else pending = { id: row.id, hash: row.content_hash };
          }
          lastTime = row.created_at;
          lastId = row.id;
          examined += 1;
          runRows += 1;
          if (deletions.length >= LIMITS.JOB_BATCH_SIZE)
            // eslint-disable-next-line no-await-in-loop -- commit a bounded deletion batch before retaining more candidate IDs
            await flushDeletions();
          if (runRows >= LIMITS.REVISION_THINNING_ROWS_PER_RUN) {
            // eslint-disable-next-line no-await-in-loop -- persist all classified deletions before yielding their cursor
            await flushDeletions();
            return new JobContinuation(progress(false));
          }
        }
      }
      // eslint-disable-next-line no-await-in-loop -- finish this note before persisting its resume cursor
      await flushDeletions();
      notes += 1;
      noteCursor = note.node_id;
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      await context.checkpoint(progress(true));
      if (runNotes >= LIMITS.REVISION_THINNING_ROWS_PER_RUN)
        return new JobContinuation(progress(true));
    }
  }
  return { removed, notes };
}
/** Existing snapshot coverage predicate is reused, one transaction/batch at a time. */
export async function pruneUpdates(
  db: Kysely<Database>,
  now: Date,
  retentionDays: number,
  context: JobContext,
): Promise<Record<string, unknown>> {
  let removed = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const count = await db.transaction().execute(async (trx) => {
      await context.ownerFence.assertCurrent(trx);
      return pruneUpdateLogBatch({
        db: trx,
        now,
        retentionDays,
        batchSize: LIMITS.JOB_BATCH_SIZE,
      });
    });
    removed += count;
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.checkpoint({ phase: 'updates', done: removed, total: removed });
    if (count < LIMITS.JOB_BATCH_SIZE) return { removed };
  }
}
/** M2 owns sessions and setup links; OAuth housekeeping arrives with its M3 producers. */
export async function sweepCredentials(
  db: Kysely<Database>,
  now: Date,
  context: JobContext,
  sweepTickets: () => void,
): Promise<Record<string, unknown>> {
  const before = new Date(now.getTime() - LIMITS.SESSION_ROW_RETENTION_DAYS * DAY_MS);
  let sessions = 0;
  let links = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const removed = await db.transaction().execute(async (trx) => {
      await context.ownerFence.assertCurrent(trx);
      const row = await trx
        .deleteFrom('sessions')
        .where((eb) =>
          eb.or([eb('absolute_expires_at', '<', before), eb('revoked_at', '<', before)]),
        )
        .orderBy('id')
        .limit(LIMITS.JOB_BATCH_SIZE)
        .executeTakeFirst();
      return Number(row.numDeletedRows);
    });
    sessions += removed;
    if (removed < LIMITS.JOB_BATCH_SIZE) break;
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.checkpoint({ phase: 'sessions', done: sessions, total: sessions });
  }
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const removed = await db.transaction().execute(async (trx) => {
      await context.ownerFence.assertCurrent(trx);
      const row = await trx
        .deleteFrom('password_setup_tokens')
        .where((eb) => eb.or([eb('expires_at', '<', before), eb('consumed_at', '<', before)]))
        .orderBy('id')
        .limit(LIMITS.JOB_BATCH_SIZE)
        .executeTakeFirst();
      return Number(row.numDeletedRows);
    });
    links += removed;
    if (removed < LIMITS.JOB_BATCH_SIZE) break;
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.checkpoint({ phase: 'setup_links', done: links, total: links });
  }
  sweepTickets();
  await context.checkpoint({ phase: 'complete', done: sessions + links, total: sessions + links });
  return { sessions, links };
}
class ManagedPathRefused extends Error {
  constructor() {
    super('A maintenance artifact path escaped its configured volume or traversed a symlink.');
    this.name = 'ManagedPathRefused';
  }
}
/** Validate every ancestor and final real path before removing an artifact. Never follow symlinks. */
export async function removeManagedPath(
  root: string,
  key: string,
  recursive: boolean,
): Promise<boolean> {
  const base = resolve(root);
  const target = isAbsolute(key) ? resolve(key) : resolve(base, key);
  const child = relative(base, target);
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new ManagedPathRefused();
  let current = base;
  try {
    const rootStat = await lstat(base);
    if (rootStat.isSymbolicLink()) throw new ManagedPathRefused();
    for (const part of child.split(sep)) {
      current = join(current, part);
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new ManagedPathRefused();
    }
    const [realBase, realTarget] = await Promise.all([realpath(base), realpath(target)]);
    const verified = relative(realBase, realTarget);
    if (
      verified === '' ||
      verified === '..' ||
      verified.startsWith(`..${sep}`) ||
      isAbsolute(verified)
    )
      throw new ManagedPathRefused();
    await rm(target, { recursive, force: true });
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
export interface TransferRetentionPaths {
  readonly staging: string;
  readonly exports: string;
  readonly attachmentTemporary: string;
}
/** Expired transfer artifacts and terminal operational rows; immutable attachment objects are untouched. */
export async function cleanTransfers(
  db: Kysely<Database>,
  now: Date,
  paths: TransferRetentionPaths,
  context: JobContext,
): Promise<Record<string, unknown>> {
  let artifacts = 0;
  let jobs = 0;
  let imports = 0;
  let cursor: Buffer | null = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    let query = db
      .selectFrom('import_jobs')
      .select(['job_id', 'staging_key'])
      .where('expires_at', '<', now)
      .where('phase', '!=', 'committing')
      .orderBy('job_id')
      .limit(LIMITS.JOB_BATCH_SIZE);
    if (cursor !== null) query = query.where('job_id', '>', cursor);
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const page = await query.execute();
    if (page.length === 0) break;
    for (const row of page) {
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      await context.assertActive();
      const expected = resolve(paths.staging, idFromBytes(row.job_id));
      const actual = isAbsolute(row.staging_key)
        ? resolve(row.staging_key)
        : resolve(paths.staging, row.staging_key);
      if (actual !== expected) throw new ManagedPathRefused();
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      if (await removeManagedPath(paths.staging, actual, true)) imports += 1;
      cursor = row.job_id;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.checkpoint({ phase: 'imports', done: imports, total: imports });
  }
  cursor = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    let query = db
      .selectFrom('export_jobs')
      .select(['job_id', 'artifact_key'])
      .where('expires_at', '<', now)
      .where('artifact_key', 'is not', null)
      .orderBy('job_id')
      .limit(LIMITS.JOB_BATCH_SIZE);
    if (cursor !== null) query = query.where('job_id', '>', cursor);
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const page = await query.execute();
    if (page.length === 0) break;
    for (const row of page) {
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      await context.assertActive();
      const key = row.artifact_key;
      if (key !== null) {
        // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
        if (await removeManagedPath(paths.exports, key, false)) artifacts += 1;
        // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
        await db.transaction().execute(async (trx) => {
          await context.ownerFence.assertCurrent(trx);
          await trx
            .updateTable('export_jobs')
            .set({ artifact_key: null })
            .where('job_id', '=', row.job_id)
            .where('artifact_key', '=', key)
            .where('expires_at', '<', now)
            .execute();
        });
      }
      cursor = row.job_id;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.checkpoint({ phase: 'exports', done: artifacts, total: artifacts });
  }
  const before = new Date(now.getTime() - LIMITS.JOB_RETENTION_DAYS * DAY_MS);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.assertActive();
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    const count = await db.transaction().execute(async (trx) => {
      await context.ownerFence.assertCurrent(trx);
      const rows = await trx
        .selectFrom('jobs')
        .select('id')
        .where('status', 'in', ['succeeded', 'failed', 'cancelled'])
        .where('finished_at', '<', before)
        .orderBy('id')
        .limit(LIMITS.JOB_BATCH_SIZE)
        .forUpdate()
        .execute();
      if (rows.length === 0) return 0;
      const ids = rows.map((row) => row.id);
      await trx.deleteFrom('import_jobs').where('job_id', 'in', ids).execute();
      await trx.deleteFrom('export_jobs').where('job_id', 'in', ids).execute();
      const result = await trx.deleteFrom('jobs').where('id', 'in', ids).executeTakeFirst();
      return Number(result.numDeletedRows);
    });
    jobs += count;
    if (count < LIMITS.JOB_BATCH_SIZE) break;
    // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
    await context.checkpoint({ phase: 'jobs', done: jobs, total: jobs });
  }
  let temporary = 0;
  try {
    for (const entry of await readdir(paths.attachmentTemporary, { withFileTypes: true })) {
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      await context.assertActive();
      if (!entry.isFile()) continue;
      const path = join(paths.attachmentTemporary, entry.name);
      // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
      const info = await lstat(path);
      if (
        info.mtimeMs < now.getTime() - LIMITS.ATTACHMENT_TEMP_RETENTION_MS &&
        // eslint-disable-next-line no-await-in-loop -- bounded retention units recheck ownership and commit before advancing the cursor
        (await removeManagedPath(paths.attachmentTemporary, entry.name, false))
      )
        temporary += 1;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await context.checkpoint({
    phase: 'complete',
    done: imports + artifacts + jobs + temporary,
    total: imports + artifacts + jobs + temporary,
  });
  return { imports, artifacts, jobs, temporary };
}
