/**
 * Spike S2 — `@fastify/websocket` 11.3.0 → `hocuspocus.handleConnection` (12-milestones.md §4.4).
 *
 * Question: does `app.get('/collab', { websocket: true, preValidation: [...] })` hand a socket to
 * `hocuspocus.handleConnection(socket, request, context)` with working message/close forwarding,
 * Origin rejection before the upgrade and `maxPayload` enforcement?
 *
 * The route is mounted on the real `buildApp` (in-process, no database), so the security plugin's
 * `onRequest` chain runs in front of the upgrade exactly as it will at M1. Every register criterion
 * is an `expect` below; the additional observations 05-collaboration-and-durability.md asks this
 * spike to record (a close from inside `onStateless`, a throw from `beforeHandleAwareness`, a socket
 * close while `onAuthenticate` is in flight) are asserted too, so M1 can cite them.
 */
import { setTimeout as sleep } from 'node:timers/promises';

import { Hocuspocus, type Connection, type Document } from '@hocuspocus/server';
import { LIMITS } from '@iridium/contracts';
import { getContent, projectMarkdown } from '@iridium/crdt';
import { createDeferred, openOriginWebSocket, waitFor, type Deferred } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSpikeApp, doubleSendLines, type SpikeApp } from './support/app.ts';
import { mountCollab } from './support/collab-mount.ts';
import {
  createSpikeClient,
  loadProviderModule,
  type CloseEventLike,
  type SpikeClient,
} from './support/provider.ts';
import { writeResult } from './support/results.ts';

const DESKTOP_ORIGIN = 'app://iridium';
const THREE_MIB = 3 * 1024 * 1024;

interface HookCounts {
  onRequest: number;
  onUpgrade: number;
  onListen: number;
  onConnect: number;
  onAuthenticate: number;
  onStateless: number;
  beforeHandleAwareness: number;
}

interface UpgradeRefusal {
  readonly status: number;
  readonly body: unknown;
}

type RefusalResponse = NodeJS.ReadableStream & { readonly statusCode?: number };

/** The `ws`-specific event the testkit's declared surface omits: the HTTP response of a refused upgrade. */
interface EmitsUnexpectedResponse {
  on(
    event: 'unexpected-response',
    listener: (request: unknown, response: RefusalResponse) => void,
  ): unknown;
}

function emitsUnexpectedResponse(value: unknown): value is EmitsUnexpectedResponse {
  return (
    typeof value === 'object' && value !== null && 'on' in value && typeof value.on === 'function'
  );
}

/** Open a raw socket and resolve with the HTTP refusal, or reject if the upgrade succeeded. */
function expectRefusedUpgrade(wsUrl: string, origin: string | null): Promise<UpgradeRefusal> {
  return new Promise<UpgradeRefusal>((resolve, reject) => {
    const socket = openOriginWebSocket(wsUrl, { origin });
    socket.on('open', () => {
      socket.close();
      reject(new Error('the upgrade was accepted'));
    });
    socket.on('error', () => {
      // `unexpected-response` below is the interesting signal; the error follows it.
    });
    if (!emitsUnexpectedResponse(socket)) {
      reject(new Error('the socket does not emit unexpected-response'));
      return;
    }
    socket.on('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // a non-JSON body is reported as text
        }
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
  });
}

describe('S2 — @fastify/websocket 11.3.0 hands sockets to hocuspocus.handleConnection', () => {
  let spike: SpikeApp;
  let hocuspocus: Hocuspocus;
  const counts: HookCounts = {
    onRequest: 0,
    onUpgrade: 0,
    onListen: 0,
    onConnect: 0,
    onAuthenticate: 0,
    onStateless: 0,
    beforeHandleAwareness: 0,
  };
  const socketCloses: CloseEventLike[] = [];
  const acceptedSockets: string[] = [];
  let authGate: Deferred<void> | null = null;
  const clients: SpikeClient[] = [];
  const observations: Record<string, unknown> = {};

  beforeAll(async () => {
    spike = await buildSpikeApp();
    hocuspocus = new Hocuspocus({
      quiet: true,
      timeout: 60_000,
      debounce: 50,
      maxDebounce: 200,
      unloadImmediately: true,
      yDocOptions: { gc: true, gcFilter: () => true },
      extensions: [
        {
          async onRequest() {
            counts.onRequest += 1;
          },
          async onUpgrade() {
            counts.onUpgrade += 1;
          },
          async onListen() {
            counts.onListen += 1;
          },
          async onConnect() {
            counts.onConnect += 1;
          },
          async onAuthenticate({ token }) {
            counts.onAuthenticate += 1;
            if (authGate !== null) await authGate.promise;
            if (token !== 'spike-ticket') throw new Error('unauthorized');
            return { userId: 'spike-user' };
          },
          async onStateless({ connection, payload }) {
            counts.onStateless += 1;
            if (payload === 'bad') {
              connection.close({ code: 4403, reason: 'protocol-error' });
              return;
            }
            if (payload === 'ping') connection.sendStateless('pong');
          },
          async beforeHandleAwareness({ states }) {
            counts.beforeHandleAwareness += 1;
            for (const state of states.values()) {
              const user = (state as { user?: { id?: string } }).user;
              if (user?.id === 'spoof') {
                throw Object.assign(new Error('awareness-spoof'), {
                  code: 4403,
                  reason: 'awareness-spoof',
                });
              }
            }
          },
        },
      ],
    });
    await mountCollab(spike.app, hocuspocus, {
      allowlist: [spike.origin, DESKTOP_ORIGIN],
      publicOrigin: spike.origin,
      onSocket: ({ origin }) => acceptedSockets.push(origin),
      onSocketClose: (event) => socketCloses.push(event),
    });
    await spike.listen();
  });

  afterAll(async () => {
    for (const client of clients) client.destroy();
    hocuspocus.closeConnections();
    await spike.close();
    writeResult('s02-observations', {
      hookCounts: counts,
      socketClosesSeenByServer: socketCloses,
      acceptedSocketOrigins: acceptedSockets,
      doubleSendLogLines: doubleSendLines(spike.logLines),
      ...observations,
    });
  });

  async function connect(name: string, origin: string | null = spike.origin): Promise<SpikeClient> {
    const client = await createSpikeClient({ wsUrl: spike.wsUrl, name, origin });
    clients.push(client);
    return client;
  }

  function serverDocument(name: string): Document {
    const document = hocuspocus.documents.get(name);
    if (document === undefined) throw new Error(`document ${name} is not loaded`);
    return document;
  }

  function firstConnection(name: string): Connection {
    const [connection] = serverDocument(name).connections.keys();
    if (connection === undefined) throw new Error(`document ${name} has no connection`);
    return connection;
  }

  it('a provider over the Origin-injecting ws reaches synced, and messages flow both ways', async () => {
    const before = counts.onConnect;
    const client = await connect('note:s2-sync');
    await client.waitSynced();
    expect(client.provider.isAuthenticated).toBe(true);
    expect(counts.onConnect).toBe(before + 1);
    expect(acceptedSockets.at(-1)).toBe(spike.origin);

    // client → server: an edit arrives through `handleMessage`.
    client.doc.transact(() => getContent(client.doc).insert(0, 'hello from the client'));
    await waitFor(
      () => projectMarkdown(serverDocument('note:s2-sync')) === 'hello from the client',
    );

    // server → client: a server-side edit is broadcast back over the same socket.
    const document = serverDocument('note:s2-sync');
    document.transact(() => getContent(document).insert(0, '[server] '), { source: 'local' });
    await waitFor(() => projectMarkdown(client.doc) === '[server] hello from the client');
  });

  it('the desktop scheme app://iridium is on the allowlist and syncs too', async () => {
    const client = await connect('note:s2-desktop', DESKTOP_ORIGIN);
    await client.waitSynced();
    expect(acceptedSockets.at(-1)).toBe(DESKTOP_ORIGIN);
  });

  it('an absent Origin is refused with HTTP 403 before the upgrade', async () => {
    const before = { connect: counts.onConnect, clients: spike.app.websocketServer.clients.size };
    const refusal = await expectRefusedUpgrade(spike.wsUrl, null);
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({ code: 'forbidden', status: 403 });
    expect(counts.onConnect).toBe(before.connect);
    expect(spike.app.websocketServer.clients.size).toBe(before.clients);
    observations['absentOrigin'] = refusal;
  });

  it('an Origin outside the allowlist is refused with HTTP 403 before the upgrade', async () => {
    const before = counts.onConnect;
    const refusal = await expectRefusedUpgrade(spike.wsUrl, 'https://evil.example');
    expect(refusal.status).toBe(403);
    expect(refusal.body).toMatchObject({ code: 'forbidden' });
    expect(counts.onConnect).toBe(before);
    observations['foreignOrigin'] = refusal;
  });

  it('a 3 MiB frame is refused by maxPayload with close code 1009', async () => {
    const before = counts.onConnect;
    const serverClosesBefore = socketCloses.length;
    const closed = createDeferred<CloseEventLike>();
    const socket = openOriginWebSocket(spike.wsUrl, { origin: spike.origin });
    socket.once('close', (code, reason) => closed.resolve({ code, reason: reason.toString() }));
    socket.on('error', () => {
      // the server drops the socket after the oversize frame; the close event is the signal
    });
    await new Promise<void>((resolve) => socket.once('open', resolve));
    socket.send(Buffer.alloc(THREE_MIB, 1));
    const close = await closed.promise;
    expect(close.code).toBe(1009);
    expect(LIMITS.WS_MAX_PAYLOAD_BYTES).toBeLessThan(THREE_MIB);
    // The server side reports its own close to `handleClose`; its code is recorded, not assumed.
    await waitFor(() => socketCloses.length > serverClosesBefore);
    const serverSide = socketCloses[serverClosesBefore];
    // The frame never became a Hocuspocus message: no connection was opened for it.
    expect(counts.onConnect).toBe(before);
    observations['oversizeFrame'] = { clientSaw: close, serverHandleCloseSaw: serverSide };
  });

  it('connection.close({code: 4403, reason: "revoked"}) surfaces the reason on the provider onClose', async () => {
    const client = await connect('note:s2-revoke');
    await client.waitSynced();
    const socket = client.provider.configuration.websocketProvider.webSocket;
    firstConnection('note:s2-revoke').close({ code: 4403, reason: 'revoked' });
    const close = await client.waitClose((event) => event.reason === 'revoked');
    observations['revokedClose'] = close;
    expect(close.reason).toBe('revoked');
    // The document-level CLOSE frame carries only the reason; the socket itself stays open.
    expect(socket?.readyState).toBe(1);
    await waitFor(() => !hocuspocus.documents.has('note:s2-revoke'));
    expect(client.provider.synced).toBe(false);
  });

  it('a socket that closes while onAuthenticate is in flight leaks no document', async () => {
    authGate = createDeferred<void>();
    const before = counts.onAuthenticate;
    const client = await connect('note:s2-inflight');
    await waitFor(() => counts.onAuthenticate === before + 1);
    client.destroy(); // closes the socket → `handleClose` while the hook is pending
    await waitFor(() => socketCloses.length > 0);
    authGate.resolve();
    authGate = null;
    await sleep(100);
    expect(hocuspocus.documents.has('note:s2-inflight')).toBe(false);
    expect(hocuspocus.loadingDocuments.has('note:s2-inflight')).toBe(false);
  });

  it('a close from inside onStateless closes only that document; the shared socket survives for the vault provider', async () => {
    const { HocuspocusProviderWebsocket } = await loadProviderModule();
    const { createOriginWebSocket } = await import('@iridium/testkit');
    const shared = new HocuspocusProviderWebsocket({
      url: spike.wsUrl,
      WebSocketPolyfill: createOriginWebSocket({ origin: spike.origin }),
    });
    const note = await createSpikeClient({
      wsUrl: spike.wsUrl,
      name: 'note:s2-stateless',
      origin: spike.origin,
      websocketProvider: shared,
    });
    const vault = await createSpikeClient({
      wsUrl: spike.wsUrl,
      name: 'vault:s2-stateless',
      origin: spike.origin,
      websocketProvider: shared,
    });
    clients.push(note, vault);
    await note.waitSynced();
    await vault.waitSynced();
    expect(hocuspocus.getConnectionsCount()).toBeGreaterThan(0);

    note.provider.sendStateless('bad');
    const close = await note.waitClose((event) => event.reason === 'protocol-error');
    observations['statelessClose'] = close;
    expect(shared.webSocket?.readyState).toBe(1);
    expect(hocuspocus.documents.has('vault:s2-stateless')).toBe(true);
    await waitFor(() => !hocuspocus.documents.has('note:s2-stateless'));

    vault.provider.sendStateless('ping');
    await waitFor(() => vault.stateless.includes('pong'));
    expect(vault.closes).toHaveLength(0);
  });

  it('a throw from beforeHandleAwareness suppresses the state and closes only that document connection', async () => {
    const honest = await connect('note:s2-awareness');
    const spoofer = await connect('note:s2-awareness');
    await honest.waitSynced();
    await spoofer.waitSynced();
    const document = serverDocument('note:s2-awareness');
    expect(document.getConnectionsCount()).toBe(2);

    spoofer.provider.setAwarenessField('user', { id: 'spoof' });
    const close = await spoofer.waitClose((event) => event.reason === 'awareness-spoof');
    observations['awarenessSpoofClose'] = close;
    await sleep(150);
    const states = [...document.awareness.getStates().values()] as { user?: { id?: string } }[];
    expect(states.some((state) => state.user?.id === 'spoof')).toBe(false);
    expect(document.getConnectionsCount()).toBe(1);
    expect(spoofer.provider.configuration.websocketProvider.webSocket?.readyState).toBe(1);
    expect(honest.closes).toHaveLength(0);
    honest.doc.transact(() => getContent(honest.doc).insert(0, 'still editing'));
    await waitFor(() => projectMarkdown(document).startsWith('still editing'));
  });

  it('needs no onRequest, onUpgrade or onListen hocuspocus hook, and Fastify never double-sends', () => {
    expect(counts.onRequest).toBe(0);
    expect(counts.onUpgrade).toBe(0);
    expect(counts.onListen).toBe(0);
    expect(counts.onConnect).toBeGreaterThan(0);
    expect(doubleSendLines(spike.logLines)).toEqual([]);
  });
});
