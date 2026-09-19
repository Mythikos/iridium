/**
 * `collab.auth-hook.unit` — `IridiumAuth` over the fake world (04-auth-and-access-control.md §6.4,
 * §7.3, §7.4, §7.6, §8.6, §8.7; 05-collaboration-and-durability.md, "Awareness";
 * 09-api-reference.md §3.2, §3.6).
 *
 * The world's authorizer, ticket store and epoch table are the product's own; what is faked is the
 * two reads and the session load. Every refusal is asserted by its close reason and its audit
 * reason, every acceptance by the context the later hooks read.
 */
import {
  decodeServerNoteMessage,
  LIMITS,
  noteDocName,
  vaultDocName,
  type ServerNoteMessage,
  type SessionId,
  type UserId,
} from '@iridium/contracts';
import { FRAME_TYPE } from '@iridium/crdt';
import { awarenessFrame, encodeAwarenessUpdate } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { SessionStoreUnavailableError } from '../../auth/plugin.ts';
import { AuthzStoreUnavailableError } from '../../authz/authorize.ts';
import { NO_MEMBERSHIP_VERSION } from '../../authz/epochs.ts';
import { authenticated } from '../context.ts';
import {
  closeReasons,
  fakeConnection,
  fakeDocumentOf,
  statelessPayloads,
} from '../testing/fake-hocuspocus.ts';
import { updateFrame } from '../testing/frames.ts';
import {
  authenticatePayload,
  awarenessPayload,
  connectedPayloadFor,
  disconnectPayload,
  hookHarness,
  hookOf,
  messagePayload,
  preAuthContext,
  tokenSyncPayload,
  type HookHarness,
} from '../testing/hook-deps.ts';
import { createAuthExtension } from './auth.ts';
import { CollabReadsUnavailable } from './resolution.ts';

const CLIENT_VERSION = '1.4.0';

function messages(payloads: readonly string[]): ServerNoteMessage[] {
  return payloads.flatMap((payload) => {
    const decoded = decodeServerNoteMessage(payload);
    return decoded.ok ? [decoded.message] : [];
  });
}

/** One vault, one initialised note and the four principals every case needs. */
function scene(options: Parameters<typeof hookHarness>[0] = {}): HookHarness & {
  readonly extension: ReturnType<typeof createAuthExtension>;
  readonly vaultId: ReturnType<HookHarness['world']['vault']>;
  readonly noteId: ReturnType<HookHarness['world']['note']>;
  readonly noteName: string;
  readonly editor: UserId;
  readonly viewer: UserId;
  readonly admin: UserId;
  readonly outsider: UserId;
} {
  const harness = hookHarness({ random: () => 0.5, ...options });
  const { world } = harness;
  const vaultId = world.vault();
  const noteId = world.note(vaultId, { snapshotSize: 1_234 });
  const editor = world.user({ name: 'Ada', colorHue: 120 });
  world.member(vaultId, editor, 'editor', 3);
  const viewer = world.user({ name: 'Vera', colorHue: 200 });
  world.member(vaultId, viewer, 'viewer', 1);
  const admin = world.user({ isServerAdmin: true, name: 'Root' });
  const outsider = world.user({ name: 'Out' });
  return {
    ...harness,
    extension: createAuthExtension(harness.deps),
    vaultId,
    noteId,
    noteName: noteDocName(noteId),
    editor,
    viewer,
    admin,
    outsider,
  };
}

/** Authenticates `userId` on `documentName` with a fresh ticket, returning the payload it filled. */
async function authenticate(
  s: ReturnType<typeof scene>,
  userId: UserId,
  documentName = s.noteName,
  headers: Readonly<Record<string, string>> = { 'x-iridium-client-version': CLIENT_VERSION },
): Promise<{
  readonly payload: ReturnType<typeof authenticatePayload>;
  readonly sessionId: SessionId;
  readonly returned: unknown;
}> {
  const credentials = s.world.credentials(userId);
  const payload = authenticatePayload({
    documentName,
    token: credentials.ticket,
    context: preAuthContext(s.clock),
    headers,
  });
  const returned = await hookOf(s.extension, 'onAuthenticate')(payload);
  return { payload, sessionId: credentials.sessionId, returned };
}

/** A refused authentication: the rejection, for its reason and audit reason. */
async function refused(
  s: ReturnType<typeof scene>,
  token: string,
  documentName = s.noteName,
): Promise<{ readonly reason?: string; readonly auditReason?: string }> {
  const payload = authenticatePayload({
    documentName,
    token,
    context: preAuthContext(s.clock),
  });
  try {
    await hookOf(s.extension, 'onAuthenticate')(payload);
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null) {
      const reason: unknown = Reflect.get(error, 'reason');
      const auditReason: unknown = Reflect.get(error, 'auditReason');
      return {
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(typeof auditReason === 'string' ? { auditReason } : {}),
      };
    }
    throw error;
  }
  throw new Error('the authentication was not refused');
}

/** An authenticated connection on the note document, registered in `documents`. */
async function connect(
  s: ReturnType<typeof scene>,
  userId: UserId,
  documentName = s.noteName,
): Promise<ReturnType<typeof fakeConnection> & { readonly sessionId: SessionId }> {
  const { payload, sessionId } = await authenticate(s, userId, documentName);
  let document = s.documents.get(documentName);
  if (document === undefined) {
    document = fakeDocumentOf(documentName);
    s.documents.set(documentName, document);
  }
  const connection = fakeConnection(document, payload.context, {
    readOnly: payload.connectionConfig.readOnly,
  });
  return { ...connection, sessionId };
}

describe('collab.auth-hook.unit [area:collab]', () => {
  describe('onAuthenticate', () => {
    it('fills the context of an editor, reserves nothing itself and seeds the epoch table', async () => {
      const s = scene();
      const { payload, sessionId, returned } = await authenticate(s, s.editor);
      expect(returned).toBe(payload.context);
      expect(payload.context).toMatchObject({
        userId: s.editor,
        sessionId,
        vaultId: s.vaultId,
        noteId: s.noteId,
        role: 'editor',
        isServerAdmin: false,
        authzEpoch: { userAuthzVersion: 1, memberVersion: 3 },
        clientName: 'web',
        clientVersion: CLIENT_VERSION,
      });
      expect(payload.connectionConfig.readOnly).toBe(false);
      // The resolved row travels to `IridiumLimits` on the same payload, with the admission estimate.
      expect(s.channel.get(payload)).toMatchObject({ kind: 'note', snapshotSize: 1_234 });
      expect(s.world.epochs.isStale(authenticated(payload.context))).toBe(false);
      expect(s.logger.events()).toContain('collab.connection.accepted');
      expect(s.delays).toEqual(['auth.slow']);
      expect(s.audit.events).toEqual([]);
    });

    it('makes a viewer read-only and a server administrator a manager without a membership row', async () => {
      const s = scene();
      const viewer = await authenticate(s, s.viewer);
      expect(viewer.payload.connectionConfig.readOnly).toBe(true);
      expect(viewer.payload.context.role).toBe('viewer');
      const admin = await authenticate(s, s.admin);
      expect(admin.payload.connectionConfig.readOnly).toBe(false);
      expect(admin.payload.context).toMatchObject({
        role: 'manager',
        isServerAdmin: true,
        authzEpoch: { userAuthzVersion: 1, memberVersion: NO_MEMBERSHIP_VERSION },
      });
    });

    it('opens the vault channel read-only for everyone, with no note id', async () => {
      const s = scene();
      const { payload } = await authenticate(s, s.editor, vaultDocName(s.vaultId));
      expect(payload.connectionConfig.readOnly).toBe(true);
      expect(payload.context).toMatchObject({ noteId: null, vaultId: s.vaultId, role: 'editor' });
      expect(s.channel.get(payload)).toMatchObject({ kind: 'vault' });
    });

    it('consumes a ticket exactly once and refuses a second use as unauthorized', async () => {
      const s = scene();
      const credentials = s.world.credentials(s.editor);
      const first = authenticatePayload({
        documentName: s.noteName,
        token: credentials.ticket,
        context: preAuthContext(s.clock),
      });
      await hookOf(s.extension, 'onAuthenticate')(first);
      await expect(refused(s, credentials.ticket)).resolves.toEqual({
        reason: 'unauthorized',
        auditReason: 'ticket_invalid',
      });
      expect(s.logger.events()).toContain('collab.connection.rejected');
      // No vault is known at that point, so nothing is audited.
      expect(s.audit.events).toEqual([]);
    });

    it('splits a dead session by reason: expired is unauthorized, revoked and inactive are revoked', async () => {
      const s = scene();
      const expired = s.world.ticket(s.world.deadSession('expired'), s.editor);
      await expect(refused(s, expired)).resolves.toEqual({
        reason: 'unauthorized',
        auditReason: 'session_expired',
      });
      const revoked = s.world.ticket(s.world.deadSession('revoked'), s.editor);
      await expect(refused(s, revoked)).resolves.toEqual({
        reason: 'revoked',
        auditReason: 'session_revoked',
      });
      const inactive = s.world.ticket(s.world.deadSession('user_inactive'), s.editor);
      await expect(refused(s, inactive)).resolves.toEqual({
        reason: 'revoked',
        auditReason: 'session_user_inactive',
      });
      const missing = s.world.ticket(s.world.deadSession('expired'), s.editor);
      s.world.sessions.clear();
      await expect(refused(s, missing)).resolves.toEqual({
        reason: 'unauthorized',
        auditReason: 'session_missing',
      });
    });

    it('refuses a ticket bound to another user than its session, and reports it to the SIEM', async () => {
      const s = scene();
      const sessionOfEditor = s.world.session(s.editor);
      const forged = s.world.ticket(sessionOfEditor, s.viewer);
      await expect(refused(s, forged)).resolves.toEqual({
        reason: 'unauthorized',
        auditReason: 'ticket_session_mismatch',
      });
      expect(s.logger.events()).toContain('authz.denied');
    });

    it('answers not-found to an outsider and audits the deny against the vault', async () => {
      const s = scene();
      const credentials = s.world.credentials(s.outsider);
      await expect(refused(s, credentials.ticket)).resolves.toEqual({
        reason: 'note-not-found',
        auditReason: 'deny_not_found',
      });
      expect(s.audit.events).toEqual([
        expect.objectContaining({
          action: 'collab.connection.rejected',
          vaultId: s.vaultId,
          userId: s.outsider,
          sessionId: credentials.sessionId,
          noteId: s.noteId,
          reason: 'deny_not_found',
        }),
      ]);
    });

    it('maps every document-name and row condition to its close reason', async () => {
      const s = scene();
      const { world } = s;
      const ticket = (): string => world.credentials(s.editor).ticket;
      await expect(refused(s, ticket(), 'note:not-a-uuid')).resolves.toMatchObject({
        reason: 'protocol-error',
      });
      await expect(
        refused(s, ticket(), noteDocName(world.note(world.vault()))),
      ).resolves.toMatchObject({
        reason: 'note-not-found',
      });
      const category = world.note(s.vaultId, { nodeKind: 'category' });
      await expect(refused(s, ticket(), noteDocName(category))).resolves.toMatchObject({
        reason: 'note-not-found',
      });
      const uninitialised = world.note(s.vaultId, { initializedAt: null });
      await expect(refused(s, ticket(), noteDocName(uninitialised))).resolves.toMatchObject({
        reason: 'note-not-found',
      });
      const trashed = world.note(s.vaultId, { deletedAt: world.clock.date() });
      await expect(refused(s, ticket(), noteDocName(trashed))).resolves.toMatchObject({
        reason: 'note-trashed',
      });
      s.gateway.markClosing(s.noteId);
      await expect(refused(s, ticket())).resolves.toMatchObject({ reason: 'note-closing' });
      s.gateway.clearClosing(s.noteId);
      const archived = world.vault({ status: 'archived' });
      world.member(archived, s.editor, 'editor');
      await expect(refused(s, ticket(), noteDocName(world.note(archived)))).resolves.toMatchObject({
        reason: 'vault-archived',
      });
      const importing = world.vault({ status: 'importing' });
      world.member(importing, s.editor, 'editor');
      await expect(refused(s, ticket(), noteDocName(world.note(importing)))).resolves.toMatchObject(
        {
          reason: 'note-not-found',
        },
      );
      await expect(refused(s, ticket(), vaultDocName(world.vault()))).resolves.toMatchObject({
        reason: 'note-not-found',
      });
    });

    it('enforces the per-user document-connection cap without auditing it', async () => {
      const s = scene({ maxConnectionsPerUser: 1 });
      await connect(s, s.editor);
      const credentials = s.world.credentials(s.editor);
      await expect(refused(s, credentials.ticket)).resolves.toEqual({
        reason: 'rate-limited',
        auditReason: 'connections_per_user',
      });
      expect(s.audit.events).toEqual([]);
      // Another user is not counted against it.
      await expect(authenticate(s, s.viewer)).resolves.toBeDefined();
    });

    it('fails closed on an unexpected identity error and logs the hook failure', async () => {
      const s = scene();
      s.world.readsFailure = new Error('identity mapping invariant failed');
      const credentials = s.world.credentials(s.editor);
      await expect(refused(s, credentials.ticket)).resolves.toEqual({
        reason: 'unauthorized',
        auditReason: 'internal_error',
      });
      expect(s.logger.events()).toContain('collab.hook.error');
    });
  });

  describe('transient identity storage failures', () => {
    it.each([
      new SessionStoreUnavailableError(),
      new AuthzStoreUnavailableError(),
      new CollabReadsUnavailable(),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ])(
      'refuses initial authentication with retryable unavailable for $name: $message',
      async (error) => {
        const s = scene();
        s.world.readsFailure = error;
        const credentials = s.world.credentials(s.editor);
        await expect(refused(s, credentials.ticket)).resolves.toEqual({
          reason: 'unavailable',
          auditReason: 'internal_error',
        });
        expect(s.audit.events).toEqual([]);
        s.world.readsFailure = null;
        await expect(authenticate(s, s.editor)).resolves.toBeDefined();
      },
    );

    it('reports a token-sync query deadline as unavailable while preserving the current identity', async () => {
      const s = scene();
      const { connection, sessionId } = await connect(s, s.editor);
      const next = s.world.credentials(s.editor);
      s.deps.sessions.loadLiveSession = async () => {
        throw Object.assign(new Error('query deadline'), { code: 'PROTOCOL_SEQUENCE_TIMEOUT' });
      };
      await expect(
        hookOf(s.extension, 'onTokenSync')(tokenSyncPayload(connection, next.ticket)),
      ).rejects.toMatchObject({ reason: 'unavailable', code: 4503 });
      expect(connection.context.sessionId).toBe(sessionId);
      expect(s.audit.events).toEqual([]);
    });

    it('rejects a resumed message transiently when its required session reread loses storage', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      s.world.sessionFence.begin('query-unavailable', s.editor);
      const message = hookOf(
        s.extension,
        'beforeHandleMessage',
      )(messagePayload(connection, updateFrame(s.noteName, new Uint8Array(2))));
      s.deps.sessions.loadLiveSession = async () => {
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      };
      s.world.sessionFence.finish('query-unavailable');
      await expect(message).rejects.toMatchObject({
        reason: 'unavailable',
        code: 4503,
        auditReason: 'reauthorize_failed',
      });
    });

    it('refuses stale-epoch messages transiently without seeding an authorization result from a failed read', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      s.world.epochs.user(s.editor, 2);
      s.world.readsFailure = Object.assign(new Error('query deadline'), {
        code: 'PROTOCOL_SEQUENCE_TIMEOUT',
      });
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(messagePayload(connection, updateFrame(s.noteName, new Uint8Array(2)))),
      ).rejects.toMatchObject({ reason: 'unavailable', code: 4503 });
      expect(authenticated(connection.context).authzEpoch.userAuthzVersion).toBe(1);
      expect(s.world.epochs.isStale(authenticated(connection.context))).toBe(true);
      expect(s.audit.events).toEqual([]);
    });
  });

  describe('onTokenSync', () => {
    it('re-runs the algorithm on the live connection: role, epoch and read-only are rewritten', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      s.world.member(s.vaultId, s.editor, 'viewer', 4);
      const next = s.world.credentials(s.editor);
      await expect(
        hookOf(s.extension, 'onTokenSync')(tokenSyncPayload(connection, next.ticket)),
      ).resolves.toBeUndefined();
      expect(connection.context).toMatchObject({
        role: 'viewer',
        sessionId: next.sessionId,
        authzEpoch: { userAuthzVersion: 1, memberVersion: 4 },
      });
      expect(connection.readOnly).toBe(true);
      expect(messages(statelessPayloads(socket))).toEqual([{ v: 1, t: 'role', role: 'viewer' }]);
      expect(s.world.epochs.isStale(authenticated(connection.context))).toBe(false);
    });

    it('refuses a ticket of another user, and closes a connection whose membership vanished as revoked', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      const foreign = s.world.credentials(s.viewer);
      await expect(
        hookOf(s.extension, 'onTokenSync')(tokenSyncPayload(connection, foreign.ticket)),
      ).rejects.toMatchObject({ reason: 'unauthorized', auditReason: 'ticket_session_mismatch' });
      s.world.removeMember(s.vaultId, s.editor);
      const own = s.world.credentials(s.editor);
      await expect(
        hookOf(s.extension, 'onTokenSync')(tokenSyncPayload(connection, own.ticket)),
      ).rejects.toMatchObject({ reason: 'revoked', auditReason: 'deny_not_found' });
      expect(s.logger.events()).toContain('collab.connection.closed');
    });
  });

  describe('beforeHandleMessage', () => {
    it('performs no read in steady state, and exactly two on an epoch mismatch', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      s.world.readLog.length = 0;
      const frame = updateFrame(s.noteName, new Uint8Array(2));
      await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      expect(s.world.readLog).toEqual([]);
      // A membership bump the bus reported: the next message re-authorizes, the one after it does not.
      s.world.member(s.vaultId, s.editor, 'editor', 4);
      s.world.epochs.member(s.vaultId, s.editor, 4);
      await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      expect(s.world.readLog).toEqual(['userAuthz', 'resolveAuthorization']);
      expect(connection.context.authzEpoch).toEqual({ userAuthzVersion: 1, memberVersion: 4 });
      await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      expect(s.world.readLog).toEqual(['userAuthz', 'resolveAuthorization']);
      expect(messages(statelessPayloads(socket))).toEqual([]);
      expect(s.logger.events()).toContain('authz.epoch_mismatch');
    });

    it('applies a role change live and sends role; a lost membership or a disabled user closes revoked', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      const frame = updateFrame(s.noteName, new Uint8Array(2));
      s.world.member(s.vaultId, s.editor, 'viewer', 5);
      s.world.epochs.member(s.vaultId, s.editor, 5);
      await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame));
      expect(connection.readOnly).toBe(true);
      expect(connection.context.role).toBe('viewer');
      expect(messages(statelessPayloads(socket))).toEqual([{ v: 1, t: 'role', role: 'viewer' }]);

      s.world.removeMember(s.vaultId, s.editor);
      s.world.epochs.member(s.vaultId, s.editor, 'removed');
      await expect(
        hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, frame)),
      ).rejects.toMatchObject({ reason: 'revoked', auditReason: 'deny_not_found' });

      const other = await connect(s, s.viewer);
      const user = s.world.users.get(s.viewer);
      if (user === undefined) throw new Error('scene');
      user.status = 'disabled';
      user.authzVersion = 2;
      s.world.epochs.user(s.viewer, 2);
      await expect(
        hookOf(s.extension, 'beforeHandleMessage')(messagePayload(other.connection, frame)),
      ).rejects.toMatchObject({ reason: 'revoked', auditReason: 'user_inactive' });
    });

    it('refuses every message on a closing note', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      s.gateway.markClosing(s.noteId);
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(messagePayload(connection, updateFrame(s.noteName, new Uint8Array(2)))),
      ).rejects.toMatchObject({ reason: 'note-closing' });
    });
  });

  describe('authorization mutation fences', () => {
    it('pauses an existing message and resumes the same connection after confirmed rollback', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      s.world.sessionFence.begin('rollback', s.editor);
      expect(connection.readOnly).toBe(true);
      let completed = false;
      const message = hookOf(
        s.extension,
        'beforeHandleMessage',
      )(messagePayload(connection, updateFrame(s.noteName, new Uint8Array(2)))).then(() => {
        completed = true;
        return undefined;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      s.world.sessionFence.finish('rollback');
      await message;
      expect(completed).toBe(true);
      expect(connection.readOnly).toBe(false);
      expect(closeReasons(socket)).toEqual([]);
    });

    it('checks the actual session after a blocked message resumes and fails closed on a read error', async () => {
      const s = scene();
      const first = await connect(s, s.editor);
      s.world.sessionFence.begin('committed', s.editor);
      const rejected = hookOf(
        s.extension,
        'beforeHandleMessage',
      )(messagePayload(first.connection, updateFrame(s.noteName, new Uint8Array(2))));
      s.world.sessions.set(first.sessionId, { dead: 'revoked' });
      s.world.sessionFence.finish('committed');
      await expect(rejected).rejects.toMatchObject({
        reason: 'revoked',
        auditReason: 'session_revoked',
      });
      const second = await connect(s, s.editor);
      s.world.sessionFence.begin('unavailable', s.editor);
      const failed = hookOf(
        s.extension,
        'beforeHandleMessage',
      )(messagePayload(second.connection, updateFrame(s.noteName, new Uint8Array(2))));
      s.deps.sessions.loadLiveSession = async () => {
        throw new Error('session read unavailable');
      };
      s.world.sessionFence.finish('unavailable');
      await expect(failed).rejects.toMatchObject({
        reason: 'unauthorized',
        auditReason: 'reauthorize_failed',
      });
      expect(s.logger.events()).toContain('authz.epoch_mismatch');
    });

    it('rejects authentication whose initial live-session read raced an entire committed revocation', async () => {
      const s = scene();
      const credentials = s.world.credentials(s.editor);
      const load = s.deps.sessions.loadLiveSession;
      let first = true;
      s.deps.sessions.loadLiveSession = async (sessionId) => {
        const result = await load(sessionId);
        if (first) {
          first = false;
          s.world.sessionFence.begin('completed-during-read', s.editor);
          s.world.sessions.set(sessionId, { dead: 'revoked' });
          s.world.sessionFence.finish('completed-during-read');
        }
        return result;
      };
      await expect(refused(s, credentials.ticket)).resolves.toMatchObject({
        reason: 'revoked',
        auditReason: 'session_revoked',
      });
    });

    it('repeats authorization when a completed membership change races its resolved note read', async () => {
      const s = scene();
      const resolve = s.world.reads.resolveNote.bind(s.world.reads);
      let first = true;
      s.world.reads.resolveNote = async (noteId) => {
        const result = await resolve(noteId);
        if (first) {
          first = false;
          s.world.sessionFence.begin('membership', s.editor);
          s.world.member(s.vaultId, s.editor, 'viewer', 4);
          s.world.sessionFence.finish('membership');
        }
        return result;
      };
      const result = await authenticate(s, s.editor);
      expect(result.payload.context.role).toBe('viewer');
      expect(result.payload.connectionConfig.readOnly).toBe(true);
      expect(s.world.readLog.filter((name) => name === 'resolveNote')).toHaveLength(2);
    });

    it('does not let token synchronization bypass an outstanding principal fence', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      const next = s.world.credentials(s.editor);
      s.world.sessionFence.begin('token', s.editor);
      const rejected = hookOf(
        s.extension,
        'onTokenSync',
      )(tokenSyncPayload(connection, next.ticket));
      s.world.sessions.set(next.sessionId, { dead: 'revoked' });
      s.world.sessionFence.finish('token');
      await expect(rejected).rejects.toMatchObject({
        reason: 'revoked',
        auditReason: 'session_revoked',
      });
    });

    it('reloads the session when a revocation races a stale-epoch authorization read', async () => {
      const s = scene();
      const { connection, sessionId } = await connect(s, s.editor);
      s.world.epochs.user(s.editor, 2);
      const read = s.world.reads.resolveAuthorization.bind(s.world.reads);
      s.world.reads.resolveAuthorization = async (target) => {
        const result = await read(target);
        s.world.sessionFence.begin('epoch-race', s.editor);
        s.world.sessions.set(sessionId, { dead: 'revoked' });
        s.world.sessionFence.finish('epoch-race');
        return result;
      };
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(messagePayload(connection, updateFrame(s.noteName, new Uint8Array(2)))),
      ).rejects.toMatchObject({ reason: 'revoked', auditReason: 'session_revoked' });
    });

    it('reconciles each session independently even after a sibling refreshes their shared epoch', async () => {
      const s = scene();
      const first = await connect(s, s.editor);
      const second = await connect(s, s.editor);
      const other = await connect(s, s.viewer);
      s.world.sessionFence.begin('unknown-commit', s.editor);
      s.world.sessions.set(second.sessionId, { dead: 'revoked' });
      await s.gateway.revalidateUser(s.editor);
      expect(closeReasons(first.socket)).toEqual([]);
      expect(closeReasons(second.socket)).toEqual(['revoked']);
      expect(closeReasons(other.socket)).toEqual([]);
      expect(first.connection.readOnly).toBe(true);
      expect(second.connection.readOnly).toBe(true);
      s.world.sessionFence.finish('unknown-commit');
      expect(first.connection.readOnly).toBe(false);
      expect(second.connection.readOnly).toBe(true);
    });

    it('joins every reconciliation read but propagates unavailable storage without a false close', async () => {
      const s = scene();
      const first = await connect(s, s.editor);
      const second = await connect(s, s.viewer);
      const attempts: SessionId[] = [];
      s.world.sessionFence.begin('unknown-global', null);
      s.deps.sessions.loadLiveSession = async (sessionId) => {
        attempts.push(sessionId);
        throw new Error('storage still unavailable');
      };
      await expect(s.gateway.revalidateUser(null)).rejects.toBeInstanceOf(AggregateError);
      expect(attempts).toEqual([first.sessionId, second.sessionId]);
      expect(closeReasons(first.socket)).toEqual([]);
      expect(closeReasons(second.socket)).toEqual([]);
      expect(s.world.sessionFence.blocked(s.editor)).toBe(true);
      expect(s.world.sessionFence.blocked(s.viewer)).toBe(true);
    });
  });

  describe('raw awareness identity and removal ownership', () => {
    it('accepts the owning connection’s state and explicit removal without a database read', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      const entry = { clientId: 7, clock: 1, state: { user: { id: s.editor } } };
      s.world.readLog.length = 0;
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            connection,
            awarenessFrame({ documentName: s.noteName, entries: [entry] }),
          ),
        ),
      ).resolves.toBeUndefined();
      connection.document.applyAwarenessUpdate(connection, encodeAwarenessUpdate([entry]));
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            connection,
            awarenessFrame({
              documentName: s.noteName,
              entries: [{ ...entry, clock: 2, state: null }],
            }),
          ),
        ),
      ).resolves.toBeUndefined();
      expect(s.world.readLog).toEqual([]);
      expect(closeReasons(socket)).toEqual([]);
    });

    it.each(['foreign-user', 'same-user'] as const)(
      'refuses removing an id owned by a different %s connection',
      async (kind) => {
        const s = scene();
        const sender = await connect(s, s.editor);
        const victim = await connect(s, kind === 'same-user' ? s.editor : s.viewer);
        const entry = {
          clientId: 8,
          clock: 1,
          state: { user: { id: victim.connection.context.userId } },
        };
        const document = victim.connection.document;
        document.applyAwarenessUpdate(victim.connection, encodeAwarenessUpdate([entry]));
        await expect(
          hookOf(
            s.extension,
            'beforeHandleMessage',
          )(
            messagePayload(
              sender.connection,
              awarenessFrame({
                documentName: s.noteName,
                entries: [{ ...entry, clock: 2, state: null }],
              }),
            ),
          ),
        ).rejects.toMatchObject({ reason: 'awareness-spoof' });
        expect(document.awareness.getStates().get(8)).toEqual(entry.state);
        expect(document.getClients(victim.connection).has(8)).toBe(true);
        expect(closeReasons(sender.socket)).toEqual(['awareness-spoof']);
        expect(s.audit.events).toHaveLength(1);
      },
    );

    it('accepts a stale absent removal but refuses a new tombstone that would poison its clock', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      const removal = { clientId: 7, clock: 2, state: null };
      connection.document.applyAwarenessUpdate(
        connection,
        encodeAwarenessUpdate([
          { clientId: 7, clock: 1, state: { user: { id: s.editor } } },
          removal,
        ]),
      );
      expect(connection.document.getClients(connection).has(7)).toBe(false);
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            connection,
            awarenessFrame({ documentName: s.noteName, entries: [removal] }),
          ),
        ),
      ).resolves.toBeUndefined();
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            connection,
            awarenessFrame({ documentName: s.noteName, entries: [{ ...removal, clock: 3 }] }),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
      expect(connection.document.awareness.meta.get(7)?.clock).toBe(2);
    });

    it('refuses claiming another connection’s active client id even with the sender’s own user id', async () => {
      const s = scene();
      const sender = await connect(s, s.editor);
      const victim = await connect(s, s.viewer);
      victim.connection.document.applyAwarenessUpdate(
        victim.connection,
        encodeAwarenessUpdate([{ clientId: 8, clock: 1, state: { user: { id: s.viewer } } }]),
      );
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            sender.connection,
            awarenessFrame({
              documentName: s.noteName,
              entries: [{ clientId: 8, clock: 2, state: { user: { id: s.editor } } }],
            }),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
      expect(victim.connection.document.awareness.getStates().get(8)).toEqual({
        user: { id: s.viewer },
      });
    });

    it('preserves a connection’s id ownership while its visible awareness has timed out', async () => {
      const s = scene();
      const sender = await connect(s, s.editor);
      const victim = await connect(s, s.viewer);
      const document = victim.connection.document;
      document.applyAwarenessUpdate(
        victim.connection,
        encodeAwarenessUpdate([{ clientId: 8, clock: 1, state: { user: { id: s.viewer } } }]),
      );
      // A server timeout removes the visible state without disconnecting its owner.
      document.awareness.getStates().delete(8);
      expect(document.getClients(victim.connection).has(8)).toBe(true);
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            sender.connection,
            awarenessFrame({
              documentName: s.noteName,
              entries: [{ clientId: 8, clock: 2, state: { user: { id: s.editor } } }],
            }),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
      expect(document.getClients(victim.connection).has(8)).toBe(true);
    });
    it.each([0, 1])(
      'validates a foreign entry even when clock %i would be discarded or overwritten',
      async (clock) => {
        const s = scene();
        const { connection } = await connect(s, s.editor);
        await expect(
          hookOf(
            s.extension,
            'beforeHandleMessage',
          )(
            messagePayload(
              connection,
              awarenessFrame({
                documentName: s.noteName,
                entries: [
                  { clientId: 7, clock, state: { user: { id: s.viewer } } },
                  { clientId: 7, clock: 2, state: { user: { id: s.editor } } },
                ],
              }),
            ),
          ),
        ).rejects.toMatchObject({ reason: 'awareness-spoof' });
        expect(connection.document.awareness.getStates().size).toBe(0);
      },
    );

    it('validates raw vault identity before duplicate folding and refuses foreign vault removals', async () => {
      const s = scene();
      const name = vaultDocName(s.vaultId);
      const sender = await connect(s, s.editor, name);
      const victim = await connect(s, s.viewer, name);
      const state = { user: { id: s.editor }, activeNoteId: s.noteId };
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            sender.connection,
            awarenessFrame({ documentName: name, entries: [{ clientId: 7, clock: 1, state }] }),
          ),
        ),
      ).resolves.toBeUndefined();
      sender.connection.document.applyAwarenessUpdate(
        sender.connection,
        encodeAwarenessUpdate([{ clientId: 7, clock: 1, state }]),
      );
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            sender.connection,
            awarenessFrame({
              documentName: name,
              entries: [{ clientId: 7, clock: 2, state: null }],
            }),
          ),
        ),
      ).resolves.toBeUndefined();
      victim.connection.document.applyAwarenessUpdate(
        victim.connection,
        encodeAwarenessUpdate([
          { clientId: 8, clock: 1, state: { user: { id: s.viewer }, activeNoteId: null } },
        ]),
      );
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            sender.connection,
            awarenessFrame({
              documentName: name,
              entries: [{ clientId: 8, clock: 2, state: null }],
            }),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
      expect(victim.connection.document.awareness.getStates().get(8)).toEqual({
        user: { id: s.viewer },
        activeNoteId: null,
      });
      const next = await connect(s, s.editor, name);
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            next.connection,
            awarenessFrame({
              documentName: name,
              entries: [
                { clientId: 9, clock: 1, state: { user: { id: s.viewer }, activeNoteId: null } },
                { clientId: 9, clock: 2, state },
              ],
            }),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
    });
    it('rejects an unknown removal before it can add awareness metadata', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor);
      await expect(
        hookOf(
          s.extension,
          'beforeHandleMessage',
        )(
          messagePayload(
            connection,
            awarenessFrame({
              documentName: s.noteName,
              entries: [{ clientId: 7, clock: Number.MAX_SAFE_INTEGER, state: null }],
            }),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
      expect(connection.document.awareness.meta.has(7)).toBe(false);
    });
  });

  describe('Hocuspocus awareness dispatch', () => {
    it('passes only wire participants to hooks, suppresses hook-deleted states, and applies explicit null removals', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      const document = connection.document;
      let suppress = false;
      const observed: number[][] = [];
      connection.beforeHandleMessage(async (_connection, update) => {
        await hookOf(s.extension, 'beforeHandleMessage')(messagePayload(connection, update));
      });
      document.beforeHandleAwareness(async (_document, states) => {
        observed.push([...states.keys()]);
        await hookOf(s.extension, 'beforeHandleAwareness')(awarenessPayload(connection, states));
        if (suppress) states.delete(7);
      });
      const send = async (clock: number, state: unknown): Promise<void> => {
        connection.handleMessage(
          awarenessFrame({ documentName: s.noteName, entries: [{ clientId: 7, clock, state }] }),
        );
        await connection.waitForPendingMessages();
      };
      try {
        const state = { user: { id: s.editor }, mode: 'split' };
        await send(1, state);
        expect(observed).toEqual([[7]]);
        expect(document.awareness.getStates().get(7)).toEqual(state);
        suppress = true;
        await send(2, { user: { id: s.editor }, mode: 'reading' });
        expect(document.awareness.getStates().get(7)).toEqual(state);
        suppress = false;
        await send(3, null);
        expect(observed).toEqual([[7], [7], []]);
        expect(document.awareness.getStates().size).toBe(0);
        expect(document.getClients(connection).size).toBe(0);
        await send(4, state);
        expect(document.getClients(connection).has(7)).toBe(true);
        await expect(
          hookOf(
            s.extension,
            'beforeHandleMessage',
          )(
            messagePayload(
              connection,
              awarenessFrame({
                documentName: s.noteName,
                entries: [
                  { clientId: 7, clock: 5, state: { user: { id: s.viewer } } },
                  { clientId: 7, clock: 6, state },
                ],
              }),
            ),
          ),
        ).rejects.toMatchObject({ reason: 'awareness-spoof' });
        expect(document.awareness.getStates().size).toBe(0);
        expect(document.hasConnection(connection)).toBe(false);
        expect(closeReasons(socket)).toEqual(['awareness-spoof']);
      } finally {
        document.destroy();
      }
    });
  });
  describe('beforeHandleAwareness', () => {
    it('accepts the connection’s own identity and records its mode; a foreign id or a stray field is a spoof', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      await hookOf(s.extension, 'connected')(connectedPayloadFor(connection));
      await expect(
        hookOf(
          s.extension,
          'beforeHandleAwareness',
        )(awarenessPayload(connection, new Map([[7, { user: { id: s.editor }, mode: 'split' }]]))),
      ).resolves.toBeUndefined();
      expect(s.gateway.participants(s.noteId).map((p) => p.mode)).toEqual(['split']);

      await expect(
        hookOf(
          s.extension,
          'beforeHandleAwareness',
        )(awarenessPayload(connection, new Map([[7, { user: { id: s.viewer } }]]))),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
      expect(closeReasons(socket)).toEqual(['awareness-spoof']);
      expect(s.audit.events).toEqual([
        expect.objectContaining({ action: 'collab.write.rejected', reason: 'awareness_spoof' }),
      ]);
      expect(s.logger.events()).toContain('collab.awareness.spoof');

      const again = await connect(s, s.editor);
      await expect(
        hookOf(
          s.extension,
          'beforeHandleAwareness',
        )(
          awarenessPayload(again.connection, new Map([[8, { user: { id: s.editor }, name: 'x' }]])),
        ),
      ).rejects.toMatchObject({ reason: 'awareness-spoof' });
    });

    it('leaves vault-channel awareness to the vault extension', async () => {
      const s = scene();
      const { connection } = await connect(s, s.editor, vaultDocName(s.vaultId));
      await expect(
        hookOf(
          s.extension,
          'beforeHandleAwareness',
        )(awarenessPayload(connection, new Map([[1, { user: { id: s.viewer } }]]))),
      ).resolves.toBeUndefined();
    });
  });

  describe('connected and onDisconnect', () => {
    it('retains the epoch, joins the participants with the server-supplied identity, and arms re-validation', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      const timersBefore = s.clock.pendingTimers;
      await hookOf(s.extension, 'connected')(connectedPayloadFor(connection));
      expect(s.world.epochs.refCount(s.editor)).toBe(1);
      expect(s.world.readLog).toContain('participantIdentity');
      expect(messages(statelessPayloads(socket))).toEqual([
        {
          v: 1,
          t: 'participants',
          users: [{ id: s.editor, name: 'Ada', colorHue: 120, role: 'editor' }],
        },
      ]);
      expect(s.clock.pendingTimers).toBe(timersBefore + 1);

      // With `random` fixed at 0.5 the jitter is zero: the request fires exactly at the interval.
      await s.clock.advance(LIMITS.TOKEN_REVALIDATION_MS);
      expect(socket.frames.filter((frame) => frame.type === FRAME_TYPE.auth)).toHaveLength(1);
      expect(closeReasons(socket)).toEqual([]);
      await s.clock.advance(LIMITS.TOKEN_REVALIDATION_GRACE_MS);
      expect(closeReasons(socket)).toEqual(['unauthorized']);
      expect(
        s.logger.lines.some((line) => line.fields['detail'] === 'revalidation_grace_elapsed'),
      ).toBe(true);
    });

    it('a token sync inside the grace window cancels the close and re-arms the interval', async () => {
      const s = scene();
      const { connection, socket } = await connect(s, s.editor);
      await hookOf(s.extension, 'connected')(connectedPayloadFor(connection));
      await s.clock.advance(LIMITS.TOKEN_REVALIDATION_MS);
      const next = s.world.credentials(s.editor);
      await hookOf(s.extension, 'onTokenSync')(tokenSyncPayload(connection, next.ticket));
      await s.clock.advance(LIMITS.TOKEN_REVALIDATION_GRACE_MS);
      expect(closeReasons(socket)).toEqual([]);
      await s.clock.advance(LIMITS.TOKEN_REVALIDATION_MS);
      expect(socket.frames.filter((frame) => frame.type === FRAME_TYPE.auth)).toHaveLength(2);
    });

    it('releases the epoch, leaves the participants and cancels the timers on disconnect', async () => {
      const s = scene();
      const editor = await connect(s, s.editor);
      const viewer = await connect(s, s.viewer);
      await hookOf(s.extension, 'connected')(connectedPayloadFor(editor.connection));
      await hookOf(s.extension, 'connected')(connectedPayloadFor(viewer.connection));
      const timersArmed = s.clock.pendingTimers;
      await expect(
        hookOf(s.extension, 'onDisconnect')(disconnectPayload(editor.connection)),
      ).resolves.toBeUndefined();
      expect(s.world.epochs.refCount(s.editor)).toBe(0);
      expect(s.gateway.participants(s.noteId).map((p) => p.id)).toEqual([s.viewer]);
      expect(s.clock.pendingTimers).toBe(timersArmed - 1);
      expect(s.logger.events()).toContain('collab.connection.closed');
      // The remaining connection was told.
      const last = messages(statelessPayloads(viewer.socket)).at(-1);
      expect(last?.t === 'participants' && last.users.map((u) => u.id)).toEqual([s.viewer]);
    });
  });
});
