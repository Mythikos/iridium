/** Real writer, compactor and loader over MySQL, sharing the nine-invariant command model. */
import { it } from '@fast-check/vitest';
import { getContent, projectMarkdown } from '@iridium/crdt';
import { normalizeSource } from '@iridium/markdown';
import { keepSchema, noteText, PROP_DB } from '@iridium/testkit';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it as test } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { connectionOrigin } from '../../src/collab/persistence/testing/fake-document.ts';
import {
  assertCoalescingPreservesSemantics,
  assertLoad,
  assertStoreInvariants,
  ConcurrentWriterCommand,
  initialModel,
  persistenceCommands,
  type ModelReal,
} from '../../src/collab/persistence/testing/model.ts';
import { runScheduledPersistence } from '../../src/collab/persistence/testing/scheduled-model.ts';
import { startDatabaseModel, type DatabaseModelFixture } from '../support/persistence-model.ts';
import { pruneUpdateLog } from '../support/prune-updates.ts';

const text = noteText({ minLength: 1, maxLength: 12 }).filter((value) => value.isWellFormed());
const seed = noteText({ maxLength: 24 }).filter((value) => value.isWellFormed());
// Each example creates a new note; retain the route-created cast for this model property.
keepSchema();
let fixture: DatabaseModelFixture;
beforeAll(async () => {
  fixture = await startDatabaseModel();
});
afterAll(async () => {
  await fixture?.stop();
});

describe('persistence.model.prop [area:collab] [spec:durable-saving] [hp:HP-1] [hp:HP-2]', () => {
  test('preserves content U+FEFF after stripping one encoding BOM (seed -1165222821)', async () => {
    const markdown = '\uFEFF';
    const real = await fixture.create(markdown, `\uFEFF${markdown}`);
    try {
      const model = initialModel(markdown);
      await assertLoad(real, model);
      await real.persistence.compactNow(real.noteId, { trigger: 'flush' });
      await real.reopen();
      expect(projectMarkdown(real.document)).toBe(markdown);
      await assertLoad(real, model);
    } finally {
      real.dispose();
    }
  });

  test('refuses the stale concurrent owner before writing (seed 2107810981)', async () => {
    const real = await fixture.create('');
    try {
      const model = initialModel('');
      await new ConcurrentWriterCommand(' ').run(model, real);
      await real.writer.drain();
      await assertLoad(real, model);
      expect(real.writer.state).toBe('idle');
    } finally {
      real.dispose();
    }
  });
  test('prunes strict-old covered batches, retains the uncheckpointed tail and refuses a missing snapshot', async () => {
    const real = await fixture.create('seed');
    const missing = await fixture.create('missing snapshot');
    try {
      real.document.transact(() => {
        getContent(real.document).insert(0, 'covered');
      }, connectionOrigin(real.connections[0]));
      await real.writer.drain();
      await real.persistence.compactNow(real.noteId, { trigger: 'flush' });
      real.document.transact(() => {
        getContent(real.document).insert(0, 'tail');
      }, connectionOrigin(real.connections[0]));
      await real.writer.drain();
      const options = {
        db: fixture.context.db,
        noteId: real.noteId,
        retentionDays: 7,
        batchSize: 1,
      };
      const boundary = real.clock.now() + 7 * 86_400_000;
      expect(await pruneUpdateLog({ ...options, now: new Date(boundary) })).toBe(0);
      expect(await pruneUpdateLog({ ...options, now: new Date(boundary + 1) })).toBe(2);
      expect((await real.view()).updates.map((row) => row.seq)).toEqual([3]);
      await real.reopen();
      expect(projectMarkdown(real.document)).toBe('tailcoveredseed');
      // This deliberately broken snapshot is an operational failure cut point, not invented seed
      // data. Retention must not erase the only recovery log even if through_seq still looks valid.
      await fixture.context.db
        .updateTable('note_docs')
        .set({ snapshot: null })
        .where('note_id', '=', idBytes(missing.noteId))
        .execute();
      expect(
        await pruneUpdateLog({ ...options, noteId: missing.noteId, now: new Date(boundary + 1) }),
      ).toBe(0);
      expect((await missing.view()).updates.map((row) => row.seq)).toEqual([1]);
    } finally {
      real.dispose();
      missing.dispose();
    }
  });
  it.prop(
    [seed, fc.commands(persistenceCommands(text), { maxCommands: PROP_DB.maxCommands })],
    PROP_DB,
  )(
    'retains the nine durability invariants through real MySQL transactions',
    async (source, commands) => {
      const markdown = normalizeSource(source).text;
      const opened: { real: ModelReal | null } = { real: null };
      const model = initialModel(markdown);
      try {
        await fc.asyncModelRun(async () => {
          const real = await fixture.create(markdown, source);
          opened.real = real;
          return { model, real };
        }, commands);
        const real = opened.real;
        if (real === null) throw new Error('the model created no note');
        await real.writer.drain();
        assertStoreInvariants(await real.view(), model, real);
        if (!model.trashed) {
          await assertCoalescingPreservesSemantics(real);
          await assertLoad(real, { ...model, committed: null, pending: 1 });
        }
      } finally {
        opened.real?.dispose();
      }
    },
  );
  it.prop([fc.scheduler(), fc.array(text, { minLength: 2, maxLength: 12 })], PROP_DB)(
    'survives scheduled enqueue, compaction, load, crash and client disconnect races',
    (scheduler, edits) =>
      runScheduledPersistence(scheduler, edits, (markdown) => fixture.create(markdown)),
  );
});
