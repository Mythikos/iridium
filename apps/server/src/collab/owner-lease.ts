/**
 * `CollabOwnerLease` — the boot lease that makes "one collaboration-server process owns the active
 * documents" an enforced refusal instead of an after-the-fact `head_seq` mismatch
 * (12-milestones.md §5.2, the `collab` row; 10-testing-and-quality.md, "Single-process document
 * ownership", D10-33).
 *
 * `SELECT GET_LOCK(<schema-derived name>, 0)` on **one dedicated `dbPersist` connection** that is
 * never returned to the pool and never used inside a row-locking transaction (`db/dedicated-connection.ts`
 * owns that rule). The timeout is `0`, so the call never waits, and the retry cadence is the
 * readiness probe's: every `collab_owner_lease` evaluation calls `tryAcquire()`, so a rolling restart
 * hands the lease over with no operator action and the successor never serves beside its
 * predecessor. MySQL named locks are server-wide, so the name includes the selected schema's digest:
 * independent deployments on the same MySQL instance must not compete for document ownership. No
 * environment override can split two owners of the same schema into different lock namespaces.
 *
 * Without the lease the process refuses `/collab` upgrades with `4503 no-owner-lease` before any
 * document is loaded, logs `collab.owner_lease.denied` exactly once however many upgrades arrive,
 * and serves only health, readiness and metrics. Release happens in the `resources` drain phase, after the writers
 * have drained and the last document has unloaded, so a successor cannot load a document whose
 * updates are still queued here. A `SIGKILL`ed process releases it only when MySQL reaps the session;
 * the durable generation row serializes every old transaction before a successor can serve.
 */
import { createHash, randomBytes } from 'node:crypto';

import { sql, type Kysely, type Transaction } from 'kysely';

import {
  reserveConnection,
  type CloseHookHost,
  type ReservedConnection,
} from '../db/dedicated-connection.ts';
import type { Database } from '../db/schema.ts';

/** 21 ASCII characters plus a 43-character SHA-256 digest fit MySQL's 64-character lock names. */
const COLLAB_OWNER_LOCK_PREFIX = 'iridium_collab_owner:';

/** The label the reservation and the readiness check carry. */
export const COLLAB_OWNER_LEASE_LABEL = 'collab_owner_lease';

/** `GET_LOCK` never waits: the retry cadence is the readiness probe's. */
const GET_LOCK_TIMEOUT_SECONDS = 0;

/** The logging methods the lease uses. */
export interface OwnerLeaseLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** What the lease needs. */
export interface OwnerLeaseOptions {
  /** `dbPersist`, resolved per call: the pool may connect after boot. */
  readonly db: () => Kysely<Database> | null;
  /** `DB_POOL_PERSIST`, so the reservation can refuse to starve the writer. */
  readonly poolSize: number;
  readonly logger: OwnerLeaseLogger;
  /** The instance whose `onClose` returns the dedicated connection when no drain ran. */
  readonly closeWith?: CloseHookHost;
  /** Synchronously stops admission/writers, then resolves after the old document lifetime is gone. */
  readonly onLost?: () => Promise<void>;
}

declare const ownerGenerationBrand: unique symbol;

/** One immutable random generation published only after its singleton update commits. */
export type OwnerGeneration = string & { readonly [ownerGenerationBrand]: true };

/** A transaction or document still belongs to a former owner; it must never adopt a new token. */
export class CollabOwnershipLost extends Error {
  readonly code = 'collab.ownership_lost';

  constructor() {
    super(
      'the collaboration owner generation changed; reconnect to the current owner before writing',
    );
    this.name = 'CollabOwnershipLost';
  }
}

/** Captured once per loaded document, checked before its SQL and held through each write COMMIT. */
export interface OwnerFence {
  assertActive(): void;
  assertCurrent(trx: Transaction<Database>): Promise<void>;
}

/**
 * Thrown when a CLI boot must take the lease for one operation and a server holds it: the repair
 * path of `iridium doctor --repair-content` (05, "The repair CLI"; the D10-33 ruling).
 */
export class CollabLeaseHeldError extends Error {
  readonly code = 'collab.lease_held';
  readonly exitCode = 2;

  constructor() {
    super(
      'a server holds the collaboration lease for this database schema; stop it before ' +
        'repairing note content, then run the command again.',
    );
    this.name = 'CollabLeaseHeldError';
  }
}

interface LockRow {
  readonly value: number | string | null;
}

class CollabLeaseSchemaError extends Error {
  constructor() {
    super(
      'the collaboration lease needs a selected database schema; configure DATABASE_URL with ' +
        'the Iridium schema before serving documents.',
    );
    this.name = 'CollabLeaseSchemaError';
  }
}

async function resolveLockName(db: Kysely<Database>): Promise<string> {
  // Information-schema name comparisons respect lower_case_table_names and return the stored name.
  // Hashing that canonical name keeps aliases of one schema together and long/Unicode names bounded
  // without identifying a deployment by the connection URL (D10-33).
  const result = await sql<{ readonly name: string }>`
    SELECT SCHEMA_NAME AS name
    FROM information_schema.SCHEMATA
    WHERE SCHEMA_NAME = DATABASE()
  `.execute(db);
  const name = result.rows[0]?.name;
  if (name === undefined || name.length === 0 || result.rows.length !== 1) {
    throw new CollabLeaseSchemaError();
  }
  return `${COLLAB_OWNER_LOCK_PREFIX}${createHash('sha256').update(name).digest('base64url')}`;
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

/** The lease. One per process, owned by the collab plugin. */
export class CollabOwnerLease {
  readonly #db: () => Kysely<Database> | null;
  readonly #poolSize: number;
  readonly #logger: OwnerLeaseLogger;
  readonly #onLost: (() => Promise<void>) | undefined;
  #reservation: ReservedConnection | null = null;
  #lockName: string | null = null;
  #held = false;
  #namedLockHeld = false;
  #generation: OwnerGeneration | null = null;
  #lossWork: Promise<void> = Promise.resolve();
  #cleanupFailed = false;
  #attempt: Promise<boolean> | null = null;
  #deniedLogged = false;
  #released = false;

  constructor(options: OwnerLeaseOptions) {
    this.#db = options.db;
    this.#poolSize = options.poolSize;
    this.#logger = options.logger;
    this.#onLost = options.onLost;
    // CLI commands acquire only after ready(); register process cleanup while boot is still open.
    // One owner-level hook also covers every connection replacement and temporary repair lease.
    options.closeWith?.addHook('onClose', () => this.release());
  }

  /** Whether this process holds the lease right now. */
  get held(): boolean {
    return this.#held && !this.#released;
  }

  /** Captures the serving lifetime; callers retain this value across every await. */
  captureGeneration(): OwnerGeneration {
    const generation = this.#generation;
    if (!this.held || generation === null) throw new CollabOwnershipLost();
    return generation;
  }

  /** A synchronous message-path check, with no database work. */
  isCurrent(generation: OwnerGeneration): boolean {
    return this.held && this.#generation === generation;
  }

  /** A loaded writer's immutable guard. A later lease claim cannot revive it. */
  captureFence(): OwnerFence {
    const generation = this.captureGeneration();
    return {
      assertActive: () => {
        if (!this.isCurrent(generation)) throw new CollabOwnershipLost();
      },
      assertCurrent: (trx) => this.assertCurrent(trx, generation),
    };
  }

  /**
   * The first statement of every owner mutation transaction. Its shared row lock lasts through
   * COMMIT, so a successor's exclusive generation update waits for every admitted old transaction.
   */
  async assertCurrent(trx: Transaction<Database>, generation: OwnerGeneration): Promise<void> {
    if (!this.isCurrent(generation)) throw new CollabOwnershipLost();
    const row = await trx
      .selectFrom('collab_owner_fence')
      .select('generation')
      .where('id', '=', 1)
      .forShare()
      .executeTakeFirst();
    if (!this.isCurrent(generation) || row?.generation.toString('hex') !== generation) {
      this.#lost();
      throw new CollabOwnershipLost();
    }
  }

  /** The schema-derived lock name while a connection is reserved, for ownership diagnostics. */
  get lockName(): string | null {
    return this.#lockName;
  }

  /** Whether the dedicated connection is reserved (for the "never returned to the pool" assertion). */
  get connectionReserved(): boolean {
    return this.#reservation?.held ?? false;
  }

  /**
   * Acquires the lease, or verifies a held lease in one round trip. Single-flight: a probe that
   * lands while an attempt is in progress joins it. Answers `false` — never throws — when the database
   * is unreachable, when another process holds the lock, or after `release()`.
   */
  tryAcquire(): Promise<boolean> {
    if (this.#released) return Promise.resolve(false);
    this.#attempt ??= this.#acquire().finally(() => {
      this.#attempt = null;
    });
    return this.#attempt;
  }

  async #acquire(): Promise<boolean> {
    const db = this.#db();
    if (db === null) return false;
    try {
      await this.#lossWork;
      if (this.#cleanupFailed || this.#released) return false;
      const reservation =
        this.#reservation ??
        (await reserveConnection({
          db,
          poolSize: this.#poolSize,
          label: COLLAB_OWNER_LEASE_LABEL,
        }));
      this.#reservation = reservation;
      const lockName = this.#lockName ?? (await resolveLockName(reservation.db));
      this.#lockName = lockName;
      if (this.#held) {
        if (!(await this.#verify(reservation.db, lockName))) {
          this.#lost();
          await this.#dropReservation();
        }
        return this.held;
      }
      const result = await sql<LockRow>`
        SELECT GET_LOCK(${lockName}, ${sql.lit(GET_LOCK_TIMEOUT_SECONDS)}) AS value
      `.execute(reservation.db);
      this.#namedLockHeld = asNumber(result.rows[0]?.value) === 1;
      if (!this.#namedLockHeld) return false;
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- randomBytes constructs the opaque 128-bit token; callers can only capture it
      const generation = randomBytes(16).toString('hex') as OwnerGeneration;
      // The named-lock reservation is never used for a row-locking transaction. The claim uses a
      // separate persist connection and waits for the preceding generation's shared-lock holders.
      await db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('collab_owner_fence')
          .select('id')
          .where('id', '=', 1)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || !(await this.#verify(reservation.db, lockName))) {
          throw new CollabOwnershipLost();
        }
        await trx
          .updateTable('collab_owner_fence')
          .set({ generation: Buffer.from(generation, 'hex') })
          .where('id', '=', 1)
          .execute();
        if (!(await this.#verify(reservation.db, lockName))) throw new CollabOwnershipLost();
      });
      // A killed named-lock session must not publish a generation after its claim COMMIT.
      if (!(await this.#verify(reservation.db, lockName))) throw new CollabOwnershipLost();
      this.#generation = generation;
      this.#held = true;
      this.#deniedLogged = false;
      this.#logger.info(
        { event: 'readyz.recovered', check: COLLAB_OWNER_LEASE_LABEL },
        'the collaboration owner lease and transaction generation are held',
      );
      return this.held;
    } catch (error) {
      this.#lost();
      await this.#dropReservation();
      this.#logger.warn(
        { err: error, event: 'readyz.degraded', check: COLLAB_OWNER_LEASE_LABEL },
        'the owner lease could not be acquired; retrying on the next readiness evaluation',
      );
      return false;
    }
  }

  async #verify(db: Kysely<Database>, lockName: string): Promise<boolean> {
    const mine = await sql<LockRow>`
      SELECT IS_USED_LOCK(${lockName}) = CONNECTION_ID() AS value
    `.execute(db);
    return asNumber(mine.rows[0]?.value) === 1;
  }

  #lost(): void {
    const wasServing = this.#held;
    this.#held = false;
    this.#generation = null;
    if (!wasServing) return;
    this.#logger.warn(
      { event: 'collab.owner_lease.lost', check: COLLAB_OWNER_LEASE_LABEL },
      'ownership was lost; existing documents are fenced and must reconnect',
    );
    // The callback fences synchronously. Its asynchronous cleanup is owned here and joined before
    // any claim of a new generation; never await it inside the transaction detecting stale work.
    try {
      this.#lossWork = Promise.resolve(this.#onLost?.()).catch((error: unknown) => {
        this.#cleanupFailed = true;
        this.#logger.warn(
          { err: error, event: 'collab.owner_lease.cleanup_failed' },
          'old documents could not be discarded; this process remains unavailable',
        );
      });
    } catch (error) {
      this.#cleanupFailed = true;
      this.#logger.warn(
        { err: error, event: 'collab.owner_lease.cleanup_failed' },
        'old documents could not be fenced; this process remains unavailable',
      );
    }
  }

  /** Logs `collab.owner_lease.denied` once per denial episode; the caller refuses the upgrade. */
  noteDenied(): void {
    if (this.#deniedLogged) return;
    this.#deniedLogged = true;
    this.#logger.warn(
      { event: 'collab.owner_lease.denied', lock: this.#lockName },
      'this process does not hold the collaboration owner lease and refuses /collab upgrades',
    );
  }

  /** `RELEASE_LOCK`, then the connection goes back to the pool, for good. Idempotent; never throws. */
  async release(): Promise<void> {
    this.#released = true;
    await this.#letGo();
  }

  /**
   * `RELEASE_LOCK` and the connection back to the pool, with a later `tryAcquire` still allowed:
   * what a CLI repair does around one operation. Idempotent; never throws.
   */
  async relinquish(): Promise<void> {
    await this.#letGo();
  }

  async #letGo(): Promise<void> {
    // Readiness may still be acquiring the reservation when the shutdown drain begins.
    // Join it so no pending attempt can acquire a lock after the release has returned.
    await this.#attempt;
    await this.#lossWork;
    const reservation = this.#reservation;
    if (reservation === null) return;
    try {
      if (this.#namedLockHeld && this.#lockName !== null) {
        await sql`SELECT RELEASE_LOCK(${this.#lockName}) AS value`.execute(reservation.db);
      }
    } catch (error) {
      this.#logger.warn(
        { err: error },
        'releasing the owner lease failed; the session ends with the pool',
      );
    } finally {
      this.#held = false;
      this.#generation = null;
      this.#namedLockHeld = false;
      await this.#dropReservation();
    }
  }

  async #dropReservation(): Promise<void> {
    const reservation = this.#reservation;
    const lockName = this.#lockName;
    this.#reservation = null;
    this.#lockName = null;
    if (reservation !== null && this.#namedLockHeld && lockName !== null) {
      try {
        await sql`SELECT RELEASE_LOCK(${lockName}) AS value`.execute(reservation.db);
      } catch {
        // A dead session has already released its lock; release() below returns only its handle.
      }
    }
    this.#namedLockHeld = false;
    if (reservation === null) return;
    try {
      await reservation.release();
    } catch {
      // The pool discards a broken connection on its own.
    }
  }
}
