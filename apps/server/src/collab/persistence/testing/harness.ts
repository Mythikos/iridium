/**
 * The persistence harness the unit and property suites share: the real `CollabPersistenceService`
 * over the in-memory store, a `ManualClock`, the real `FaultRegistry` (armed the way the harness
 * arms it), and recorders for the log lines, the metrics and the callbacks the writer produces.
 *
 * `openNote` is `NoteService.initialize` followed by the load path, exactly as `onLoadDocument` and
 * `afterLoadDocument` perform them — seed the five rows, load, apply in place, attach — on a
 * `fakeDocument`, so a suite starts where a client's first frame would arrive.
 */
import { newId, noteDocName, NoteId, SessionId, UserId, VaultId } from '@iridium/contracts';

import { ManualClock } from '../../../../test/support/manual-clock.ts';
import { FaultRegistry } from '../../../ops/faults.ts';
import { CollabPersistenceService } from '../index.ts';
import type { OwnedPersistenceStore } from '../store.ts';
import type { LoadedState, UpdateActor } from '../types.ts';
import type { NoteWriter, WriterMetrics } from '../writer.ts';
import { fakeDocument, type FakeDocument } from './fake-document.ts';
import { MemoryPersistenceStore } from './memory-store.ts';

/** One recorded log line. */
export interface LogLine {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

/** The logger the harness hands every component: three methods, one array. */
export interface RecordingLogger {
  readonly lines: LogLine[];
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
  /** The `event` fields, in order, for assertions on the SIEM vocabulary. */
  events(): readonly string[];
}

export function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = [];
  const push =
    (level: LogLine['level']) =>
    (fields: Readonly<Record<string, unknown>>, message: string): void => {
      lines.push({ level, fields, message });
    };
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    events: () =>
      lines.flatMap((line) =>
        typeof line.fields['event'] === 'string' ? [line.fields['event']] : [],
      ),
  };
}

/** The metrics the writer moves, recorded as `name{labels}` → value. */
export interface RecordingMetrics extends WriterMetrics {
  readonly counters: Map<string, number>;
  readonly observations: Map<string, number[]>;
  readonly gauges: Map<string, number>;
  count(name: string, labels?: Readonly<Record<string, string>>): number;
}

function key(name: string, labels: Readonly<Record<string, string>> = {}): string {
  const rendered = Object.entries(labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([label, value]) => `${label}=${value}`)
    .join(',');
  return rendered === '' ? name : `${name}{${rendered}}`;
}

export function recordingMetrics(): RecordingMetrics {
  const counters = new Map<string, number>();
  const observations = new Map<string, number[]>();
  const gauges = new Map<string, number>();
  const inc = (name: string, labels?: Readonly<Record<string, string>>): void => {
    const k = key(name, labels);
    counters.set(k, (counters.get(k) ?? 0) + 1);
  };
  const observe = (name: string, value: number): void => {
    const list = observations.get(name) ?? [];
    list.push(value);
    observations.set(name, list);
  };
  return {
    counters,
    observations,
    gauges,
    count: (name, labels) => counters.get(key(name, labels)) ?? 0,
    persistLatencySeconds: { observe: (value) => observe('persist_latency_seconds', value) },
    persistFailuresTotal: { inc: (labels) => inc('persist_failures_total', labels) },
    compactionsTotal: { inc: (labels) => inc('compactions_total', labels) },
    noteStateBytes: { observe: (value) => observe('note_state_bytes', value) },
    stateVectorOversizeTotal: { inc: () => inc('state_vector_oversize_total') },
    contentInvalidTotal: { inc: (labels) => inc('content_invalid_total', labels) },
  };
}

/** What `createHarness` returns. */
export interface PersistenceHarness {
  readonly store: MemoryPersistenceStore;
  readonly clock: ManualClock;
  readonly logger: RecordingLogger;
  readonly metrics: RecordingMetrics;
  readonly faults: FaultRegistry;
  readonly persistence: CollabPersistenceService;
  /** Document names whose vetoed unload the writer asked to complete. */
  readonly unloadRequests: string[];
  /** Note ids the writer reported trashed. */
  readonly trashed: string[];
  /** `SIGKILL`s the fault registry asked for, counted instead of performed. */
  readonly kills: number[];
  readonly gaugeValues: { queueDepth: number; backlogAgeSeconds: number; writersFailed: number };
  /** Seeds a note and opens it the way the load path does. */
  openNote(input?: OpenNoteInput): Promise<OpenedNote>;
}

export interface OpenNoteInput {
  readonly noteId?: NoteId;
  readonly vaultId?: VaultId;
  readonly markdown?: string;
  readonly checkpointIntervalMinutes?: number;
}

/** An opened note: the document, its writer, and the ids. */
export interface OpenedNote {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly documentName: string;
  readonly document: FakeDocument;
  readonly writer: NoteWriter;
  readonly loaded: LoadedState;
}

export interface HarnessOptions {
  readonly slots?: number;
  readonly compactionAwaitTimeoutMs?: number;
  readonly random?: () => number;
  readonly clock?: ManualClock;
  readonly store?: MemoryPersistenceStore;
  readonly writerStore?: () => OwnedPersistenceStore;
  readonly principalBlocked?: (userId: UserId) => boolean;
  readonly onRequestUnload?: (documentName: string) => Promise<void>;
}

/** The fixed, obviously fake author of every seeded note. */
export const HARNESS_USER: UserId = UserId.parse('0190f2a0-0000-7000-8000-00000000a001');

/** That author as the writer records it. */
export const HARNESS_ACTOR: UpdateActor = Object.freeze({
  userId: HARNESS_USER,
  sessionId: null,
  actorType: 'user',
});

/** A user id for a second author, so coalescing has two actors to keep apart. */
export const SECOND_USER: UserId = UserId.parse('0190f2a0-0000-7000-8000-00000000a002');

/** Two sessions of the first author. */
export const SESSION_A: SessionId = SessionId.parse('0190f2a0-0000-7000-8000-00000000c001');
export const SESSION_B: SessionId = SessionId.parse('0190f2a0-0000-7000-8000-00000000c002');

/** Builds the harness. */
export function createHarness(options: HarnessOptions = {}): PersistenceHarness {
  const clock = options.clock ?? new ManualClock();
  const store = options.store ?? new MemoryPersistenceStore();
  const logger = recordingLogger();
  const metrics = recordingMetrics();
  const kills: number[] = [];
  const faults = new FaultRegistry({
    nodeEnv: 'test',
    clock,
    logger,
    hardKill: () => {
      kills.push(clock.now());
    },
  });
  const unloadRequests: string[] = [];
  const trashed: string[] = [];
  const gaugeValues = { queueDepth: 0, backlogAgeSeconds: 0, writersFailed: 0 };
  const persistence = new CollabPersistenceService({
    store,
    ...(options.writerStore === undefined ? {} : { writerStore: options.writerStore }),
    ...(options.principalBlocked === undefined
      ? {}
      : { principalBlocked: options.principalBlocked }),
    clock,
    logger,
    metrics: () => metrics,
    gauges: () => ({
      persistQueueDepth: { set: (value) => void (gaugeValues.queueDepth = value) },
      persistBacklogAgeSeconds: { set: (value) => void (gaugeValues.backlogAgeSeconds = value) },
      persistWritersFailed: { set: (value) => void (gaugeValues.writersFailed = value) },
    }),
    faults,
    limits: { compactionAwaitTimeoutMs: options.compactionAwaitTimeoutMs ?? 1_000 },
    slots: options.slots ?? 3,
    callbacks: {
      onTrashed: (noteId) => {
        trashed.push(noteId);
      },
      requestUnload: async (documentName) => {
        unloadRequests.push(documentName);
        await options.onRequestUnload?.(documentName);
      },
      onWriteRejected: () => undefined,
    },
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  return {
    store,
    clock,
    logger,
    metrics,
    faults,
    persistence,
    unloadRequests,
    trashed,
    kills,
    gaugeValues,
    async openNote(input = {}): Promise<OpenedNote> {
      const noteId = input.noteId ?? NoteId.parse(newId());
      const vaultId = input.vaultId ?? VaultId.parse(newId());
      if (store.note(noteId) === undefined) {
        store.seed({
          noteId,
          vaultId,
          markdownLf: input.markdown ?? '',
          actor: HARNESS_ACTOR,
          now: clock.date(),
          ...(input.checkpointIntervalMinutes === undefined
            ? {}
            : { checkpointIntervalMinutes: input.checkpointIntervalMinutes }),
        });
      }
      const loaded = await persistence.load(noteId, vaultId);
      const document = fakeDocument();
      persistence.apply(document, loaded);
      const documentName = noteDocName(noteId);
      const writer = persistence.attach(document, { noteId, vaultId, documentName }, loaded);
      return { noteId, vaultId, documentName, document, writer, loaded };
    },
  };
}

/** Lets every queued microtask run: what a writer turn needs between two synchronous steps. */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- each round drains one layer of microtasks
    await Promise.resolve();
  }
}
