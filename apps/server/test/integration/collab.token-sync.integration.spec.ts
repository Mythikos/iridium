import { issueTickets } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { expectConverged, startCollab } from '../support/collab-harness.ts';

describe('collab.token-sync.integration [hp:HP-3]', () => {
  it('revalidates a same-user fresh session on the existing attachment without duplicating its document', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      // Sign-in can resolve a principal admission barrier. Establish both real sessions before
      // attaching so this test observes only the in-place token refresh, not login recovery.
      await harness.server.loginAs(cast.editorA);
      const nextSession = await harness.server.sessions.signInDesktop(
        cast.editorA,
        'refresh device',
      );
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const document = harness
        .application()
        .collab.server.hocuspocus.documents.get(client.documentName);
      const connection = document?.getConnections()[0];
      const provider = client.provider;
      if (connection === undefined || provider === null)
        throw new Error('The real attachment must be connected.');
      expect(connection.context.sessionId).not.toBe(nextSession.session.id);
      const ticket = (await issueTickets(nextSession.client, 1))[0];
      if (ticket === undefined) throw new Error('The real ticket route must issue a token.');
      provider.setConfiguration({
        token: ticket,
        websocketProvider: provider.configuration.websocketProvider,
      });
      const identity = client.clientId;
      connection.requestToken();
      try {
        await expect.poll(() => connection.context.sessionId).toBe(nextSession.session.id);
      } catch (cause) {
        throw new Error(
          `A real token refresh did not replace its session: ${JSON.stringify({
            actualSession: connection.context.sessionId,
            expectedSession: nextSession.session.id,
            providerUnchanged: client.provider === provider,
            authenticated: provider.isAuthenticated,
            synced: provider.synced,
            states: client.states,
            closes: client.closes,
            logs: harness.logs.slice(-20),
          })}`,
          { cause },
        );
      }
      expect(document?.getConnectionsCount()).toBe(1);
      expect(client.provider).toBe(provider);
      expect(client.clientId).toBe(identity);
      expect(client.closes).toEqual([]);
      const marker = client.marker('revalidated');
      expect((await expectConverged(harness, cast.note.id, [client])).text).toContain(marker);
    } finally {
      await harness.close();
    }
  });

  it('consumes but refuses a foreign user token without switching the authenticated document identity', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id);
      await client.waitFor('saved');
      const document = harness
        .application()
        .collab.server.hocuspocus.documents.get(client.documentName);
      const connection = document?.getConnections()[0];
      const provider = client.provider;
      if (connection === undefined || provider === null)
        throw new Error('The real attachment must be connected.');
      const before = await harness.committed(cast.note.id);
      const ticket = (await harness.server.tickets.issue(cast.editorB, 1))[0];
      if (ticket === undefined) throw new Error('The real ticket route must issue a token.');
      provider.setConfiguration({
        token: ticket,
        websocketProvider: provider.configuration.websocketProvider,
      });
      const closed = client.waitClosed();
      connection.requestToken();
      expect((await closed).reason).toBe('unauthorized');
      expect(connection.context.userId).toBe(cast.editorA.id);
      expect((await harness.committed(cast.note.id)).head).toBe(before.head);
      expect(harness.logs.some((line) => line.includes('ticket_session_mismatch'))).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
