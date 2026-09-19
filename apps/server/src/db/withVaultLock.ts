/**
 * `withVaultLock()` — the structural transaction protocol of 03-data-model.md §6.4, verbatim.
 *
 * Every create, rename, move, trash, restore and purge runs through this one helper so the lock order
 * and the compare-and-set discipline cannot diverge between call sites. The file name is the one
 * §6.4's heading gives it (`apps/server/src/db/withVaultLock.ts`), matching `db/assertFoundRows.ts`:
 * where the plan names a module after an exported function, the tree spells it the plan's way.
 *
 * The protocol, and why each step is where it is:
 *
 *  1. `START TRANSACTION` at **REPEATABLE READ**, and the *first* statement is
 *     `SELECT id, tree_version FROM vaults WHERE id = ? AND status = 'active' FOR UPDATE`. The lock is
 *     taken before the transaction's first consistent read, so the snapshot is established after the
 *     lock. A `FOR UPDATE` on a recursive CTE would not lock the base rows the CTE read, which is why
 *     serialisation is per vault and not per subtree. No row → `409 vault_archived` when the vault
 *     exists in another status, `404 not_found` when it does not exist at all.
 *  2. …steps 2 to 4 and 6 belong to the caller — loading target rows, comparing `If-Match`, the move
 *     checks, the versioned `UPDATE … WHERE id = ? AND version = ?` (`db/cas.ts`) and the
 *     `note_search.title` maintenance — because they differ per operation.
 *  5. `ctx.bumpTreeVersion()`. It is the caller's call rather than an automatic epilogue because it
 *     must happen **before** the audit row (step 7), and an epilogue would put it after. A structural
 *     transaction that never bumps is a bug, so the helper refuses to commit one.
 *  7. `AuditWriter.record(trx, …)` — the caller's last statement. It locks `audit_chain_heads`, which
 *     is always the last lock taken in the global lock order (`A46`).
 *  8. `COMMIT`, then the caller's post-COMMIT side effects, which this helper deliberately does not
 *     run: `tree-changed`, `CollabGateway.closeNote` and `AuthzBus` publications must not be inside
 *     the transaction, and a helper that took callbacks for both would make the boundary invisible.
 *
 * **`innodb_lock_wait_timeout` is capped at 5 s and restored afterwards** (§7.4). A smaller
 * serving-session baseline, derived from the command deadline, is never raised. The transaction runs
 * on a connection this helper reserves with `db.connection()`: `SET SESSION` outlives a transaction,
 * so its prior bounded policy must be restored before another borrower uses that session.
 *
 * **A deadlock is retried exactly once, with a fresh read** (§7.4); a lock-wait timeout is not retried
 * at all. Both end as `503 busy` with `Retry-After: 1` through `db/failure.ts`.
 */
import { idToBytes } from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Clock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';
import { isRetryableDeadlock, toProblem } from './failure.ts';
import type { Database, VaultStatus } from './schema.ts';

/** `SET SESSION innodb_lock_wait_timeout` for a structural transaction (03-data-model.md §7.4). */
export const VAULT_LOCK_WAIT_TIMEOUT_SECONDS = 5;

/** `SET SESSION innodb_lock_wait_timeout` on `dbPersist` for the writer (03-data-model.md §7.4). */
export const PERSIST_LOCK_WAIT_TIMEOUT_SECONDS = 10;

/** MySQL's own default, restored when the session variable read back an unusable value. */
const MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS = 50;

/** How many times a deadlocked transaction is retried: exactly once, with a fresh read (§7.4). */
const DEADLOCK_RETRIES = 1;

/** The statuses the lock accepts by default; every other status is not a mutable vault (§6.4 step 1). */
const MUTABLE_STATUSES: readonly VaultStatus[] = Object.freeze(['active']);

/** The vault row the `FOR UPDATE` select returned. */
export interface LockedVault {
  /** The canonical vault id, as the caller passed it. */
  readonly vaultId: string;
  /** `vaults.tree_version` as it was when the lock was taken. */
  readonly treeVersion: number;
  /** `vaults.status`, so a caller that opted into a wider status set can branch on it. */
  readonly status: VaultStatus;
}

/** What the work callback receives. */
export interface VaultLockContext {
  /** The transaction every statement of steps 2 to 7 runs on. */
  readonly trx: Transaction<Database>;
  /** The locked vault row. */
  readonly vault: LockedVault;
  /** `1` on the first attempt, `2` on the deadlock retry, so a caller can log the difference. */
  readonly attempt: number;
  /**
   * Step 5: `UPDATE vaults SET tree_version = tree_version + 1, updated_at = ? WHERE id = ?`.
   *
   * Call it once, after the node writes and before the audit row. Resolves to the new value, which is
   * what the `tree-changed` broadcast publishes.
   */
  bumpTreeVersion(): Promise<number>;
}

export interface WithVaultLockOptions {
  /** Immutable admission generation, held before any business row lock. */
  readonly ownerFence: OwnerFence;
  /** `dbApp`. The writer's own transactions never take this lock (`A19`). */
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  /** The canonical vault id. */
  readonly vaultId: string;
  /**
   * Statuses the lock accepts. Defaults to `['active']`. `importing` is the one deliberate widening —
   * the import commit writes a tree into a vault that is not active yet (08) — and naming it at the
   * call site is what keeps "an archived vault is read-only" true everywhere else.
   */
  readonly statuses?: readonly VaultStatus[];
}

/** Thrown when the work callback never bumped `tree_version`; a programming error, not a client's. */
export class TreeVersionNotBumpedError extends Error {
  readonly code = 'db.tree_version_not_bumped';

  constructor(vaultId: string) {
    super(
      `a structural transaction on vault ${vaultId} committed without calling bumpTreeVersion(). ` +
        'Every structural change bumps `vaults.tree_version` (03-data-model.md §6.4 step 5) — it is ' +
        'what every client compares to decide whether its tree is stale. Call ctx.bumpTreeVersion() ' +
        'after the node writes and before the audit row, or use a plain transaction if the change is ' +
        'not structural.',
    );
    this.name = 'TreeVersionNotBumpedError';
  }
}

interface VaultLockRow {
  readonly tree_version: number;
  readonly status: VaultStatus;
}

async function readLockTimeout(db: Kysely<Database>): Promise<number> {
  const result = await sql<{
    value: number | string;
  }>`SELECT @@SESSION.innodb_lock_wait_timeout AS value`.execute(db);
  const raw = result.rows[0]?.value;
  const seconds = typeof raw === 'number' ? raw : Number(raw ?? VAULT_LOCK_WAIT_TIMEOUT_SECONDS);
  return Number.isSafeInteger(seconds) && seconds >= 1
    ? seconds
    : MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS;
}

/**
 * `SET SESSION innodb_lock_wait_timeout = <seconds>`.
 *
 * The value is interpolated with `sql.lit` rather than bound as a parameter: MySQL does not accept a
 * placeholder for a system variable in `SET`. It is an integer this module computed, never input.
 */
async function setLockTimeout(db: Kysely<Database>, seconds: number): Promise<void> {
  const safe =
    Number.isSafeInteger(seconds) && seconds >= 0
      ? seconds
      : MYSQL_DEFAULT_LOCK_WAIT_TIMEOUT_SECONDS;
  await sql`SET SESSION innodb_lock_wait_timeout = ${sql.lit(safe)}`.execute(db);
}

/**
 * Reserves one connection, narrows its lock-wait timeout, and runs `work` with the vault row locked.
 *
 * @throws ProblemError `404 not_found` (no such vault), `409 vault_archived` (a vault in another
 * status), `503 busy` (lock-wait timeout, or a deadlock that survived its one retry).
 * @throws TreeVersionNotBumpedError when the callback committed without bumping `tree_version`.
 */
export async function withVaultLock<T>(
  options: WithVaultLockOptions,
  work: (context: VaultLockContext) => Promise<T>,
): Promise<T> {
  const { db, clock, vaultId } = options;
  const statuses = options.statuses ?? MUTABLE_STATUSES;

  return db.connection().execute(async (connection) => {
    const previousTimeout = await readLockTimeout(connection);
    await setLockTimeout(connection, Math.min(previousTimeout, VAULT_LOCK_WAIT_TIMEOUT_SECONDS));
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= DEADLOCK_RETRIES + 1; attempt += 1) {
        try {
          // Sequential by design: the second attempt exists only because the first deadlocked, and it
          // must re-read everything the rolled-back transaction read.
          // eslint-disable-next-line no-await-in-loop -- the retry is sequential by definition
          return await runLocked(
            connection,
            { clock, vaultId, statuses, attempt, ownerFence: options.ownerFence },
            work,
          );
        } catch (error) {
          lastError = error;
          if (!isRetryableDeadlock(error)) throw mapFailure(error);
        }
      }
      throw mapFailure(lastError);
    } finally {
      // A reset that fails must not replace the error the caller needs to see: the connection is about
      // to be returned to the pool, and a broken connection is discarded there rather than reused.
      try {
        await setLockTimeout(connection, previousTimeout);
      } catch {
        // Deliberately ignored; see above.
      }
    }
  });
}

/** Anything §7.4 maps becomes its problem; anything else propagates unchanged. */
function mapFailure(error: unknown): unknown {
  return toProblem(error) ?? error;
}

async function runLocked<T>(
  connection: Kysely<Database>,
  context: {
    readonly clock: Clock;
    readonly vaultId: string;
    readonly statuses: readonly VaultStatus[];
    readonly attempt: number;
    readonly ownerFence: OwnerFence;
  },
  work: (context: VaultLockContext) => Promise<T>,
): Promise<T> {
  const { clock, vaultId, statuses, attempt } = context;
  const idBytes = Buffer.from(idToBytes(vaultId));

  return connection
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      // The serving generation is held through COMMIT, including every deadlock retry.
      await context.ownerFence.assertCurrent(trx);
      // Step 1. The first business statement establishes the snapshot after the vault lock.
      const locked = await trx
        .selectFrom('vaults')
        .select(['tree_version', 'status'])
        .where('id', '=', idBytes)
        .where('status', 'in', [...statuses])
        .forUpdate()
        .executeTakeFirst();

      if (locked === undefined) throw await absentVaultProblem(trx, idBytes, vaultId);

      const row: VaultLockRow = locked;
      let bumped: number | null = null;

      const lockContext: VaultLockContext = {
        trx,
        attempt,
        vault: { vaultId, treeVersion: row.tree_version, status: row.status },
        async bumpTreeVersion(): Promise<number> {
          if (bumped !== null) return bumped;
          const next = row.tree_version + 1;
          await trx
            .updateTable('vaults')
            .set({ tree_version: next, updated_at: clock.date() })
            .where('id', '=', idBytes)
            .executeTakeFirst();
          bumped = next;
          return next;
        },
      };

      const result = await work(lockContext);
      if (bumped === null) throw new TreeVersionNotBumpedError(vaultId);
      return result;
    });
}

/**
 * Which of the two answers §6.4 step 1 gives: a vault that exists in a status the caller did not accept
 * is `409 vault_archived`; one that does not exist at all is `404 not_found`.
 *
 * "Knowing an identifier grants nothing" is why the second is `not_found` rather than a distinguishable
 * message: a caller who is not a member never learns whether the id exists (04 §5.4).
 */
async function absentVaultProblem(
  trx: Transaction<Database>,
  idBytes: Buffer,
  vaultId: string,
): Promise<ProblemError> {
  const existing = await trx
    .selectFrom('vaults')
    .select('status')
    .where('id', '=', idBytes)
    .executeTakeFirst();

  if (existing === undefined) {
    return new ProblemError('not_found', { detail: 'No such vault.' });
  }
  return new ProblemError('vault_archived', {
    detail: `This vault is ${existing.status} and accepts no structural changes.`,
    current: { vaultId, status: existing.status },
  });
}
