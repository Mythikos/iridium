/**
 * The 1 MiB synthetic history of spike S1, criterion (f): a note edited one transaction at a time
 * — mostly single-character inserts biased towards the end of the text, with occasional deletions —
 * until the V1 update log reaches the target size. Each transaction's `update` event is one
 * `note_updates` row; the merged log, the V1 snapshot and the V2 snapshot are then compared, and the
 * time to load each is measured on fresh documents.
 */
import { performance } from 'node:perf_hooks';

import {
  applyV1,
  createNoteDoc,
  encodeState,
  getContent,
  loadState,
  LOAD_ORIGIN,
  mergeV1,
  projectMarkdown,
  stateVector,
  type V1Update,
} from '@iridium/crdt';

import { percentile, round } from './results.ts';
import { bytesEqual } from './stub-persistence.ts';

const WORDS = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'note',
  'vault',
  'iridium',
  'markdown',
  'sync',
  'crdt',
];

/** A small deterministic PRNG so the history is reproducible run to run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticHistory {
  readonly rows: readonly V1Update[];
  readonly logBytes: number;
  readonly operations: number;
  readonly textChars: number;
  readonly finalText: string;
  readonly v1Snapshot: V1Update;
  readonly v2Snapshot: Uint8Array;
  readonly mergedLog: V1Update;
}

export function synthesizeHistory(targetBytes: number, seed = 20260913): SyntheticHistory {
  const random = mulberry32(seed);
  const doc = createNoteDoc();
  // Update sizes depend on the client id's varint width, so a fixed id keeps the byte counts and
  // therefore the number of operations needed to reach the target reproducible run to run.
  doc.clientID = seed >>> 0;
  const text = getContent(doc);
  const rows: V1Update[] = [];
  let logBytes = 0;
  // The `update` event payload is the V1 wire encoding; the product brands it at this same boundary
  // (codec.ts), and the harness may not import `yjs` to do it another way.
  doc.on('update', (update: Uint8Array) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    rows.push(update as V1Update);
    logBytes += update.byteLength;
  });
  const origin = { source: 'local' };
  let operations = 0;
  for (;;) {
    if (logBytes >= targetBytes) break;
    const length = text.length;
    const roll = random();
    doc.transact(() => {
      if (roll < 0.06 && length > 40) {
        // A deletion of a few characters somewhere in the text.
        const at = Math.floor(random() * (length - 20));
        text.delete(at, 1 + Math.floor(random() * 8));
      } else if (roll < 0.2) {
        // A whole word typed at the end, as a paste or an autocomplete would.
        text.insert(length, `${WORDS[Math.floor(random() * WORDS.length)] ?? 'word'} `);
      } else {
        // One character, mostly at the end (typing) and sometimes mid-text (an edit).
        const at = random() < 0.85 ? length : Math.floor(random() * length);
        const char = random() < 0.15 ? '\n' : String.fromCharCode(97 + Math.floor(random() * 26));
        text.insert(at, char);
      }
    }, origin);
    operations += 1;
  }
  const finalText = projectMarkdown(doc);
  return {
    rows,
    logBytes,
    operations,
    textChars: finalText.length,
    finalText,
    v1Snapshot: encodeState(doc, 1),
    v2Snapshot: encodeState(doc, 2),
    mergedLog: mergeV1(rows),
  };
}

export interface LoadTiming {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly minMs: number;
}

function timeLoads(samples: number, load: () => void): LoadTiming {
  const durations: number[] = [];
  for (let index = 0; index < samples; index++) {
    const started = performance.now();
    load();
    durations.push(performance.now() - started);
  }
  return {
    samples,
    p50Ms: round(percentile(durations, 50), 3),
    p95Ms: round(percentile(durations, 95), 3),
    minMs: round(Math.min(...durations), 3),
  };
}

export interface HistoryMeasurement {
  readonly operations: number;
  readonly rows: number;
  readonly textChars: number;
  readonly bytes: {
    readonly rawLog: number;
    readonly mergedLogV1: number;
    readonly snapshotV1: number;
    readonly snapshotV2: number;
    readonly v2OverV1: number;
  };
  readonly load: {
    readonly snapshotV1: LoadTiming;
    readonly snapshotV2: LoadTiming;
    readonly mergedLogV1: LoadTiming;
    readonly replayRows: LoadTiming;
    /** The production shape: V2 snapshot at 90 % of the log plus the last 10 % of rows replayed. */
    readonly snapshotV2PlusTail: LoadTiming & {
      readonly tailRows: number;
      readonly tailBytes: number;
    };
  };
  readonly equivalence: {
    readonly v1AndV2LoadSameStateVector: boolean;
    readonly v2LoadProjectsSameText: boolean;
    readonly v2PlusTailProjectsSameText: boolean;
  };
}

export function measureHistory(history: SyntheticHistory, samples = 7): HistoryMeasurement {
  const loadV1 = (): ReturnType<typeof createNoteDoc> => {
    const doc = createNoteDoc();
    loadState(doc, history.v1Snapshot, 1, LOAD_ORIGIN);
    return doc;
  };
  const loadV2 = (): ReturnType<typeof createNoteDoc> => {
    const doc = createNoteDoc();
    loadState(doc, history.v2Snapshot, 2, LOAD_ORIGIN);
    return doc;
  };

  // The production shape: compaction covered 90 % of the rows, the rest is replayed after the snapshot.
  const cut = Math.floor(history.rows.length * 0.9);
  const headDoc = createNoteDoc();
  for (const row of history.rows.slice(0, cut)) applyV1(headDoc, row, LOAD_ORIGIN);
  const partialV2 = encodeState(headDoc, 2);
  const tail = history.rows.slice(cut);
  const tailBytes = tail.reduce((sum, row) => sum + row.byteLength, 0);
  const loadV2PlusTail = (): ReturnType<typeof createNoteDoc> => {
    const doc = createNoteDoc();
    loadState(doc, partialV2, 2, LOAD_ORIGIN);
    for (const row of tail) applyV1(doc, row, LOAD_ORIGIN);
    return doc;
  };

  const fromV1 = loadV1();
  const fromV2 = loadV2();
  const fromV2PlusTail = loadV2PlusTail();

  return {
    operations: history.operations,
    rows: history.rows.length,
    textChars: history.textChars,
    bytes: {
      rawLog: history.logBytes,
      mergedLogV1: history.mergedLog.byteLength,
      snapshotV1: history.v1Snapshot.byteLength,
      snapshotV2: history.v2Snapshot.byteLength,
      v2OverV1: round(history.v2Snapshot.byteLength / history.v1Snapshot.byteLength, 4),
    },
    load: {
      snapshotV1: timeLoads(samples, loadV1),
      snapshotV2: timeLoads(samples, loadV2),
      mergedLogV1: timeLoads(samples, () => {
        const doc = createNoteDoc();
        loadState(doc, history.mergedLog, 1, LOAD_ORIGIN);
      }),
      replayRows: timeLoads(Math.min(samples, 3), () => {
        const doc = createNoteDoc();
        for (const row of history.rows) applyV1(doc, row, LOAD_ORIGIN);
      }),
      snapshotV2PlusTail: {
        ...timeLoads(samples, loadV2PlusTail),
        tailRows: tail.length,
        tailBytes,
      },
    },
    equivalence: {
      v1AndV2LoadSameStateVector: bytesEqual(stateVector(fromV1), stateVector(fromV2)),
      v2LoadProjectsSameText: projectMarkdown(fromV2) === history.finalText,
      v2PlusTailProjectsSameText: projectMarkdown(fromV2PlusTail) === history.finalText,
    },
  };
}
