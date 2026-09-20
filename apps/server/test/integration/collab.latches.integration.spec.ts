/** ACL refresh cannot clear independent persistence safety latches. */
import { NoteId, UserId } from '@iridium/contracts';
import { issueTickets } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';

describe('collab.latches.integration [hp:HP-3] [hp:HP-5]', () => {
  it.each(['content-invalid', 'oversize'] as const)(
    'preserves the %s latch across role changes, epoch refresh, and token revalidation',
    async (kind) => {
      const harness = await startCollab();
      const connectionSetup = Promise.withResolvers<void>();
      let lateConnectionObserved = false;
      try {
        const cast = await harness.server.seed.kernel();
        const client = await harness.open(cast.editorA, cast.note.id, { flushDelayMs: false });
        await client.waitFor('saved');
        const app = harness.application();
        const writer = app.collab.persistence.writerOf(NoteId.parse(cast.note.id));
        const document = app.collab.server.hocuspocus.documents.get(client.documentName);
        if (writer === undefined || document === undefined)
          throw new Error('The fixture must be loaded.');
        const ack = client.waitForAck();
        client.typeAt(client.text.length, kind === 'content-invalid' ? '\r' : 'oversize-fault');
        await ack;
        if (kind === 'oversize') app.faults.arm({ point: 'compact.snapshot-oversize' });
        await writer.enqueueCompaction('flush');
        await expect
          .poll(
            () => client.session.input[kind === 'content-invalid' ? 'contentInvalid' : 'oversize'],
          )
          .toBe(true);
        const before = await harness.committed(cast.note.id);
        const memberPath = `/vaults/${cast.vault.id}/members/${cast.editorA.id}`;
        expect(
          (
            await cast.admin.client.put(memberPath, {
              headers: { 'if-match': '"1"' },
              json: { role: 'viewer' },
            })
          ).status,
        ).toBe(200);
        await expect.poll(() => client.session.input.role).toBe('viewer');
        const beforeRoleUpgrade = [...document.getConnections()];
        // Native queued frames run before connected finishes. Hold that real hook chain so
        // the first-frame latch proof cannot depend on participant identity SQL being fast.
        app.collab.server.hocuspocus.configuration.extensions.unshift({
          extensionName: 'HoldConnectionSetup',
          async connected() {
            lateConnectionObserved = true;
            await connectionSetup.promise;
          },
        });
        expect(
          (
            await cast.admin.client.put(memberPath, {
              headers: { 'if-match': '"2"' },
              json: { role: 'editor' },
            })
          ).status,
        ).toBe(200);
        expect(beforeRoleUpgrade.every((connection) => connection.readOnly)).toBe(true);
        await expect.poll(() => client.session.input.role).toBe('editor');
        await expect
          .poll(() => client.provider?.isAuthenticated === true && client.provider.synced)
          .toBe(true);
        expect(lateConnectionObserved).toBe(true);
        expect(document.getConnections().every((connection) => connection.readOnly)).toBe(true);
        connectionSetup.resolve();
        expect(
          client.session.input[kind === 'content-invalid' ? 'contentInvalid' : 'oversize'],
        ).toBe(true);
        const userId = UserId.parse(cast.editorA.id);
        const epoch = app.authz.epochs.userEpoch(userId);
        if (epoch === undefined) throw new Error('The active user must retain its epoch.');
        app.authz.epochs.user(userId, epoch + 1);
        const baseline = client.waitForStateless('persisted');
        client.sendStateless({ v: 1, t: 'baseline' });
        await baseline;
        expect(document.getConnections().every((connection) => connection.readOnly)).toBe(true);
        const connection = document.getConnections()[0];
        const provider = client.provider;
        const refreshedSession = await harness.server.sessions.signInDesktop(
          cast.editorA,
          'locked-note revalidation',
        );
        const ticket = (await issueTickets(refreshedSession.client, 1))[0];
        if (connection === undefined || provider === null || ticket === undefined)
          throw new Error('Missing authenticated connection.');
        provider.setConfiguration({
          token: ticket,
          websocketProvider: provider.configuration.websocketProvider,
        });
        connection.requestToken();
        await expect.poll(() => connection.context.sessionId).toBe(refreshedSession.session.id);
        expect(connection.readOnly).toBe(true);
        const marker = client.marker('must-remain-refused');
        const afterRefusal = client.waitForStateless('persisted');
        client.sendStateless({ v: 1, t: 'baseline' });
        await afterRefusal;
        expect((await harness.committed(cast.note.id)).head).toBe(before.head);
        expect((await harness.committed(cast.note.id)).text).not.toContain(marker);
        expect(client.saveState).not.toBe('saved');
        expect(
          client.stateless.some((message) => message.t === 'role' && message.recovered === true),
        ).toBe(false);
      } finally {
        connectionSetup.resolve();
        await harness.close();
      }
    },
  );

  it('rolls back a stale ACL change and replays pending edits once with the same document and undo', async () => {
    const clock = new ManualClock(Date.now());
    const harness = await startCollab({ clock });
    try {
      const cast = await harness.server.seed.kernel();
      const client = await harness.open(cast.editorA, cast.note.id, { flushDelayMs: false });
      await client.waitFor('saved');
      const document = client.ydoc;
      const undo = client.undo;
      const app = harness.application();
      const writer = app.collab.persistence.writerOf(NoteId.parse(cast.note.id));
      if (writer === undefined) throw new Error('The real note must have a writer.');
      const before = await harness.committed(cast.note.id);
      app.faults.arm({ point: 'store.slow', arg: 1_000 });
      const accepted = client.marker('before-rollback-fence');
      await expect
        .poll(() =>
          harness.logs.some(
            (line) =>
              line.includes('"event":"fault.fired"') && line.includes('"point":"store.slow"'),
          ),
        )
        .toBe(true);
      app.faults.arm({ point: 'store.slow', count: 0 });
      const rollback = cast.admin.client.put(
        `/vaults/${cast.vault.id}/members/${cast.editorA.id}`,
        {
          headers: { 'if-match': '"999"' },
          json: { role: 'viewer' },
        },
      );
      const userId = UserId.parse(cast.editorA.id);
      await expect.poll(() => app.authz.sessionFence.blocked(userId)).toBe(true);
      const live = app.collab.server.hocuspocus.documents.get(client.documentName);
      expect(live?.getConnections().every((connection) => connection.readOnly)).toBe(true);
      const pending = client.marker('during-rollback-fence');
      expect((await harness.committed(cast.note.id)).head).toBe(before.head);
      expect(client.saveState).not.toBe('saved');
      await clock.advance(1_000);
      const refused = await rollback;
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'stale_version' });
      await client.waitFor('saved', { timeoutMs: 15_000 });
      expect(app.authz.sessionFence.blocked(userId)).toBe(false);
      expect(client.session.input.role).toBe('editor');
      expect(client.ydoc).toBe(document);
      expect(client.undo).toBe(undo);
      const after = await harness.committed(cast.note.id);
      expect(after.head).toBe(before.head + 2);
      expect(after.text.split(accepted)).toHaveLength(2);
      expect(after.text.split(pending)).toHaveLength(2);
      expect(after.text).toBe(client.text.toJSON());
      expect(
        client.stateless.filter((message) => message.t === 'role' && message.recovered === true),
      ).toHaveLength(1);
      expect(client.closes.every((close) => close.reason === 'provider_initiated')).toBe(true);
    } finally {
      await clock.advance(1_000);
      await harness.close();
    }
  });
});
