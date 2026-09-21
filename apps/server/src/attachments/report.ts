/** Durable unreferenced-report generation and the administrator's last-completed-report view. */
import {
  idFromBytes,
  LIMITS,
  UnreferencedAttachmentPage,
  type UnreferencedAttachment,
  type UnreferencedAttachmentsQuery,
} from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { cursorInvalid, type CursorCodec } from '../mcp/cursor.ts';
import type { Clock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';
import type { AttachmentScanHit, AttachmentScanTask } from './reference-scan.worker.ts';
import { attachmentDto, attachmentRows, type AttachmentRow } from './service.ts';
import type { StorageDriver, StoredObject } from './storage.ts';

/** The report stores both REST candidates and the non-destructive orphan inventory (08 §9.6). */
export interface AttachmentReport {
  readonly items: readonly UnreferencedAttachment[];
  readonly scannedAt: string;
  readonly scannedRevisions: number;
  readonly orphanBlobs: readonly StoredObject[];
  readonly totals: {
    readonly rows: number;
    readonly bytes: number;
    readonly orphanBlobs: number;
    readonly orphanBytes: number;
  };
}

/** Database reads feed bounded tasks to the same pool that owns Markdown projection. */
export interface AttachmentReportDeps {
  readonly database: () => Kysely<Database>;
  readonly clock: Clock;
  readonly storage: StorageDriver;
  readonly scan: (task: AttachmentScanTask) => Promise<readonly AttachmentScanHit[]>;
}

async function scanRetainedSources(
  trx: Transaction<Database>,
  vaultId: Buffer,
  candidates: readonly AttachmentRow[],
  scan: AttachmentReportDeps['scan'],
): Promise<{ readonly referenced: ReadonlySet<string>; readonly scannedRevisions: number }> {
  const input = candidates.map((row) => ({
    id: idFromBytes(row.id),
    pathHint: attachmentDto(row).pathHint,
  }));
  const referenced = new Set<string>();
  let scannedRevisions = 0;
  let afterRevision = 0;
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- retained revisions are keyset-paged and each worker task is bounded
    const page = await trx
      .selectFrom('note_revisions as revision')
      .innerJoin('notes as note', 'note.node_id', 'revision.note_id')
      .select(['revision.id', 'revision.markdown'])
      .where('note.vault_id', '=', vaultId)
      .where('revision.id', '>', afterRevision)
      .orderBy('revision.id')
      .limit(LIMITS.ATTACHMENT_SCAN_BATCH)
      .execute();
    if (page.length === 0) break;
    scannedRevisions += page.length;
    // eslint-disable-next-line no-await-in-loop -- worker completion bounds live source memory
    const hits = await scan({
      candidates: input,
      sources: page.map((row) => ({ markdown: row.markdown, revision: row.id })),
    });
    for (const hit of hits) referenced.add(hit.id);
    afterRevision = page.at(-1)?.id ?? afterRevision;
  }
  let afterNote: Buffer | null = null;
  while (true) {
    let query = trx
      .selectFrom('note_projections as projection')
      .innerJoin('notes as note', 'note.node_id', 'projection.note_id')
      .select(['projection.note_id', 'projection.markdown'])
      .where('note.vault_id', '=', vaultId);
    if (afterNote !== null) query = query.where('projection.note_id', '>', afterNote);
    // eslint-disable-next-line no-await-in-loop -- keyset source pages are processed one at a time
    const page = await query
      .orderBy('projection.note_id')
      .limit(LIMITS.ATTACHMENT_SCAN_BATCH)
      .execute();
    if (page.length === 0) break;
    // eslint-disable-next-line no-await-in-loop -- the next page is not retained while this task scans
    const hits = await scan({
      candidates: input,
      sources: page.map((row) => ({ markdown: row.markdown, revision: null })),
    });
    for (const hit of hits) referenced.add(hit.id);
    afterNote = page.at(-1)?.note_id ?? afterNote;
  }
  return { referenced, scannedRevisions };
}

async function* reportVaults(db: Kysely<Database>, vaultId?: string): AsyncGenerator<Buffer> {
  let after: Buffer | null = null;
  for (;;) {
    let query = db
      .selectFrom('vaults')
      .select('id')
      .orderBy('id')
      .limit(LIMITS.ATTACHMENT_SCAN_BATCH);
    if (vaultId !== undefined) query = query.where('id', '=', idBytes(vaultId));
    if (after !== null) query = query.where('id', '>', after);
    // eslint-disable-next-line no-await-in-loop -- the next vault page follows the completed keyset
    const page = await query.execute();
    if (page.length === 0) {
      if (vaultId !== undefined && after === null) throw new ProblemError('not_found');
      return;
    }
    for (const vault of page) yield vault.id;
    after = page.at(-1)?.id ?? after;
  }
}

/** Generates a report only; removal requires an independent explicit purge with fresh checks. */
export async function generateAttachmentReport(
  deps: AttachmentReportDeps,
  vaultId?: string,
): Promise<AttachmentReport> {
  const db = deps.database();
  const items: UnreferencedAttachment[] = [];
  let scannedRevisions = 0;
  for await (const vault of reportVaults(db, vaultId)) {
    // eslint-disable-next-line no-await-in-loop -- keep one consistent vault snapshot and bounded worker source set
    const result = await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const references = trx
          .selectFrom('note_links as link')
          .innerJoin('nodes as note', 'note.id', 'link.from_note_id')
          .select('link.resolved_attachment_id')
          .where('link.vault_id', '=', vault)
          .where('note.vault_id', '=', vault)
          .where('note.deleted_at', 'is', null)
          .where('link.resolved_attachment_id', 'is not', null);
        let afterId: Buffer | null = null;
        let revisions = 0;
        const unreferenced: UnreferencedAttachment[] = [];
        while (true) {
          let query = attachmentRows(trx)
            .where('attachments.vault_id', '=', vault)
            .where('attachments.id', 'not in', references);
          if (afterId !== null) query = query.where('attachments.id', '>', afterId);
          // eslint-disable-next-line no-await-in-loop -- attachment pages feed bounded retained-source scans
          const page = await query
            .orderBy('attachments.id')
            .limit(LIMITS.ATTACHMENT_SCAN_BATCH)
            .execute();
          if (page.length === 0) break;
          // eslint-disable-next-line no-await-in-loop -- report pages share the transaction's consistent snapshot
          const scanned = await scanRetainedSources(trx, vault, page, deps.scan);
          revisions = Math.max(revisions, scanned.scannedRevisions);
          for (const row of page)
            if (!scanned.referenced.has(idFromBytes(row.id)))
              unreferenced.push({ ...attachmentDto(row), lastReferencedRevision: null });
          afterId = page.at(-1)?.id ?? afterId;
        }
        return { items: unreferenced, revisions };
      });
    items.push(...result.items);
    scannedRevisions += result.revisions;
  }
  const orphanBlobs: StoredObject[] = [];
  let objectPage: StoredObject[] = [];
  const classifyPage = async (): Promise<void> => {
    if (objectPage.length === 0) return;
    const known = await db
      .selectFrom('attachments')
      .select('storage_key')
      .where(
        'storage_key',
        'in',
        objectPage.map((object) => object.key),
      )
      .execute();
    const keys = new Set(known.map((row) => row.storage_key));
    orphanBlobs.push(...objectPage.filter((object) => !keys.has(object.key)));
    objectPage = [];
  };
  for await (const object of deps.storage.list(vaultId)) {
    objectPage.push(object);
    if (objectPage.length >= LIMITS.ATTACHMENT_SCAN_BATCH) await classifyPage();
  }
  await classifyPage();
  return {
    items,
    scannedAt: deps.clock.date().toISOString(),
    scannedRevisions,
    orphanBlobs,
    totals: {
      rows: items.length,
      bytes: items.reduce((total, row) => total + row.sizeBytes, 0),
      orphanBlobs: orphanBlobs.length,
      orphanBytes: orphanBlobs.reduce((total, row) => total + row.sizeBytes, 0),
    },
  };
}

/** Reads only a terminal job's immutable result, binding each cursor to that specific report. */
export async function readAttachmentReport(
  db: Kysely<Database>,
  query: UnreferencedAttachmentsQuery,
  codec: CursorCodec,
  principalKey: string,
): Promise<UnreferencedAttachmentPage> {
  let listing = db
    .selectFrom('jobs')
    .select(['id'])
    .select(sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(result, '$.scannedAt'))`.as('scannedAt'))
    .select(sql<string | null>`JSON_TYPE(JSON_EXTRACT(result, '$.items'))`.as('itemsType'))
    .where('type', '=', 'attachment_unreferenced_report')
    .where('status', '=', 'succeeded');
  listing =
    query.vaultId === undefined
      ? listing.where('vault_id', 'is', null)
      : listing.where('vault_id', '=', idBytes(query.vaultId));
  const job = await listing
    .orderBy('finished_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (job === undefined)
    throw new ProblemError('unavailable', {
      detail:
        'No completed attachment report exists. Run the attachment_unreferenced_report maintenance job first.',
      retryAfterMs: 1000,
    });
  if (job.itemsType !== 'ARRAY') throw new AttachmentReportDataError(idFromBytes(job.id));
  const jobId = idFromBytes(job.id);
  const filter = { report: jobId, vaultId: query.vaultId ?? null };
  const expectation = { kind: 'attachments' as const, filter, principalKey };
  let after = '';
  if (query.cursor !== undefined) {
    const key = codec.parse(query.cursor, expectation).a;
    if (key.length !== 1 || typeof key[0] !== 'string')
      throw cursorInvalid('Invalid attachment-report continuation.');
    after = key[0];
  }
  // JSON_TABLE keeps the durable report in MySQL. Only limit+1 item objects cross the driver
  // boundary, so requesting one page never materializes a server-wide report in the API process.
  const page = await sql<{ readonly item: unknown }>`
    SELECT JSON_EXTRACT(report.result, CONCAT('$.items[', item.ordinal - 1, ']')) AS item
    FROM jobs AS report
    JOIN JSON_TABLE(report.result, '$.items[*]' COLUMNS (
      ordinal FOR ORDINALITY,
      id CHAR(36) PATH '$.id' ERROR ON EMPTY ERROR ON ERROR
    )) AS item
    WHERE report.id = ${job.id} AND item.id > ${after}
    ORDER BY item.id LIMIT ${query.limit + 1}
  `.execute(db);
  const parsed = UnreferencedAttachmentPage.safeParse({
    items: page.rows.map((row) => (typeof row.item === 'string' ? JSON.parse(row.item) : row.item)),
    scannedAt: job.scannedAt,
    jobId,
  });
  if (!parsed.success) throw new AttachmentReportDataError(jobId);
  const items = parsed.data.items.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    scannedAt: parsed.data.scannedAt,
    jobId,
    ...(parsed.data.items.length > items.length && last !== undefined
      ? { nextCursor: codec.issue({ ...expectation, after: [last.id] }) }
      : {}),
  };
}

/** A succeeded job must carry the documented durable report shape. */
export class AttachmentReportDataError extends Error {
  constructor(jobId: string) {
    super(
      `Attachment report job '${jobId}' has an invalid result; rerun attachment_unreferenced_report.`,
    );
    this.name = 'AttachmentReportDataError';
  }
}
