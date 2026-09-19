/** Strict awareness identity over the real provider, including explicit owned presence removals. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AwarenessState } from '@iridium/contracts';
import { decodeAwarenessEntries, FRAME_TYPE, peekFrame } from '@iridium/crdt';
import { startServer, workerSchemaName, type NoteClient, type SeededUser } from '@iridium/testkit';
import { describe, expect, inject, it, vi } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { createLogger } from '../../src/ops/logging.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

registerRecordingOpenApiMatcher();

function awareness(
  client: NoteClient,
): NonNullable<NonNullable<NoteClient['provider']>['awareness']> {
  const value = client.provider?.awareness;
  if (value === null || value === undefined) throw new Error('a synced client has no awareness');
  return value;
}

function clockOf(client: NoteClient, clientId: number): number {
  const value = awareness(client).meta.get(clientId)?.clock;
  if (value === undefined) throw new Error('the expected presence has no awareness clock');
  return value;
}

describe('collab.awareness-identity.integration [area:collab]', () => {
  it('accepts legitimate presence, propagates its explicit removal, and rejects foreign identities and removals', async () => {
    const mysql = inject('iridiumMysql');
    const scratch = mkdtempSync(join(tmpdir(), 'iridium-awareness-'));
    const clients: NoteClient[] = [];
    const logs: string[] = [];
    const logger = createLogger({
      level: 'info',
      format: 'json',
      instanceId: 'awareness-identity',
      destination: {
        write: (line: string): void => {
          logs.push(line);
        },
      },
    });
    const server = await startServer({
      mode: 'in-process',
      db: { ...mysql, schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1') },
      attachmentsDir: scratch,
      buildApp: (bootOptions) => buildApp({ ...bootOptions, logger }),
    });
    try {
      await server.waitReady();
      const managerUser = await server.seed.admin();
      const editorUser = await server.seed.user({ email: 'awareness-editor@iridium.test' });
      const vault = await server.seed.vault({
        name: 'Awareness identity',
        members: [[editorUser, 'editor']],
      });
      const note = await server.seed.note({ vault, name: 'Presence', markdown: '# Presence\n' });
      const open = async (user: SeededUser): Promise<NoteClient> => {
        const client = await server.client(user, note.id, {
          role: user.isServerAdmin ? 'manager' : 'editor',
        });
        clients.push(client);
        await client.waitFor('saved');
        return client;
      };
      // Only the library's interval scheduler is virtual; transport, database and request timers stay real.
      vi.useFakeTimers({ toFake: ['setInterval'] });
      const manager = await open(managerUser);
      const editor = await open(editorUser);
      const app = server.app;
      if (app === null) throw new Error('the awareness proof needs an in-process server');
      const document = app.collab.server.hocuspocus.documents.get(manager.documentName);
      const database = app.database.dbApp;
      if (document === undefined || database === null)
        throw new Error('the connected note has no document or database');
      const updateCount = async (): Promise<number> => {
        const row = await database
          .selectFrom('note_updates')
          .select(({ fn }) => fn.countAll<number>().as('count'))
          .where('note_id', '=', idBytes(note.id))
          .executeTakeFirstOrThrow();
        return row.count;
      };
      const initialUpdates = await updateCount();
      const participantIds = (): string[] =>
        [...document.awareness.getStates().values()]
          .map((state) => AwarenessState.parse(state).user.id)
          .toSorted();
      await expect.poll(participantIds).toEqual([managerUser.id, editorUser.id].toSorted());
      await expect.poll(() => awareness(manager).getStates().has(editor.clientId)).toBe(true);
      await expect.poll(() => awareness(editor).getStates().has(manager.clientId)).toBe(true);
      expect(manager.closes).toEqual([]);
      expect(editor.closes).toEqual([]);

      const editorProvider = editor.provider;
      if (editorProvider === null) throw new Error('the synced editor has no provider');
      const emittedClients: number[] = [];
      editorProvider.on(
        'outgoingMessage',
        ({ message }: { message: { toUint8Array(): Uint8Array } }) => {
          const bytes = message.toUint8Array();
          const header = peekFrame(bytes);
          if (header?.type !== FRAME_TYPE.awareness) return;
          const entries = decodeAwarenessEntries(bytes, header);
          if (entries === null) throw new Error('the provider emitted malformed awareness');
          emittedClients.push(...entries.map((entry) => entry.clientId));
        },
      );
      const timedOutClients: number[] = [];
      awareness(editor).on('update', (changes: { removed: number[] }, origin: unknown) => {
        if (origin === 'timeout') timedOutClients.push(...changes.removed);
      });
      const peerMetadata = awareness(editor).meta.get(manager.clientId);
      if (peerMetadata === undefined) throw new Error('the editor has no peer awareness metadata');
      peerMetadata.lastUpdated = 0;
      await vi.runOnlyPendingTimersAsync();
      expect(timedOutClients).toContain(manager.clientId);
      expect(awareness(editor).getStates().has(manager.clientId)).toBe(false);
      expect(emittedClients).not.toContain(manager.clientId);
      expect(document.awareness.getStates().has(manager.clientId)).toBe(true);
      const stillConnected = editor.waitForAck();
      editor.sendStateless({ v: 1, t: 'baseline' });
      await stillConnected;
      expect(editor.closes).toEqual([]);
      manager.publishPresence({ mode: 'reading' });
      await expect.poll(() => awareness(editor).getStates().has(manager.clientId)).toBe(true);
      // This is a tombstone on an open connection, so connection teardown cannot mask a lost removal.
      awareness(editor).setLocalState(null);
      await expect.poll(() => document.awareness.getStates().get(editor.clientId)).toBeUndefined();
      await expect.poll(() => awareness(manager).getStates().has(editor.clientId)).toBe(false);
      expect(editor.closes).toEqual([]);
      expect(editor.session.input.socket).toBe('connected');
      awareness(editor).setLocalState({ user: { id: editorUser.id }, cursor: null, mode: 'split' });
      await expect.poll(() => document.awareness.getStates().has(editor.clientId)).toBe(true);
      await expect.poll(() => awareness(manager).getStates().has(editor.clientId)).toBe(true);

      expect(
        document
          .getConnections()
          .some((connection) => document.getClients(connection).has(editor.clientId)),
      ).toBe(true);

      // Duplicate ids must not let the later valid state hide a foreign identity from validation.
      const spoofedIdentity = editor.waitClosed();
      const editorClock = clockOf(editor, editor.clientId);
      editor.sendAwarenessFrame([
        {
          clientId: editor.clientId,
          clock: editorClock + 1,
          state: { user: { id: managerUser.id } },
        },
        {
          clientId: editor.clientId,
          clock: editorClock + 2,
          state: { user: { id: editorUser.id } },
        },
      ]);
      expect((await spoofedIdentity).collabReason).toBe('awareness-spoof');
      await expect.poll(() => document.awareness.getStates().get(editor.clientId)).toBeUndefined();

      const remover = await open(editorUser);
      const removedForeign = remover.waitClosed();
      remover.sendAwarenessFrame([
        { clientId: manager.clientId, clock: clockOf(manager, manager.clientId) + 1, state: null },
      ]);
      expect((await removedForeign).collabReason).toBe('awareness-spoof');
      expect(
        AwarenessState.parse(document.awareness.getStates().get(manager.clientId)).user.id,
      ).toBe(managerUser.id);

      // Ownership is per connection: a second tab of the same user cannot delete the first tab.
      const sameUserRemover = await open(managerUser);
      const removedOtherTab = sameUserRemover.waitClosed();
      sameUserRemover.sendAwarenessFrame([
        { clientId: manager.clientId, clock: clockOf(manager, manager.clientId) + 1, state: null },
      ]);
      expect((await removedOtherTab).collabReason).toBe('awareness-spoof');
      expect(
        AwarenessState.parse(document.awareness.getStates().get(manager.clientId)).user.id,
      ).toBe(managerUser.id);
      expect(manager.closes).toEqual([]);
      expect(manager.saveState).toBe('saved');
      expect(await updateCount()).toBe(initialUpdates);
      expect(logs.filter((line) => line.includes('"event":"collab.awareness.spoof"'))).toHaveLength(
        3,
      );
      const markdown = await (
        await server.loginAsDesktop(managerUser)
      ).get<string>(`/notes/${note.id}/markdown`);
      expect(markdown.status).toBe(200);
      expect(markdown.body).toBe(note.markdown);
      await expect(markdown).toMatchOpenApi('notes.getMarkdown', 200);
    } finally {
      try {
        await Promise.all(clients.map((client) => client.close()));
      } finally {
        vi.useRealTimers();
        await server.stop();
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  });
});
