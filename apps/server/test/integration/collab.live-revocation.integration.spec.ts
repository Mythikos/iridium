/** M1 revocation through real HTTP mutations and multiple live collaboration connections. */
import { performance } from 'node:perf_hooks';

import { createNoteClient, restTicketSource, type NoteClient } from '@iridium/testkit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startCollab, type CollabHarness } from '../support/collab-harness.ts';

let harness: CollabHarness;
const extras: NoteClient[] = [];
beforeEach(async () => {
  harness = await startCollab();
  await harness.server.waitReady();
});
afterEach(async () => {
  await Promise.all(extras.splice(0).map((client) => client.close()));
  await harness.close();
});

async function fixture() {
  const seeded = await harness.server.seed.kernel();
  const secondNote = await harness.server.seed.note({
    vault: seeded.vault,
    name: 'Second open note',
    markdown: 'another note\n',
  });
  const clients = await Promise.all([
    harness.open(seeded.editorA, seeded.note.id),
    harness.open(seeded.editorA, seeded.note.id),
    harness.open(seeded.editorA, secondNote.id),
  ]);
  const observer = await harness.open(seeded.editorB, seeded.note.id);
  const otherVault = await harness.server.seed.vault({
    admin: seeded.admin,
    name: 'Independent membership',
    members: [[seeded.editorA, 'editor']],
  });
  const otherNote = await harness.server.seed.note({ vault: otherVault, name: 'Other vault note' });
  const elsewhere = await harness.open(seeded.editorA, otherNote.id);
  await Promise.all([...clients, observer, elsewhere].map((client) => client.waitFor('saved')));
  return { seeded, clients, observer, secondNote, elsewhere, otherNote };
}

/** Request start precedes COMMIT, so this bound is stricter than the required COMMIT-to-client second. */
async function assertRevoked(clients: readonly NoteClient[], started: number): Promise<void> {
  const observed = await Promise.all(
    clients.map(async (client) => {
      const close = await client.waitClosed({ timeoutMs: 1_000 });
      return { close, elapsed: performance.now() - started };
    }),
  );
  for (const { close, elapsed } of observed) {
    expect(close.collabReason).toBe('revoked');
    expect(elapsed).toBeLessThanOrEqual(1_000);
  }
}

describe('collab.live-revocation.integration [area:collab]', () => {
  it('removes membership from every open note connection within a second and refuses a fresh attachment', async () => {
    const { seeded, clients, observer, elsewhere, otherNote } = await fixture();
    const started = performance.now();
    const revoked = assertRevoked(clients, started);
    const removed = await seeded.admin.client.del(
      `/vaults/${seeded.vault.id}/members/${seeded.editorA.id}`,
      {
        headers: { 'if-match': '"1"' },
      },
    );
    expect(removed.status).toBe(204);
    await revoked;
    const refused = await harness.open(seeded.editorA, seeded.note.id);
    expect((await refused.waitClosed()).collabReason).toBe('note-not-found');
    const rest = await harness.server.loginAs(seeded.editorA);
    expect((await rest.get(`/notes/${seeded.note.id}`)).status).toBe(404);
    const marker = observer.marker('still-authorized');
    await observer.waitFor('saved');
    expect((await harness.committed(seeded.note.id)).text).toContain(marker);
    const otherMarker = elsewhere.marker('same-user-unaffected-vault');
    await elsewhere.waitFor('saved');
    expect((await harness.committed(otherNote.id)).text).toContain(otherMarker);
    expect(elsewhere.closes).toEqual([]);
  });

  it('disables a user across every open connection and rejects old and new authentication', async () => {
    const { seeded, clients, observer, elsewhere } = await fixture();
    const started = performance.now();
    const revoked = assertRevoked([...clients, elsewhere], started);
    const disabled = await seeded.admin.client.post(`/admin/users/${seeded.editorA.id}/disable`, {
      json: {},
    });
    expect(disabled.status).toBe(200);
    await revoked;
    const oldSession = await harness.server.sessions.current(seeded.editorA);
    expect(
      (await oldSession.client.post('/auth/collab-tickets', { json: { count: 1 } })).status,
    ).toBe(401);
    const login = await harness.server.rest({ client: 'desktop' }).post('/auth/sessions', {
      json: { email: seeded.editorA.email, password: seeded.editorA.password, client: 'desktop' },
    });
    expect(login.status).toBe(401);
    observer.marker('unaffected-by-disable');
    await observer.waitFor('saved');
  });

  it('revokes all connections of one session while another device of the same user keeps editing', async () => {
    const { seeded, clients, elsewhere } = await fixture();
    const otherSession = await harness.server.sessions.signInDesktop(
      seeded.editorA,
      'independent-device',
    );
    const other = createNoteClient({
      wsUrl: harness.server.wsUrl,
      noteId: seeded.note.id,
      userId: seeded.editorA.id,
      sessionId: otherSession.session.id,
      tickets: restTicketSource(otherSession.client),
    });
    extras.push(other);
    await other.waitFor('saved');
    const target = await harness.server.sessions.current(seeded.editorA);
    const started = performance.now();
    const revoked = assertRevoked([...clients, elsewhere], started);
    expect((await otherSession.client.del(`/me/sessions/${target.session.id}`)).status).toBe(204);
    await revoked;
    expect((await target.client.post('/auth/collab-tickets', { json: { count: 1 } })).status).toBe(
      401,
    );
    expect((await otherSession.client.get('/auth/me')).status).toBe(200);
    const marker = other.marker('same-user-other-device');
    await other.waitFor('saved');
    expect((await harness.committed(seeded.note.id)).text).toContain(marker);
    expect(other.closes).toEqual([]);
  });

  it('downgrades every provider live, then upgrades on the same Y.Doc and durably resends pending edits', async () => {
    const { seeded, clients, observer, elsewhere, otherNote } = await fixture();
    const documents = clients.map((client) => client.ydoc);
    const providers = clients.map((client) => client.provider);
    const started = performance.now();
    const notified = Promise.all(
      clients.map(async (client) => {
        await client.waitFor('read-only', { timeoutMs: 1_000 });
        expect(performance.now() - started).toBeLessThanOrEqual(1_000);
      }),
    );
    const downgraded = await seeded.admin.client.put(
      `/vaults/${seeded.vault.id}/members/${seeded.editorA.id}`,
      {
        headers: { 'if-match': '"1"' },
        json: { role: 'viewer' },
      },
    );
    expect(downgraded.status).toBe(200);
    await notified;
    for (const client of clients) {
      expect(client.session.input.role).toBe('viewer');
      expect(client.closes).toEqual([]);
    }
    const unaffectedMarker = elsewhere.marker('other-vault-stays-writable');
    await elsewhere.waitFor('saved');
    expect(elsewhere.session.input.role).toBe('editor');
    expect((await harness.committed(otherNote.id)).text).toContain(unaffectedMarker);
    expect(elsewhere.closes).toEqual([]);
    const pending = clients.map((client, index) => client.marker(`pending-upgrade-${index}`));
    await Promise.all(clients.map((client) => client.waitFor('rejected')));
    const durableBefore = await harness.committed(seeded.note.id);
    for (const marker of pending) expect(durableBefore.text).not.toContain(marker);
    const upgraded = await seeded.admin.client.put(
      `/vaults/${seeded.vault.id}/members/${seeded.editorA.id}`,
      {
        headers: { 'if-match': '"2"' },
        json: { role: 'editor' },
      },
    );
    expect(upgraded.status).toBe(200);
    await Promise.all(clients.map((client) => client.waitFor('saved'))).catch((cause: unknown) => {
      throw new Error(
        JSON.stringify(
          clients.map((client) => ({
            note: client.documentName,
            state: client.saveState,
            input: client.session.input,
            providerChanged: !providers.includes(client.provider),
            states: client.states,
            closes: client.closes,
            lastMessages: client.stateless.slice(-5),
          })),
        ),
        { cause },
      );
    });
    for (const [index, client] of clients.entries()) {
      expect(client.ydoc).toBe(documents[index]);
      expect(client.provider).not.toBe(providers[index]);
      expect(client.session.input.role).toBe('editor');
      expect(client.markerCount(`pending-upgrade-${index}`)).toBe(1);
    }
    const committed = await harness.committed(seeded.note.id);
    expect(committed.text).toContain(pending[0]);
    expect(committed.text).toContain(pending[1]);
    await expect.poll(() => observer.text.toJSON()).toBe(committed.text);
  });
});
