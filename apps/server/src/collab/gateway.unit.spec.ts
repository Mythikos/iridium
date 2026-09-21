/**
 * `collab.gateway.unit` — `CollabGateway`: the participant table, the sweeps the `AuthzBus` events
 * drive, the closing set and the server-originated edit (04-auth-and-access-control.md §6.9, §8.4;
 * 05-collaboration-and-durability.md, "`participants`", "The AuthzBus reactions"; A40; D05-12).
 *
 * The documents and connections are Hocuspocus's own classes over recording sockets, so every
 * broadcast and close the gateway performs is read back as the frames a provider would receive.
 */
import {
  LIMITS,
  decodeServerNoteMessage,
  decodeServerVaultMessage,
  newId,
  noteDocName,
  TokenId,
  vaultDocName,
  type NoteId,
  type ServerNoteMessage,
  type SessionId,
  type UserId,
  type VaultId,
} from '@iridium/contracts';
import { getContent, projectMarkdown } from '@iridium/crdt';
import { describe, expect, it } from 'vitest';

import { InProcessAuthzBus } from '../authz/bus.ts';
import { ProblemError } from '../security/problem.ts';
import { authenticated } from './context.ts';
import { CLOSING_GRACE_MS, CollabGateway, type GatewayOptions } from './gateway.ts';
import { CollabOwnershipLost } from './owner-lease.ts';
import { recordingLogger } from './persistence/testing/harness.ts';
import {
  closeReasons,
  fakeConnection,
  fakeDocumentOf,
  fakeGatewayServer,
  statelessPayloads,
  type FakeSocket,
} from './testing/fake-hocuspocus.ts';
import { authenticatedContext, FakeWorld } from './testing/hook-deps.ts';

function noteMessages(socket: FakeSocket): ServerNoteMessage[] {
  return statelessPayloads(socket).flatMap((payload) => {
    const decoded = decodeServerNoteMessage(payload);
    return decoded.ok ? [decoded.message] : [];
  });
}

interface Scene {
  readonly world: FakeWorld;
  readonly gateway: CollabGateway;
  readonly server: ReturnType<typeof fakeGatewayServer>;
  readonly logger: ReturnType<typeof recordingLogger>;
  readonly vaultId: VaultId;
  readonly noteId: NoteId;
  readonly ada: UserId;
  readonly bob: UserId;
  /** Opens `userId` on a document, registering it with the gateway the way the hooks do. */
  open(
    userId: UserId,
    documentName: string,
    role?: 'viewer' | 'editor' | 'manager',
  ): ReturnType<typeof fakeConnection> & { readonly sessionId: SessionId };
}

function unexpectedLifecycleRead(): never {
  throw new Error('A fresh boot must not scan stored notes.');
}

function scene(
  options: Partial<Pick<GatewayOptions, 'applyWriterLatches' | 'captureOwner' | 'reads'>> = {},
): Scene {
  const world = new FakeWorld();
  const logger = recordingLogger();
  const server = fakeGatewayServer();
  const gateway = new CollabGateway({
    clock: world.clock,
    logger,
    authorize: world.authorizer.authorize,
    reads: world.reads,
    applyWriterLatches: () => undefined,
    principalBlocked: (userId) => world.sessionFence.blocked(userId),
    ...options,
  });
  gateway.bind(server);
  world.sessionFence.subscribe((userId) => gateway.refreshPrincipalFence(userId));
  const vaultId = world.vault();
  const noteId = world.note(vaultId);
  const ada = world.user({ name: 'Ada', colorHue: 10 });
  const bob = world.user({ name: 'Bob', colorHue: 20 });
  world.member(vaultId, ada, 'editor');
  world.member(vaultId, bob, 'editor');
  const open: Scene['open'] = (userId, documentName, role = 'editor') => {
    let document = server.documents.get(documentName);
    if (document === undefined) {
      document = fakeDocumentOf(documentName);
      server.documents.set(documentName, document);
      gateway.registerDocument(documentName, vaultId);
    }
    const sessionId = world.session(userId);
    const context = authenticatedContext(world.clock, {
      userId,
      sessionId,
      vaultId,
      noteId: documentName.startsWith('note:') ? noteId : null,
      role,
    });
    const opened = fakeConnection(document, context, { readOnly: role === 'viewer' });
    const user = world.users.get(userId);
    gateway.join(document, authenticated(context), {
      name: user?.name ?? '?',
      colorHue: user?.colorHue ?? 0,
    });
    return { ...opened, sessionId };
  };
  return { world, gateway, server, logger, vaultId, noteId, ada, bob, open };
}

describe('collab.gateway.unit [area:collab]', () => {
  describe('participants', () => {
    it('lists joined users most-recently-active first, collapses a user’s connections, and broadcasts every change', async () => {
      const s = scene();
      const name = noteDocName(s.noteId);
      const ada = s.open(s.ada, name);
      await s.world.clock.advance(10);
      const bob = s.open(s.bob, name);
      expect(s.gateway.participants(s.noteId).map((p) => p.id)).toEqual([s.bob, s.ada]);
      await s.world.clock.advance(10);
      const adaAgain = s.open(s.ada, name);
      expect(s.gateway.participants(s.noteId)).toEqual([
        expect.objectContaining({
          id: s.ada,
          name: 'Ada',
          colorHue: 10,
          role: 'editor',
          connections: 2,
        }),
        expect.objectContaining({ id: s.bob, connections: 1 }),
      ]);
      const since = s.gateway.participants(s.noteId).find((p) => p.id === s.ada)?.since;
      expect(since).toBe(Date.parse('2026-09-14T12:00:00.000Z'));
      // `mode` follows the most recent awareness report, and activity re-orders the list.
      await s.world.clock.advance(10);
      s.gateway.setMode(name, s.bob, 'reading');
      expect(s.gateway.participants(s.noteId).map((p) => [p.id, p.mode])).toEqual([
        [s.bob, 'reading'],
        [s.ada, undefined],
      ]);
      // The wire message carries id, name, colour, role and mode — never the session or the counts.
      s.gateway.broadcastParticipants(bob.connection.document);
      const last = noteMessages(bob.socket).at(-1);
      expect(last?.t === 'participants' && last.users).toEqual([
        { id: s.bob, name: 'Bob', colorHue: 20, role: 'editor', mode: 'reading' },
        { id: s.ada, name: 'Ada', colorHue: 10, role: 'editor' },
      ]);
      // Leaving one of Ada's two connections keeps her listed; leaving the last removes her.
      s.gateway.leave(ada.connection.document, authenticated(adaAgain.connection.context));
      expect(s.gateway.participants(s.noteId).find((p) => p.id === s.ada)?.connections).toBe(1);
      s.gateway.leave(ada.connection.document, authenticated(ada.connection.context));
      expect(s.gateway.participants(s.noteId).map((p) => p.id)).toEqual([s.bob]);
      s.gateway.forgetDocument(name);
      expect(s.gateway.participants(s.noteId)).toEqual([]);
      expect(s.gateway.vaultOf(name)).toBeUndefined();
    });

    it('caps the list at the schema size, keeping the most recently active', async () => {
      const s = scene();
      const name = noteDocName(s.noteId);
      const users: UserId[] = [];
      for (let index = 0; index < 70; index += 1) {
        const userId = s.world.user({ name: `u${String(index)}` });
        s.world.member(s.vaultId, userId, 'editor');
        users.push(userId);
        s.open(userId, name);
        // eslint-disable-next-line no-await-in-loop -- each join happens one tick later than the last
        await s.world.clock.advance(1);
      }
      const listed = s.gateway.participants(s.noteId);
      expect(listed).toHaveLength(64);
      expect(listed[0]?.id).toBe(users[69]);
      expect(listed.some((p) => p.id === users[0])).toBe(false);
    });
  });

  describe('the sweeps', () => {
    it('performs no durable reads when a fresh process has no loaded documents', async () => {
      const s = scene({
        reads: { resolveNote: unexpectedLifecycleRead, resolveVault: unexpectedLifecycleRead },
      });
      await expect(s.gateway.sweepTrashedOnBoot()).resolves.toBeUndefined();
    });

    it('does not close a replacement document after a delayed stale-state read', async () => {
      const s = scene();
      const name = noteDocName(s.noteId);
      s.open(s.ada, name);
      const row = s.world.notes.get(s.noteId);
      if (row === undefined) throw new Error('The retained note must exist.');
      row.deletedAt = s.world.clock.date();
      const resolution = await s.world.reads.resolveNote(s.noteId);
      const gate = Promise.withResolvers<typeof resolution>();
      s.world.reads.resolveNote = () => gate.promise;
      const sweeping = s.gateway.sweepTrashedOnBoot();
      s.server.documents.set(name, fakeDocumentOf(name));
      const replacement = s.open(s.bob, name);
      gate.resolve(resolution);
      await sweeping;
      expect(closeReasons(replacement.socket)).toEqual([]);
      expect(replacement.connection.readOnly).toBe(false);
    });

    it('reconciles retained trash and inactive vault channels while preserving live documents', async () => {
      const s = scene();
      const trashed = s.open(s.ada, noteDocName(s.noteId));
      const inactiveVault = s.world.vault({ status: 'archived' });
      const inactiveNote = s.world.note(inactiveVault);
      const inactive = s.open(s.bob, noteDocName(inactiveNote));
      const channel = s.open(s.bob, vaultDocName(inactiveVault));
      s.gateway.registerDocument(noteDocName(inactiveNote), inactiveVault);
      s.gateway.registerDocument(vaultDocName(inactiveVault), inactiveVault);
      const liveId = s.world.note(s.vaultId);
      const live = s.open(s.bob, noteDocName(liveId));
      const row = s.world.notes.get(s.noteId);
      if (row === undefined) throw new Error('The retained note must have a durable fixture row.');
      row.deletedAt = s.world.clock.date();
      const sweeping = s.gateway.sweepTrashedOnBoot();
      await expect
        .poll(() => noteMessages(trashed.socket).some((message) => message.t === 'closing'))
        .toBe(true);
      await s.world.clock.advance(CLOSING_GRACE_MS);
      await sweeping;
      expect(closeReasons(trashed.socket)).toEqual(['note-trashed']);
      expect(closeReasons(inactive.socket)).toEqual(['vault-archived']);
      expect(closeReasons(channel.socket)).toEqual(['vault-archived']);
      expect(closeReasons(live.socket)).toEqual([]);
      expect(live.connection.readOnly).toBe(false);
    });

    it('revokes a user across documents, narrowed by session, vault or exception', async () => {
      const s = scene();
      const otherVault = s.world.vault();
      s.world.member(otherVault, s.ada, 'editor');
      const noteA = s.open(s.ada, noteDocName(s.noteId));
      const vaultA = s.open(s.ada, vaultDocName(s.vaultId));
      const bob = s.open(s.bob, noteDocName(s.noteId));
      await s.gateway.revokeUser(s.ada, { sessionId: vaultA.sessionId });
      expect(closeReasons(vaultA.socket)).toEqual(['revoked']);
      expect(closeReasons(noteA.socket)).toEqual([]);
      await s.gateway.revokeUser(s.ada, { exceptSessionId: noteA.sessionId });
      expect(closeReasons(noteA.socket)).toEqual([]);
      await s.gateway.revokeUser(s.ada, { vaultId: otherVault });
      expect(closeReasons(noteA.socket)).toEqual([]);
      await s.gateway.revokeUser(s.ada, { vaultId: s.vaultId, reason: 'vault-archived' });
      expect(closeReasons(noteA.socket)).toEqual(['vault-archived']);
      expect(closeReasons(bob.socket)).toEqual([]);
    });

    it('applies a role change live: context, read-only flag, a role message, and the participant list', async () => {
      const s = scene();
      const name = noteDocName(s.noteId);
      const ada = s.open(s.ada, name);
      const vault = s.open(s.ada, vaultDocName(s.vaultId));
      await s.gateway.changeRole(s.ada, s.vaultId, 'viewer', {
        userAuthzVersion: 1,
        memberVersion: 9,
      });
      expect(ada.connection.context).toMatchObject({
        role: 'viewer',
        authzEpoch: { userAuthzVersion: 1, memberVersion: 9 },
      });
      expect(ada.connection.readOnly).toBe(true);
      expect(vault.connection.readOnly).toBe(true);
      expect(noteMessages(ada.socket).map((m) => m.t)).toContain('role');
      expect(s.gateway.participants(s.noteId).map((p) => p.role)).toEqual(['viewer']);
      await s.gateway.changeRole(s.ada, s.vaultId, 'editor', {
        userAuthzVersion: 1,
        memberVersion: 10,
      });
      expect(ada.connection.readOnly).toBe(false);
      // The vault channel stays read-only whatever the role.
      expect(vault.connection.readOnly).toBe(true);
      expect(closeReasons(ada.socket)).toEqual([]);
      expect(s.logger.events()).toContain('collab.role.changed');
    });

    it('closes a trashed note after the grace, a closing one at once, and an archived vault after its message', async () => {
      const s = scene();
      const ada = s.open(s.ada, noteDocName(s.noteId));
      const closing = s.gateway.closeNote(s.noteId, 'note-trashed');
      await Promise.resolve();
      expect(noteMessages(ada.socket).at(-1)).toEqual({
        v: 1,
        t: 'closing',
        reason: 'note-trashed',
        graceMs: CLOSING_GRACE_MS,
      });
      expect(closeReasons(ada.socket)).toEqual([]);
      await s.world.clock.advance(CLOSING_GRACE_MS);
      await closing;
      expect(closeReasons(ada.socket)).toEqual(['note-trashed']);

      const bob = s.open(s.bob, noteDocName(s.noteId));
      await s.gateway.closeNote(s.noteId, 'note-closing');
      expect(closeReasons(bob.socket)).toEqual(['note-closing']);
      // An unknown note is a no-op.
      await expect(
        s.gateway.closeNote(s.world.note(s.vaultId), 'note-closing'),
      ).resolves.toBeUndefined();

      const vault = s.open(s.ada, vaultDocName(s.vaultId));
      await s.gateway.archiveVault(s.vaultId);
      const vaultPayloads = statelessPayloads(vault.socket).flatMap((payload) => {
        const decoded = decodeServerNoteMessage(payload);
        return decoded.ok ? [decoded.message] : [];
      });
      expect(vaultPayloads.at(-1)).toEqual({
        v: 1,
        t: 'closing',
        reason: 'vault-archived',
        graceMs: 0,
      });
      expect(closeReasons(vault.socket)).toEqual(['vault-archived']);
    });

    it('broadcasts server messages on the vault channel and on a loaded note', () => {
      const s = scene();
      const vault = s.open(s.ada, vaultDocName(s.vaultId));
      const note = s.open(s.ada, noteDocName(s.noteId));
      s.gateway.broadcastVault(s.vaultId, { v: 1, t: 'vault-updated', version: 4 });
      const vaultMessage = statelessPayloads(vault.socket)
        .map((payload) => decodeServerVaultMessage(payload))
        .find((decoded) => decoded.ok && decoded.message.t === 'vault-updated');
      expect(vaultMessage?.ok).toBe(true);
      s.gateway.broadcastNote(s.noteId, { v: 1, t: 'projected', seq: 7 });
      expect(noteMessages(note.socket).at(-1)).toEqual({ v: 1, t: 'projected', seq: 7 });
      // Unknown targets are no-ops.
      s.gateway.broadcastVault(s.world.vault(), { v: 1, t: 'vault-updated', version: 1 });
      s.gateway.broadcastNote(s.world.note(s.vaultId), { v: 1, t: 'projected', seq: 1 });
    });

    it('reacts to every AuthzBus event per the table, isolates a failing reaction, and ignores token.revoked', async () => {
      const s = scene();
      const ada = s.open(s.ada, noteDocName(s.noteId));
      const bob = s.open(s.bob, noteDocName(s.noteId));
      await s.gateway.handle({
        type: 'token.revoked',
        userId: s.ada,
        tokenId: TokenId.parse(newId()),
      });
      await s.gateway.handle({
        type: 'session.revoked',
        userId: s.ada,
        sessionId: bob.sessionId,
        reason: 'logout',
      });
      await Promise.resolve();
      expect(closeReasons(ada.socket)).toEqual([]);
      await s.gateway.handle({
        type: 'membership.role_changed',
        userId: s.bob,
        vaultId: s.vaultId,
        role: 'viewer',
        userAuthzVersion: 1,
        memberVersion: 2,
      });
      await Promise.resolve();
      expect(bob.connection.readOnly).toBe(true);
      await s.gateway.handle({
        type: 'membership.removed',
        userId: s.bob,
        vaultId: s.vaultId,
        userAuthzVersion: 1,
      });
      await Promise.resolve();
      expect(closeReasons(bob.socket)).toEqual(['revoked']);
      await s.gateway.handle({
        type: 'user.password_changed',
        userId: s.ada,
        keepSessionId: ada.sessionId,
      });
      await Promise.resolve();
      expect(closeReasons(ada.socket)).toEqual([]);
      await s.gateway.handle({ type: 'user.disabled', userId: s.ada });
      await Promise.resolve();
      expect(closeReasons(ada.socket)).toEqual(['revoked']);
      const again = s.open(s.ada, noteDocName(s.noteId));
      const purging = s.gateway.handle({
        type: 'note.purged',
        vaultId: s.vaultId,
        noteId: s.noteId,
      });
      await Promise.resolve();
      await s.world.clock.advance(CLOSING_GRACE_MS);
      await purging;
      expect(closeReasons(again.socket)).toEqual(['note-trashed']);
      const vault = s.open(s.ada, vaultDocName(s.vaultId));
      await s.gateway.handle({ type: 'vault.archived', vaultId: s.vaultId });
      await Promise.resolve();
      expect(closeReasons(vault.socket)).toEqual(['vault-archived']);
      expect(s.logger.events()).not.toContain('collab.hook.error');
    });
  });

  it('returns a failed sweep to the awaitable bus without an unhandled rejection', async () => {
    const s = scene();
    const ada = s.open(s.ada, noteDocName(s.noteId));
    const failure = new Error('connection cleanup failed');
    ada.connection.onClose(() => {
      throw failure;
    });
    const errors: unknown[] = [];
    const bus = new InProcessAuthzBus({ onHandlerError: (_type, error) => errors.push(error) });
    bus.subscribe((event) => s.gateway.handle(event));
    let laterSubscriber = false;
    bus.subscribe(() => {
      laterSubscriber = true;
    });
    await expect(
      bus.publishAndWait({
        type: 'session.revoked',
        userId: s.ada,
        sessionId: ada.sessionId,
        reason: 'admin',
      }),
    ).resolves.toBe(false);
    expect(laterSubscriber).toBe(true);
    expect(errors).toEqual([failure]);
  });

  describe('the closing set and the server edit', () => {
    it('emits bounded server insertion updates with the captured repair origin and refuses an outer transaction', async () => {
      const s = scene();
      const document = fakeDocumentOf(noteDocName(s.noteId));
      s.server.openDirectConnection = async (_documentName, context) => ({
        document,
        transact: async (fn) => document.transact(() => fn(document), { source: 'local', context }),
        disconnect: async () => document.destroy(),
      });
      const edit = await s.gateway.openServerEdit(s.noteId, {
        principal: { kind: 'system', job: 'cli:doctor', onBehalfOf: s.ada },
        permission: 'note:write',
        reason: 'repair',
      });
      const emitted: Array<{ bytes: number; origin: unknown }> = [];
      edit.document.on('update', (update: Uint8Array, origin: unknown) =>
        emitted.push({ bytes: update.byteLength, origin }),
      );
      const input = '漢😀'.repeat(250_000);
      edit.insertChunked(0, input);
      expect(projectMarkdown(edit.document)).toBe(input);
      expect(emitted.length).toBeGreaterThan(1);
      expect(emitted.every((update) => update.bytes <= LIMITS.YJS_UPDATE_MAX_BYTES)).toBe(true);
      expect(emitted.map((update) => update.origin)).toEqual(
        emitted.map(() => ({
          source: 'local',
          context: expect.objectContaining({ reason: 'repair', userId: s.ada, noteId: s.noteId }),
        })),
      );
      const before = emitted.length;
      expect(() => edit.document.transact(() => edit.insertChunked(0, 'bad'), 'outer')).toThrow(
        expect.objectContaining({ code: 'nested-transaction' }),
      );
      expect(emitted).toHaveLength(before);
      expect(projectMarkdown(edit.document)).toBe(input);
      await edit.disconnect();
    });

    it('reasserts the captured owner before every bounded insertion chunk', async () => {
      let active = true;
      const s = scene({
        captureOwner: () => ({
          assertActive: () => {
            if (!active) throw new CollabOwnershipLost();
          },
          assertCurrent: async () => undefined,
        }),
      });
      const document = fakeDocumentOf(noteDocName(s.noteId));
      s.server.openDirectConnection = async (_name, context) => ({
        document,
        transact: async (fn) => document.transact(() => fn(document), { source: 'local', context }),
        disconnect: async () => document.destroy(),
      });
      const edit = await s.gateway.openServerEdit(s.noteId, {
        principal: { kind: 'system', job: 'cli:doctor' },
        permission: 'note:write',
        reason: 'repair',
      });
      document.on('update', () => {
        active = false;
      });
      expect(() => edit.insertChunked(0, 'x'.repeat(LIMITS.INSERT_CHUNK_MAX_BYTES * 2))).toThrow(
        CollabOwnershipLost,
      );
      expect(projectMarkdown(document)).toBe('x'.repeat(LIMITS.INSERT_CHUNK_MAX_BYTES));
      await edit.disconnect();
    });

    it('marks, reads and clears a closing note', () => {
      const s = scene();
      expect(s.gateway.isClosing(s.noteId)).toBe(false);
      s.gateway.markClosing(s.noteId);
      expect(s.gateway.isClosing(s.noteId)).toBe(true);
      s.gateway.clearClosing(s.noteId);
      expect(s.gateway.isClosing(s.noteId)).toBe(false);
    });

    it('authorizes a server edit, opens a direct connection with the local origin, and refuses the unauthorized', async () => {
      const s = scene();
      const opened: unknown[] = [];
      const document = fakeDocumentOf(noteDocName(s.noteId));
      s.server.openDirectConnection = async (documentName, context) => {
        opened.push({ documentName, context });
        return {
          document,
          transact: async (fn) => fn(document),
          disconnect: async () => undefined,
        };
      };
      const sessionId = s.world.session(s.ada);
      const edit = await s.gateway.openServerEdit(s.noteId, {
        principal: {
          kind: 'user',
          userId: s.ada,
          sessionId,
          sessionKind: 'web',
          isServerAdmin: false,
          authzVersion: 1,
          lastAuthenticatedAt: s.world.clock.date(),
        },
        permission: 'note:write',
        reason: 'repair',
      });
      await edit.transact((doc) => {
        getContent(doc).insert(0, 'edited');
      });
      expect(projectMarkdown(document)).toBe('edited');
      expect(opened).toEqual([
        {
          documentName: noteDocName(s.noteId),
          context: expect.objectContaining({
            ip: 'server',
            requestId: 'server-edit:repair',
            vaultId: s.vaultId,
            noteId: s.noteId,
            userId: s.ada,
            reason: 'repair',
          }),
        },
      ]);
      await edit.disconnect();

      const outsider = s.world.user();
      await expect(
        s.gateway.openServerEdit(s.noteId, {
          principal: {
            kind: 'user',
            userId: outsider,
            sessionId: s.world.session(outsider),
            sessionKind: 'web',
            isServerAdmin: false,
            authzVersion: 1,
            lastAuthenticatedAt: s.world.clock.date(),
          },
          permission: 'note:write',
          reason: 'restore',
          revisionId: 3,
        }),
      ).rejects.toBeInstanceOf(ProblemError);
      // A system principal is trusted, and its `onBehalfOf` is the recorded author.
      await expect(
        s.gateway.openServerEdit(s.noteId, {
          principal: { kind: 'system', job: 'cli:doctor', onBehalfOf: s.bob },
          permission: 'note:write',
          reason: 'repair',
        }),
      ).resolves.toBeDefined();
      expect(opened.at(-1)).toMatchObject({ context: { userId: s.bob, reason: 'repair' } });
      // A trashed or unknown note is refused before any authorization.
      const trashed = s.world.note(s.vaultId, { deletedAt: s.world.clock.date() });
      await expect(
        s.gateway.openServerEdit(trashed, {
          principal: { kind: 'system', job: 'cli:doctor' },
          permission: 'note:write',
          reason: 'repair',
        }),
      ).rejects.toMatchObject({ code: 'node_trashed' });
    });
  });

  it('composes overlapping principal fences and writer latches, and keeps a closed native connection read-only', async () => {
    let writerLatched = false;
    const s = scene({
      applyWriterLatches: (connection) => {
        if (writerLatched) connection.readOnly = true;
      },
    });
    const ada = s.open(s.ada, noteDocName(s.noteId));
    const bob = s.open(s.bob, noteDocName(s.noteId));
    const vault = s.open(s.ada, vaultDocName(s.vaultId));
    s.world.sessionFence.begin('one', s.ada);
    expect(ada.connection.readOnly).toBe(true);
    expect(bob.connection.readOnly).toBe(false);
    s.gateway.applyReadOnly(ada.connection, false);
    expect(ada.connection.readOnly).toBe(true);
    s.world.sessionFence.begin('all', null);
    s.world.sessionFence.finish('one');
    expect(ada.connection.readOnly).toBe(true);
    expect(noteMessages(ada.socket).filter((message) => message.t === 'role')).toEqual([]);
    writerLatched = true;
    s.world.sessionFence.finish('all');
    expect(ada.connection.readOnly).toBe(true);
    expect(noteMessages(ada.socket).filter((message) => message.t === 'role')).toEqual([]);
    writerLatched = false;
    s.world.sessionFence.begin('rollback', s.ada);
    s.world.sessionFence.finish('rollback');
    expect(ada.connection.readOnly).toBe(false);
    expect(vault.connection.readOnly).toBe(true);
    expect(noteMessages(ada.socket).at(-1)).toEqual({
      v: 1,
      t: 'role',
      role: 'editor',
      recovered: true,
    });
    await s.gateway.revokeUser(s.ada);
    expect(ada.connection.document.hasConnection(ada.connection)).toBe(false);
    s.gateway.applyReadOnly(ada.connection, false);
    expect(ada.connection.readOnly).toBe(true);
  });

  it('reauthorizes every actual connection independently and joins siblings before surfacing a failure', async () => {
    const s = scene();
    const first = s.open(s.ada, noteDocName(s.noteId));
    const second = s.open(s.ada, vaultDocName(s.vaultId));
    const other = s.open(s.bob, noteDocName(s.noteId));
    await expect(s.gateway.revalidateUser(s.ada)).rejects.toThrow('not bound');
    const delayed = Promise.withResolvers<void>();
    const checked: string[] = [];
    s.gateway.bindReauthorization(async (connection) => {
      checked.push(connection.context.sessionId ?? 'missing');
      if (connection === first.connection) throw new Error('unavailable');
      if (connection === second.connection) await delayed.promise;
    });
    let settled = false;
    const result = s.gateway.revalidateUser(s.ada).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    expect(checked.toSorted()).toEqual([first.sessionId, second.sessionId].toSorted());
    expect(settled).toBe(false);
    delayed.resolve();
    expect(await result).toBeInstanceOf(AggregateError);
    s.gateway.bindReauthorization(async (connection) => {
      checked.push(connection.context.sessionId ?? 'missing');
    });
    await s.gateway.revalidateUser(null);
    expect(checked).toContain(other.sessionId);
  });
});
