/**
 * The `FOUND_ROWS` boot assertion (03-data-model.md section 1.3, skeleton A10).
 *
 * Every compare-and-set in the data model asserts *matched* rows, not *changed* rows:
 *
 *   UPDATE nodes SET ..., version = version + 1 WHERE id = ? AND version = ?   -- must match 1 row
 *
 * Without the mysql2 `FOUND_ROWS` client flag an update that sets a column to the value it already
 * holds reports `0`, and every one of those statements would misread a successful write as a
 * `409 stale_version` -- or, on the persistence writer's `head_seq` CAS, as corruption. The flag is
 * a mysql2 default, so this probe exists to catch a driver change or a connection-flag override
 * rather than a configuration mistake, and it is cheap: one `UPDATE` of one row to its own value.
 *
 * The probe targets `schema_meta['iridium_version']`, which migration `0032` guarantees exists, so
 * this runs after migrations and before the first request.
 */
import { sql, type Kysely } from 'kysely';

import type { Database } from './schema.ts';

/** The `schema_meta` row the probe updates to its own value. */
export const FOUND_ROWS_PROBE_KEY = 'iridium_version';

/** Thrown when the probe matches no row; `main.ts` maps `exitCode` straight to `process.exit`. */
export class FoundRowsUnavailableError extends Error {
  readonly code = 'config.found_rows_missing';
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'FoundRowsUnavailableError';
  }
}

/**
 * Runs the probe. Resolves when the connection reports matched rows; throws otherwise.
 *
 * A `0` here has exactly two causes and the message names both, because they need opposite repairs:
 * the client flag is missing (a driver or pool-option regression), or migration `0032` has not run
 * (the caller sequenced the boot wrongly).
 */
export async function assertFoundRows(db: Kysely<Database>): Promise<void> {
  const result = await db
    .updateTable('schema_meta')
    .set({ value: sql.ref('value') })
    .where('key', '=', FOUND_ROWS_PROBE_KEY)
    .executeTakeFirst();

  if (result.numUpdatedRows !== 1n) {
    throw new FoundRowsUnavailableError(
      `the FOUND_ROWS client flag is not in effect: updating schema_meta['${FOUND_ROWS_PROBE_KEY}'] ` +
        `to its own value matched ${String(result.numUpdatedRows)} rows instead of 1. Every ` +
        'compare-and-set in the server asserts matched rows, so the server refuses to start. ' +
        'Either the mysql2 pool was built without the default FOUND_ROWS client flag, or migration ' +
        '0032_schema_meta has not been applied to this database.',
    );
  }
}
