/** A refusal before the websocket plugin's onRequest still owns and releases the raw TCP socket. */
import { errorMonitor, type EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';

import { createDeferred, withDeadline } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import {
  buildWithoutDatabase,
  NO_DATABASE_HOST,
  NO_DATABASE_ORIGIN,
} from '../../test/support/no-database-app.ts';

/** Read the complete HTTP refusal while deliberately leaving the client's write half open. */
function responseOf(socket: Socket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const separator = received.indexOf('\r\n\r\n');
      if (separator < 0) return;
      const header = received.subarray(0, separator).toString('ascii');
      const status = Number(/^HTTP\/1\.1 (\d{3}) /u.exec(header)?.[1]);
      const length = Number(/\r\ncontent-length: (\d+)/iu.exec(header)?.[1]);
      if (!Number.isSafeInteger(status) || !Number.isSafeInteger(length)) {
        reject(new Error('The readiness refusal must have a status and Content-Length.'));
        return;
      }
      const bodyStart = separator + 4;
      if (received.length < bodyStart + length) return;
      resolve({ status, body: received.subarray(bodyStart, bodyStart + length).toString('utf8') });
    });
  });
}

describe('collab.upgrade-cleanup.unit [area:collab]', () => {
  it('closes an early-denied raw upgrade and completes product shutdown without client assistance', async () => {
    const harness = await buildWithoutDatabase();
    const app = harness.app;
    const peers = new Set<Socket>();
    const peerClosed = createDeferred<void>();
    const initializedAtResponse: unknown[] = [];
    let client: Socket | null = null;
    app.server.on('connection', (socket) => {
      peers.add(socket);
      socket.once('close', () => {
        peers.delete(socket);
        peerClosed.resolve(undefined);
      });
    });
    app.addHook('onResponse', async (request) => {
      initializedAtResponse.push(request.ws);
    });
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      await app.drain();
      expect(app.readiness.state).toBe('not_ready');
      const address = app.server.address();
      if (address === null || typeof address === 'string')
        throw new Error('The product must listen on a real TCP port.');
      // A half-open peer never sends FIN for us: only the product can satisfy the close assertion.
      client = createConnection({ host: '127.0.0.1', port: address.port, allowHalfOpen: true });
      const response = responseOf(client);
      client.write(
        [
          'GET /collab HTTP/1.1',
          `Host: ${NO_DATABASE_HOST}`,
          `Origin: ${NO_DATABASE_ORIGIN}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          '',
          '',
        ].join('\r\n'),
      );
      const refused = await withDeadline(response, {
        timeoutMs: 2_000,
        description: 'the real readiness gate to reject an incomplete upgrade',
      });
      expect(refused.status).toBe(503);
      expect(JSON.parse(refused.body)).toMatchObject({ status: 503, code: 'not_ready' });
      expect(initializedAtResponse).toEqual([null]);
      expect(app.websocketServer.clients.size).toBe(0);
      expect(app.collab.server.loadedDocuments()).toEqual([]);
      await withDeadline(Promise.all([peerClosed.promise, app.close()]), {
        timeoutMs: 1_000,
        description: 'the denied raw upgrade and the product listener to close',
      });
      expect(peers.size).toBe(0);
      expect(app.server.listening).toBe(false);
    } finally {
      // Cleanup happens after the bounded assertion, so it cannot conceal a leaked upgrade.
      client?.destroy();
      for (const socket of peers) socket.destroy();
      await withDeadline(harness.close(), {
        timeoutMs: 2_000,
        description: 'the upgrade regression to release its remaining resources',
      });
    }
  });
  it.each(['during admission', 'after ws handoff'] as const)(
    'owns a real client TCP reset %s without retaining the admission handler',
    async (phase) => {
      const harness = await buildWithoutDatabase();
      const app = harness.app;
      const entered = createDeferred<Socket>();
      const release = createDeferred<void>();
      const upgraded = createDeferred<Socket>();
      const peerClosed = createDeferred<void>();
      const reset = createDeferred<Error>();
      const peers = new Set<Socket>();
      const clientErrors: Error[] = [];
      let client: Socket | null = null;
      app.server.on('connection', (socket) => {
        peers.add(socket);
        // errorMonitor observes but does not handle an otherwise-unhandled Socket error.
        const events: EventEmitter = socket;
        events.on(errorMonitor, (error: Error) => reset.resolve(error));
        socket.once('close', () => {
          peers.delete(socket);
          peerClosed.resolve(undefined);
        });
      });
      app.addHook('onRequest', async (request) => {
        if (request.url !== '/collab') return;
        entered.resolve(request.raw.socket);
        await release.promise;
      });
      app.websocketServer.once('connection', (_socket, request) => {
        upgraded.resolve(request.socket);
      });
      try {
        await app.listen({ host: '127.0.0.1', port: 0 });
        const address = app.server.address();
        if (address === null || typeof address === 'string')
          throw new Error('The product must listen on a real TCP port.');
        client = createConnection({ host: '127.0.0.1', port: address.port });
        client.on('error', (error) => clientErrors.push(error));
        client.write(
          [
            'GET /collab HTTP/1.1',
            `Host: ${NO_DATABASE_HOST}`,
            `Origin: ${NO_DATABASE_ORIGIN}`,
            'Connection: Upgrade',
            'Upgrade: websocket',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            '',
            '',
          ].join('\r\n'),
        );
        const peer = await withDeadline(entered.promise, {
          timeoutMs: 2_000,
          description: 'the real upgrade to enter the held onRequest hook',
        });
        // Fail safely before injecting a reset on an unpatched install. The later real error must
        // still be observed, so a listener count alone cannot make the regression pass.
        expect(peer.listenerCount('error')).toBe(1);
        const admissionHandlers = peer.listeners('error');
        let transferred: Socket | null = null;
        if (phase === 'after ws handoff') {
          release.resolve(undefined);
          transferred = await withDeadline(upgraded.promise, {
            timeoutMs: 2_000,
            description: 'ws to accept the socket after admission resumes',
          });
        }
        expect(transferred).toBe(phase === 'after ws handoff' ? peer : null);
        expect(peer.listenerCount('error')).toBe(1);
        expect(peer.listeners('error').some((handler) => admissionHandlers.includes(handler))).toBe(
          phase === 'during admission',
        );
        client.resetAndDestroy();
        const [error] = await withDeadline(Promise.all([reset.promise, peerClosed.promise]), {
          timeoutMs: 2_000,
          description: 'the actual TCP reset and its server socket close',
        });
        expect(error).toMatchObject({ code: 'ECONNRESET' });
        for (const handler of admissionHandlers)
          expect(peer.listeners('error')).not.toContain(handler);
        release.resolve(undefined);
        expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
        expect(app.server.listening).toBe(true);
        expect(clientErrors).toEqual([]);
        await app.drain();
        await withDeadline(app.close(), {
          timeoutMs: 1_000,
          description: 'the product to close after the handled upgrade reset',
        });
        expect(peers.size).toBe(0);
      } finally {
        release.resolve(undefined);
        client?.destroy();
        for (const socket of peers) socket.destroy();
        await withDeadline(harness.close(), {
          timeoutMs: 2_000,
          description: 'the reset regression to release its remaining resources',
        });
      }
    },
  );
});
