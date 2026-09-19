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
import { SERVER_CHAIN_ID, VAULT_CHAIN_PREFIX } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

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
import { requireDatabase } from './app.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderTable, type CliIo } from './output.ts';

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
