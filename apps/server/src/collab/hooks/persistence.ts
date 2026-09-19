import type {
  afterLoadDocumentPayload,
  afterUnloadDocumentPayload,
  beforeHandleMessagePayload,
  beforeUnloadDocumentPayload,
  connectedPayload,
  Connection,
  Extension,
  onLoadDocumentPayload,
  onStatelessPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
/**
 * `IridiumPersistence` — durability on `/collab`
 * (05-collaboration-and-durability.md, "Loading a document", "The baseline", "Forcing currency",
 * "Unload, veto, and completing the unload"; 09-api-reference.md §3.8).
 *
 * `onLoadDocument` applies the persisted state in place and **returns `undefined`**: a returned byte
 * array would be applied by Hocuspocus as V1, and the snapshot is V2 (A15, spike S1). `afterLoadDocument`
 * attaches the writer and initialises the baseline. `onStateless` answers `baseline` on that
 * connection only and `flush` with the current `projected {seq}`, and closes the connection itself
 * on anything it cannot parse — it never signals by throwing. `onStoreDocument` enqueues a compaction
 * into the writer's FIFO and awaits it, so `flushPendingStores()` is truthful. `beforeUnloadDocument`
 * vetoes on the four conditions, and `afterUnloadDocument` disposes the writer.
 */
import {
  decodeClientNoteMessage,
  encodeStateless,
  LIMITS,
  NoteId,
  parseDocName,
} from '@iridium/contracts';
import {
  deleteSetFingerprint,
  dominates,
  FRAME_TYPE,
  peekFrame,
  peekSyncType,
  scanHostileContent,
  stateVector,
  SYNC_TYPE,
} from '@iridium/crdt';

import { classifyDatabaseFailure } from '../../db/failure.ts';
import type { Clock } from '../../ops/clock.ts';
import type { CollabHookContext } from '../context.ts';
import type { CollabGateway } from '../gateway.ts';
import type { CollabMetrics } from '../metrics.ts';
import { CollabOwnershipLost } from '../owner-lease.ts';
import { isCompactionRejection } from '../persistence/errors.ts';
import type { CollabPersistenceService } from '../persistence/index.ts';
import { PersistenceUnavailable } from '../persistence/kysely-store.ts';
import type { LoadedState, Persisted } from '../persistence/types.ts';
import type { WriterDocument } from '../persistence/writer.ts';
import { RateWindow } from '../rate.ts';
import {
  CollabRejection,
  closeEventFor,
  isHookSignal,
  StoreRejected,
  UnloadVeto,
} from '../rejection.ts';
import { safeHook, type SafeHookDeps } from '../safe-hook.ts';

/** What the extension needs. */
export interface PersistenceExtensionDeps {
  readonly persistence: CollabPersistenceService;
  readonly gateway: CollabGateway;
  readonly clock: Clock;
  readonly logger: {
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly metrics: () => CollabMetrics | null;
  /** A load that reserved budget and then failed releases it here. */
  readonly onLoadFailed: (documentName: string) => void;
  /** After the writer is disposed: the gateway index, the metrics. */
  readonly onUnloaded: (documentName: string) => void;
}

/** The window of `FLUSH_PER_MINUTE`. */
const FLUSH_WINDOW_MS = 60_000;

/** The `retryInMs` a `baseline` read that failed answers: one round trip later (05, "The baseline"). */
const BASELINE_READ_FAILED_RETRY_MS = 1_000;

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function isNote(documentName: string): boolean {
  return parseDocName(documentName)?.channel === 'note';
}

/** Builds the extension. */
export function createPersistenceExtension(
  deps: PersistenceExtensionDeps,
): Extension<CollabHookContext> {
  const loaded = new Map<string, LoadedState>();
  const flushWindows = new WeakMap<Connection<CollabHookContext>, RateWindow>();
  const hookDeps: SafeHookDeps = {
    logger: deps.logger,
    hookErrors: () => deps.metrics()?.collabHookErrorsTotal ?? null,
  };

  const beforeHandleMessage = async (
    data: beforeHandleMessagePayload<CollabHookContext>,
  ): Promise<void> => {
    if (!data.connection.readOnly) return;
    const header = peekFrame(data.update);
    if (
      header === null ||
      (header.type !== FRAME_TYPE.sync && header.type !== FRAME_TYPE.syncReply)
    )
      return;
    const subtype = peekSyncType(data.update, header);
    if (subtype !== SYNC_TYPE.step2 && subtype !== SYNC_TYPE.update) return;
    deps.persistence.writerOfDocument(data.documentName)?.notifyInvalidWrite(data.connection);
  };

  const onLoadDocument = async (
    data: onLoadDocumentPayload<CollabHookContext>,
  ): Promise<undefined> => {
    if (!isNote(data.documentName)) return undefined;
    const parsed = parseDocName(data.documentName);
    const vaultId = data.context.vaultId;
    if (parsed === null || vaultId === undefined) {
      deps.onLoadFailed(data.documentName);
      throw new CollabRejection('note-not-found', { auditReason: 'context_missing' });
    }
    try {
      const state = await deps.persistence.load(NoteId.parse(parsed.id), vaultId);
      deps.persistence.apply(data.document, state);
      loaded.set(data.documentName, state);
    } catch (error) {
      deps.onLoadFailed(data.documentName);
      if (isHookSignal(error)) throw error;
      deps.logger.error(
        {
          err: error,
          event: 'collab.hook.error',
          hook: 'onLoadDocument',
          documentName: data.documentName,
        },
        'loading a document failed; the document is refused rather than served empty',
      );
      if (error instanceof CollabOwnershipLost) throw new CollabRejection('no-owner-lease');
      const failure = classifyDatabaseFailure(error).kind;
      if (
        error instanceof PersistenceUnavailable ||
        failure === 'unavailable' ||
        failure === 'deadlock' ||
        failure === 'lock_wait_timeout'
      ) {
        throw new CollabRejection('unavailable', { auditReason: 'load_unavailable' });
      }
      throw new CollabRejection('note-not-found', { auditReason: 'load_failed' });
    }
    return undefined;
  };

  const afterLoadDocument = async (
    data: afterLoadDocumentPayload<CollabHookContext>,
  ): Promise<void> => {
    if (!isNote(data.documentName)) return;
    const state = loaded.get(data.documentName);
    loaded.delete(data.documentName);
    const parsed = parseDocName(data.documentName);
    if (state === undefined || parsed === null) return;
    const document: WriterDocument & typeof data.document = data.document;
    const writer = deps.persistence.attach(
      document,
      { noteId: NoteId.parse(parsed.id), vaultId: state.vaultId, documentName: data.documentName },
      state,
    );
    deps.gateway.registerDocument(data.documentName, state.vaultId);
    // The baseline must dominate the freshly loaded document; a violation is a codec bug, logged
    // rather than thrown, because a thrown afterLoadDocument would leave a served document with no
    // writer.
    if (
      !dominates(writer.lastPersisted.sv, stateVector(data.document)) ||
      writer.lastPersisted.ds !== deleteSetFingerprint(data.document)
    ) {
      deps.logger.error(
        { event: 'collab.hook.error', hook: 'afterLoadDocument', documentName: data.documentName },
        'the persisted baseline does not dominate the loaded document',
      );
    }
    const scan = scanHostileContent(data.document);
    if (!scan.ok) writer.lockContentInvalid(scan.reason);
  };

  /** A connection created after the latches were set is read-only from its first frame. */
  const connected = async (data: connectedPayload<CollabHookContext>): Promise<void> => {
    if (!isNote(data.documentName)) return;
    const writer = deps.persistence.writerOfDocument(data.documentName);
    if (writer === undefined) return;
    writer.applyLatches(data.connection);
  };

  const answerBaseline = async (data: onStatelessPayload): Promise<void> => {
    const connection: Connection<CollabHookContext> = data.connection;
    const parsed = parseDocName(data.documentName);
    if (parsed === null) return;
    const writer = deps.persistence.writerOfDocument(data.documentName);
    let base: Persisted | null;
    try {
      base = writer?.lastPersisted ?? (await deps.persistence.baselineOf(NoteId.parse(parsed.id)));
    } catch (error) {
      deps.logger.warn(
        { err: error, event: 'persist.failed', documentName: data.documentName },
        'the baseline could not be read; the client is told to retry',
      );
      base = null;
    }
    if (base === null) {
      connection.sendStateless(
        encodeStateless({
          v: 1,
          t: 'persist-failed',
          reason: 'db_error',
          retryInMs: BASELINE_READ_FAILED_RETRY_MS,
        }),
      );
      return;
    }
    connection.sendStateless(
      encodeStateless({ v: 1, t: 'persisted', seq: base.seq, sv: base64(base.sv), ds: base.ds }),
    );
    const failure = writer?.lastFailure ?? null;
    if (
      writer !== undefined &&
      (writer.state === 'failed' || writer.state === 'backpressure') &&
      failure !== null
    ) {
      connection.sendStateless(
        encodeStateless({
          v: 1,
          t: 'persist-failed',
          reason: failure.reason,
          retryInMs: failure.retryInMs,
        }),
      );
    }
  };

  const answerFlush = async (data: onStatelessPayload): Promise<void> => {
    const connection: Connection<CollabHookContext> = data.connection;
    const writer = deps.persistence.writerOfDocument(data.documentName);
    if (writer === undefined) return;
    let window = flushWindows.get(connection);
    if (window === undefined) {
      window = new RateWindow(LIMITS.FLUSH_PER_MINUTE, FLUSH_WINDOW_MS);
      flushWindows.set(connection, window);
    }
    if (!window.take(deps.clock.now())) {
      // Beyond the budget: the current seq, no work, never `persist-failed`, never a close (§3.4).
      connection.sendStateless(
        encodeStateless({ v: 1, t: 'projected', seq: writer.lastProjectedSeq }),
      );
      return;
    }
    try {
      const outcome = await writer.enqueueCompaction('flush');
      const seq = outcome.projected ? outcome.throughSeq : writer.lastProjectedSeq;
      connection.sendStateless(encodeStateless({ v: 1, t: 'projected', seq }));
    } catch (error) {
      if (!isCompactionRejection(error)) throw error;
      const failure = writer.lastFailure;
      connection.sendStateless(
        encodeStateless({
          v: 1,
          t: 'persist-failed',
          reason: 'db_unavailable',
          retryInMs: failure?.retryInMs ?? BASELINE_READ_FAILED_RETRY_MS,
        }),
      );
    }
  };

  const onStateless = async (data: onStatelessPayload): Promise<void> => {
    if (!isNote(data.documentName)) return;
    const decoded = decodeClientNoteMessage(data.payload);
    if (!decoded.ok) {
      deps.logger.warn(
        {
          event: 'collab.write.rejected',
          documentName: data.documentName,
          reason: decoded.reason,
          detail: decoded.detail,
        },
        'a client stateless payload was refused and the document connection is closed',
      );
      data.connection.close(closeEventFor('protocol-error'));
      return;
    }
    if (decoded.message.t === 'baseline') {
      await answerBaseline(data);
      return;
    }
    await answerFlush(data);
  };

  const onStoreDocument = async (
    data: onStoreDocumentPayload<CollabHookContext>,
  ): Promise<void> => {
    if (!isNote(data.documentName) || deps.persistence.isFenced(data.document)) return;
    const writer = deps.persistence.writerOfDocument(data.documentName);
    if (writer === undefined) {
      deps.logger.warn(
        { event: 'persist.failed', documentName: data.documentName },
        'a store fired for a document with no writer attached; nothing is stored',
      );
      return;
    }
    try {
      await writer.enqueueCompaction(data.clientsCount === 0 ? 'unload' : 'debounce');
    } catch (error) {
      // A lost owner deliberately discards this obsolete object after its SQL settles. Keeping it
      // for a retry would either pin ownership recovery or ask an old generation to write again.
      if (deps.persistence.isFenced(data.document)) return;
      throw new StoreRejected(error);
    }
  };

  const beforeUnloadDocument = async (data: beforeUnloadDocumentPayload): Promise<void> => {
    if (!isNote(data.documentName)) return;
    if (deps.persistence.isFenced(data.document)) {
      await deps.persistence.settleFenced(data.document);
      return;
    }
    const writer = deps.persistence.writerOfDocument(data.documentName);
    if (writer === undefined) return;
    let veto: UnloadVeto | null;
    try {
      veto = await writer.unloadVeto();
    } catch (error) {
      if (deps.persistence.isFenced(data.document)) {
        await deps.persistence.settleFenced(data.document);
        return;
      }
      // Fail closed: a veto check that could not run (the checkpoint read failed) keeps the document
      // in memory, where the writer retries the unload once it next drains.
      deps.logger.error(
        {
          err: error,
          event: 'collab.hook.error',
          hook: 'beforeUnloadDocument',
          documentName: data.documentName,
        },
        'the unload veto could not be decided; the document stays loaded',
      );
      veto = new UnloadVeto('the veto check failed');
    }
    if (deps.persistence.isFenced(data.document))
      await deps.persistence.settleFenced(data.document);
    else if (veto !== null) throw veto;
  };

  const afterUnloadDocument = async (data: afterUnloadDocumentPayload): Promise<void> => {
    if (isNote(data.documentName)) deps.persistence.detach(data.documentName);
    loaded.delete(data.documentName);
    deps.gateway.forgetDocument(data.documentName);
    deps.onUnloaded(data.documentName);
  };

  return {
    extensionName: 'IridiumPersistence',
    beforeHandleMessage: safeHook('beforeHandleMessage', beforeHandleMessage, hookDeps),
    onLoadDocument: safeHook('onLoadDocument', onLoadDocument, hookDeps),
    afterLoadDocument: safeHook('afterLoadDocument', afterLoadDocument, hookDeps),
    connected: safeHook('connected', connected, hookDeps),
    onStateless: safeHook('onStateless', onStateless, hookDeps),
    onStoreDocument: safeHook('onStoreDocument', onStoreDocument, hookDeps),
    beforeUnloadDocument: safeHook('beforeUnloadDocument', beforeUnloadDocument, hookDeps),
    afterUnloadDocument: safeHook('afterUnloadDocument', afterUnloadDocument, hookDeps),
  };
}
