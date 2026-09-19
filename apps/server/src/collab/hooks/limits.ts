import type {
  afterLoadDocumentPayload,
  afterUnloadDocumentPayload,
  beforeHandleMessagePayload,
  Connection,
  Document,
  Extension,
  onAuthenticatePayload,
  onLoadDocumentPayload,
} from '@hocuspocus/server';
/**
 * `IridiumLimits` — sizes, rates and budgets on `/collab`
 * (05-collaboration-and-durability.md, "Extensions and every hook they use", "Admission control";
 * 09-api-reference.md §3.10; 04-auth-and-access-control.md §7.6).
 *
 * It runs after `IridiumAuth` in the same events, so identity is resolved before a budget is
 * checked. The admission budget is reserved at `onAuthenticate` for a document that is not loaded
 * yet, replaced with the measured V2 size at `afterLoadDocument` and released at
 * `afterUnloadDocument`; refusal, never eviction (A50). `beforeHandleMessage` reads the frame header
 * with `peekFrame` — never decoding the update — to count the frame by type, apply the 200 / 10 s
 * bucket to every non-awareness type, refuse a single update above 1 MiB with `too-large`, and audit
 * the one write a read-only connection attempts, once per connection.
 *
 * The awareness cap is not here: a hook cannot drop a frame, only close, so the 10 / s cap is enforced
 * before dispatch in the `/collab` socket handler (D05-18).
 */
import { LIMITS, parseDocName } from '@iridium/contracts';
import { encodeState, FRAME_TYPE, peekFrame, peekSyncType, SYNC_TYPE } from '@iridium/crdt';

import type { Clock } from '../../ops/clock.ts';
import type { CollabMessageType } from '../../ops/metrics.ts';
import type { CollabAuditSink } from '../audit.ts';
import { authenticated, type CollabHookContext } from '../context.ts';
import type { AdmissionBudget } from '../limits.ts';
import type { CollabMetrics } from '../metrics.ts';
import { RateWindow } from '../rate.ts';
import { CollabRejection } from '../rejection.ts';
import { safeHook, type SafeHookDeps } from '../safe-hook.ts';
import type { CollabReads, ResolutionChannel } from './resolution.ts';

/** The `ops/metrics.ts` gauges and counters this extension moves. */
export interface AdmissionMetrics {
  readonly docsLoaded: { set(value: number): void };
  readonly collabStateBytes: { set(value: number): void };
  readonly collabAdmissionRefusedTotal: { inc(labels: { reason: string }): void };
}

/** What the extension needs. */
export interface LimitsExtensionDeps {
  readonly budget: AdmissionBudget;
  readonly reads: Pick<CollabReads, 'resolveNote'>;
  readonly channel: ResolutionChannel;
  readonly documents: () => Map<string, Document>;
  readonly clock: Clock;
  readonly audit: Pick<CollabAuditSink, 'record'>;
  readonly logger: {
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly metrics: () => AdmissionMetrics | null;
  readonly collabMetrics: () => CollabMetrics | null;
}

function messageTypeLabel(type: number): CollabMessageType {
  switch (type) {
    case FRAME_TYPE.sync:
    case FRAME_TYPE.syncReply:
      return 'sync';
    case FRAME_TYPE.awareness:
      return 'awareness';
    case FRAME_TYPE.stateless:
      return 'stateless';
    case FRAME_TYPE.auth:
      return 'auth';
    case FRAME_TYPE.queryAwareness:
      return 'query_awareness';
    default:
      return 'other';
  }
}

/** Builds the extension. */
export function createLimitsExtension(deps: LimitsExtensionDeps): Extension<CollabHookContext> {
  const windows = new WeakMap<Connection<CollabHookContext>, RateWindow>();
  const writeRejectedAudited = new WeakSet<Connection<CollabHookContext>>();
  const hookDeps: SafeHookDeps = {
    logger: deps.logger,
    hookErrors: () => deps.collabMetrics()?.collabHookErrorsTotal ?? null,
  };

  const publishGauges = (): void => {
    const metrics = deps.metrics();
    if (metrics === null) return;
    metrics.docsLoaded.set(deps.documents().size);
    metrics.collabStateBytes.set(deps.budget.stateBytes);
  };

  const onAuthenticate = async (data: onAuthenticatePayload<CollabHookContext>): Promise<void> => {
    if (deps.documents().has(data.documentName)) return;
    const resolved = deps.channel.get(data);
    const estimate = resolved?.kind === 'note' ? resolved.snapshotSize : 0;
    const admission = deps.budget.reserve(data.documentName, estimate);
    if (admission.admitted) return;
    deps.metrics()?.collabAdmissionRefusedTotal.inc({ reason: admission.refusal });
    deps.logger.warn(
      {
        event: 'collab.admission.refused',
        documentName: data.documentName,
        reason: admission.refusal,
        ...deps.budget.reading(),
      },
      'a document load was refused by the admission budget',
    );
    const context = data.context;
    if (context.vaultId !== undefined) {
      void deps.audit.record({
        action: 'collab.connection.rejected',
        vaultId: context.vaultId,
        userId: context.userId ?? null,
        sessionId: context.sessionId ?? null,
        noteId: context.noteId ?? null,
        reason: `capacity_${admission.refusal}`,
        ip: context.ip,
        requestId: context.requestId,
        subject: data.documentName,
      });
    }
    throw new CollabRejection('capacity', { auditReason: `capacity_${admission.refusal}` });
  };

  // DirectConnection does not authenticate over the wire. All loads still reserve the same
  // budget before persistence constructs the document, including CLI repair and fresh REST reads.
  const onLoadDocument = async (
    data: onLoadDocumentPayload<CollabHookContext>,
  ): Promise<undefined> => {
    if (deps.budget.has(data.documentName)) return undefined;
    const parsed = parseDocName(data.documentName);
    let resolved;
    try {
      resolved = parsed?.channel === 'note' ? await deps.reads.resolveNote(parsed.id) : null;
    } catch (error) {
      deps.logger.error(
        {
          err: error,
          event: 'collab.hook.error',
          hook: 'onLoadDocument',
          documentName: data.documentName,
        },
        'a server-side document estimate failed; the load is refused',
      );
      throw new CollabRejection('capacity', { auditReason: 'admission_unavailable' });
    }
    const admission = deps.budget.reserve(data.documentName, resolved?.snapshotSize ?? 0);
    if (admission.admitted) return undefined;
    deps.metrics()?.collabAdmissionRefusedTotal.inc({ reason: admission.refusal });
    deps.logger.warn(
      {
        event: 'collab.admission.refused',
        documentName: data.documentName,
        reason: admission.refusal,
        ...deps.budget.reading(),
      },
      'a server-side document load was refused by the admission budget',
    );
    throw new CollabRejection('capacity', { auditReason: `capacity_${admission.refusal}` });
  };

  const afterLoadDocument = async (
    data: afterLoadDocumentPayload<CollabHookContext>,
  ): Promise<void> => {
    const measured =
      parseDocName(data.documentName)?.channel === 'note'
        ? encodeState(data.document, 2).byteLength
        : 0;
    deps.budget.confirm(data.documentName, measured);
    publishGauges();
  };

  const afterUnloadDocument = async (data: afterUnloadDocumentPayload): Promise<void> => {
    deps.budget.release(data.documentName);
    publishGauges();
  };

  const beforeHandleMessage = async (
    data: beforeHandleMessagePayload<CollabHookContext>,
  ): Promise<void> => {
    const connection = data.connection;
    const header = peekFrame(data.update);
    const type = header === null ? 'other' : messageTypeLabel(header.type);
    deps.collabMetrics()?.collabMessagesTotal.inc({ type });
    if (header !== null && header.type === FRAME_TYPE.awareness) return;

    let window = windows.get(connection);
    if (window === undefined) {
      window = new RateWindow(LIMITS.YJS_MESSAGES_PER_WINDOW, LIMITS.YJS_MESSAGE_WINDOW_MS);
      windows.set(connection, window);
    }
    if (!window.take(deps.clock.now())) {
      deps.logger.warn(
        {
          event: 'collab.limit.exceeded',
          limit: 'YJS_MESSAGES_PER_WINDOW',
          documentName: data.documentName,
          socketId: data.socketId,
        },
        'a connection exceeded the message rate and is closed',
      );
      throw new CollabRejection('rate-limited', { auditReason: 'message_rate' });
    }
    if (data.update.byteLength > LIMITS.YJS_UPDATE_MAX_BYTES) {
      deps.logger.warn(
        {
          event: 'collab.limit.exceeded',
          limit: 'YJS_UPDATE_MAX_BYTES',
          documentName: data.documentName,
          bytes: data.update.byteLength,
        },
        'a single update exceeded the cap and the document connection is closed',
      );
      throw new CollabRejection('too-large');
    }
    if (
      connection.readOnly &&
      header !== null &&
      (header.type === FRAME_TYPE.sync || header.type === FRAME_TYPE.syncReply) &&
      !writeRejectedAudited.has(connection)
    ) {
      const sub = peekSyncType(data.update, header);
      if (sub === SYNC_TYPE.step2 || sub === SYNC_TYPE.update) {
        writeRejectedAudited.add(connection);
        const context = authenticated(connection.context);
        deps.logger.warn(
          {
            event: 'collab.write.rejected',
            documentName: data.documentName,
            userId: context.userId,
            role: context.role,
          },
          'a read-only connection sent a write; Hocuspocus answers SyncStatus(false)',
        );
        void deps.audit.record({
          action: 'collab.write.rejected',
          vaultId: context.vaultId,
          userId: context.userId,
          sessionId: context.sessionId,
          noteId: context.noteId,
          reason: 'read_only',
          ip: context.ip,
          requestId: context.requestId,
          subject: connection.socketId,
        });
      }
    }
  };

  return {
    extensionName: 'IridiumLimits',
    onAuthenticate: safeHook('onAuthenticate', onAuthenticate, hookDeps),
    onLoadDocument: safeHook('onLoadDocument', onLoadDocument, hookDeps),
    afterLoadDocument: safeHook('afterLoadDocument', afterLoadDocument, hookDeps),
    afterUnloadDocument: safeHook('afterUnloadDocument', afterUnloadDocument, hookDeps),
    beforeHandleMessage: safeHook('beforeHandleMessage', beforeHandleMessage, hookDeps),
  };
}
