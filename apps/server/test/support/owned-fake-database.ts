/** Real owner-lease protocol over the scripted database transport used by unit tests. */
import { CollabOwnerLease } from '../../src/collab/owner-lease.ts';
import { fakeDatabase, type FakeDatabaseOptions } from './fake-driver.ts';

export async function ownedFakeDatabase(options: FakeDatabaseOptions) {
  let generation: Buffer = Buffer.alloc(16);
  const fake = fakeDatabase({
    ...options,
    script: (query, ordinal) => {
      if (query.sql.trim() === 'SELECT 1') return { rows: [{ value: 1 }] };
      if (query.sql.includes('information_schema.SCHEMATA'))
        return { rows: [{ name: 'owned_unit' }] };
      if (
        query.sql.includes('GET_LOCK') ||
        query.sql.includes('IS_USED_LOCK') ||
        query.sql.includes('RELEASE_LOCK')
      )
        return { rows: [{ value: 1 }] };
      if (query.sql.startsWith('update `collab_owner_fence`')) {
        const value = query.parameters[0];
        if (!Buffer.isBuffer(value)) throw new Error('owner claim must carry a generation buffer');
        generation = value;
        return { numAffectedRows: 1n };
      }
      if (query.sql.includes('from `collab_owner_fence`')) return { rows: [{ id: 1, generation }] };
      return options.script(query, ordinal);
    },
  });
  let claimError: unknown;
  const owner = new CollabOwnerLease({
    db: () => fake.db,
    poolSize: 4,
    logger: {
      info: () => undefined,
      warn: (fields) => {
        claimError = fields['err'];
      },
    },
  });
  if (!(await owner.tryAcquire()))
    throw new Error('scripted owner claim failed', { cause: claimError });
  const queriesBefore = fake.executed.length;
  const phasesBefore = fake.lifecycle.length;
  return {
    db: fake.db,
    owner,
    get executed() {
      return fake.executed.slice(queriesBefore);
    },
    get lifecycle() {
      return fake.lifecycle.slice(phasesBefore);
    },
    async close() {
      await owner.release();
      await fake.db.destroy();
    },
  };
}
