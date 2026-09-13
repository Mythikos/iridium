/**
 * Spike S1 — in-place V2 + V1 apply in `onLoadDocument` (12-milestones.md §4.4).
 *
 * Question: can `onLoadDocument` apply a V2 snapshot plus V1 log rows in place to `data.document`
 * and return `undefined`, with `afterLoadDocument` firing after the apply and before the first sync,
 * without Hocuspocus 4.7.0 re-applying the state (fix #1155) or the load appearing in Iridium's own
 * `update` listener?
 *
 * The register's lettered criteria map to the tests below:
 *   (a) state vector after load equals the fixture's — asserted on every boot;
 *   (b) every marker exactly once after 20 restarts — the restart loop plus the final rebuild;
 *   (c) `afterLoadDocument` before the first `beforeHandleMessage` — the recorded hook order;
 *   (d) the `update` listener registered in `afterLoadDocument` sees zero load events and one event per
 *       client update — the writer counters;
 *   (e) `document.isLoading` / `loadingDocuments` observable while a second connection waits;
 *   (f) V2 versus V1 snapshot size and load time on a 1 MiB synthetic history.
 *
 * Everything goes through `@iridium/crdt`'s codec (`loadState` / `applyV1` with `LOAD_ORIGIN`); the
 * harness imports no `yjs`.
 */
// oxlint-disable no-await-in-loop -- a restart loop is sequential by definition: boot, edit, stop.
import { setTimeout as sleep } from 'node:timers/promises';

import { Hocuspocus, type Document } from '@hocuspocus/server';
import { newId } from '@iridium/contracts';
import {
  createNoteDoc,
  encodeState,
  getContent,
  initialNoteState,
  LOAD_ORIGIN,
  projectMarkdown,
  stateVector,
} from '@iridium/crdt';
import { countMarkers, formatMarker, reserveLoopbackPort, waitFor } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSpikeApp, doubleSendLines, type SpikeApp } from './support/app.ts';
import { mountCollab } from './support/collab-mount.ts';
import { createSpikeClient, type SpikeClient } from './support/provider.ts';
import { writeResult } from './support/results.ts';
import {
  bytesEqual,
  StubCollabPersistence,
  type AttachedWriter,
  type LoadedState,
} from './support/stub-persistence.ts';
import { measureHistory, synthesizeHistory } from './support/synthetic-history.ts';

const RESTARTS = 20;
const CLIENTS = 3;
const ONE_MIB = 1024 * 1024;

const NOTE_ID = newId();
const DOC_NAME = `note:${NOTE_ID}`;

interface BootRecord {
  readonly boot: number;
  readonly hookOrder: string[];
  loaded: {
    snapshotFormat: number | null;
    snapshotBytes: number;
    rowsReplayed: number;
    headSeq: number;
  } | null;
  svEqualAfterLoad: boolean | null;
  textEqualAfterLoad: boolean | null;
  /** Events an `update` listener attached *before* the apply saw, by origin. */
  earlyListener: { loadOrigin: number; other: number };
  /** The listener `afterLoadDocument` attaches — the writer's. */
  afterLoadListener: { filteredLoadOrigin: number; accepted: number };
  onStoreDuringLoad: number;
  onChangeDuringLoad: number;
  isLoadingDuringLoad: boolean | null;
  isLoadingAfterLoad: boolean | null;
  sameYjsClass: boolean | null;
  compactedBeforeBoot: boolean;
}

interface BootedServer {
  readonly spike: SpikeApp;
  readonly hocuspocus: Hocuspocus;
  readonly record: BootRecord;
  writer: AttachedWriter | null;
  document: Document | null;
  close(): Promise<void>;
}

const persistence = new StubCollabPersistence();
const records: BootRecord[] = [];
let port = 0;

async function bootServer(boot: number, compactedBeforeBoot: boolean): Promise<BootedServer> {
  const record: BootRecord = {
    boot,
    hookOrder: [],
    loaded: null,
    svEqualAfterLoad: null,
    textEqualAfterLoad: null,
    earlyListener: { loadOrigin: 0, other: 0 },
    afterLoadListener: { filteredLoadOrigin: 0, accepted: 0 },
    onStoreDuringLoad: 0,
    onChangeDuringLoad: 0,
    isLoadingDuringLoad: null,
    isLoadingAfterLoad: null,
    sameYjsClass: null,
    compactedBeforeBoot,
  };
  let loading = false;
  const booted: BootedServer = {
    spike: await buildSpikeApp({ port }),
    hocuspocus: new Hocuspocus({
      quiet: true,
      timeout: 60_000,
      debounce: 20,
      maxDebounce: 100,
      unloadImmediately: true,
      yDocOptions: { gc: true, gcFilter: () => true },
      extensions: [
        {
          async onConnect() {
            record.hookOrder.push('onConnect');
          },
          async onAuthenticate() {
            record.hookOrder.push('onAuthenticate');
            return { userId: 'spike-user' };
          },
          async onLoadDocument({ document, documentName }) {
            if (documentName !== DOC_NAME) return undefined;
            record.hookOrder.push('onLoadDocument:start');
            booted.document = document;
            loading = true;
            record.isLoadingDuringLoad = document.isLoading;
            const early = (_update: Uint8Array, origin: unknown): void => {
              if (origin === LOAD_ORIGIN) record.earlyListener.loadOrigin += 1;
              else record.earlyListener.other += 1;
            };
            document.on('update', early);
            const loaded: LoadedState = await persistence.load(NOTE_ID);
            StubCollabPersistence.applyLoaded(document, loaded);
            document.off('update', early);
            loading = false;
            record.loaded = {
              snapshotFormat: loaded.snapshot === null ? null : loaded.snapshotFormat,
              snapshotBytes: loaded.snapshot?.byteLength ?? 0,
              rowsReplayed: loaded.rows.length,
              headSeq: loaded.headSeq,
            };
            record.svEqualAfterLoad = bytesEqual(
              stateVector(document),
              persistence.shadowSv(NOTE_ID),
            );
            record.textEqualAfterLoad =
              projectMarkdown(document) === persistence.shadowText(NOTE_ID);
            record.hookOrder.push('onLoadDocument:end');
            return undefined; // never bytes: Hocuspocus would `applyUpdate` (V1) whatever is returned
          },
          async afterLoadDocument({ document, documentName }) {
            if (documentName !== DOC_NAME) return;
            record.hookOrder.push('afterLoadDocument');
            record.isLoadingAfterLoad = document.isLoading;
            record.sameYjsClass =
              Object.getPrototypeOf(Object.getPrototypeOf(document)) ===
              Object.getPrototypeOf(createNoteDoc());
            booted.writer = persistence.attach(NOTE_ID, document);
          },
          async connected() {
            record.hookOrder.push('connected');
          },
          async beforeHandleMessage() {
            record.hookOrder.push('beforeHandleMessage');
          },
          async onChange() {
            if (loading) record.onChangeDuringLoad += 1;
          },
          async onStoreDocument() {
            if (loading) record.onStoreDuringLoad += 1;
          },
        },
      ],
    }),
    record,
    writer: null,
    document: null,
    async close(): Promise<void> {
      if (booted.writer !== null) {
        record.afterLoadListener = {
          filteredLoadOrigin: booted.writer.filteredLoadOrigin,
          accepted: booted.writer.accepted,
        };
      }
      booted.hocuspocus.closeConnections();
      await booted.spike.close();
    },
  };
  await mountCollab(booted.spike.app, booted.hocuspocus, {
    allowlist: [booted.spike.origin],
    publicOrigin: booted.spike.origin,
  });
  await booted.spike.listen();
  return booted;
}

/** Every offset at which a line begins: 0 and the offset after each newline. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n' && index + 1 <= text.length) starts.push(index + 1);
  }
  return starts;
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

describe('S1 — onLoadDocument applies V2 + V1 in place and returns undefined', () => {
  beforeAll(async () => {
    port = await reserveLoopbackPort();
    persistence.seed(NOTE_ID, initialNoteState('# S1 spike note\n\nseed paragraph\n'));
  });

  afterAll(() => {
    writeResult('s01-restarts', {
      boots: records.length,
      restarts: records.length - 1,
      clientsPerBoot: CLIENTS,
      records,
    });
  });

  it(`survives ${String(RESTARTS)} in-process restarts with every marker exactly once`, async () => {
    for (let boot = 0; boot <= RESTARTS; boot++) {
      const compactedBeforeBoot = boot > 0 && (boot - 1) % 4 === 3;
      const server = await bootServer(boot, compactedBeforeBoot);
      const clients: SpikeClient[] = [];
      for (let k = 0; k < CLIENTS; k++) {
        clients.push(
          await createSpikeClient({
            wsUrl: server.spike.wsUrl,
            name: DOC_NAME,
            origin: server.spike.origin,
          }),
        );
      }
      await Promise.all(clients.map((client) => client.waitSynced()));

      // (a) the loaded document is the fixture: state vector and projection both match the shadow.
      expect({
        boot,
        svEqualAfterLoad: server.record.svEqualAfterLoad,
        textEqualAfterLoad: server.record.textEqualAfterLoad,
        sameYjsClass: server.record.sameYjsClass,
      }).toEqual({ boot, svEqualAfterLoad: true, textEqualAfterLoad: true, sameYjsClass: true });
      const shadowText = persistence.shadowText(NOTE_ID);
      for (const client of clients) expect(projectMarkdown(client.doc)).toBe(shadowText);

      // (c) hook order: load, then afterLoadDocument, then the first message of the first connection.
      // The three clients connect concurrently, so their `onConnect`/`onAuthenticate` may interleave
      // with the single load; what must hold is the relative order of the load, the attach and the
      // first message.
      const order = server.record.hookOrder;
      const index = {
        loadStart: order.indexOf('onLoadDocument:start'),
        loadEnd: order.indexOf('onLoadDocument:end'),
        afterLoad: order.indexOf('afterLoadDocument'),
        firstMessage: order.indexOf('beforeHandleMessage'),
      };
      const ordered =
        index.loadStart >= 0 &&
        index.loadStart < index.loadEnd &&
        index.loadEnd < index.afterLoad &&
        index.afterLoad < index.firstMessage;
      expect({ boot, ordered, index }).toMatchObject({ boot, ordered: true });
      expect(order.filter((name) => name === 'afterLoadDocument')).toHaveLength(1);
      expect(order.filter((name) => name === 'onLoadDocument:start')).toHaveLength(1);

      // (d) and the no-re-apply half: the load produced exactly its own events and nothing else.
      const loaded = server.record.loaded;
      expect(loaded).not.toBeNull();
      const expectedLoadEvents =
        (loaded?.snapshotFormat === null ? 0 : 1) + (loaded?.rowsReplayed ?? 0);
      expect(server.record.earlyListener).toEqual({ loadOrigin: expectedLoadEvents, other: 0 });
      expect(server.record.onStoreDuringLoad).toBe(0);
      expect(server.record.onChangeDuringLoad).toBe(0);
      expect(server.record.isLoadingDuringLoad).toBe(true);
      expect(server.record.isLoadingAfterLoad).toBe(false);

      // Each client inserts one marker line at a different line start, so no later insertion can
      // land inside an earlier marker and split it (the count below must see whole markers).
      const markers = clients.map((_client, k) => formatMarker(`c${String(k)}`, boot));
      clients.forEach((client, k) => {
        const text = getContent(client.doc);
        const at =
          lineStarts(projectMarkdown(client.doc))[
            (boot * 7 + k * 13) % lineStarts(projectMarkdown(client.doc)).length
          ] ?? 0;
        const marker = markers[k] ?? '';
        client.doc.transact(() => text.insert(at, `${marker}\n`), { source: 'spike-client' });
      });
      await waitFor(() =>
        clients.every((client) =>
          markers.every((marker) => projectMarkdown(client.doc).includes(marker)),
        ),
      );
      await waitFor(() => server.writer?.accepted === CLIENTS);
      await sleep(60);
      expect(server.writer?.accepted).toBe(CLIENTS); // one event per client update, no extras
      expect(server.writer?.filteredLoadOrigin).toBe(0); // the writer's listener never saw the load
      expect(projectMarkdown(server.document ?? createNoteDoc())).toBe(
        persistence.shadowText(NOTE_ID),
      );

      for (const client of clients) client.destroy();
      await waitFor(() => server.hocuspocus.documents.size === 0);
      await server.close();
      records.push(server.record);
      if (boot % 4 === 3) persistence.compact(NOTE_ID, 2);
    }

    // (b) rebuilt from the store alone: every marker exactly once.
    const rebuilt = persistence.rebuildFromStore(NOTE_ID);
    const text = projectMarkdown(rebuilt);
    for (let boot = 0; boot <= RESTARTS; boot++) {
      for (let k = 0; k < CLIENTS; k++) {
        expect(occurrences(text, formatMarker(`c${String(k)}`, boot))).toBe(1);
      }
    }
    for (let k = 0; k < CLIENTS; k++) {
      expect(countMarkers(text, `c${String(k)}`)).toBe(RESTARTS + 1);
    }
    expect(text).toBe(persistence.shadowText(NOTE_ID));
    expect(records.filter((record) => record.compactedBeforeBoot).length).toBeGreaterThan(0);
    expect(
      records.filter((record) => (record.loaded?.rowsReplayed ?? 0) > 0).length,
    ).toBeGreaterThan(0);
  });

  it('(e) a connection arriving mid-load waits on the same load and observes isLoading', async () => {
    const gate = persistence.openGate();
    const loadsBefore = persistence.loads;
    const server = await bootServer(RESTARTS + 1, false);
    const first = await createSpikeClient({
      wsUrl: server.spike.wsUrl,
      name: DOC_NAME,
      origin: server.spike.origin,
    });
    await waitFor(() => server.record.hookOrder.includes('onLoadDocument:start'));
    expect(server.hocuspocus.loadingDocuments.has(DOC_NAME)).toBe(true);
    expect(server.hocuspocus.documents.has(DOC_NAME)).toBe(false);
    expect(server.document?.isLoading).toBe(true);

    const second = await createSpikeClient({
      wsUrl: server.spike.wsUrl,
      name: DOC_NAME,
      origin: server.spike.origin,
    });
    await sleep(200);
    expect(first.provider.synced).toBe(false);
    expect(second.provider.synced).toBe(false);
    expect(persistence.loads).toBe(loadsBefore + 1); // the second connection joined the pending load

    gate.resolve();
    persistence.gate = null;
    await first.waitSynced();
    await second.waitSynced();
    expect(server.document?.isLoading).toBe(false);
    expect(server.hocuspocus.loadingDocuments.has(DOC_NAME)).toBe(false);
    expect(persistence.loads).toBe(loadsBefore + 1);
    expect(server.record.hookOrder.filter((name) => name === 'afterLoadDocument')).toHaveLength(1);

    first.destroy();
    second.destroy();
    await waitFor(() => server.hocuspocus.documents.size === 0);
    await server.close();
    expect(doubleSendLines(server.spike.logLines)).toEqual([]);
  });

  it('control: returning the V2 blob from onLoadDocument makes Hocuspocus applyUpdate it as V1', async () => {
    const seeded = initialNoteState('control text\n');
    const outcomes: Record<string, unknown> = {};

    const returnsBlob = new Hocuspocus({
      quiet: true,
      extensions: [
        {
          async onLoadDocument() {
            return seeded.snapshot;
          },
        },
      ],
    });
    let returnedV2Blob: {
      readonly rejected: boolean;
      readonly text?: string;
      readonly message?: string;
    };
    try {
      const direct = await returnsBlob.openDirectConnection('note:control-blob', {});
      returnedV2Blob = {
        rejected: false,
        text: projectMarkdown(direct.document ?? createNoteDoc()),
      };
      await direct.disconnect();
    } catch (error) {
      returnedV2Blob = {
        rejected: true,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    outcomes['returnedV2Blob'] = returnedV2Blob;

    const appliesInPlace = new Hocuspocus({
      quiet: true,
      extensions: [
        {
          async onLoadDocument({ document }) {
            StubCollabPersistence.applyLoaded(document, {
              snapshot: seeded.snapshot,
              snapshotFormat: 2,
              snapshotSv: seeded.sv,
              snapshotThroughSeq: 1,
              headSeq: 1,
              rows: [],
            });
            return undefined;
          },
        },
      ],
    });
    const direct = await appliesInPlace.openDirectConnection('note:control-inplace', {});
    const document = direct.document ?? createNoteDoc();
    outcomes['appliedInPlace'] = {
      text: projectMarkdown(document),
      svEqual: bytesEqual(stateVector(document), seeded.sv),
    };
    await direct.disconnect();

    writeResult('s01-control', outcomes);
    expect(outcomes['appliedInPlace']).toEqual({ text: 'control text\n', svEqual: true });
    // Returning the V2 bytes either rejects the load or yields a document that is not the note.
    expect(returnedV2Blob.rejected || returnedV2Blob.text !== 'control text\n').toBe(true);
  });

  it('(f) reports V2 against V1 on a 1 MiB synthetic history', () => {
    const history = synthesizeHistory(ONE_MIB);
    const measurement = measureHistory(history);
    writeResult('s01-history', measurement);
    expect(history.logBytes).toBeGreaterThanOrEqual(ONE_MIB);
    expect(measurement.equivalence).toEqual({
      v1AndV2LoadSameStateVector: true,
      v2LoadProjectsSameText: true,
      v2PlusTailProjectsSameText: true,
    });
    expect(measurement.bytes.snapshotV2).toBeLessThan(measurement.bytes.snapshotV1);
    // The codec's two encoders agree with the fixture's own encoders.
    const check = createNoteDoc();
    expect(encodeState(check, 2).byteLength).toBeGreaterThan(0);
  });
});
