import { LIMITS } from '@iridium/contracts';
import { FRAME_TYPE, peekFrame, type FrameHeader } from '@iridium/crdt';
import {
  awarenessFrame,
  createCollabSocket,
  createDeferred,
  noteClientWebSocket,
  openOriginWebSocket,
  statelessFrame,
  withDeadline,
  type TestWebSocket,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

const NOTE_NAME = 'note:0190f2a0-0000-7000-8000-000000000001';

function authenticationFrame(routingKey: string, ticket = ''): Uint8Array {
  const template = statelessFrame({ documentName: routingKey, payload: ticket });
  const header = peekFrame(template);
  if (header === null) throw new Error('The fixture encoder must emit a complete header.');
  return Uint8Array.from([
    ...template.subarray(0, header.bodyOffset - 1),
    FRAME_TYPE.auth,
    0,
    ...template.subarray(header.bodyOffset),
  ]);
}

function closeFrame(routingKey: string): Uint8Array {
  const template = statelessFrame({ documentName: routingKey, payload: '' });
  const header = peekFrame(template);
  if (header === null) throw new Error('The fixture encoder must emit a complete header.');
  template[header.bodyOffset - 1] = FRAME_TYPE.close;
  return template;
}

async function rawClient(
  url: string,
  origin: string,
): Promise<{
  readonly socket: TestWebSocket;
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
  next(accept: (header: FrameHeader, bytes: Uint8Array) => boolean): Promise<Uint8Array>;
  close(): Promise<void>;
}> {
  const socket = openOriginWebSocket(url, { origin });
  const opened = createDeferred<void>();
  const closed = createDeferred<{ code: number; reason: string }>();
  const waiters = new Set<{
    accept: (header: FrameHeader, bytes: Uint8Array) => boolean;
    resolve: (bytes: Uint8Array) => void;
  }>();
  socket.once('open', () => opened.resolve(undefined));
  socket.on('error', (error) => opened.reject(error));
  socket.once('close', (code, reason) => closed.resolve({ code, reason: reason.toString() }));
  socket.on('message', (data) => {
    const bytes =
      data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (bytes === null) return;
    const header = peekFrame(bytes);
    if (header === null) return;
    for (const waiter of waiters) {
      if (!waiter.accept(header, bytes)) continue;
      waiters.delete(waiter);
      waiter.resolve(bytes);
    }
  });
  try {
    await withDeadline(opened.promise, {
      timeoutMs: 2_000,
      description: 'the real pre-auth socket to open',
    });
  } catch (error) {
    socket.terminate();
    throw error;
  }
  return {
    socket,
    closed: closed.promise,
    next(accept) {
      const result = createDeferred<Uint8Array>();
      const waiter = { accept, resolve: (bytes: Uint8Array) => result.resolve(bytes) };
      waiters.add(waiter);
      return withDeadline(result.promise, {
        timeoutMs: 2_000,
        description: 'the actual Hocuspocus response',
      }).finally(() => waiters.delete(waiter));
    },
    async close() {
      try {
        socket.close();
        await withDeadline(closed.promise, {
          timeoutMs: 2_000,
          description: 'the owned raw socket to close',
        });
      } finally {
        socket.terminate();
      }
    },
  };
}

describe('collab.awareness-rate.integration [hp:HP-5]', () => {
  it('drops the eleventh awareness message independently per document on a shared socket and immediately accepts sync', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock });
    const socket = createCollabSocket({
      url: harness.server.wsUrl,
      webSocketPolyfill: noteClientWebSocket({ defaultOrigin: harness.server.origin }),
    });
    try {
      const cast = await harness.server.seed.kernel();
      const another = await harness.server.seed.note({
        vault: cast.vault,
        name: 'Independent awareness',
        markdown: 'second',
      });
      const senders = await Promise.all(
        [cast.note, another].map((note) => harness.open(cast.editorA, note.id, { socket })),
      );
      const observers = await Promise.all(
        [cast.note, another].map((note) => harness.open(cast.editorB, note.id)),
      );
      await Promise.all([...senders, ...observers].map((client) => client.waitFor('saved')));
      await clock.advance(1_001);
      const metric = 'iridium_collab_messages_total{type="awareness_dropped"}';
      const before = (await harness.server.metrics())[metric] ?? 0;
      const finalClocks: number[] = [];
      for (const sender of senders) {
        const current = sender.provider?.awareness?.meta.get(sender.clientId)?.clock;
        if (current === undefined)
          throw new Error('A connected client must have advertised its identity.');
        finalClocks.push(current + LIMITS.AWARENESS_MESSAGES_PER_SECOND);
        for (let frame = 1; frame <= LIMITS.AWARENESS_MESSAGES_PER_SECOND + 1; frame++) {
          sender.sendAwarenessFrame([
            {
              clientId: sender.clientId,
              clock: current + frame,
              state: { user: { id: sender.userId }, mode: 'reading' },
            },
          ]);
        }
      }
      await expect.poll(async () => (await harness.server.metrics())[metric]).toBe(before + 2);
      for (const [index, observer] of observers.entries()) {
        const sender = senders[index];
        if (sender === undefined) throw new Error('Each note needs one sender.');
        // eslint-disable-next-line no-await-in-loop -- compare independent wire recipients against their own per-document budget
        await expect
          .poll(() => observer.provider?.awareness?.meta.get(sender.clientId)?.clock)
          .toBe(finalClocks[index]);
        sender.marker(`sync-after-presence-${String(index)}`);
        // eslint-disable-next-line no-await-in-loop -- syncing must not consume the awareness window or wait for it to reset
        await expectConverged(harness, index === 0 ? cast.note.id : another.id, [sender, observer]);
      }
      expect([...senders, ...observers].every((client) => client.closes.length === 0)).toBe(true);
      expect(
        (await harness.server.metrics())[
          'iridium_collab_hook_errors_total{hook="beforeHandleAwareness"}'
        ] ?? 0,
      ).toBe(0);
    } finally {
      await harness.close();
      socket.destroy();
    }
  });
  it('bounds awareness counters through repeated pre-auth frames and refused Auth, then expires them while idle', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock });
    let wire: Awaited<ReturnType<typeof rawClient>> | undefined;
    try {
      wire = await rawClient(harness.server.wsUrl, harness.server.origin);
      const server = harness.application().collab.server;
      const metric = 'iridium_collab_messages_total{type="awareness_dropped"}';
      const before = (await harness.server.metrics())[metric] ?? 0;
      const attempts = LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET * 3;
      for (let index = 0; index < attempts; index++) {
        const name = 'note:0190f2a0-0000-7000-8000-' + index.toString().padStart(12, '0');
        const refused = wire.next(
          (header, bytes) =>
            header.routingKey === name &&
            header.type === FRAME_TYPE.auth &&
            bytes[header.bodyOffset] === 1,
        );
        wire.socket.send(awarenessFrame({ documentName: name, entries: [] }));
        wire.socket.send(authenticationFrame(name));
        // eslint-disable-next-line no-await-in-loop -- every refusal must free Hocuspocus's queue before the next distinct name reproduces the leak
        await refused;
        expect(server.awarenessWindowCount()).toBe(
          Math.min(index + 1, LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET),
        );
      }
      expect(wire.socket.readyState).toBe(1);
      expect(server.loadedDocuments()).toEqual([]);
      expect((await harness.server.metrics())[metric]).toBe(
        before + attempts - LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET,
      );
      await clock.advance(1_000);
      expect(server.awarenessWindowCount()).toBe(0);
      expect(wire.socket.readyState).toBe(1);
    } finally {
      try {
        await wire?.close();
      } finally {
        await harness.close();
      }
    }
  });

  it.each([
    ['oversized document name', 'note:' + 'a'.repeat(65_536)],
    [
      'oversized session suffix',
      NOTE_NAME + '\0' + 'a'.repeat(LIMITS.COLLAB_SESSION_ID_MAX_CHARS + 1),
    ],
    ['second NUL', NOTE_NAME + '\0first\0second'],
    ['empty session suffix', NOTE_NAME + '\0'],
    ['non-ASCII session suffix', NOTE_NAME + '\0café'],
    ['noncanonical document name', NOTE_NAME.toUpperCase()],
  ])('refuses %s before any pre-auth key is retained', async (_label, name) => {
    const harness = await startCollab();
    let wire: Awaited<ReturnType<typeof rawClient>> | undefined;
    try {
      wire = await rawClient(harness.server.wsUrl, harness.server.origin);
      wire.socket.send(awarenessFrame({ documentName: name, entries: [] }));
      await expect(
        withDeadline(wire.closed, {
          timeoutMs: 2_000,
          description: 'invalid routing to close before auth',
        }),
      ).resolves.toEqual({ code: 4403, reason: 'protocol-error' });
      expect(harness.application().collab.server.awarenessWindowCount()).toBe(0);
      expect(harness.application().collab.server.loadedDocuments()).toEqual([]);
    } finally {
      try {
        await wire?.close();
      } finally {
        await harness.close();
      }
    }
  });

  it('preserves independent authenticated suffix attachments and their shared document quota after one closes', async () => {
    const clock = new ManualClock();
    const harness = await startCollab({ clock });
    let wire: Awaited<ReturnType<typeof rawClient>> | undefined;
    try {
      wire = await rawClient(harness.server.wsUrl, harness.server.origin);
      const cast = await harness.server.seed.kernel();
      const tickets = await harness.server.tickets.issue(cast.editorA, 2);
      const noteName = 'note:' + cast.note.id;
      const names = [
        noteName + '\0' + 'a'.repeat(LIMITS.COLLAB_SESSION_ID_MAX_CHARS),
        noteName + '\0session-B_1',
      ];
      for (const [index, name] of names.entries()) {
        const ticket = tickets[index];
        if (ticket === undefined) throw new Error('Both attachments need a real ticket.');
        const accepted = wire.next(
          (header, bytes) =>
            header.routingKey === name &&
            header.type === FRAME_TYPE.auth &&
            bytes[header.bodyOffset] === 2,
        );
        wire.socket.send(authenticationFrame(name, ticket));
        // eslint-disable-next-line no-await-in-loop -- observe each independent authenticated routing address
        await accepted;
      }
      const server = harness.application().collab.server;
      await expect
        .poll(() => server.hocuspocus.documents.get(noteName)?.getConnectionsCount())
        .toBe(2);
      const document = server.hocuspocus.documents.get(noteName);
      if (document === undefined) throw new Error('The authenticated note must be loaded.');
      const [first, second] = names;
      if (first === undefined || second === undefined)
        throw new Error('The fixture needs two suffixes.');
      const metric = 'iridium_collab_messages_total{type="awareness_dropped"}';
      const before = (await harness.server.metrics())[metric] ?? 0;
      for (let frame = 1; frame <= LIMITS.AWARENESS_MESSAGES_PER_SECOND; frame++) {
        wire.socket.send(
          awarenessFrame({
            documentName: frame % 2 === 0 ? second : first,
            entries: [
              {
                clientId: frame % 2 === 0 ? 102 : 101,
                clock: frame,
                state: { user: { id: cast.editorA.id } },
              },
            ],
          }),
        );
      }
      await expect
        .poll(() => document.awareness.meta.get(102)?.clock)
        .toBe(LIMITS.AWARENESS_MESSAGES_PER_SECOND);
      expect(server.awarenessWindowCount()).toBe(1);
      const firstClosed = wire.next(
        (header) => header.routingKey === first && header.type === FRAME_TYPE.close,
      );
      wire.socket.send(closeFrame(first));
      await firstClosed;
      expect(document.getConnectionsCount()).toBe(1);
      wire.socket.send(
        awarenessFrame({
          documentName: second,
          entries: [{ clientId: 102, clock: 11, state: { user: { id: cast.editorA.id } } }],
        }),
      );
      await expect.poll(async () => (await harness.server.metrics())[metric]).toBe(before + 1);
      expect(document.awareness.meta.get(102)?.clock).toBe(LIMITS.AWARENESS_MESSAGES_PER_SECOND);
      expect(wire.socket.readyState).toBe(1);
      await clock.advance(1_000);
      expect(server.awarenessWindowCount()).toBe(0);
      wire.socket.send(
        awarenessFrame({
          documentName: second,
          entries: [{ clientId: 102, clock: 12, state: { user: { id: cast.editorA.id } } }],
        }),
      );
      await expect.poll(() => document.awareness.meta.get(102)?.clock).toBe(12);
      expect(document.getConnections()[0]?.sessionId).toBe('session-B_1');
      expect(wire.socket.readyState).toBe(1);
      await wire.close();
      await expect.poll(() => server.awarenessWindowCount()).toBe(0);
    } finally {
      try {
        await wire?.close();
      } finally {
        await harness.close();
      }
    }
  });
});
