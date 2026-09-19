import { SkipFurtherHooksError } from '@hocuspocus/common';
import type {
  beforeHandleAwarenessPayload,
  beforeHandleMessagePayload,
  Extension,
  onLoadDocumentPayload,
  onStatelessPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
/**
 * `IridiumVaultChannel` — the never-persisted `vault:<uuid>` documents
 * (05-collaboration-and-durability.md, "Document naming and the vault realtime channel", "Extensions
 * and every hook they use").
 *
 * A vault channel exists so the tree, the membership and "who is in this vault" stay fresh without a
 * second transport. Nobody may write to it (`connection.readOnly = true` for everyone, set by
 * `IridiumAuth`), it is never loaded from and never stored to the database, and all traffic on it is
 * the server's own `broadcastStateless`. M1 registers the extension without a product client: the
 * gateway needs the channel from the first version that opens it so `revokeUser` closes `vault:*`
 * connections too.
 *
 * `onStoreDocument` resolves without storing. The plan spells `throw SkipFurtherHooksError`, which
 * skips the `afterStoreDocument` hooks and lets the document unload; no `afterStoreDocument` hook
 * exists in this server, and Hocuspocus schedules the same unload check after a resolved store, so the
 * two are the same behaviour — and `@hocuspocus/common`, where the class lives, is not a dependency of
 * this package. Switching to the plan's word is one import once it is.
 */
import { parseDocName, VaultAwarenessState } from '@iridium/contracts';
import { decodeSyncUpdate, FRAME_TYPE, peekFrame, peekSyncType, SYNC_TYPE } from '@iridium/crdt';

import type { CollabHookContext } from './context.ts';
import type { CollabMetrics } from './metrics.ts';
import { CollabRejection, closeEventFor } from './rejection.ts';
import { safeHook, type SafeHookDeps } from './safe-hook.ts';

/** What the extension needs. */
export interface VaultChannelDeps {
  readonly logger: {
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly metrics: () => CollabMetrics | null;
}

function isVault(documentName: string): boolean {
  return parseDocName(documentName)?.channel === 'vault';
}

/** Builds the extension. */
export function createVaultChannelExtension(deps: VaultChannelDeps): Extension<CollabHookContext> {
  const hookDeps: SafeHookDeps = {
    logger: deps.logger,
    hookErrors: () => deps.metrics()?.collabHookErrorsTotal ?? null,
  };

  const onLoadDocument = async (
    data: onLoadDocumentPayload<CollabHookContext>,
  ): Promise<undefined> => {
    if (!isVault(data.documentName)) return undefined;
    // The document stays empty; nothing is read.
    return undefined;
  };

  const onStoreDocument = async (
    data: onStoreDocumentPayload<CollabHookContext>,
  ): Promise<void> => {
    if (!isVault(data.documentName)) return;
    // Nothing is stored and no later store hook runs; the document may unload (12 §5.2).
    throw new SkipFurtherHooksError();
  };

  const beforeHandleMessage = async (
    data: beforeHandleMessagePayload<CollabHookContext>,
  ): Promise<void> => {
    if (!isVault(data.documentName)) return;
    const header = peekFrame(data.update);
    if (header === null) return;
    if (header.type !== FRAME_TYPE.sync && header.type !== FRAME_TYPE.syncReply) return;
    const sub = peekSyncType(data.update, header);
    // A provider answers SyncStep1 with the canonical empty V1 update even on a read-only vault.
    // Both the struct count and delete-set count must be zero; content or tombstones stay forbidden.
    if (sub === SYNC_TYPE.step2) {
      const update = decodeSyncUpdate(data.update, header);
      if (update?.byteLength === 2 && update[0] === 0 && update[1] === 0) return;
    }
    if (sub === SYNC_TYPE.step2 || sub === SYNC_TYPE.update) {
      deps.logger.warn(
        {
          event: 'collab.write.rejected',
          documentName: data.documentName,
          socketId: data.socketId,
        },
        'a client sent content on a vault channel',
      );
      throw new CollabRejection('protocol-error', { auditReason: 'vault_channel_write' });
    }
  };

  const beforeHandleAwareness = async (
    data: beforeHandleAwarenessPayload<CollabHookContext>,
  ): Promise<void> => {
    if (!isVault(data.documentName)) return;
    const connection = data.connection;
    if (connection === undefined) return;
    for (const state of data.states.values()) {
      if (VaultAwarenessState.safeParse(state).success) continue;
      connection.close(closeEventFor('awareness-spoof'));
      throw new CollabRejection('awareness-spoof', { auditReason: 'vault_awareness_shape' });
    }
  };

  const onStateless = async (data: onStatelessPayload): Promise<void> => {
    if (!isVault(data.documentName)) return;
    deps.logger.warn(
      { event: 'collab.write.rejected', documentName: data.documentName },
      'a client sent a stateless message on a vault channel',
    );
    data.connection.close(closeEventFor('protocol-error'));
  };

  return {
    extensionName: 'IridiumVaultChannel',
    onLoadDocument: safeHook('onLoadDocument', onLoadDocument, hookDeps),
    onStoreDocument: safeHook('onStoreDocument', onStoreDocument, hookDeps),
    beforeHandleMessage: safeHook('beforeHandleMessage', beforeHandleMessage, hookDeps),
    beforeHandleAwareness: safeHook('beforeHandleAwareness', beforeHandleAwareness, hookDeps),
    onStateless: safeHook('onStateless', onStateless, hookDeps),
  };
}
