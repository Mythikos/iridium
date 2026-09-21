/** The fixture drain must preserve real I/O deadlines while driving the product's injected timers. */
import { once } from 'node:events';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

import { waitFor } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { drainWithClock } from '../../test/support/drain-with-clock.ts';
import { ManualClock } from '../../test/support/manual-clock.ts';

describe('harness.drain-clock.unit [area:testkit]', () => {
  it('delivers an overdue interval once after a quota-aging clock jump', async () => {
    const clock = new ManualClock();
    let callbacks = 0;
    const periodic = clock.every(1_000, () => {
      callbacks += 1;
    });
    clock.jump(clock.now() + 600_000);
    const pendingIo = Promise.withResolvers<void>();
    const draining = drainWithClock({ drain: () => pendingIo.promise }, clock);
    try {
      await setImmediate();
      expect(callbacks).toBe(1);
    } finally {
      periodic.cancel();
      pendingIo.resolve();
      await draining;
    }
  });

  it('lets real I/O settle inside its deadline instead of speeding that deadline up', async () => {
    const clock = new ManualClock();
    const pendingIo = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      received.resolve();
      void releaseResponse.promise.then(() => response.end('settled'));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No TCP listener.');
    const io = fetch(`http://127.0.0.1:${String(address.port)}`).then(async (response) => {
      expect(await response.text()).toBe('settled');
      pendingIo.resolve();
      return undefined;
    });
    await received.promise;
    const deadline = clock.after(1_000, () => {
      pendingIo.reject(new Error('real I/O lost its acquisition deadline'));
    });
    const injectedStart = clock.now();
    const realStart = performance.now();
    const draining = drainWithClock({ drain: () => pendingIo.promise }, clock);
    try {
      // Hold an actual socket response across several drain polls. An accelerated fixture clock
      // can reach this boundary before the corresponding host time has elapsed.
      await waitFor(() => clock.now() - injectedStart >= 100, {
        timeoutMs: 1_000,
        intervalMs: 10,
        description: 'multiple clock ticks while the real socket response remains gated',
      });
      expect(clock.now() - injectedStart).toBeLessThanOrEqual(performance.now() - realStart + 10);
      releaseResponse.resolve();
      await expect(draining).resolves.toBeUndefined();
    } finally {
      deadline.cancel();
      releaseResponse.resolve();
      try {
        await Promise.all([io, draining]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      }
    }
  });

  it('propagates a real drain failure instead of treating completion as success', async () => {
    const failure = new Error('the writer could not commit');
    await expect(
      drainWithClock({ drain: () => Promise.reject(failure) }, new ManualClock()),
    ).rejects.toBe(failure);
  });
});
