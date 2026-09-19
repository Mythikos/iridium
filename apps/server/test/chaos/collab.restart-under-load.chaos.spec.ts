import {
  createNoteDoc,
  decodeStateVector,
  dominates,
  LOAD_ORIGIN,
  loadState,
  projectMarkdown,
  stateVector,
  type StateVector,
} from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { asStateVector } from '../../src/collab/persistence/testing/bytes.ts';
import { NIGHTLY_CHAOS } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.restart-under-load.chaos [hp:HP-2]', () => {
  it.skipIf(!NIGHTLY_CHAOS).each(Array.from({ length: 40 }, (_, index) => index))(
    'recovers every acknowledged marker from forty live editors after kill window %i',
    async (iteration) => {
      const harness = await startCollab({ mode: 'child' });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const notes = await Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            harness.server.seed.note({
              vault: cast.vault,
              name: `Loaded ${String(index)}`,
              markdown: `load ${String(index)}\n`,
            }),
          ),
        );
        const clients = await Promise.all(
          notes.flatMap((note) =>
            [cast.editorA, cast.editorB, cast.editorC, cast.admin].map((user) =>
              harness.open(user, note.id, {
                flushDelayMs: false,
                role: user.isServerAdmin ? 'manager' : 'editor',
              }),
            ),
          ),
        );
        await Promise.all(clients.map((client) => client.waitFor('saved')));
        const produced: { note: number; marker: string; sv: StateVector }[] = [];
        // A deterministic uniform permutation of the 40 half-second slots makes failed windows replayable.
        const killAt = (((iteration * 17) % 40) + 1) * 500;
        const began = Date.now();
        for (let tick = 0; tick * 500 < killAt; tick++) {
          clients.forEach((client, index) => {
            produced.push({
              note: Math.floor(index / 4),
              marker: client.marker(`load-${String(index)}-${String(tick)}`),
              sv: stateVector(client.ydoc),
            });
          });
          // eslint-disable-next-line no-await-in-loop -- sustain the specified two edits/second until this case's kill slot
          await expect
            .poll(() => Date.now() - began, { timeout: 2_000, interval: 25 })
            .toBeGreaterThanOrEqual((tick + 1) * 500);
        }
        await harness.server.kill('SIGKILL');
        expect(harness.server.lastExit).not.toBeNull();
        expect(harness.server.lastExit?.code).not.toBe(0);
        const acknowledged = produced.filter((edit) =>
          clients
            .slice(edit.note * 4, edit.note * 4 + 4)
            .some((client) =>
              client.stateless.some(
                (message) =>
                  message.t === 'persisted' &&
                  dominates(
                    decodeStateVector(asStateVector(Buffer.from(message.sv, 'base64'))),
                    edit.sv,
                  ),
              ),
            ),
        );
        await Promise.all(clients.map((client) => client.close()));
        await harness.server.restart();
        const fresh = await Promise.all(
          notes.flatMap((note) =>
            [cast.editorA, cast.editorB, cast.editorC, cast.admin].map((user) =>
              harness.open(user, note.id, { role: user.isServerAdmin ? 'manager' : 'editor' }),
            ),
          ),
        );
        for (const [index, note] of notes.entries()) {
          // eslint-disable-next-line no-await-in-loop -- each note's fresh replay is an independent durable-prefix oracle
          const durable = await expectConverged(
            harness,
            note.id,
            fresh.slice(index * 4, index * 4 + 4),
          );
          const acknowledgedEdits = acknowledged.filter((entry) => entry.note === index);
          expect(acknowledgedEdits.length).toBeGreaterThan(0);
          for (const edit of acknowledgedEdits)
            expect(durable.text.split(edit.marker)).toHaveLength(2);
          const acknowledgedSequences = new Set(
            clients
              .slice(index * 4, index * 4 + 4)
              .flatMap((client) =>
                client.stateless.flatMap((message) =>
                  message.t === 'persisted' ? [message.seq] : [],
                ),
              ),
          );
          // Rebuild every committed prefix from its V1 log, independently of the final snapshot.
          // A live client's text at ack time may already contain a later unacknowledged edit.
          // eslint-disable-next-line no-await-in-loop -- inspect each note's actual acknowledged transaction prefixes
          const rows = await harness.sql.rows(
            `SELECT seq, HEX(update_v1) FROM ${harness.server.schema}.note_updates WHERE note_id=UNHEX('${note.id.replaceAll('-', '')}') ORDER BY seq;`,
          );
          const replay = createNoteDoc({ gc: true });
          try {
            const acknowledgedLengths: number[] = [];
            for (const row of rows) {
              loadState(replay, Buffer.from(row[1] ?? '', 'hex'), 1, LOAD_ORIGIN);
              if (acknowledgedSequences.has(Number(row[0])))
                acknowledgedLengths.push(projectMarkdown(replay).length);
            }
            expect(acknowledgedLengths).toHaveLength(acknowledgedSequences.size);
            expect(
              acknowledgedLengths.every(
                (length, offset) =>
                  length >= (acknowledgedLengths[offset - 1] ?? note.markdown.length),
              ),
            ).toBe(true);
            expect(projectMarkdown(replay)).toBe(durable.text);
            expect(durable.text.length).toBeGreaterThanOrEqual(
              acknowledgedLengths.at(-1) ?? note.markdown.length,
            );
          } finally {
            replay.destroy();
          }
          expect(durable.contentInvalid).toBe(false);
          expect(durable.oversize).toBe(false);
          expect(durable.text.startsWith(note.markdown)).toBe(true);
        }
      } finally {
        await harness.close();
      }
    },
    600_000,
  );
});
