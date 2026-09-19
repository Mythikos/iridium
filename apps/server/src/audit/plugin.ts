import { SERVER_CHAIN_ID } from '@iridium/contracts';
/**
 * Boot step 6, the `audit` plugin (02-system-architecture.md, "Boot sequence and plugin order";
 * 11-operations-and-deployment.md, "Audit log operations").
 *
 * It decorates the instance with `app.audit`, the one `AuditWriter` every mutating service reaches the
 * chain through, and it refines the `key_versions` readiness check that boot step 2 registered as a
 * floor. Two boot checks the plan names live here:
 *
 *  1. **the promoted version is configured** — `schema_meta.audit_key_version` must be present in the
 *     `AUDIT_HMAC_KEY_V<n>` keyring, or a restored environment file would silently sign with a retired
 *     key (`config.key_version_downgrade`);
 *  2. **the `server` chain has a head row** — inserted with a genesis `last_hash` of 32 zero bytes when
 *     absent, so the first audited action of a fresh install does not have to create it under load.
 *
 * Both are **deferred, not skipped**, when the database is not reachable at boot. Boot step 2 deliberately
 * tolerates an absent or unmigrated database — the documented recovery is "migrate from a sidecar", not
 * "restart" — so a check that threw here would turn a recoverable state into a dead process. They run on
 * the first readiness evaluation that finds a connected database, and until then `key_versions` reports
 * what it can. The writer rejects every audited mutation as `unavailable` until the promoted signing
 * version has been read and validated; it never guesses a fallback version. A failed append aborts
 * the mutation it would have described.
 *
 * The `access_log` writer of 03-data-model.md §12.5 is deliberately **not** here at M1. Every producer of
 * an `access_log` row is a token-authenticated read or an OAuth grant step, and no credential that
 * produces one can exist before M3: M1 ships the PAT *verifier* only, and the token lifecycle REST and
 * the MCP mounts arrive with that milestone. The table, its partitions and its readiness check exist from
 * M0; the writer lands with its first producer.
 */
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { DatabaseHandle } from '../boot/db.ts';
import type { IridiumConfig } from '../config/env.ts';
import type { Database } from '../db/schema.ts';
import type { Clock } from '../ops/clock.ts';
import type { ServerLogger } from '../ops/logging.ts';
import type { CheckOutcome, Readiness } from '../ops/readiness.ts';
import { ProblemError } from '../security/problem.ts';
import { AuditWriter, GENESIS_HASH, type AuditKeys } from './chain.ts';
import {
  configuredAuditKeyVersions,
  createAuditKeys,
  readPromotedAuditKeyVersion,
  referencedAuditKeyVersions,
  referencedPepperVersions,
} from './keys.ts';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The audit chain writer of boot step 6. Every mutating service calls
     * `app.audit.record(trx, event)` as the last statement of its transaction (03-data-model.md §12.2).
     */
    audit: AuditWriter;
  }
}

/** What the audit plugin needs; slices, never the whole configuration object. */
export interface AuditPluginOptions {
  readonly config: IridiumConfig;
  readonly database: DatabaseHandle;
  readonly clock: Clock;
  readonly logger: ServerLogger;
  readonly readiness: Readiness;
}

/**
 * A keyring view whose signing version is re-read once, from `schema_meta`, on the first evaluation that
 * finds a connected database. It is a small mutable holder rather than a rebuilt writer because
 * `app.audit` is decorated at boot and Fastify decorators are not replaceable afterwards.
 */
class PromotedAuditKeys implements AuditKeys {
  #signingVersion: number | null = null;
  readonly #keyFor: (version: number) => Uint8Array | undefined;

  constructor(options: { readonly keyFor: (version: number) => Uint8Array | undefined }) {
    this.#keyFor = options.keyFor;
  }

  get signingVersion(): number {
    if (this.#signingVersion === null) {
      throw new ProblemError('unavailable', {
        detail:
          'The promoted audit signing key has not been resolved. Check key_versions readiness and restore the configured audit key material.',
      });
    }
    return this.#signingVersion;
  }

  keyFor(version: number): Uint8Array | undefined {
    return this.#keyFor(version);
  }

  /** Called once the promoted version has been read and validated against the keyring. */
  promote(version: number): void {
    this.#signingVersion = version;
  }
}

/** Applies boot step 6. */
export function applyAuditPlugin(app: FastifyInstance, options: AuditPluginOptions): void {
  const { config, database, clock, logger, readiness } = options;
  const keyring = config.keys.auditHmac;
  const keys = new PromotedAuditKeys({
    keyFor: (version) => keyring.versions.get(version),
  });

  app.decorate('audit', new AuditWriter({ keys, clock }));

  // The two boot checks, deferred until a connected database can answer them. `#resolved` is the memo:
  // a readiness evaluation runs every 5 s and neither check has to run more than once.
  let resolved = false;
  let deferredDetail = 'waiting for a reachable database to compare key versions with schema_meta';

  const resolveOnce = async (db: Kysely<Database>): Promise<void> => {
    if (resolved) return;
    const promoted = await readPromotedAuditKeyVersion(db);
    // Throws `AuditKeyVersionDowngradeError` when the promoted version is absent from the keyring.
    createAuditKeys({ keyring, signingVersion: promoted });
    await ensureServerChainHead(db);
    keys.promote(promoted);
    resolved = true;
    logger.info(
      { event: 'config.loaded', auditKeyVersion: promoted },
      'the audit chain is signing with the promoted key version',
    );
  };

  readiness.register('key_versions', async () => {
    const configured = configuredAuditKeyVersions(keyring);
    if (configured.length === 0) {
      return { status: 'fail', detail: 'no AUDIT_HMAC_KEY version is configured' };
    }
    const db = database.dbApp;
    if (db === null) {
      return { status: 'warn', detail: deferredDetail };
    }
    try {
      await resolveOnce(db);
      await app.auth.pepperVersion.current();
    } catch (error) {
      deferredDetail = error instanceof Error ? error.message : String(error);
      return { status: 'fail', detail: deferredDetail };
    }
    return keyVersionOutcome(db, keys.signingVersion, configured, config.keys.pepper.versions);
  });

  app.addHook('onReady', async () => {
    const db = database.dbApp;
    if (db === null) return;
    // A failure here is a `fail` on the `key_versions` check rather than a dead process: the boot path
    // deliberately survives a database that is absent, unmigrated or mid-restore.
    try {
      await resolveOnce(db);
    } catch (error) {
      deferredDetail = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, event: 'readyz.degraded', check: 'key_versions' },
        'the audit key version could not be resolved; /readyz reports key_versions: fail',
      );
    }
  });
}

/** Compares every version rows reference with the versions the environment configured. */
async function keyVersionOutcome(
  db: Kysely<Database>,
  signingVersion: number,
  configuredAudit: readonly number[],
  pepperVersions: ReadonlyMap<number, Uint8Array>,
): Promise<CheckOutcome> {
  const referencedAudit = await referencedAuditKeyVersions(db);
  const missingAudit = referencedAudit.filter((version) => !configuredAudit.includes(version));
  const referencedPepper = await referencedPepperVersions(db);
  const missingPepper = referencedPepper.filter((version) => !pepperVersions.has(version));

  if (missingAudit.length > 0 || missingPepper.length > 0) {
    const parts: string[] = [];
    if (missingAudit.length > 0) parts.push(`AUDIT_HMAC_KEY v${missingAudit.join(', v')}`);
    if (missingPepper.length > 0) parts.push(`AUTH_PASSWORD_PEPPER v${missingPepper.join(', v')}`);
    return {
      status: 'fail',
      detail: `rows reference key versions that are not configured: ${parts.join('; ')}`,
    };
  }
  return {
    status: 'ok',
    detail:
      `signing audit rows with v${String(signingVersion)}; every referenced audit and pepper version ` +
      'is configured',
  };
}

/**
 * Inserts the `server` chain's genesis head when it is absent.
 *
 * `INSERT … ON DUPLICATE KEY UPDATE chain_id = chain_id` rather than a read followed by an insert: two
 * processes boot against one schema during a rolling restart, and a self-assignment that changes nothing
 * is the idempotent form (the deprecated VALUES-function form of `ON DUPLICATE KEY UPDATE` is banned
 * by `db.dialect-floor.guard`).
 */
async function ensureServerChainHead(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto('audit_chain_heads')
    .values({ chain_id: SERVER_CHAIN_ID, last_id: 0, last_hash: GENESIS_HASH })
    .onDuplicateKeyUpdate((eb) => ({ chain_id: eb.ref('audit_chain_heads.chain_id') }))
    .executeTakeFirst();
}
