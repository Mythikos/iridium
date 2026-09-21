/** Verified export-before-archive with one pinned migrator connection and reset-on-release. */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress } from 'node:zlib';

import { idFromBytes, LIMITS, newId } from '@iridium/contracts';
import { Kysely, MysqlDialect, sql, type MysqlPoolConnection, type Selectable } from 'kysely';
import type { Pool, PoolConnection } from 'mysql2';

import { listChainIds, verifyChain, type AuditKeys } from '../audit/chain.ts';
import type { AuditRecorder } from '../auth/audit.ts';
import type { AuditEventsTable, Database } from '../db/schema.ts';
import type { JobContext } from './scheduler.ts';

type AuditRow = Selectable<AuditEventsTable>;
/** The export preserves every column; hashes are hex and binary identities are canonical UUIDs. */
export function auditExportRow(row: AuditRow): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date
        ? value.toISOString().replace(/(\.\d{3})Z$/, '$1000Z')
        : Buffer.isBuffer(value)
          ? value.length === 16
            ? idFromBytes(value)
            : value.toString('hex')
          : value,
    ]),
  );
}
class AuditArchiveVerificationFailed extends Error {
  readonly exitCode = 5;
  constructor(chain: string) {
    super(`Audit chain ${chain} did not verify; archive refused.`);
    this.name = 'AuditArchiveVerificationFailed';
  }
}
class AuditArchiveCopyFailed extends Error {
  constructor() {
    super('The archived rows do not match their source hashes; deletion refused.');
    this.name = 'AuditArchiveCopyFailed';
  }
}

/** The adapter never releases a connection behind the session flag owner's back. */
export async function withArchiveConnection<T>(
  pool: Pool,
  work: (db: Kysely<Database>) => Promise<T>,
): Promise<T> {
  const connection = await new Promise<PoolConnection>((resolve, reject) => {
    pool.getConnection((error, value) => {
      if (error !== null) reject(error);
      else resolve(value);
    });
  });
  const pinned: MysqlPoolConnection = {
    config: connection.config,
    connect: connection.connect.bind(connection),
    destroy: connection.destroy.bind(connection),
    query: connection.query.bind(connection),
    threadId: connection.threadId,
    release: () => undefined,
  };
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({
      pool: {
        getConnection: (callback) => callback(null, pinned),
        end: (callback) => callback(null),
      },
    }),
  });
  let safeToRelease = false;
  try {
    await sql`SET @iridium_audit_archive = 1`.execute(db);
    return await work(db);
  } finally {
    try {
      await sql`SET @iridium_audit_archive = 0`.execute(db);
      safeToRelease = true;
    } finally {
      await db.destroy();
      if (safeToRelease) connection.release();
      else connection.destroy();
    }
  }
}

async function exportPrefix(
  db: Kysely<Database>,
  chain: string,
  from: number,
  to: number,
  directory: string,
  context: JobContext,
): Promise<{ path: string; sha256: string; rows: number }> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `audit-${chain.replace(':', '-')}-${String(from)}-${String(to)}.jsonl.zst`,
  );
  const temporary = `${path}.${newId()}.tmp`;
  let rows = 0;
  async function* source(): AsyncGenerator<string> {
    let after = from - 1;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
      await context.assertActive();
      // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
      const page = await db
        .selectFrom('audit_events')
        .selectAll()
        .where('chain_id', '=', chain)
        .where('id', '>', after)
        .where('id', '<=', to)
        .orderBy('id')
        .limit(LIMITS.JOB_ARCHIVE_BATCH_SIZE)
        .execute();
      if (page.length === 0) return;
      for (const row of page) {
        rows += 1;
        after = row.id;
        yield `${JSON.stringify(auditExportRow(row))}\n`;
      }
    }
  }
  const hash = createHash('sha256');
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.from(source()),
      createZstdCompress(),
      hashing,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    );
    const handle = await open(temporary, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = hash.digest('hex');
    await rename(temporary, path);
    await writeFile(`${path}.sha256`, `${sha256}  ${path.split(/[\\/]/).at(-1) ?? ''}\n`, {
      mode: 0o600,
    });
    const checksum = await open(`${path}.sha256`, 'r+');
    try {
      await checksum.sync();
    } finally {
      await checksum.close();
    }
    // Windows does not support opening directories for fsync; POSIX must persist both renames.
    if (process.platform !== 'win32') {
      const folder = await open(directory, 'r');
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
    }
    return { path, sha256, rows };
  } finally {
    await rm(temporary, { force: true });
  }
}
export interface AuditArchiveDeps {
  readonly db: Kysely<Database> | null;
  readonly pool: Pool | null;
  readonly keys: AuditKeys;
  readonly audit: AuditRecorder;
  readonly directory: string;
  readonly now: Date;
  readonly retentionDays: number;
}
/** No credential means an observable skipped result; no trigger is ever dropped or disabled. */
export async function archiveAudit(
  deps: AuditArchiveDeps,
  context: JobContext,
): Promise<Record<string, unknown>> {
  if (deps.db === null || deps.pool === null)
    return { status: 'skipped_no_ddl_credential', rows: 0 };
  const override =
    typeof context.payload['olderThanDays'] === 'number'
      ? context.payload['olderThanDays']
      : deps.retentionDays;
  const requested =
    typeof context.payload['beforeDate'] === 'string'
      ? Date.parse(context.payload['beforeDate'])
      : Infinity;
  const cutoff = new Date(
    Math.min(deps.now.getTime() - Math.max(deps.retentionDays, override) * 86_400_000, requested),
  );
  let removed = 0;
  const exports: Record<string, unknown>[] = [];
  for (const chain of await listChainIds(deps.db)) {
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    await context.assertActive();
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    const firstRecent = await deps.db
      .selectFrom('audit_events')
      .select('id')
      .where('chain_id', '=', chain)
      .where('occurred_at', '>=', cutoff)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    let eligible = deps.db
      .selectFrom('audit_events')
      .select(['id'])
      .where('chain_id', '=', chain)
      .where('occurred_at', '<', cutoff);
    if (firstRecent !== undefined) eligible = eligible.where('id', '<', firstRecent.id);
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    const first = await eligible.orderBy('id').limit(1).executeTakeFirst();
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    const last = await eligible.orderBy('id', 'desc').limit(1).executeTakeFirst();
    if (first === undefined || last === undefined) continue;
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    const verified = await deps.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((trx) => verifyChain(trx, chain, deps.keys));
    if (!verified.ok) throw new AuditArchiveVerificationFailed(chain);
    if (context.payload['dryRun'] === true) {
      // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
      const count = await eligible
        .clearSelect()
        .select((eb) => eb.fn.countAll<number | string>().as('rows'))
        .executeTakeFirstOrThrow();
      exports.push({ chain, from: first.id, to: last.id, rows: Number(count.rows), dryRun: true });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    const artifact = await exportPrefix(deps.db, chain, first.id, last.id, deps.directory, context);
    exports.push({ chain, from: first.id, to: last.id, ...artifact });
    // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
    await withArchiveConnection(deps.pool, async (db) => {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
        await context.assertActive();
        // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
        const moved = await db.transaction().execute(async (trx) => {
          await context.ownerFence.assertCurrent(trx);
          const rows = await trx
            .selectFrom('audit_events')
            .selectAll()
            .where('chain_id', '=', chain)
            .where('id', '>=', first.id)
            .where('id', '<=', last.id)
            .orderBy('id')
            .limit(LIMITS.JOB_ARCHIVE_BATCH_SIZE)
            .forUpdate()
            .execute();
          if (rows.length === 0) return 0;
          const ids = rows.map((row) => row.id);
          const columns = Object.keys(rows[0] ?? {});
          if (columns.length === 0) return 0;
          // Explicit source columns preserve original global ids. The metadata table shares the exact
          // migration schema; using identifiers here avoids an implicit auto-increment insertion.
          await sql`INSERT INTO audit_events_archive (${sql.join(columns.map((name) => sql.id(name)))}) SELECT ${sql.join(columns.map((name) => sql.id(name)))} FROM audit_events WHERE id IN (${sql.join(ids)})`.execute(
            trx,
          );
          const copied = await trx
            .selectFrom('audit_events_archive')
            .select(['id', 'hash', 'prev_hash'])
            .where('id', 'in', ids)
            .orderBy('id')
            .execute();
          if (
            copied.length !== rows.length ||
            copied.some(
              (row, index) =>
                row.id !== rows[index]?.id ||
                !row.hash.equals(rows[index]?.hash ?? Buffer.alloc(0)) ||
                !row.prev_hash.equals(rows[index]?.prev_hash ?? Buffer.alloc(0)),
            )
          )
            throw new AuditArchiveCopyFailed();
          const deleted = await trx
            .deleteFrom('audit_events')
            .where('id', 'in', ids)
            .executeTakeFirst();
          await deps.audit.record(trx, {
            action: 'system.audit.archived',
            actorType: 'system',
            credentialType: 'none',
            outcome: 'success',
            context: { client: 'maintenance' },
            metadata: {
              chain_id: chain,
              from_id: rows[0]?.id,
              to_id: rows.at(-1)?.id,
              rows: Number(deleted.numDeletedRows),
              export_path: artifact.path,
              export_sha256: artifact.sha256,
              job_id: context.jobId,
            },
          });
          return Number(deleted.numDeletedRows);
        });
        removed += moved;
        // eslint-disable-next-line no-await-in-loop -- bounded export and archive batches preserve their ordered cursor and commit boundary
        await context.checkpoint({
          phase: 'archive',
          done: removed,
          total: removed,
          cursor: chain,
        });
        if (moved < LIMITS.JOB_ARCHIVE_BATCH_SIZE) break;
      }
    });
  }
  return { rows: removed, exports, dryRun: context.payload['dryRun'] === true };
}
