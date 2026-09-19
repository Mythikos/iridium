/** Retention refuses unsafe bounds and cannot turn a full batch into unbounded work. */
import { newId, NoteId } from '@iridium/contracts';
import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { Database } from '../../db/schema.ts';
import { pruneUpdateLog, type PruneUpdateLogOptions } from './prune.ts';

/** Only the database result seam is replaced; every query runs through the real MySQL compiler. */
function database(results: readonly (number | Error)[]): {
  db: Kysely<Database>;
  calls: () => number;
} {
  let calls = 0;
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (instance) => new MysqlIntrospector(instance),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
    plugins: [
      {
        transformQuery: (args) => args.node,
        async transformResult() {
          const result = results[calls] ?? new Error('unexpected database execution');
          calls += 1;
          if (result instanceof Error) throw result;
          return { rows: [], numAffectedRows: BigInt(result) };
        },
      },
    ],
  });
  return { db, calls: () => calls };
}
const now = new Date('2026-09-17T12:00:00Z');

describe('collab.update-log-prune.unit [area:collab]', () => {
  const invalid: readonly Partial<Omit<PruneUpdateLogOptions, 'db'>>[] = [
    { retentionDays: 0 },
    { retentionDays: -1 },
    { retentionDays: 1.5 },
    { retentionDays: Number.NaN },
    { retentionDays: Number.POSITIVE_INFINITY },
    { now: new Date(Number.NaN) },
    { retentionDays: Number.MAX_SAFE_INTEGER },
    { batchSize: 0 },
    { batchSize: 10_001 },
    { batchSize: 1.5 },
    { maxBatches: 0 },
    { maxBatches: 1001 },
    { maxBatches: 1.5 },
  ];
  for (const [index, options] of invalid.entries()) {
    it(`rejects invalid retention or work bound ${String(index)} before any database call`, async () => {
      const fixture = database([]);
      try {
        await expect(
          pruneUpdateLog({ db: fixture.db, now, retentionDays: 7, ...options }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(fixture.calls()).toBe(0);
      } finally {
        await fixture.db.destroy();
      }
    });
  }
  it('stops on the first incomplete batch with the exact removed total', async () => {
    const fixture = database([500, 4]);
    try {
      expect(await pruneUpdateLog({ db: fixture.db, now, retentionDays: 7 })).toBe(504);
      expect(fixture.calls()).toBe(2);
    } finally {
      await fixture.db.destroy();
    }
  });
  it('caps complete batches for one note even when more rows remain eligible', async () => {
    const fixture = database([3, 3]);
    try {
      expect(
        await pruneUpdateLog({
          db: fixture.db,
          now,
          retentionDays: 1,
          batchSize: 3,
          maxBatches: 2,
          noteId: NoteId.parse(newId()),
        }),
      ).toBe(6);
      expect(fixture.calls()).toBe(2);
    } finally {
      await fixture.db.destroy();
    }
  });
  it('propagates a database failure without pretending the remaining work completed', async () => {
    const error = new Error('database disconnected');
    const fixture = database([500, error]);
    try {
      await expect(pruneUpdateLog({ db: fixture.db, now, retentionDays: 7 })).rejects.toBe(error);
      expect(fixture.calls()).toBe(2);
    } finally {
      await fixture.db.destroy();
    }
  });
});
