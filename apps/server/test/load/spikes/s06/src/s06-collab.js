/**
 * Spike S6's k6 script: two VUs in two scenarios against the S2 harness server.
 *
 * `observer` connects first and stays connected. `probe` connects two seconds later, completes
 * Auth → SyncStep1 → SyncStep2 → Update, and appends `MARKERS` markers of the form
 * `[[S06:<seq>:<epochMs>]]` to the note's single `Y.Text`. The observer applies the incoming updates
 * to its own `Y.Doc` and, for every marker it has not seen before, records
 * `yjs_propagation_ms = Date.now() - epochMs` — the register's "the marker inserted by the probe VU
 * is observed by a second VU with a measured propagation time". The probe additionally times
 * `durable_ack_ms` from each marker's insertion to the `persisted` stateless broadcast whose
 * `lastSeq` covers it. `k6/websockets` already emits the register's `ws_connecting` trend natively
 * with sub-millisecond resolution, so `iridium_ws_connecting_ms` is recorded beside it only as a
 * cross-check that a script-side handshake timing agrees with the engine's.
 *
 * The metric names are the M8 SLO table's names, and the thresholds are its SLOs, so the summary this
 * script emits is the shape the load lane would report.
 */
import { check } from 'k6';
import exec from 'k6/execution';
import { Counter, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

import { NoteWireClient } from './wire.js';

const WS_URL = __ENV['S06_WS_URL'];
const ORIGIN = __ENV['S06_ORIGIN'];
const TOKEN = __ENV['S06_TOKEN'] ?? 'spike-ticket';
const DOCUMENT = __ENV['S06_DOCUMENT'] ?? 's06-note';
const SUMMARY_PATH = __ENV['S06_SUMMARY'] ?? 'results/s06-k6-summary.json';
const MARKERS = Number(__ENV['S06_MARKERS'] ?? '40');
const MARKER_INTERVAL_MS = Number(__ENV['S06_MARKER_INTERVAL_MS'] ?? '25');
/** How long the observer stays connected after the probe's last marker. */
const OBSERVER_TAIL_MS = Number(__ENV['S06_OBSERVER_TAIL_MS'] ?? '4000');
const PROBE_START = __ENV['S06_PROBE_START'] ?? '2s';
/** VUs per scenario. 1 is the register's shape; a higher value is the concurrency smoke. */
const VUS = Number(__ENV['S06_VUS'] ?? '1');
/**
 * Base for the `Y.Doc.clientID` this script assigns per virtual user; see `wire.js` for why k6's
 * `crypto.getRandomValues` makes yjs's own generator unusable here. `base + idInTest` is unique
 * within a run and, with a per-run base, across runs against the same document. `0` disables the
 * assignment and hands the document back to yjs's own generator — the reproduction of the defect.
 */
const CLIENT_ID_BASE = Number(__ENV['S06_CLIENT_ID_BASE'] ?? '1000000');

/** `[[S06:<vu>:<seq>:<epochMs>]]`. The VU id keeps sequences unique when `S06_VUS > 1`. */
const MARKER_PATTERN = /\[\[S06:(\d+):(\d+):(\d+)\]\]/g;

/** The M8 SLO trends (11-operations-and-deployment.md), recorded here under their own names. */
const wsConnecting = new Trend('iridium_ws_connecting_ms', true);
const propagation = new Trend('yjs_propagation_ms', true);
const durableAck = new Trend('durable_ack_ms', true);
/**
 * The wire-level ack, which is **not** a durability ack: `MessageReceiver.readSyncMessage` answers
 * every `messageYjsUpdate` with `MessageType.SyncStatus(true)` the moment it has applied the update
 * in memory, before any `onStoreDocument` runs. Recorded separately so the two are never confused.
 */
const syncStatusAck = new Trend('iridium_sync_status_ms', true);
const syncDuration = new Trend('iridium_sync_ms', true);
const markersSent = new Counter('s06_markers_sent');
const markersObserved = new Counter('s06_markers_observed');
const propagationZero = new Counter('s06_propagation_zero_ms_samples');
const statelessAcks = new Counter('s06_stateless_persisted');

export const options = {
  scenarios: {
    observer: {
      executor: 'per-vu-iterations',
      exec: 'observer',
      vus: VUS,
      iterations: 1,
      startTime: '0s',
      maxDuration: '120s',
    },
    probe: {
      executor: 'per-vu-iterations',
      exec: 'probe',
      vus: VUS,
      iterations: 1,
      startTime: PROBE_START,
      maxDuration: '120s',
    },
    // The control: S2 proved the `/collab` Origin allowlist refuses before the upgrade. This asserts
    // that k6 really does put `Origin` on the wire — otherwise the two scenarios above would be
    // measuring a server that had stopped checking.
    origins: {
      executor: 'per-vu-iterations',
      exec: 'origins',
      vus: 1,
      iterations: 1,
      startTime: '0s',
      maxDuration: '30s',
    },
  },
  thresholds: {
    // The register's own metric name, emitted by `k6/websockets` itself.
    ws_connecting: ['p(95)<500'],
    iridium_ws_connecting_ms: ['p(95)<500'],
    yjs_propagation_ms: ['p(95)<250'],
    durable_ack_ms: ['p(95)<1000'],
    checks: ['rate==1.0'],
  },
  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'max', 'count'],
  // k6 2.x refuses an unknown option; the two below keep the run self-contained.
  noConnectionReuse: false,
  discardResponseBodies: false,
};

function requireEnv() {
  if (WS_URL === undefined || ORIGIN === undefined) {
    throw new Error('S06_WS_URL and S06_ORIGIN must be set (run.mjs sets them)');
  }
}

/** The probe VU: Auth → SyncStep1 → SyncStep2 → Update, then `MARKERS` timed markers. */
export function probe() {
  requireEnv();
  const vuId = String(exec.vu.idInTest);
  const pending = new Map();
  const markerSentAt = new Map();
  let seq = 0;
  let syncedAt = 0;
  let acks = 0;
  let syncStatusFrames = 0;
  let authenticatedScope = null;

  const client = new NoteWireClient({
    url: WS_URL,
    origin: ORIGIN,
    token: TOKEN,
    documentName: DOCUMENT,
    label: 'probe',
    clientId: CLIENT_ID_BASE === 0 ? undefined : CLIENT_ID_BASE + exec.vu.idInTest,
    awareness: true,
    on: {
      open: (_c, connectMs) => {
        wsConnecting.add(connectMs);
      },
      authenticated: (_c, scope) => {
        authenticatedScope = scope;
      },
      synced: (c) => {
        syncedAt = Date.now();
        syncDuration.add(syncedAt - c.connectStartedAt);
        c.sendAwareness('user', { name: 's06-probe', color: '#2f6f4f' });
        emitMarker();
      },
      syncStatus: (_c, applied) => {
        // FIFO on one socket: the first `SyncStatus` acks the probe's own `SyncStep2`, the n-th
        // (n >= 2) acks marker n - 1.
        syncStatusFrames += 1;
        if (!applied) return;
        const at = markerSentAt.get(syncStatusFrames - 1);
        if (at !== undefined) syncStatusAck.add(Date.now() - at);
      },
      stateless: (_c, payload) => {
        let parsed = null;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }
        if (parsed === null || parsed.event !== 'persisted') return;
        statelessAcks.add(1);
        acks += 1;
        const head = parsed.heads?.[vuId] ?? 0;
        const now = Date.now();
        for (const [markerSeq, sentAt] of pending) {
          if (markerSeq <= head) {
            durableAck.add(now - sentAt);
            pending.delete(markerSeq);
          }
        }
      },
    },
  });

  function emitMarker() {
    if (seq >= MARKERS) {
      finish();
      return;
    }
    seq += 1;
    const at = Date.now();
    pending.set(seq, at);
    markerSentAt.set(seq, at);
    client.append(`[[S06:${vuId}:${seq}:${at}]]`);
    markersSent.add(1);
    setTimeout(emitMarker, MARKER_INTERVAL_MS);
  }

  function finish() {
    // Let the last `persisted` broadcast arrive: `maxDebounce` is 200 ms on the server.
    setTimeout(() => {
      check(client, {
        'probe authenticated with a read-write scope': (c) =>
          c.authenticated && authenticatedScope === 'read-write',
        'probe completed the sync round trip': (c) => c.synced,
        'probe received the server first sync step': (c) =>
          (c.received.byType[4] ?? 0) + (c.received.byType[0] ?? 0) >= 2,
        'probe sent sync step 2': (c) => (c.sent.byType[0] ?? 0) >= 2,
        'probe inserted every marker': () => seq === MARKERS,
        'probe saw at least one persisted ack': () => acks > 0,
        'probe saw one SyncStatus per update plus one for its SyncStep2': () =>
          syncStatusFrames === MARKERS + 1,
        'probe had every marker acknowledged as persisted': () => pending.size === 0,
        'probe text contains its own markers': (c) =>
          [...c.contents().matchAll(MARKER_PATTERN)].filter((m) => m[1] === vuId).length ===
          MARKERS,
        'probe hit no protocol errors': (c) => c.errors.length === 0,
      });
      console.info(
        `s06 probe vu${vuId}: clientID=${String(client.doc.clientID)} sent=${JSON.stringify(client.sent)} received=${JSON.stringify(client.received)} acks=${String(acks)} syncStatus=${String(syncStatusFrames)} pending=${String(pending.size)} errors=${JSON.stringify(client.errors)}`,
      );
      client.close();
    }, 600);
  }

  client.connect();
}

/** The observer VU: connects, syncs, and times every marker the probe inserts. */
export function observer() {
  requireEnv();
  const seen = new Set();
  let lastMarkerAt = 0;
  let buffer = '';
  let finished = false;

  const client = new NoteWireClient({
    url: WS_URL,
    origin: ORIGIN,
    token: TOKEN,
    documentName: DOCUMENT,
    label: 'observer',
    clientId: CLIENT_ID_BASE === 0 ? undefined : CLIENT_ID_BASE + exec.vu.idInTest,
    awareness: true,
    observeText: true,
    on: {
      open: (_c, connectMs) => {
        wsConnecting.add(connectMs);
      },
      synced: (c) => {
        syncDuration.add(Date.now() - c.connectStartedAt);
      },
      /**
       * O(inserted) per frame: only the delta the update carried is scanned, and any trailing
       * partial marker is carried into the next delta.
       */
      textInsert: (_c, inserted) => {
        const now = Date.now();
        buffer += inserted;
        let consumedTo = 0;
        for (const match of buffer.matchAll(MARKER_PATTERN)) {
          consumedTo = match.index + match[0].length;
          const key = `${match[1]}:${match[2]}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const delta = now - Number(match[3]);
          propagation.add(delta);
          if (delta === 0) propagationZero.add(1);
          markersObserved.add(1);
          lastMarkerAt = now;
        }
        if (consumedTo > 0) buffer = buffer.slice(consumedTo);
        if (seen.size === VUS * MARKERS) finish();
      },
    },
  });

  function finish() {
    if (finished) return;
    finished = true;
    check(client, {
      'observer completed the sync round trip': (c) => c.synced,
      'observer observed every marker of every probe': () => seen.size === VUS * MARKERS,
      'observer sees the markers of each probe in order': (c) => {
        const perVu = new Map();
        for (const match of c.contents().matchAll(MARKER_PATTERN)) {
          const previous = perVu.get(match[1]) ?? 0;
          if (Number(match[2]) !== previous + 1) return false;
          perVu.set(match[1], previous + 1);
        }
        return [...perVu.values()].every((last) => last === MARKERS);
      },
      'observer received awareness from the probe': (c) => (c.received.byType[1] ?? 0) > 0,
      'observer hit no protocol errors': (c) => c.errors.length === 0,
    });
    console.info(
      `s06 observer vu${String(exec.vu.idInTest)}: markers=${String(seen.size)}/${String(VUS * MARKERS)} received=${JSON.stringify(client.received)} lastMarkerAt=${String(lastMarkerAt)} errors=${JSON.stringify(client.errors)}`,
    );
    client.close();
  }

  setTimeout(
    finish,
    Number(PROBE_START.replace('s', '')) * 1000 + MARKERS * MARKER_INTERVAL_MS + OBSERVER_TAIL_MS,
  );
  client.connect();
}

/**
 * The Origin control: a foreign `Origin` and an absent `Origin` must both be refused before the
 * upgrade, and the allowlisted one must open.
 */
export function origins() {
  requireEnv();
  const outcomes = { foreign: null, absent: null, allowed: null };

  function attempt(key, headers) {
    const socket = new WebSocket(WS_URL, null, headers === null ? {} : { headers });
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => {
      outcomes[key] = 'open';
      socket.close();
    });
    socket.addEventListener('error', () => {
      if (outcomes[key] === null) outcomes[key] = 'refused';
    });
    socket.addEventListener('close', () => {
      if (outcomes[key] === null) outcomes[key] = 'refused';
    });
  }

  attempt('foreign', { Origin: 'https://evil.example' });
  attempt('absent', null);
  attempt('allowed', { Origin: ORIGIN });

  setTimeout(() => {
    check(outcomes, {
      'a foreign Origin is refused before the upgrade': (o) => o.foreign === 'refused',
      'an absent Origin is refused before the upgrade': (o) => o.absent === 'refused',
      'the allowlisted Origin upgrades': (o) => o.allowed === 'open',
    });
    console.info(`s06 origins: ${JSON.stringify(outcomes)}`);
  }, 1500);
}

export default function () {
  throw new Error(`s06 has no default scenario (vu ${String(exec.vu.idInTest)})`);
}

export function handleSummary(data) {
  const out = {
    spike: 'S6',
    generatedAt: new Date().toISOString(),
    // `options` is re-bound to k6's consolidated Go-side config by the time `handleSummary` runs, so
    // `Object.keys(options.scenarios)` yields Go method names rather than scenario names.
    k6: { scenarios: ['observer', 'probe', 'origins'], thresholds: options.thresholds },
    environment: {
      wsUrl: WS_URL,
      origin: ORIGIN,
      document: DOCUMENT,
      vusPerScenario: VUS,
      clientIdBase: CLIENT_ID_BASE,
      markers: MARKERS,
      markerIntervalMs: MARKER_INTERVAL_MS,
    },
    metrics: data.metrics,
    thresholdFailures: Object.entries(data.metrics).flatMap(([name, metric]) =>
      Object.entries(metric.thresholds ?? {})
        .filter(([, result]) => result.ok === false)
        .map(([expression]) => `${name}: ${expression}`),
    ),
  };
  const json = JSON.stringify(out, null, 2);
  return {
    [SUMMARY_PATH]: json,
    stdout: `\ns06 summary written to ${SUMMARY_PATH} (${String(json.length)} bytes)\n`,
  };
}
