/** Independent HMAC walk over committed rows, without the product writer, verifier or canonicalizer. */
import { createHmac } from 'node:crypto';

import { idFromBytes } from '@iridium/contracts';
import { TEST_SECRETS } from '@iridium/testkit';
import type { Kysely, Selectable } from 'kysely';
import { expect } from 'vitest';

import type { AuditEventsTable, Database } from '../../src/db/schema.ts';

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value !== 'object') throw new Error('An audit payload must contain only JSON values.');
  return `{${Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    .join(',')}}`;
}

/** Reconstruct the specified payload from SQL columns, carrying predecessor IDs independently. */
function payload(row: Selectable<AuditEventsTable>, previousId: number): unknown {
  const optional = {
    actor_id: row.actor_id === null ? null : idFromBytes(row.actor_id),
    actor_display: row.actor_display,
    on_behalf_of_user_id:
      row.on_behalf_of_user_id === null ? null : idFromBytes(row.on_behalf_of_user_id),
    credential_id: row.credential_id === null ? null : idFromBytes(row.credential_id),
    vault_id: row.vault_id === null ? null : idFromBytes(row.vault_id),
    target_type: row.target_type,
    target_id: row.target_id === null ? null : idFromBytes(row.target_id),
    targets: row.targets,
    reason: row.reason,
    metadata: row.metadata,
  };
  return {
    prev_id: previousId,
    occurred_at: row.occurred_at.toISOString().replace('Z', '000Z'),
    schema_version: row.schema_version,
    chain_id: row.chain_id,
    action: row.action,
    actor_type: row.actor_type,
    credential_type: row.credential_type,
    outcome: row.outcome,
    context: row.context,
    ...Object.fromEntries(Object.entries(optional).filter(([, member]) => member !== null)),
  };
}

/** Verify every extant chain in one consistent read, including archived events and its final head. */
export async function expectIndependentAuditChains(db: Kysely<Database>): Promise<number> {
  const key = TEST_SECRETS['AUDIT_HMAC_KEY'];
  if (key === undefined) throw new Error('The child fixture must supply its audit key.');
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (trx) => {
      const heads = await trx
        .selectFrom('audit_chain_heads')
        .selectAll()
        .orderBy('chain_id')
        .execute();
      const active = await trx.selectFrom('audit_events').selectAll().execute();
      const archived = await trx.selectFrom('audit_events_archive').selectAll().execute();
      const rows = [...active, ...archived].toSorted((left, right) => left.id - right.id);
      expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
      expect(new Set(rows.map((row) => row.chain_id))).toEqual(
        new Set(heads.map((head) => head.chain_id)),
      );
      for (const head of heads) {
        let previousId = 0;
        let previousHash: Uint8Array = Buffer.alloc(32);
        for (const row of rows.filter((event) => event.chain_id === head.chain_id)) {
          expect(row.key_version).toBe(1);
          expect(row.prev_hash).toEqual(Buffer.from(previousHash));
          const computed = createHmac('sha256', key)
            .update(previousHash)
            .update(canonical(payload(row, previousId)), 'utf8')
            .digest();
          expect(
            row.hash,
            `Audit row ${String(row.id)} must bind its complete predecessor and payload`,
          ).toEqual(computed);
          previousId = row.id;
          previousHash = computed;
        }
        expect(head.last_id).toBe(previousId);
        expect(head.last_hash).toEqual(Buffer.from(previousHash));
      }
      return heads.length;
    });
}
