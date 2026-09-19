import { FRAME_TYPE, peekFrame, peekStatelessPayload } from '@iridium/crdt';
import {
  createNoteClient,
  warnsBeforeUnload,
  restTicketSource,
  type NoteClient,
  createCollabSocket,
  noteClientWebSocket,
  connectToxiproxy,
  COLLAB_PROXY_NAME,
  type ToxicSpec,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import { NIGHTLY_CHAOS } from '../support/collab-chaos.ts';
import { expectConverged, startCollab } from '../support/collab-harness.ts';

const cases: readonly ToxicSpec[] = [
  { type: 'latency', attributes: { latency: 800, jitter: 400 } },
  ...(NIGHTLY_CHAOS
    ? ([
        { type: 'bandwidth', attributes: { rate: 30 } },
        { type: 'slicer', attributes: { average_size: 128, size_variation: 64, delay: 10 } },
        { type: 'limit_data', attributes: { bytes: 65_536 } },
        { type: 'reset_peer', attributes: { timeout: 0 } },
        // Keep the TCP stream open while dropping every server message, exercising the real watchdog.
        { type: 'timeout', attributes: { timeout: 0 } },
      ] satisfies readonly ToxicSpec[])
    : []),
];

describe('collab.network-degradation.chaos [hp:HP-5]', () => {
  it.each(cases)(
    'preserves pending edits and converges after actual $type transport degradation',
    async (spec) => {
      const provided = inject('iridiumToxiproxy');
      const proxy = connectToxiproxy(provided.controlUrl).proxy(
        COLLAB_PROXY_NAME,
        provided.collabProxy.host,
        provided.collabProxy.port,
      );
      const harness = await startCollab({ mode: 'child', port: provided.collabServerPort });
      const sockets: ReturnType<typeof createCollabSocket>[] = [];
      const attempts: number[][] = [];
      const transportErrors: string[] = [];
      const clients: NoteClient[] = [];
      const wire: { auth: number; baseline: number; tickets: string[] }[] = [];
      try {
        await harness.server.waitReady();
        expect(harness.server.port).toBe(provided.collabServerPort);
        const proxyHealth = await fetch(proxy.uri('http', '/healthz'), {
          signal: AbortSignal.timeout(5_000),
        });
        expect(proxyHealth.status).toBe(200);
        const cast = await harness.server.seed.kernel();
        const opened = await Promise.all(
          [cast.editorA, cast.editorB, cast.editorC].map(async (user) => {
            const times: number[] = [];
            const observed = { auth: 0, baseline: 0, tickets: [] as string[] };
            wire.push(observed);
            const source = restTicketSource(await harness.server.loginAs(user));
            attempts.push(times);
            const BaseSocket = noteClientWebSocket({
              defaultOrigin: harness.server.origin,
              headers: { host: new URL(harness.server.origin).host },
            });
            class ObservedSocket extends BaseSocket {
              override send(data: string | ArrayBufferLike | ArrayBufferView): void {
                const bytes =
                  typeof data === 'string'
                    ? new TextEncoder().encode(data)
                    : ArrayBuffer.isView(data)
                      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                      : new Uint8Array(data);
                const header = peekFrame(bytes);
                if (header?.type === FRAME_TYPE.auth) observed.auth += 1;
                if (header?.type === FRAME_TYPE.stateless) {
                  const payload = peekStatelessPayload(bytes, header);
                  if (payload !== null) {
                    const decoded: unknown = JSON.parse(payload);
                    if (
                      typeof decoded === 'object' &&
                      decoded !== null &&
                      't' in decoded &&
                      decoded.t === 'baseline'
                    )
                      observed.baseline += 1;
                  }
                }
                super.send(data);
              }
              constructor(address: string | URL, protocols?: string | string[]) {
                super(address, protocols);
                times.push(Date.now());
                this.on('error', (error) => {
                  transportErrors.push(`${String(address)}: ${error.message}`);
                });
              }
            }
            const socket = createCollabSocket({
              url: proxy.uri('ws', '/collab'),
              webSocketPolyfill: ObservedSocket,
            });
            sockets.push(socket);
            return createNoteClient({
              socket,
              noteId: cast.note.id,
              userId: user.id,
              role: 'editor',
              flushDelayMs: false,
              tickets: {
                async next(): Promise<string> {
                  const ticket = await source.next();
                  observed.tickets.push(ticket);
                  return ticket;
                },
                invalidate: (ticket: string) => source.invalidate?.(ticket),
              },
            });
          }),
        );
        clients.push(...opened);
        await expectConverged(harness, cast.note.id, clients).catch((cause: unknown) => {
          throw new Error(JSON.stringify({ transportErrors, logs: harness.logs.slice(-15) }), {
            cause,
          });
        });
        const attemptsBeforeFault = attempts.map((times) => times.length);
        const toxic = await proxy.addToxic(spec);
        const faultAt = Date.now();
        const markers: string[] = [];
        try {
          clients.forEach((client, index) => {
            markers.push(client.marker(`network-${String(index)}`));
            if (spec.type === 'limit_data') client.typeAt(client.text.length, 'x'.repeat(70_000));
            expect(client.saveState).not.toBe('saved');
            expect(client.session.input.unsynced).toBeGreaterThan(0);
          });
          if (spec.type === 'reset_peer' || spec.type === 'limit_data' || spec.type === 'timeout') {
            await Promise.all(
              clients.map((client) => client.waitFor('disconnected', { timeoutMs: 45_000 })),
            );
            if (spec.type === 'limit_data') {
              const warnings = clients.map((client) => warnsBeforeUnload(client.session.input));
              if (!warnings.every(Boolean))
                throw new Error('Dropped updates must retain the before-unload warning.');
            }
          } else {
            // Observe real degraded acknowledgements; no sleep stands in for a delivered frame.
            await Promise.all(
              clients.map((client) => client.waitFor('saved', { timeoutMs: 35_000 })),
            );
          }
          const automaticAttempts =
            spec.type === 'reset_peer' ? 7 : spec.type === 'timeout' ? 1 : 0;
          await expect
            .poll(
              () =>
                attempts.every(
                  (times, index) =>
                    times.length >= (attemptsBeforeFault[index] ?? 0) + automaticAttempts,
                ),
              { timeout: 90_000, interval: 50 },
            )
            .toBe(true);
          const retryGaps =
            spec.type === 'reset_peer'
              ? attempts.flatMap((times, index) => {
                  const retries = times.slice(attemptsBeforeFault[index]);
                  return retries.slice(1).map((at, offset) => ({
                    gap: at - (retries[offset] ?? at),
                    ceiling: Math.min(1_000 * 2 ** offset, 30_000),
                  }));
                })
              : [];
          // Node event-loop and local relay latency are outside the jitter timer itself.
          expect(retryGaps.every(({ gap, ceiling }) => gap >= 900 && gap <= ceiling + 2_000)).toBe(
            true,
          );
          expect(
            spec.type !== 'reset_peer' || retryGaps.some(({ gap, ceiling }) => gap < ceiling - 250),
          ).toBe(true);
          const watchdogDelays =
            spec.type === 'timeout'
              ? attempts.map(
                  (times, index) => (times[attemptsBeforeFault[index] ?? 0] ?? 0) - faultAt,
                )
              : [];
          // The pinned provider checks at timeout/10 and force-closes after three unanswered closes.
          expect(watchdogDelays.every((delay) => delay >= 28_000 && delay <= 42_000)).toBe(true);
          expect(
            clients.every((client) =>
              markers.some((marker) => client.text.toJSON().includes(marker)),
            ),
          ).toBe(true);
        } finally {
          await toxic.remove();
        }
        await Promise.all(clients.map((client) => client.disconnectSocket()));
        const beforeReconnect = wire.map((observed) => ({
          auth: observed.auth,
          baseline: observed.baseline,
          tickets: observed.tickets.length,
        }));
        await Promise.all(clients.map((client) => client.reconnectSocket()));
        const recovered = await expectConverged(harness, cast.note.id, clients);
        for (const marker of markers) expect(recovered.text.split(marker)).toHaveLength(2);
        for (const [index, observed] of wire.entries()) {
          const before = beforeReconnect[index];
          expect(observed.auth - (before?.auth ?? 0)).toBe(1);
          expect(observed.baseline - (before?.baseline ?? 0)).toBe(1);
          expect(observed.tickets.length - (before?.tickets ?? 0)).toBe(1);
          expect(new Set(observed.tickets).size).toBe(observed.tickets.length);
        }
        for (const socket of sockets) {
          expect(socket.configuration).toMatchObject({
            messageReconnectTimeout: 30_000,
            factor: 2,
            minDelay: 1_000,
            maxDelay: 30_000,
            jitter: true,
          });
        }
        // Initial connection lifetime includes the deliberate 30s watchdog window; retry gaps
        // themselves were measured above while reset_peer stayed active through the capped attempt.
        expect(attempts.every((times) => times.length >= 2)).toBe(true);
        expect(harness.logs.some((line) => line.includes('collab.hook.error'))).toBe(false);
      } finally {
        await proxy.removeAllToxics();
        await Promise.all(clients.map((client) => client.close()));
        await harness.close();
        sockets.forEach((socket) => socket.destroy());
      }
    },
    180_000,
  );
});
