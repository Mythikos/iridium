/** Bounded durable-row diagnostics and explicit, fenced sequence-bookkeeping repair (I-07/I-08). */
import { idFromBytes, LIMITS, NoteId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import type { AuditEventContext } from '../audit/chain.ts';
import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { requireDatabase } from './app.ts';
import type { CliActor } from './attribution.ts';
import type { DoctorCheck } from './doctor.ts';
import { EXIT } from './exit.ts';
import { renderJson, type CliIo } from './output.ts';

interface HeadRow {
  readonly note_id: Buffer;
  readonly vault_id: Buffer;
  readonly head_seq: number;
  readonly snapshot_through_seq: number;
  readonly projected_seq: number;
  readonly projection_revision: number | null;
  readonly expected: number;
}

function headsQuery(db: Kysely<Database>) {
  return db
    .selectFrom('note_docs as d')
    .innerJoin('nodes as n', 'n.id', 'd.note_id')
    .leftJoin('note_projections as p', 'p.note_id', 'd.note_id')
    .select([
      'd.note_id',
      'n.vault_id',
      'd.head_seq',
      'd.snapshot_through_seq',
      'd.projected_seq',
      'p.revision as projection_revision',
      // GREATEST over COALESCE(MAX(...)) widens to DECIMAL, which mysql2 hands back as a string on
      // both required lines. Without the cast `sql<number>` is a lie: `head_seq !== expected`
      // compares a number with a string, is true for every consistent note, and the head repair
      // reports and audits work it never needed to do. The cast keeps the declared type honest.
      sql<number>`CAST(GREATEST(d.snapshot_through_seq,COALESCE((SELECT MAX(u.seq) FROM note_updates u WHERE u.note_id=d.note_id),0)) AS SIGNED)`.as(
        'expected',
      ),
    ]);
}
function headIsInconsistent(row: HeadRow): boolean {
  return (
    row.head_seq !== row.expected ||
    row.snapshot_through_seq > row.head_seq ||
    row.projected_seq > row.head_seq ||
    (row.projection_revision ?? 0) > row.head_seq
  );
}

/** Visit every requested note in bounded id pages, including trash whose integrity still matters. */
async function* headFindings(db: Kysely<Database>, noteId?: string): AsyncGenerator<HeadRow> {
  let after: Buffer | null = null;
  while (true) {
    let query = headsQuery(db).orderBy('d.note_id').limit(LIMITS.JOB_BATCH_SIZE);
    if (noteId !== undefined) query = query.where('d.note_id', '=', idBytes(noteId));
    if (after !== null) query = query.where('d.note_id', '>', after);
    // eslint-disable-next-line no-await-in-loop -- the next bounded page depends on the previous keyset
    const rows = await query.execute();
    for (const row of rows) if (headIsInconsistent(row)) yield row;
    const last = rows.at(-1);
    if (last === undefined || rows.length < LIMITS.JOB_BATCH_SIZE) break;
    after = last.note_id;
  }
}

/** Read-only checks use the same findings the explicit repair revalidates under its lock. */
export async function contentDoctorChecks(
  app: FastifyInstance,
  options: {
    readonly heads?: boolean;
    readonly staleProjections?: boolean;
    readonly noteId?: string;
  } = {},
): Promise<readonly DoctorCheck[]> {
  if (options.noteId !== undefined) NoteId.parse(options.noteId);
  const db = requireDatabase(app, 'doctor');
  const checks: DoctorCheck[] = [];
  if (options.heads !== false) {
    let count = 0;
    const samples: string[] = [];
    for await (const row of headFindings(db, options.noteId)) {
      count += 1;
      if (samples.length < LIMITS.JOB_BATCH_SIZE) samples.push(idFromBytes(row.note_id));
    }
    checks.push({
      name: 'heads',
      status: count === 0 ? 'ok' : 'fail',
      detail:
        count === 0
          ? 'All durable heads agree with their snapshot and update log.'
          : `${count} inconsistent head(s); first ${samples.length}: ${samples.join(', ')}`,
      remedy:
        count === 0
          ? null
          : 'Run doctor --repair-heads --dry-run; inspect the proposed values before --yes. Projections ahead of the durable log require recovery from a verified backup.',
    });
  }
  if (options.staleProjections !== false) {
    const groups = { underMinute: 0, underHour: 0, older: 0 };
    let after: Buffer | null = null;
    while (true) {
      let query = db
        .selectFrom('note_docs as d')
        .innerJoin('nodes as n', 'n.id', 'd.note_id')
        .innerJoin('notes as t', 't.node_id', 'd.note_id')
        .leftJoin('note_projections as p', 'p.note_id', 'd.note_id')
        .select(['d.note_id', 'd.updated_at'])
        .where('n.deleted_at', 'is', null)
        .where('t.content_invalid', '=', false)
        .where((eb) => eb.or([eb('p.status', 'is', null), eb('p.status', '!=', 'invalid_content')]))
        .where((eb) =>
          eb.or([
            eb('d.projected_seq', '<', eb.ref('d.head_seq')),
            eb('p.note_id', 'is', null),
            eb('p.status', 'in', ['pending', 'timeout', 'error']),
          ]),
        )
        .orderBy('d.note_id')
        .limit(LIMITS.JOB_BATCH_SIZE);
      if (options.noteId !== undefined)
        query = query.where('d.note_id', '=', idBytes(options.noteId));
      if (after !== null) query = query.where('d.note_id', '>', after);
      // eslint-disable-next-line no-await-in-loop -- diagnostics scan one bounded keyset at a time
      const rows = await query.execute();
      for (const row of rows) {
        const age = app.clock.now() - row.updated_at.getTime();
        if (age < 60_000) groups.underMinute += 1;
        else if (age < 3_600_000) groups.underHour += 1;
        else groups.older += 1;
      }
      const last = rows.at(-1);
      if (last === undefined || rows.length < LIMITS.JOB_BATCH_SIZE) break;
      after = last.note_id;
    }
    const count = groups.underMinute + groups.underHour + groups.older;
    checks.push({
      name: 'stale_projections',
      status: count === 0 ? 'ok' : 'fail',
      detail: `${count} stale projection(s): <1m ${groups.underMinute}, 1m–1h ${groups.underHour}, >=1h ${groups.older}; invalid-content notes excluded.`,
      remedy: count === 0 ? null : 'iridium reindex --stale',
    });
  }
  return checks;
}

/** Explicit operator attribution accompanies every repaired head in the mutation transaction. */
export interface RepairHeadsInput {
  readonly app: FastifyInstance;
  readonly io: CliIo;
  readonly noteId?: string | undefined;
  readonly confirmed: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly actor: CliActor;
  readonly context: AuditEventContext;
}

/** A separate CLI cannot establish that another process has no loaded note, so it must own the lease. */
export async function runRepairHeads(input: RepairHeadsInput): Promise<number> {
  if (!input.confirmed && !input.dryRun) {
    input.io.err('doctor --repair-heads requires --yes after reviewing --dry-run.');
    return EXIT.refused;
  }
  const parsed = input.noteId === undefined ? undefined : NoteId.safeParse(input.noteId);
  if (parsed !== undefined && !parsed.success) {
    input.io.err('--note must be a canonical note UUID.');
    return EXIT.usage;
  }
  const db = requireDatabase(input.app, 'doctor --repair-heads');
  const lease = input.app.collab.ownerLease;
  const held = lease.held;
  if (!held && !(await lease.tryAcquire())) {
    input.io.err(
      'Stop the serving process before repairing durable heads; it owns the collaboration lease.',
    );
    return EXIT.refused;
  }
  const fence = lease.captureFence();
  let count = 0;
  let refused = false;
  const writeLine = async (text: string): Promise<void> => {
    if (input.io.writeLine === undefined) input.io.out(text);
    else await input.io.writeLine(text);
  };
  const emit = async (row: {
    noteId: string;
    before: number;
    after: number;
    outcome: string;
  }): Promise<void> => {
    if (count === 0) await writeLine(input.json ? '{"results":[' : 'note\tbefore\tafter\toutcome');
    await writeLine(
      input.json
        ? (count === 0 ? '' : ',') + renderJson(row)
        : [row.noteId, row.before, row.after, row.outcome].join('\t'),
    );
    count += 1;
    if (row.outcome.startsWith('refused')) refused = true;
  };
  try {
    for await (const finding of headFindings(db, input.noteId)) {
      const noteId = NoteId.parse(idFromBytes(finding.note_id));
      const name = `note:${noteId}`;
      input.app.notes.markClosing(noteId);
      try {
        if (
          input.app.collab.server.hocuspocus.documents.has(name) ||
          input.app.collab.server.hocuspocus.loadingDocuments.has(name)
        ) {
          // eslint-disable-next-line no-await-in-loop -- stdout backpressure bounds each independently reported repair
          await emit({
            noteId,
            before: finding.head_seq,
            after: finding.expected,
            outcome: 'refused_loaded',
          });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop -- each note is independently locked and audited
        const result = await db
          .transaction()
          .setIsolationLevel('read committed')
          .execute(async (trx) => {
            await fence.assertCurrent(trx);
            await trx
              .selectFrom('note_docs')
              .select('note_id')
              .where('note_id', '=', finding.note_id)
              .forUpdate()
              .executeTakeFirstOrThrow();
            const row = await headsQuery(trx)
              .where('d.note_id', '=', finding.note_id)
              .executeTakeFirstOrThrow();
            const after = row.expected;
            if (!headIsInconsistent(row))
              return { noteId, before: row.head_seq, after, outcome: 'already_consistent' };
            if (row.projected_seq > after || (row.projection_revision ?? 0) > after)
              return { noteId, before: row.head_seq, after, outcome: 'refused_projection_ahead' };
            if (input.dryRun) return { noteId, before: row.head_seq, after, outcome: 'dry_run' };
            await trx
              .updateTable('note_docs')
              .set({ head_seq: after, updated_at: input.app.clock.date() })
              .where('note_id', '=', finding.note_id)
              .execute();
            await input.app.audit.record(trx, {
              action: 'note.content.repaired',
              actorType: input.actor.actorType,
              actorId: input.actor.actorId,
              actorDisplay: input.actor.actorDisplay,
              credentialType: 'cli',
              vaultId: idFromBytes(row.vault_id),
              targetType: 'note',
              targetId: noteId,
              outcome: 'success',
              context: input.context,
              metadata: { repair: 'heads', before: row.head_seq, after },
            });
            return { noteId, before: row.head_seq, after, outcome: 'repaired' };
          });
        // eslint-disable-next-line no-await-in-loop -- stdout backpressure bounds each independently reported repair
        await emit(result);
      } finally {
        input.app.notes.clearClosing(noteId);
      }
    }
  } finally {
    if (!held) await lease.relinquish();
  }
  if (count === 0) {
    input.io.err('No inconsistent durable head was found; no repair was performed.');
    return EXIT.refused;
  }
  if (input.json) await writeLine(']}');
  return refused ? EXIT.refused : EXIT.success;
}
