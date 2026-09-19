/** Effective critical app privileges and durable grant provenance for the readiness boundary. */
import { sql, type Kysely } from 'kysely';

import { readGrantProvenance } from './grants.ts';
import type { Database } from './schema.ts';

interface GrantOutcome {
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
}

const APP_PRIVILEGE_PROBES = Object.freeze([
  {
    privilege: 'INSERT/SELECT on audit_events',
    query: sql`INSERT INTO audit_events SELECT * FROM audit_events WHERE FALSE`,
  },
  {
    privilege: 'INSERT/SELECT on session_revocation_commands',
    query: sql`INSERT INTO session_revocation_commands SELECT * FROM session_revocation_commands WHERE FALSE`,
  },
  {
    privilege: 'UPDATE (result, delivered_at) on session_revocation_commands',
    query: sql`UPDATE session_revocation_commands SET result = result, delivered_at = delivered_at WHERE FALSE`,
  },
  {
    privilege: 'SELECT on collab_owner_fence',
    query: sql`SELECT id, generation FROM collab_owner_fence WHERE FALSE`,
  },
  {
    privilege: 'UPDATE (generation) on collab_owner_fence',
    query: sql`UPDATE collab_owner_fence SET generation = generation WHERE FALSE`,
  },
]);

function isPrivilegeDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ER_TABLEACCESS_DENIED_ERROR' || error.code === 'ER_COLUMNACCESS_DENIED_ERROR')
  );
}

/**
 * Probes once after successful boot, retrying failures so a DBA repair can recover readiness.
 * Zero-row DML exercises privileges without inventing audit records or consuming sequence ids.
 */
export class AppGrantVerifier {
  #probed = false;

  /** Missing critical privileges fail before skipped or unknown metadata can produce a warning. */
  async check(db: Kysely<Database>): Promise<GrantOutcome> {
    if (!this.#probed) {
      const missing = await db.connection().execute(async (connection) => {
        await sql`START TRANSACTION`.execute(connection);
        try {
          for (const probe of APP_PRIVILEGE_PROBES) {
            try {
              // eslint-disable-next-line no-await-in-loop -- one pinned transaction, first refusal identifies the missing capability
              await probe.query.execute(connection);
            } catch (error) {
              if (isPrivilegeDenied(error)) return probe.privilege;
              throw error;
            }
          }
          return null;
        } finally {
          await sql`ROLLBACK`.execute(connection);
        }
      });
      if (missing !== null) return { status: 'fail', detail: `app role lacks ${missing}` };
      this.#probed = true;
    }

    const provenance = await readGrantProvenance(db);
    if (provenance.skipped.length > 0 || provenance.unverified.length > 0) {
      const skipped = provenance.skipped.map((row) => `${row.table}: ${row.reason}`);
      return {
        status: 'warn',
        detail: `grants unverified; ${[...skipped, ...provenance.unverified].join(', ')}. Apply docs/ops/db-grants.sql as a DBA and verify the effective role grants.`,
      };
    }
    return { status: 'ok', detail: 'grant application recorded; critical app privileges probed' };
  }
}
