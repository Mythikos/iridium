// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form; each `expect` runs inside the property's own test body.
/**
 * `persistence.model.prop` — the writer/loader model over the in-memory store, the `unit` mirror of
 * `apps/server/test/property/persistence.model.prop.spec.ts` (10-testing-and-quality.md,
 * "`persistence.model.prop` — the writer/loader model"; HP-1, HP-2).
 *
 * The commands and the invariants are `testing/model.ts`, shared with the MySQL-backed file; what
 * differs here is only the store, so the model runs at `PROP` strength every night without a
 * database round trip per command.
 */
import { it } from '@fast-check/vitest';
import { normalizeSource } from '@iridium/markdown';
import { noteText, PROP, PROP_DB } from '@iridium/testkit';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { ManualClock } from '../../../test/support/manual-clock.ts';
import { recordingLogger } from './testing/harness.ts';
import { MemoryPersistenceStore } from './testing/memory-store.ts';
import {
  assertCoalescingPreservesSemantics,
  assertLoad,
  ConcurrentWriterCommand,
  createModelReal,
  initialModel,
  InsertCommand,
  memoryModelStore,
  persistenceCommands,
  type ModelReal,
} from './testing/model.ts';
import { runScheduledPersistence } from './testing/scheduled-model.ts';

/**
 * The alphabet, minus lone surrogate halves: a Yjs update is UTF-8 on the wire, so a lone half
 * becomes U+FFFD in every peer and every row — the one input the live document and the store would
 * legitimately disagree on, and one no editor produces.
 */
const text = noteText({ minLength: 1, maxLength: 12 }).filter((value) => value.isWellFormed());
/** The seed goes through the product's own normalisation, as `NoteService.initialize` runs it. */
const seed = noteText({ maxLength: 24 })
  .filter((value) => value.isWellFormed())
  .map((value) => normalizeSource(value).text);

describe('persistence.memory-model.prop [spec:durable-saving] [hp:HP-1] [hp:HP-2]', () => {
  it('serializes the memory row lock before concurrent writers read their drafts (seed 1530339404)', async () => {
    const real = await createModelReal({
      modelStore: memoryModelStore(new MemoryPersistenceStore()),
      clock: new ManualClock(),
      logger: recordingLogger(),
      markdown: '',
      random: () => 0.5,
    });
    try {
      await new ConcurrentWriterCommand(' ').run(initialModel(''), real);
    } finally {
      real.dispose();
    }
  });
  it.prop(
    [seed, fc.commands(persistenceCommands(text), { maxCommands: PROP_DB.maxCommands })],
    PROP,
  )(
    'every command sequence keeps the nine invariants of the writer, the loader and the compactor',
    async (markdown, commands) => {
      const built: { real: ModelReal | null } = { real: null };
      try {
        await fc.asyncModelRun(async () => {
          const store = new MemoryPersistenceStore();
          const real = await createModelReal({
            modelStore: memoryModelStore(store),
            clock: new ManualClock(),
            logger: recordingLogger(),
            markdown,
            random: () => 0.5,
          });
          built.real = real;
          return { model: initialModel(markdown), real };
        }, commands);
        const opened = built.real;
        if (opened === null) throw new Error('the model run built no real');
        if (!opened.writer.state.startsWith('trashed')) {
          await opened.writer.drain();
          const view = await opened.view();
          expect(view.headSeq).toBeGreaterThanOrEqual(1);
          await assertCoalescingPreservesSemantics(opened);
          await assertLoad(opened, {
            text: '',
            committed: null,
            pending: 1,
            compacted: false,
            trashed: false,
            headSeen: view.headSeq,
          });
        }
      } finally {
        built.real?.dispose();
      }
    },
  );
  it.prop([fc.scheduler(), fc.array(text, { minLength: 2, maxLength: 12 })], PROP)(
    'survives scheduled enqueue, compaction, load, crash and client disconnect races',
    (scheduler, edits) =>
      runScheduledPersistence(scheduler, edits, (markdown) =>
        createModelReal({
          modelStore: memoryModelStore(new MemoryPersistenceStore()),
          clock: new ManualClock(),
          logger: recordingLogger(),
          markdown,
          random: () => 0.5,
        }),
      ),
  );
  it('keeps cursor positions on code-point boundaries after an astral concurrent edit (seed 741368818)', async () => {
    const real = await createModelReal({
      modelStore: memoryModelStore(new MemoryPersistenceStore()),
      clock: new ManualClock(),
      logger: recordingLogger(),
      markdown: ' ',
      random: () => 0.5,
    });
    const model = initialModel(' ');
    try {
      await new InsertCommand(0, 0, ' ').run(model, real);
      await new ConcurrentWriterCommand('𐀀  \n𐀀 ').run(model, real);
      await new InsertCommand(0, 0.09, ' ').run(model, real);
      await real.writer.drain();
      await assertLoad(real, { ...model, pending: 0 });
      expect(model.text.isWellFormed()).toBe(true);
    } finally {
      real.dispose();
    }
  });
});
