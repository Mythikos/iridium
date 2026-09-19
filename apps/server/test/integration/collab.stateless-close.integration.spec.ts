import { VaultId } from '@iridium/contracts';
import {
  createCollabSocket,
  createVaultClient,
  noteClientWebSocket,
  restTicketSource,
  type VaultClient,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('collab.stateless-close.integration [area:collab] [hp:HP-5]', () => {
  it('closes only the malformed note attachment while its sibling vault and socket remain usable', async () => {
    const harness = await startCollab();
    const socket = createCollabSocket({
      url: harness.server.wsUrl,
      webSocketPolyfill: noteClientWebSocket({ defaultOrigin: harness.server.origin }),
    });
    let vault: VaultClient | undefined;
    try {
      const cast = await harness.server.seed.kernel();
      const rest = await harness.server.loginAs(cast.editorA);
      const note = await harness.open(cast.editorA, cast.note.id, { socket });
      vault = createVaultClient({
        socket,
        vaultId: cast.vault.id,
        tickets: restTicketSource(rest),
      });
      await Promise.all([note.waitFor('saved'), vault.waitConnected()]);
      const socketBefore = socket.webSocket;
      const closed = note.waitClosed();
      note.sendStateless('{');
      const close = await closed;
      expect(close).toMatchObject({ code: 1000, reason: 'protocol-error' });
      expect(socket.status).toBe('connected');
      expect(socket.webSocket).toBe(socketBefore);
      expect(vault.closes).toEqual([]);
      harness.application().collab.gateway.broadcastVault(VaultId.parse(cast.vault.id), {
        v: 1,
        t: 'vault-updated',
        version: cast.vault.version + 1,
        changed: ['description'],
      });
      await expect
        .poll(() => vault?.messages.at(-1))
        .toMatchObject({ t: 'vault-updated', version: cast.vault.version + 1 });
      expect(vault.provider.isAuthenticated).toBe(true);
      expect(
        (await harness.server.metrics())['iridium_collab_hook_errors_total{hook="onStateless"}'] ??
          0,
      ).toBe(0);
    } finally {
      vault?.close();
      await harness.close();
      socket.destroy();
    }
  });
});
