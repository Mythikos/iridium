/** Real TCP source identity and Origin are observable at the peer, including on Windows. */
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { noteClientWebSocket } from './clients/note-client.ts';
import { withDeadline } from './harness/deadline.ts';

const SOURCE_ADDRESSES = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5'];

describe('testkit.origin-ws.unit [area:testkit]', () => {
  it.each(SOURCE_ADDRESSES)(
    'binds real source %s and retains the authenticated Origin header',
    async (localAddress) => {
      const server = createServer();
      const websocketServer = new WebSocketServer({ server });
      const transports = new Set<Socket>();
      server.on('connection', (socket) => {
        transports.add(socket);
        socket.once('close', () => transports.delete(socket));
      });
      const received = new Promise<{ address: string | undefined; origin: string | undefined }>(
        (resolve) => {
          websocketServer.once('connection', (_socket, request) =>
            resolve({
              address: request.socket.remoteAddress,
              origin: request.headers.origin,
            }),
          );
        },
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('A TCP listener is required.');
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const BoundSocket = noteClientWebSocket({ defaultOrigin: origin, localAddress });
      const client = new BoundSocket(`ws://127.0.0.1:${String(address.port)}/collab`);
      const connected = new Promise<void>((resolve, reject) => {
        client.once('open', resolve);
        client.once('error', reject);
      });
      try {
        const [peer] = await withDeadline(Promise.all([received, connected]), {
          timeoutMs: 4_000,
          description: 'the actual source-address WebSocket handshake',
        });
        expect(peer).toEqual({ address: localAddress, origin });
      } finally {
        const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
        client.terminate();
        for (const websocket of websocketServer.clients) websocket.terminate();
        for (const socket of transports) socket.destroy();
        await Promise.all([
          closed,
          new Promise<void>((resolve, reject) =>
            websocketServer.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
        ]);
      }
    },
  );
});
