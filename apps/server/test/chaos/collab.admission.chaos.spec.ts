import { describe, expect, it } from 'vitest';

import { ROUTINE_ITERATIONS } from '../support/collab-chaos.ts';
import { startCollab } from '../support/collab-harness.ts';

describe.each(Array.from({ length: ROUTINE_ITERATIONS }, (_, index) => index))(
  'collab.admission.chaos [hp:HP-5] iteration %i',
  () => {
    it('releases the count and byte reservations through fifty cycles across twenty notes and four concurrent workers', async () => {
      const harness = await startCollab({
        mode: 'child',
        limits: { maxLoadedDocs: 8, maxStateBytesTotal: '2MiB' },
      });
      try {
        await harness.server.waitReady();
        const cast = await harness.server.seed.kernel();
        const notes = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            harness.server.seed.note({
              vault: cast.vault,
              name: `Churn ${String(index)}`,
              markdown: `note ${String(index)}`,
            }),
          ),
        );
        const users = [cast.editorA, cast.editorB, cast.editorC, cast.admin];
        const metric = 'iridium_docs_loaded';
        await Promise.all(
          users.map(async (user, worker) => {
            for (let cycle = worker; cycle < 50; cycle += users.length) {
              const note = notes[cycle % notes.length];
              if (note === undefined) throw new Error('Every churn cycle needs a real note.');
              // eslint-disable-next-line no-await-in-loop -- each worker closes its attachment before its next cycle
              const client = await harness.open(user, note.id);
              // eslint-disable-next-line no-await-in-loop -- authenticated initial baseline is part of each admission
              await client.waitFor('saved');
              client.marker(`churn-${String(cycle)}`);
              // eslint-disable-next-line no-await-in-loop -- every accepted update must be durable before unloading
              await client.waitFor('saved');
              // eslint-disable-next-line no-await-in-loop -- unload owns the reservation, not the client
              await client.close();
              // eslint-disable-next-line no-await-in-loop -- do not outrun production unload debounce and turn churn into capacity pressure
              await expect
                .poll(async () => (await harness.server.metrics())[metric], { timeout: 15_000 })
                .toBeLessThanOrEqual(3);
            }
          }),
        );
        await expect
          .poll(async () => (await harness.server.metrics())[metric], { timeout: 15_000 })
          .toBe(0);
        const metrics = await harness.server.metrics();
        expect(metrics['iridium_collab_state_bytes']).toBe(0);
        expect(
          Object.entries(metrics)
            .filter(([key]) => key.startsWith('iridium_collab_admission_refused_total'))
            .every(([, value]) => value === 0),
        ).toBe(true);
        expect(harness.logs.some((line) => line.includes('collab.hook.error'))).toBe(false);
      } finally {
        await harness.close();
      }
    }, 180_000);
  },
);
