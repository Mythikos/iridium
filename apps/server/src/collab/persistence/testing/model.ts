/**
 * The writer/loader model the two `persistence.model.prop` files share (10-testing-and-quality.md,
 * "`persistence.model.prop` — the writer/loader model"; HP-1, HP-2).
 *
 * The real system under test is the product's `NoteWriter`, loader and compactor over a
 * `PersistenceStore`; what varies between the `unit` mirror and the `property` project is only the
 * `ModelStore` — the in-memory double here, real MySQL there. The model keeps the text the live
 * document must show and the text a load must reproduce; every command re-checks the invariants the
 * plan numbers against the store as it is, never against a prediction of its rows.
 */
import { newId, NoteId, SessionId, UserId, VaultId } from '@iridium/contracts';
import {
  applyV1,
  createNoteDoc,
  dominates,
  getContent,
  mergeV1,
  projectMarkdown,
  stateVector,
  type NoteDoc,
} from '@iridium/crdt';
import * as fc from 'fast-check';
import { expect } from 'vitest';

import { HeadSeqCasViolation } from '../../../db/cas.ts';
import type { UpdateOrigin } from '../../../db/schema.ts';
import type { Clock } from '../../../ops/clock.ts';
import { CollabRejection, isHookSignal } from '../../rejection.ts';
import { capture, NO_COMPACTION_FAULTS, runCompaction } from '../compactor.ts';
import { CollabPersistenceService } from '../index.ts';
import { applyLoaded } from '../loader.ts';
import type { PersistenceStore } from '../store.ts';
import { asV1Update, type UpdateActor } from '../types.ts';
import type { NoteWriter, WriterFaults, WriterLogger } from '../writer.ts';
import { asStateVector } from './bytes.ts';
import {
  connectionOrigin,
  fakeDocument,
  type FakeConnection,
  type FakeDocument,
} from './fake-document.ts';
import type { MemoryPersistenceStore } from './memory-store.ts';

/** What the model reads back from a store after a command. */
export interface StoreView {
  readonly headSeq: number;
  readonly snapshotThroughSeq: number;
  readonly projectedSeq: number;
  readonly projectionRevision: number | null;
  readonly projectionHash: string | null;
  readonly projectionMarkdown: string | null;
  readonly deletedAt: Date | null;
  readonly updates: readonly StoredUpdateView[];
}

export interface StoredUpdateView {
  readonly seq: number;
  readonly origin: UpdateOrigin;
  readonly actorUserId: string | null;
  readonly actorSessionId: string | null;
  readonly svAfter: Uint8Array;
  readonly updateV1: Uint8Array;
}

/** The store as the model drives it: the port, plus the three things a test does around it. */
export interface ModelStore {
  readonly store: PersistenceStore;
  /** `NoteService.initialize` for one note, however the store is backed. */
  seedNote(input: {
    readonly noteId: NoteId;
    readonly vaultId: VaultId;
    readonly markdownLf: string;
    readonly actor: UpdateActor;
    readonly now: Date;
  }): Promise<void>;
  view(noteId: NoteId): Promise<StoreView>;
  /** The trash flow's effect on the row the writer's guard reads. */
  trash(noteId: NoteId, at: Date): Promise<void>;
  /** `jobs/update_log_prune`: rows at or below `snapshot_through_seq` older than `olderThan`. */
  prune(noteId: NoteId, olderThan: Date): Promise<number>;
}

/** The in-memory store as a `ModelStore`. */
export function memoryModelStore(store: MemoryPersistenceStore): ModelStore {
  return {
    store,
    seedNote: async (input) => {
      store.seed(input);
    },
    view: async (noteId) => {
      const note = store.note(noteId);
      if (note === undefined) throw new Error(`the store holds no note ${noteId}`);
      return {
        headSeq: note.headSeq,
        snapshotThroughSeq: note.snapshotThroughSeq,
        projectedSeq: note.projectedSeq,
        projectionRevision: note.projection?.revision ?? null,
        projectionHash:
          note.projection === null
            ? null
            : Buffer.from(note.projection.contentHash).toString('hex'),
        projectionMarkdown: note.projection?.markdown ?? null,
        deletedAt: note.deletedAt,
        updates: note.updates.map((row) => ({
          seq: row.seq,
          origin: row.origin,
          actorUserId: row.actor.userId,
          actorSessionId: row.actor.sessionId,
          svAfter: row.svAfter,
          updateV1: row.updateV1,
        })),
      };
    },
    trash: async (noteId, at) => {
      store.trash(noteId, at);
    },
    prune: async (noteId, olderThan) => store.prune(noteId, olderThan),
  };
}

/** Two authors, each on its own session: what coalescing and attribution are checked against. */
export interface ModelActor {
  readonly userId: UserId;
  readonly sessionId: SessionId;
}

/** The writer faults that never fire. */
const NO_WRITER_FAULTS: WriterFaults = {
  hold: async () => undefined,
  fire: () => ({ fired: false, arg: undefined }),
  delay: async () => undefined,
  crash: () => undefined,
  maybeThrow: () => undefined,
};

const COMPACTION_AWAIT_MS = 1_000;

/** What the model drives: the live document, its writer and the store behind them. */
export interface ModelReal {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly actors: readonly [ModelActor, ModelActor];
  readonly clock: Clock;
  readonly modelStore: ModelStore;
  readonly persistence: CollabPersistenceService;
  document: FakeDocument;
  writer: NoteWriter;
  connections: readonly [FakeConnection, FakeConnection];
  /** Note ids the layer reported trashed. */
  readonly trashed: string[];
  view(): Promise<StoreView>;
  /** A throwaway document loaded from the store: what a reconnecting client would receive. */
  loadFresh(): Promise<NoteDoc>;
  /** Disposes the writer and reopens the note from the store: a crash, or a restart. */
  reopen(): Promise<void>;
  /** A second writer instance over the same store, with its own document and connection. */
  secondWriter(): Promise<{
    readonly document: FakeDocument;
    readonly writer: NoteWriter;
    readonly connection: FakeConnection;
    settled(): Promise<void>;
    dispose(): void;
  }>;
  /** A compaction captured at `throughSeq`, run after newer state committed. */
  staleCompaction(throughSeq: number): Promise<void>;
  dispose(): void;
}

export interface ModelRealOptions {
  readonly modelStore: ModelStore;
  /** IDs from routes and authenticated sessions in the MySQL-backed model. */
  readonly identity?: {
    readonly noteId: NoteId;
    readonly vaultId: VaultId;
    readonly actors: readonly [ModelActor, ModelActor];
  };
  readonly clock: Clock;
  readonly logger: WriterLogger;
  readonly markdown: string;
  readonly slots?: number;
  readonly random?: () => number;
}

function service(options: ModelRealOptions, trashed: string[]): CollabPersistenceService {
  return new CollabPersistenceService({
    store: options.modelStore.store,
    clock: options.clock,
    logger: options.logger,
    metrics: () => null,
    gauges: () => null,
    faults: NO_WRITER_FAULTS,
    limits: { compactionAwaitTimeoutMs: COMPACTION_AWAIT_MS },
    slots: options.slots ?? 2,
    callbacks: {
      onTrashed: (noteId) => {
        trashed.push(noteId);
      },
      requestUnload: async () => undefined,
      onWriteRejected: () => undefined,
    },
    ...(options.random === undefined ? {} : { random: options.random }),
  });
}

/** Seeds one note and opens it: the load path as `onLoadDocument` and `afterLoadDocument` run it. */
export async function createModelReal(options: ModelRealOptions): Promise<ModelReal> {
  const noteId = options.identity?.noteId ?? NoteId.parse(newId());
  const vaultId = options.identity?.vaultId ?? VaultId.parse(newId());
  const actors: readonly [ModelActor, ModelActor] = options.identity?.actors ?? [
    { userId: UserId.parse(newId()), sessionId: SessionId.parse(newId()) },
    { userId: UserId.parse(newId()), sessionId: SessionId.parse(newId()) },
  ];
  const trashed: string[] = [];
  const persistence = service(options, trashed);
  const documentName = `note:${noteId}`;
  await options.modelStore.seedNote({
    noteId,
    vaultId,
    markdownLf: options.markdown,
    actor: { userId: actors[0].userId, sessionId: null, actorType: 'user' },
    now: options.clock.date(),
  });

  const open = async (
    layer: CollabPersistenceService,
  ): Promise<{ document: FakeDocument; writer: NoteWriter }> => {
    const loaded = await layer.load(noteId, vaultId);
    const document = fakeDocument();
    layer.apply(document, loaded);
    const writer = layer.attach(document, { noteId, vaultId, documentName }, loaded);
    return { document, writer };
  };
  const connect = (document: FakeDocument): [FakeConnection, FakeConnection] => [
    document.addConnection({ role: 'editor', ...actors[0] }),
    document.addConnection({ role: 'editor', ...actors[1] }),
  ];

  const first = await open(persistence);
  const real: ModelReal = {
    noteId,
    vaultId,
    actors,
    clock: options.clock,
    modelStore: options.modelStore,
    persistence,
    document: first.document,
    writer: first.writer,
    connections: connect(first.document),
    trashed,
    view: () => options.modelStore.view(noteId),
    async loadFresh(): Promise<NoteDoc> {
      const loaded = await persistence.load(noteId, vaultId);
      const doc = createNoteDoc({ gc: true });
      persistence.apply(doc, loaded);
      return doc;
    },
    async reopen(): Promise<void> {
      // A crash abandons the writer; a transaction the database already had in flight still ends
      // on its own — committed or rolled back — before the successor loads, as it would in MySQL.
      persistence.detach(documentName);
      real.document.destroy();
      await persistence.scheduler.idle();
      const next = await open(persistence);
      real.document = next.document;
      real.writer = next.writer;
      real.connections = connect(next.document);
    },
    async secondWriter() {
      const other = service(options, trashed);
      const opened = await open(other);
      const connection = opened.document.addConnection({ role: 'editor', ...actors[1] });
      return {
        document: opened.document,
        writer: opened.writer,
        connection,
        settled: () => other.scheduler.idle(),
        dispose: () => {
          other.detach(documentName);
          opened.document.destroy();
        },
      };
    },
    async staleCompaction(throughSeq: number): Promise<void> {
      const row = await options.modelStore.store.loadDoc(noteId);
      if (row === null) throw new Error('the note has no note_docs row');
      const stale = createNoteDoc({ gc: true });
      try {
        applyLoaded(stale, { ...row, updates: [] });
        await runCompaction(options.modelStore.store, {
          noteId,
          vaultId,
          captured: capture(stale, { lastCommittedSeq: throughSeq, lastEditor: null }),
          trigger: 'flush',
          now: options.clock.date(),
          faults: NO_COMPACTION_FAULTS,
          actor: { userId: null, sessionId: null, actorType: 'system' },
          onStateVectorOversize: () => undefined,
        });
      } finally {
        stale.destroy();
      }
    },
    dispose(): void {
      persistence.detach(documentName);
      real.document.destroy();
    },
  };
  return real;
}

// ---- the model and its invariants ---------------------------------------------------------------

/** What the model believes. */
export interface PersistenceModel {
  /** The text the live document shows. */
  text: string;
  /** The text a load must reproduce; `null` after a step whose committed prefix is not predictable. */
  committed: string | null;
  pending: number;
  compacted: boolean;
  trashed: boolean;
  /** The highest `head_seq` seen, for monotonicity. */
  headSeen: number;
}

export function initialModel(markdown: string): PersistenceModel {
  return {
    text: markdown,
    committed: markdown,
    pending: 0,
    compacted: false,
    trashed: false,
    headSeen: 1,
  };
}

/** Invariants 1, 5 and 9 plus the monotonic counters, against the store as it is. */
export function assertStoreInvariants(
  view: StoreView,
  model: PersistenceModel,
  real: ModelReal,
): void {
  const seqs = view.updates.map((row) => row.seq);
  for (let index = 1; index < seqs.length; index += 1) {
    expect(seqs[index], 'seq is gap-free and strictly increasing').toBe((seqs[index - 1] ?? 0) + 1);
  }
  expect(new Set(seqs).size, 'no two rows share a seq').toBe(seqs.length);
  const last = seqs.at(-1);
  if (last !== undefined) expect(view.headSeq, 'head_seq is the last row').toBe(last);
  expect(view.snapshotThroughSeq, 'snapshot_through_seq <= head_seq').toBeLessThanOrEqual(
    view.headSeq,
  );
  expect(view.projectedSeq, 'projected_seq <= head_seq').toBeLessThanOrEqual(view.headSeq);
  expect(view.headSeq, 'head_seq never decreases').toBeGreaterThanOrEqual(model.headSeen);
  model.headSeen = view.headSeq;
  const users = new Set(real.actors.map((actor) => actor.userId));
  const sessions = new Set(real.actors.map((actor) => actor.sessionId));
  for (const row of view.updates) {
    if (row.origin !== 'connection') continue;
    expect(
      row.actorUserId !== null && users.has(UserId.parse(row.actorUserId)),
      'actor is a user',
    ).toBe(true);
    expect(
      row.actorSessionId !== null && sessions.has(SessionId.parse(row.actorSessionId)),
      'actor session is the connection session',
    ).toBe(true);
  }
}

/** Invariant 3: a load dominates every committed `sv_after`, and shows the committed text. */
export async function assertLoad(real: ModelReal, model: PersistenceModel): Promise<string> {
  const view = await real.view();
  const fresh = await real.loadFresh();
  try {
    const sv = stateVector(fresh);
    for (const row of view.updates) {
      if (row.svAfter.byteLength === 0) continue;
      expect(dominates(sv, asStateVector(row.svAfter)), 'load dominates sv_after').toBe(true);
    }
    const text = projectMarkdown(fresh);
    // With updates still queued the writer may have committed any prefix of them; only a drained
    // writer makes the loaded text predictable.
    if (model.pending === 0) expect(text, 'a load shows the committed text').toBe(model.text);
    return text;
  } finally {
    fresh.destroy();
  }
}

/** Plain checks for the command bodies, which run inside the property's test body. */
function same<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function sameList(actual: readonly unknown[], expected: readonly unknown[], what: string): void {
  same(JSON.stringify(actual), JSON.stringify(expected), what);
}

function holds(condition: boolean, what: string): void {
  if (!condition) throw new Error(`${what} does not hold`);
}

function clampPosition(at: number, text: string): number {
  const position = Math.min(text.length, Math.max(0, Math.floor(at * (text.length + 1))));
  // Browser caret positions do not bisect UTF-16 surrogate pairs. Yjs deliberately repairs a
  // split pair to U+FFFD, so that invalid cursor position is not an independent string-splice oracle.
  const before = text.charCodeAt(position - 1);
  const after = text.charCodeAt(position);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? position + 1
    : position;
}

// ---- the commands ------------------------------------------------------------------------------

type Command = fc.AsyncCommand<PersistenceModel, ModelReal>;

export class InsertCommand implements Command {
  readonly #actor: 0 | 1;
  readonly #at: number;
  readonly #text: string;

  constructor(actor: 0 | 1, at: number, text: string) {
    this.#actor = actor;
    this.#at = at;
    this.#text = text;
  }

  check(model: Readonly<PersistenceModel>): boolean {
    return !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    const position = clampPosition(this.#at, model.text);
    const connection = real.connections[this.#actor];
    real.document.transact(() => {
      getContent(real.document).insert(position, this.#text);
    }, connectionOrigin(connection));
    model.text = model.text.slice(0, position) + this.#text + model.text.slice(position);
    model.pending += 1;
    same(projectMarkdown(real.document), model.text, 'the live text after an insert');
  }

  toString(): string {
    return `Insert(${String(this.#actor)}, ${this.#at.toFixed(2)}, ${JSON.stringify(this.#text)})`;
  }
}

class FlushCommand implements Command {
  check(model: Readonly<PersistenceModel>): boolean {
    return !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    await real.writer.drain();
    same(real.writer.state, 'idle', 'the writer state after a drain');
    holds(
      dominates(real.writer.lastPersisted.sv, stateVector(real.document)),
      'the acknowledged vector dominates the live document',
    );
    const view = await real.view();
    assertStoreInvariants(view, model, real);
    model.committed = model.text;
    model.pending = 0;
    await assertLoad(real, model);
  }

  toString(): string {
    return 'Flush';
  }
}

class CompactCommand implements Command {
  check(model: Readonly<PersistenceModel>): boolean {
    return !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    const first = await real.persistence.compactNow(real.noteId, { trigger: 'flush' });
    same(first?.status, 'ok', 'the first compaction');
    const afterFirst = await real.view();
    const second = await real.persistence.compactNow(real.noteId, { trigger: 'flush' });
    same(second?.status, 'ok', 'the second compaction');
    const afterSecond = await real.view();
    // Invariant 6: a second compaction at the same head changes nothing.
    sameList(
      [afterSecond.snapshotThroughSeq, afterSecond.projectedSeq, afterSecond.projectionHash],
      [afterFirst.snapshotThroughSeq, afterFirst.projectedSeq, afterFirst.projectionHash],
      'a repeated compaction',
    );
    same(
      afterSecond.snapshotThroughSeq,
      afterSecond.headSeq,
      'snapshot_through_seq after compaction',
    );
    same(afterSecond.projectedSeq, afterSecond.headSeq, 'projected_seq after compaction');
    assertStoreInvariants(afterSecond, model, real);
    model.committed = model.text;
    model.pending = 0;
    model.compacted = true;
    same(afterSecond.projectionMarkdown, model.text, 'the committed projection');
  }

  toString(): string {
    return 'Compact';
  }
}

class LoadCommand implements Command {
  check(): boolean {
    return true;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    if (model.trashed) {
      // A trashed note is refused by the loader, never served.
      const refusal = await real.loadFresh().then(
        () => 'served',
        (error: unknown) =>
          isHookSignal(error) && error instanceof CollabRejection ? error.reason : 'other',
      );
      same(refusal, 'note-trashed', 'a load of a trashed note');
      return;
    }
    await assertLoad(real, model);
  }

  toString(): string {
    return 'Load';
  }
}

class CrashCommand implements Command {
  check(model: Readonly<PersistenceModel>): boolean {
    return !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    // Whatever was in flight is abandoned with the writer; the store keeps exactly what committed.
    await real.reopen();
    const view = await real.view();
    assertStoreInvariants(view, model, real);
    model.text = projectMarkdown(real.document);
    model.committed = model.text;
    model.pending = 0;
    await assertLoad(real, model);
  }

  toString(): string {
    return 'Crash';
  }
}

class EnqueueStaleCommand implements Command {
  check(model: Readonly<PersistenceModel>): boolean {
    return model.compacted && !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    await real.writer.drain();
    model.committed = model.text;
    model.pending = 0;
    const before = await real.view();
    if (before.snapshotThroughSeq >= before.headSeq) return;
    const refused = await real.staleCompaction(before.snapshotThroughSeq).then(
      () => false,
      (error: unknown) => error instanceof HeadSeqCasViolation,
    );
    holds(refused, 'the stale compaction is refused before mutation');
    const after = await real.view();
    // Invariant 2: the stale store overwrote nothing.
    sameList(
      [after.headSeq, after.snapshotThroughSeq, after.projectedSeq, after.projectionHash],
      [before.headSeq, before.snapshotThroughSeq, before.projectedSeq, before.projectionHash],
      'the store after a stale compaction',
    );
    await assertLoad(real, model);
  }

  toString(): string {
    return 'EnqueueStale';
  }
}

export class ConcurrentWriterCommand implements Command {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  check(model: Readonly<PersistenceModel>): boolean {
    return !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    await real.writer.drain();
    const before = await real.view();
    const other = await real.secondWriter();
    let committedText = '';
    try {
      other.document.transact(() => {
        getContent(other.document).insert(0, this.#text);
      }, connectionOrigin(other.connection));
      real.document.transact(() => {
        getContent(real.document).insert(getContent(real.document).length, this.#text);
      }, connectionOrigin(real.connections[0]));
      // A failed writer deliberately retains its unacknowledged queue, so drain() cannot finish.
      // The real schedulers settle when both transactions have reached their terminal state.
      await Promise.all([real.persistence.scheduler.idle(), other.settled()]);
      sameList(
        [real.writer.state, other.writer.state].toSorted(),
        ['failed', 'idle'],
        'one CAS winner and one stale-owner refusal',
      );
      const winner = real.writer.state === 'idle' ? real.writer : other.writer;
      const loser = winner === real.writer ? other.writer : real.writer;
      same(loser.lastCommittedSeq, before.headSeq, 'the losing writer acknowledges no update');
      same(loser.lastFailure?.retryInMs, 0, 'a stale owner is a permanent failure');
      committedText = projectMarkdown(winner === real.writer ? real.document : other.document);
      const view = await real.view();
      assertStoreInvariants(view, model, real);
      same(view.headSeq, before.headSeq + 1, 'exactly one concurrent update commits');
      same(view.headSeq, winner.lastCommittedSeq, 'head_seq names the winner');
    } finally {
      other.dispose();
    }
    await real.reopen();
    model.text = projectMarkdown(real.document);
    same(model.text, committedText, 'the reloaded text contains only the acknowledged winner');
    model.committed = model.text;
    model.pending = 0;
    await assertLoad(real, model);
  }

  toString(): string {
    return `ConcurrentWriter(${JSON.stringify(this.#text)})`;
  }
}

class PruneLogCommand implements Command {
  check(model: Readonly<PersistenceModel>): boolean {
    return model.compacted && !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    await real.writer.drain();
    model.committed = model.text;
    model.pending = 0;
    const before = await real.view();
    const olderThan = new Date(real.clock.now() + 1);
    await real.modelStore.prune(real.noteId, olderThan);
    const after = await real.view();
    holds(
      after.updates.every((row) => row.seq > before.snapshotThroughSeq),
      'every remaining row is above snapshot_through_seq',
    );
    same(after.headSeq, before.headSeq, 'head_seq after a prune');
    // Pruning is safe: the snapshot covers what was pruned.
    await assertLoad(real, model);
  }

  toString(): string {
    return 'PruneLog';
  }
}

class TrashNoteCommand implements Command {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  check(model: Readonly<PersistenceModel>): boolean {
    return !model.trashed;
  }

  async run(model: PersistenceModel, real: ModelReal): Promise<void> {
    await real.writer.drain();
    const before = await real.view();
    await real.modelStore.trash(real.noteId, real.clock.date());
    real.document.transact(() => {
      getContent(real.document).insert(0, this.#text);
    }, connectionOrigin(real.connections[0]));
    await real.writer.drain();
    // Invariant 7: nothing is written after the trash, and the writer reports it.
    same(real.writer.state, 'trashed', 'the writer state after a trashed write');
    holds(real.trashed.includes(real.noteId), 'the layer reported the note trashed');
    const after = await real.view();
    same(after.headSeq, before.headSeq, 'head_seq after a trashed write');
    same(
      after.updates.map((row) => row.seq).join(','),
      before.updates.map((row) => row.seq).join(','),
      'the rows after a trashed write',
    );
    model.trashed = true;
    model.pending = 0;
  }

  toString(): string {
    return `TrashNote(${JSON.stringify(this.#text)})`;
  }
}

/** The command arbitraries, with `text` drawn from the caller's alphabet. */
export function persistenceCommands(text: fc.Arbitrary<string>): fc.Arbitrary<Command>[] {
  const actor = fc.constantFrom<0 | 1>(0, 1);
  const at = fc.double({ min: 0, max: 1, noNaN: true });
  return [
    fc.tuple(actor, at, text).map(([who, where, what]) => new InsertCommand(who, where, what)),
    fc.tuple(actor, at, text).map(([who, where, what]) => new InsertCommand(who, where, what)),
    fc.constant(new FlushCommand()),
    fc.constant(new FlushCommand()),
    fc.constant(new CompactCommand()),
    fc.constant(new LoadCommand()),
    fc.constant(new CrashCommand()),
    fc.constant(new EnqueueStaleCommand()),
    text.map((what) => new ConcurrentWriterCommand(what)),
    fc.constant(new PruneLogCommand()),
    text.map((what) => new TrashNoteCommand(what)),
  ];
}

/** Invariant 8, checked once per run: the merged rows applied alone equal the rows applied in order. */
export async function assertCoalescingPreservesSemantics(real: ModelReal): Promise<void> {
  const view = await real.view();
  const row = await real.modelStore.store.loadDoc(real.noteId);
  if (row === null) return;
  const tail = view.updates.filter((update) => update.seq > row.snapshotThroughSeq);
  const inOrder = createNoteDoc({ gc: true });
  const merged = createNoteDoc({ gc: true });
  try {
    applyLoaded(inOrder, { ...row, updates: [] });
    applyLoaded(merged, { ...row, updates: [] });
    const updates = tail.map((update) => asV1Update(update.updateV1));
    for (const update of updates) applyV1(inOrder, update, null);
    if (updates.length > 0) applyV1(merged, mergeV1(updates), null);
    same(
      projectMarkdown(merged),
      projectMarkdown(inOrder),
      'the merged row against the rows in order',
    );
  } finally {
    inOrder.destroy();
    merged.destroy();
  }
}
