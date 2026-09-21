/** A real authenticated vault attachment on a product-configured shared collaboration socket. */
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createTicketGetter, systemCollabClock, type TicketSource } from '@iridium/collab-client';
import {
  COLLAB_CLOSE_CODES,
  CollabCloseReason,
  decodeServerVaultMessage,
  VaultId,
  vaultDocName,
  type ServerVaultMessage,
} from '@iridium/contracts';
import { createNoteDoc } from '@iridium/crdt';

import { waitFor, type WaitOptions } from '../harness/deadline.ts';
import type { CollabSocket } from './note-client.ts';

export interface VaultClientOptions {
  readonly socket: CollabSocket;
  readonly vaultId: string;
  readonly tickets: TicketSource;
}

export interface VaultClient {
  readonly provider: HocuspocusProvider;
  readonly messages: readonly ServerVaultMessage[];
  readonly closes: readonly { readonly code: number; readonly reason: string }[];
  waitConnected(options?: WaitOptions): Promise<void>;
  waitClosed(options?: WaitOptions): Promise<{ readonly code: number; readonly reason: string }>;
  close(): void;
}

/** No note save-state is invented for a channel whose document is deliberately never persisted. */
export function createVaultClient(options: VaultClientOptions): VaultClient {
  const document = createNoteDoc({ gc: true });
  const messages: ServerVaultMessage[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const provider = new HocuspocusProvider({
    name: vaultDocName(VaultId.parse(options.vaultId)),
    document,
    websocketProvider: options.socket,
    // Presence is a separate opt-in concern; this harness drives the real stateless vault channel.
    awareness: null,
    token: createTicketGetter({ source: options.tickets, clock: systemCollabClock }),
    onStateless: ({ payload }) => {
      const decoded = decodeServerVaultMessage(payload);
      if (decoded.ok) messages.push(decoded.message);
    },
    onClose: ({ event }) => {
      closes.push({ code: event.code, reason: event.reason });
    },
    onAuthenticationFailed: ({ reason }) => {
      const parsed = CollabCloseReason.safeParse(reason);
      closes.push({
        code: parsed.success ? COLLAB_CLOSE_CODES[parsed.data] : COLLAB_CLOSE_CODES.unauthorized,
        reason,
      });
    },
  });
  provider.attach();
  return {
    provider,
    messages,
    closes,
    async waitConnected(waitOptions = {}): Promise<void> {
      await waitFor(() => provider.isAuthenticated && provider.synced, {
        description: 'the real vault attachment to authenticate and synchronize',
        ...waitOptions,
      });
    },
    async waitClosed(
      waitOptions = {},
    ): Promise<{ readonly code: number; readonly reason: string }> {
      await waitFor(() => closes.length > 0, {
        description: 'the real vault attachment to be refused or closed',
        ...waitOptions,
      });
      const closed = closes.at(-1);
      if (closed === undefined) throw new Error('The vault attachment has no recorded close.');
      return closed;
    },
    close(): void {
      provider.destroy();
      document.destroy();
    },
  };
}
