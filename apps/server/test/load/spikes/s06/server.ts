/**
 * Spike S6's target: the S2 harness server, run as a standalone process so that k6 — an external
 * binary, not a Vitest worker — can open real WebSocket connections against it.
 *
 * Nothing here is new surface. `buildSpikeApp` and `mountCollab` are the S1/S2 harness support
 * modules (`apps/server/test/spikes/support/`), imported unchanged: the real `buildApp` in
 * `in-process` mode with no database, the `/collab` route with the Origin allowlist as a
 * `preValidation` hook and the `LIMITS.WS_MAX_PAYLOAD_BYTES` frame cap. The only addition is the
 * persistence acknowledgement S6 measures: an extension whose `afterStoreDocument` broadcasts a
 * `persisted` stateless payload naming the highest marker sequence it has stored, which is what the
 * probe VU times `durable_ack_ms` against.
 *
 * The process speaks one line of JSON on stdout when it is listening and one when it shuts down, and
 * it shuts down on the line `shutdown` on stdin (signals are not reliably deliverable to a child on
 * Windows). `run.mjs` drives both ends.
 */
import { Hocuspocus } from '@hocuspocus/server';
import { projectMarkdown } from '@iridium/crdt';

import { buildSpikeApp, type SpikeApp } from '../../../spikes/support/app.ts';
import { mountCollab } from '../../../spikes/support/collab-mount.ts';

/** The token the k6 client sends in its `Auth` frame; anything else is refused by `onAuthenticate`. */
const SPIKE_TOKEN = 'spike-ticket';
const DESKTOP_ORIGIN = 'app://iridium';
/**
 * `[[S06:<vu>:<seq>:<epochMs>]]` — a probe VU's marker. Parsed here only so the `persisted` ack can
 * name the highest sequence stored *per probe VU*, which is what each probe correlates against.
 */
const MARKER = /\[\[S06:(\d+):(\d+):(\d+)\]\]/g;

interface ServerCounts {
  onConnect: number;
  onAuthenticate: number;
  authRejected: number;
  onLoadDocument: number;
  onChange: number;
  onStoreDocument: number;
  afterStoreDocument: number;
  statelessBroadcasts: number;
}

const counts: ServerCounts = {
  onConnect: 0,
  onAuthenticate: 0,
  authRejected: 0,
  onLoadDocument: 0,
  onChange: 0,
  onStoreDocument: 0,
  afterStoreDocument: 0,
  statelessBroadcasts: 0,
};

/** Highest `<seq>` per `<vu>` in a document's text, and the total marker count. */
function markerHeads(text: string): {
  readonly heads: Record<string, number>;
  readonly total: number;
} {
  const heads: Record<string, number> = {};
  let total = 0;
  for (const match of text.matchAll(MARKER)) {
    total += 1;
    const vu = match[1] ?? '0';
    const seq = Number(match[2]);
    if (seq > (heads[vu] ?? 0)) heads[vu] = seq;
  }
  return { heads, total };
}

/**
 * `Y.Doc.store.pendingStructs` — updates Yjs accepted but could not integrate because a predecessor
 * is missing. They produce no `update` event and no text until the gap is filled, so a non-empty
 * value is the difference between "the server applied N updates" and "the document shows N edits".
 * The shape is internal to yjs 13.6.32 and is read here only as a spike measurement.
 */
function describePending(document: {
  store: { pendingStructs: unknown };
}): Record<string, unknown> {
  const pending = document.store.pendingStructs;
  if (pending === null || typeof pending !== 'object') return { pending: false };
  const missing = 'missing' in pending ? pending.missing : undefined;
  const update = 'update' in pending ? pending.update : undefined;
  return {
    pending: true,
    missing: missing instanceof Map ? Object.fromEntries(missing) : null,
    updateBytes: update instanceof Uint8Array ? update.byteLength : null,
  };
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function main(): Promise<void> {
  const spike: SpikeApp = await buildSpikeApp();
  const documents = new Set<string>();
  let lastPersistedHeads: Record<string, number> = {};
  let lastPersistedBytes = 0;
  let lastPersistedMarkers = 0;
  let lastPersistedText = '';
  let lastPending: Record<string, unknown> = { pending: false };
  let lastClients: readonly { readonly client: number; readonly items: number }[] = [];

  const hocuspocus = new Hocuspocus({
    quiet: true,
    timeout: 60_000,
    // The M8 pair is a measurement, not a decision; these are S2's values so the two spikes agree.
    debounce: 50,
    maxDebounce: 200,
    unloadImmediately: true,
    yDocOptions: { gc: true, gcFilter: () => true },
    extensions: [
      {
        async onConnect() {
          counts.onConnect += 1;
        },
        async onAuthenticate({ token }) {
          counts.onAuthenticate += 1;
          if (token !== SPIKE_TOKEN) {
            counts.authRejected += 1;
            throw new Error('unauthorized');
          }
          return { userId: 'spike-user' };
        },
        async onLoadDocument({ documentName }) {
          counts.onLoadDocument += 1;
          documents.add(documentName);
          return undefined;
        },
        async onChange() {
          counts.onChange += 1;
        },
        async onStoreDocument() {
          counts.onStoreDocument += 1;
        },
        async afterStoreDocument({ document }) {
          counts.afterStoreDocument += 1;
          const text = projectMarkdown(document);
          const { heads, total } = markerHeads(text);
          lastPersistedHeads = heads;
          lastPersistedBytes = Buffer.byteLength(text, 'utf8');
          lastPersistedMarkers = total;
          lastPersistedText = text;
          lastPending = describePending(document);
          lastClients = [...document.store.clients.entries()].map(([client, items]) => ({
            client,
            items: items.length,
          }));
          counts.statelessBroadcasts += 1;
          document.broadcastStateless(
            JSON.stringify({
              event: 'persisted',
              documentName: document.name,
              heads,
              markers: total,
              bytes: lastPersistedBytes,
            }),
          );
        },
      },
    ],
  });

  await mountCollab(spike.app, hocuspocus, {
    allowlist: [spike.origin, DESKTOP_ORIGIN],
    publicOrigin: spike.origin,
  });
  await spike.listen();

  emit({
    event: 'ready',
    port: spike.port,
    origin: spike.origin,
    wsUrl: spike.wsUrl,
    publicHost: spike.publicHost,
    token: SPIKE_TOKEN,
    desktopOrigin: DESKTOP_ORIGIN,
  });

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    // Under `unloadImmediately` the document is gone by the time both sockets have closed, so this
    // map is normally empty; `lastPersisted*` below is the record of the final state.
    const texts = Object.fromEntries(
      [...documents].map((name) => {
        const document = hocuspocus.documents.get(name);
        const text = document === undefined ? '' : projectMarkdown(document);
        return [name, { bytes: Buffer.byteLength(text, 'utf8'), markers: markerHeads(text).total }];
      }),
    );
    emit({
      event: 'shutdown',
      counts,
      documents: [...documents],
      texts,
      lastPersistedHeads,
      lastPersistedBytes,
      lastPersistedMarkers,
      lastPersistedText,
      lastPending,
      lastClients,
      warnLogLines: spike.logLines.length,
      warnLines: spike.logLines,
    });
    // The embedded `Hocuspocus` has no `destroy()` — only the `Server` wrapper this project never
    // uses does (`index.d.ts` declares it on `Server`, not on `Hocuspocus`). S2's teardown is the
    // shape that exists: flush the debounced stores, drop the connections, close Fastify.
    hocuspocus.flushPendingStores();
    hocuspocus.closeConnections();
    await spike.close();
    process.exit(0);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    if (chunk.includes('shutdown')) void shutdown();
  });
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

await main();
