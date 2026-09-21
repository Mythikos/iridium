/**
 * `iridium audit verify-chain [--chain <id>] [--json]` (03-data-model.md §12.2;
 * 11-operations-and-deployment.md, "Audit and access log" and "Verifying the chain").
 *
 * The chain's whole value is that it refuses to let a change happen quietly, and this is the command
 * that collects on that promise: it recomputes `HMAC-SHA256(key[key_version], prev_hash ‖
 * canonicalJSON(row))` for every row in `id` order, compares each row's `prev_hash` with its
 * predecessor's `hash`, and finally compares the last row with `audit_chain_heads`. Exit `0` when
 * every chain is intact, `5` naming the first divergent row when one is not — the code a nightly
 * timer and the pre-upgrade runbook step both branch on.
 *
 * **It fails closed in two different ways, and they are different exit codes.** A row whose
 * `key_version` this deployment does not configure is a *divergence* (`5`): the verifier will not
 * skip a row it cannot check, because a skipped row is exactly where a tampered one would hide. But a
 * *signing* version that is not configured means no verification ran at all, which is a configuration
 * error (`2`) — the operator has to supply the key before the question can be asked.
 *
 * A verification failure is a security incident and not a maintenance task: `docs/runbooks/audit-verify.md`
 * says do not restart the server, do not run repairs, snapshot the state and compare the divergent row
 * with the most recent backup. The refusal prints that, because an operator reading a red exit code at
 * 02:00 should not have to find the runbook first.
 */
import { open } from 'node:fs/promises';

import {
  AuditAction,
  LIMITS,
  SERVER_CHAIN_ID,
  Timestamp,
  VAULT_CHAIN_PREFIX,
  VaultId,
} from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { sql, type Selectable } from 'kysely';

import {
  listChainIds,
  verifyChain,
  type AuditKeys,
  type ChainVerification,
} from '../audit/chain.ts';
import {
  AuditKeyVersionDowngradeError,
  createAuditKeys,
  readPromotedAuditKeyVersion,
} from '../audit/keys.ts';
import type { AuditEventsTable } from '../db/schema.ts';
import { auditExportRow } from '../jobs/archive.ts';
import { requireDatabase } from './app.ts';
import type { CommandInput } from './commands.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderTable, type CliIo } from './output.ts';

function csv(values: readonly unknown[]): string {
  return values
    .map((value) => {
      const text = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      return `"${text.replaceAll('"', '""')}"`;
    })
    .join(',');
}

/** One repeatable snapshot prevents archive movement from duplicating or hiding streamed rows. */
export async function runAuditExport(input: CommandInput): Promise<number> {
  if (input.app === null) throw new Error('Audit export requires the CLI application.');
  const app = input.app;
  const db = requireDatabase(app, input.path);
  const format = input.args.value('format') ?? 'jsonl';
  const vault = input.args.value('vault'),
    from = input.args.value('from'),
    to = input.args.value('to'),
    action = input.args.value('action');
  if (
    !['jsonl', 'csv'].includes(format) ||
    (vault !== undefined && !VaultId.safeParse(vault).success) ||
    (from !== undefined && !Timestamp.safeParse(from).success) ||
    (to !== undefined && !Timestamp.safeParse(to).success) ||
    (action !== undefined && !AuditAction.safeParse(action).success) ||
    (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to))
  ) {
    input.io.err(
      'audit export requires jsonl or csv, canonical UUIDs, UTC timestamps, and a known action.',
    );
    return EXIT.usage;
  }
  const out = input.args.value('out');
  const file = out === undefined ? null : await open(out, 'wx', 0o600);
  const emit = async (line: string): Promise<void> => {
    if (file !== null) await file.writeFile(`${line}\n`, 'utf8');
    else if (input.io.writeLine !== undefined) await input.io.writeLine(line);
    else input.io.out(line);
  };
  let rows = 0;
  let columns: string[] | null = null;
  try {
    await db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        let after = 0;
        for (;;) {
          const predicates = [sql`id > ${after}`];
          if (vault !== undefined)
            predicates.push(sql`chain_id = ${`${VAULT_CHAIN_PREFIX}${vault.replaceAll('-', '')}`}`);
          if (from !== undefined) predicates.push(sql`occurred_at >= ${new Date(from)}`);
          if (to !== undefined) predicates.push(sql`occurred_at <= ${new Date(to)}`);
          if (action !== undefined) predicates.push(sql`action = ${action}`);
          const where = sql.join(predicates, sql` AND `);
          const active = sql`SELECT * FROM audit_events WHERE ${where} ORDER BY id LIMIT ${LIMITS.JOB_ARCHIVE_BATCH_SIZE}`;
          const selection = input.args.has('include-archive')
            ? sql`
          (${active}) UNION ALL
          (SELECT * FROM audit_events_archive WHERE ${where} ORDER BY id LIMIT ${LIMITS.JOB_ARCHIVE_BATCH_SIZE})
          ORDER BY id LIMIT ${LIMITS.JOB_ARCHIVE_BATCH_SIZE}`
            : active;
          // eslint-disable-next-line no-await-in-loop -- consume one bounded page before fetching the next export cursor
          const page = await sql<Selectable<AuditEventsTable>>`${selection}`.execute(trx);
          if (page.rows.length === 0) break;
          for (const row of page.rows) {
            const exported = auditExportRow(row);
            if (format === 'csv' && columns === null) {
              columns = Object.keys(exported);
              // eslint-disable-next-line no-await-in-loop -- stdout and file writes apply backpressure to this stream
              await emit(csv(columns));
            }
            // eslint-disable-next-line no-await-in-loop -- stdout and file writes apply backpressure to this stream
            await emit(
              format === 'jsonl'
                ? JSON.stringify(exported)
                : csv((columns ?? []).map((column) => exported[column])),
            );
            rows += 1;
            after = row.id;
          }
        }
      });
    await file?.sync();
  } finally {
    await file?.close();
  }
  if (input.actor.userId !== null)
    await db.transaction().execute(async (trx) => {
      await app.audit.record(trx, {
        action: 'admin.audit.exported',
        actorType: input.actor.actorType,
        actorId: input.actor.actorId,
        actorDisplay: input.actor.actorDisplay,
        credentialType: 'cli',
        credentialId: null,
        outcome: 'success',
        context: input.auditContext,
        metadata: {
          format,
          rows,
          includeArchive: input.args.has('include-archive'),
          vaultId: vault ?? null,
        },
      });
    });
  input.io.err(`Exported ${String(rows)} audit rows${out === undefined ? '' : ` to ${out}`}.`);
  return EXIT.success;
}

/** What `audit verify-chain` needs after the flags are parsed. */
export interface VerifyChainInput {
  readonly io: CliIo;
  readonly app: FastifyInstance;
  /** `--chain <id>`; every chain with a head row when absent. */
  readonly chain: string | undefined;
  readonly json: boolean;
}

/** Runs `iridium audit verify-chain`. */
export async function runVerifyChain(input: VerifyChainInput): Promise<number> {
  const db = requireDatabase(input.app, 'audit verify-chain');

  let keys: AuditKeys;
  try {
    keys = createAuditKeys({
      keyring: input.app.iridiumConfig.keys.auditHmac,
      signingVersion: await readPromotedAuditKeyVersion(db),
    });
  } catch (error) {
    if (!(error instanceof AuditKeyVersionDowngradeError)) throw error;
    input.io.err(
      `iridium audit verify-chain cannot run: ${error.message}. Verification fails closed without ` +
        'the key — configure the missing AUDIT_HMAC_KEY version rather than verifying what is left.',
    );
    return EXIT.usage;
  }

  const known = await listChainIds(db);
  const chains = input.chain === undefined ? known : [input.chain];
  if (input.chain !== undefined && !known.includes(input.chain)) {
    input.io.err(
      `iridium audit verify-chain: no chain ${JSON.stringify(input.chain)} has been written. A ` +
        `chain id is ${SERVER_CHAIN_ID} or ${VAULT_CHAIN_PREFIX}<32 lowercase hex> — the vault uuid ` +
        `without hyphens (D03-05). This schema carries ${String(known.length)} chain(s).`,
    );
    return EXIT.refused;
  }

  const results: ChainVerification[] = [];
  for (const chainId of chains) {
    // Sequential by design: each chain is a bounded streaming walk, and running them concurrently
    // would multiply the memory the streaming exists to bound.
    // eslint-disable-next-line no-await-in-loop -- one bounded walk at a time is the point
    results.push(await verifyChain(db, chainId, keys));
  }

  return report(input.io, results, input.json);
}

/** Prints the per-chain outcome and answers the exit code. */
function report(io: CliIo, results: readonly ChainVerification[], json: boolean): number {
  const broken = results.filter((result) => !result.ok);

  if (json) {
    io.out(
      renderJson({
        ok: broken.length === 0,
        chains: results.map((result) => ({
          chainId: result.chainId,
          rows: result.rows,
          lastId: result.lastId,
          ok: result.ok,
          divergence:
            result.divergence === null
              ? null
              : {
                  ...result.divergence,
                  occurredAt: result.divergence.occurredAt?.toISOString() ?? null,
                },
        })),
      }),
    );
  } else {
    io.out(
      renderTable(
        ['chain', 'rows', 'last id', 'result'],
        results.map((result) => [
          result.chainId,
          String(result.rows),
          String(result.lastId),
          result.ok ? 'intact' : `BROKEN at id ${String(result.divergence?.id ?? 0)}`,
        ]),
      ),
    );
  }

  if (broken.length === 0) return EXIT.success;

  for (const result of broken) {
    const divergence = result.divergence;
    if (divergence === null) continue;
    io.err(
      `${result.chainId} diverges at id ${String(divergence.id)} ` +
        `(${divergence.occurredAt?.toISOString() ?? 'no timestamp'}, action ${divergence.action}): ` +
        divergence.reason,
    );
  }
  io.err(
    'A verification failure is a security incident, not a maintenance task: do not restart the ' +
      'server and do not run repairs. Snapshot the state (`iridium backup` plus the binlogs), ' +
      'compare the divergent row with the same row in the most recent backup, and check the ' +
      'system.key.rotated events — see docs/runbooks/audit-verify.md.',
  );
  return EXIT.verification;
}
