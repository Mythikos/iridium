import type {
  beforeHandleAwarenessPayload,
  beforeHandleMessagePayload,
  connectedPayload,
  Connection,
  Document,
  Extension,
  onAuthenticatePayload,
  onDisconnectPayload,
  onTokenSyncPayload,
} from '@hocuspocus/server';
/**
 * `IridiumAuth` — identity, authorization and revocation on `/collab`
 * (04-auth-and-access-control.md §6.4, §7.3, §8.6, §8.7; 05-collaboration-and-durability.md,
 * "Extensions and every hook they use"; 09-api-reference.md §3.2, §3.6, §3.8).
 *
 * `onAuthenticate` is 04 §6.4's algorithm, step for step: consume the ticket, load the session by
 * primary key with the reason split the close table requires, parse the name, resolve the row with
 * all three vault columns, authorize `read` then `write` reusing one membership lookup, set
 * `readOnly`, enforce the per-user document cap, seed the epoch table, return the context. Every
 * refusal is a `CollabRejection` carrying one of the contract's close reasons, logged as
 * `collab.connection.rejected` and — when the vault is known and the refusal is not an operational
 * cap — audited.
 *
 * Two deliberate departures from the hook order the plan sketches, both recorded here:
 *
 *  - **The epoch refcount is retained at `connected`, not at `onAuthenticate`.** Hocuspocus fires
 *    `onDisconnect` for every connection that reached `connected`, and for none that failed between
 *    `onAuthenticate` and it (a refused `onLoadDocument`, a socket that closed mid-setup). Retaining
 *    where the release is guaranteed is what keeps the refcount exact; the *values* are still seeded
 *    at `onAuthenticate` step 8, so a message handled before `connected` finds a fresh entry.
 *  - **Every unexpected error fails closed.** `safeHook` swallows what is not a typed marker, and a
 *    swallowed `onAuthenticate` would authenticate nobody as someone; so the three identity hooks
 *    turn any other error into a rejection before `safeHook` sees it.
 */
import {
  AwarenessState,
  encodeStateless,
  LIMITS,
  NoteId,
  parseDocName,
  VaultAwarenessState,
  type SessionId,
  type UserId,
  type UserPrincipal,
  type VaultId,
} from '@iridium/contracts';
import { decodeAwarenessEntries, FRAME_TYPE, peekFrame } from '@iridium/crdt';

import { SessionStoreUnavailableError } from '../../auth/plugin.ts';
import { isDeadSession, type SessionVerifier } from '../../auth/sessions/verify.ts';
import type { TicketStore } from '../../auth/tickets/store.ts';
import {
  AuthzStoreUnavailableError,
  type Authorizer,
  type MemberForAuthz,
} from '../../authz/authorize.ts';
import { NO_MEMBERSHIP_VERSION, type EpochTable } from '../../authz/epochs.ts';
import type { SessionCommandFence } from '../../authz/session-command-fence.ts';
import { classifyDatabaseFailure } from '../../db/failure.ts';
import type { Clock, TimerHandle } from '../../ops/clock.ts';
import type { CollabAuditSink } from '../audit.ts';
import { authenticated, type AuthenticatedContext, type CollabHookContext } from '../context.ts';
import type { CollabGateway } from '../gateway.ts';
import type { CollabLimits } from '../limits.ts';
import type { CollabMetrics } from '../metrics.ts';
import { CollabRejection, closeEventFor, isHookSignal } from '../rejection.ts';
import { safeHook, type SafeHookDeps } from '../safe-hook.ts';
import {
  CollabReadsUnavailable,
  type CollabReads,
  type ParticipantIdentity,
  type Resolved,
  type ResolutionChannel,
} from './resolution.ts';

/** What the extension needs. */
export interface AuthExtensionDeps {
  readonly tickets: TicketStore;
  readonly sessions: Pick<SessionVerifier, 'loadLiveSession'>;
  readonly authorize: Authorizer['authorize'];
  readonly authorizeDetailed: Authorizer['authorizeDetailed'];
  readonly epochs: EpochTable;
  readonly sessionFence: SessionCommandFence;
  readonly reads: CollabReads;
  readonly gateway: CollabGateway;
  readonly audit: Pick<CollabAuditSink, 'record'>;
  readonly channel: ResolutionChannel;
  readonly clock: Clock;
  readonly logger: {
    info(fields: Readonly<Record<string, unknown>>, message: string): void;
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly faults: { delay(point: string): Promise<void> };
  readonly limits: Pick<CollabLimits, 'maxConnectionsPerUser'>;
  readonly documents: () => Map<string, Document>;
  readonly metrics: () => CollabMetrics | null;
  /** Injected randomness for the re-validation jitter; `Math.random` in production. */
  readonly random?: () => number;
}

/** What the connection carries beside its context: the re-validation timers (04 §7.4, §8.7). */
interface Revalidation {
  interval: TimerHandle | null;
  grace: TimerHandle | null;
}

const MS_PER_MINUTE = 60_000;

/** The participant shown when the `users` row cannot be read; the id still identifies the caret. */
const UNKNOWN_PARTICIPANT: ParticipantIdentity = Object.freeze({ name: 'unknown', colorHue: 0 });

/** The `SIEM authz.denied {reason:'ticket_session_mismatch'}` of 04 §6.4 step 2. */
const TICKET_SESSION_MISMATCH = 'ticket_session_mismatch';

interface Identity {
  readonly principal: UserPrincipal;
  readonly sessionId: SessionId;
}

interface Authorization {
  readonly resolved: Resolved;
  readonly vaultId: VaultId;
  readonly noteId: NoteId | null;
  readonly member: MemberForAuthz | null;
  readonly readOnly: boolean;
  readonly role: 'viewer' | 'editor' | 'manager';
}

/** Storage failure refuses this attempt without telling clients their valid session was revoked. */
function unexpectedRejection(error: unknown, auditReason: string): CollabRejection {
  const unavailable =
    error instanceof SessionStoreUnavailableError ||
    error instanceof AuthzStoreUnavailableError ||
    error instanceof CollabReadsUnavailable ||
    classifyDatabaseFailure(error).kind === 'unavailable';
  return new CollabRejection(unavailable ? 'unavailable' : 'unauthorized', { auditReason });
}

/** Builds the extension. */
export function createAuthExtension(deps: AuthExtensionDeps): Extension<CollabHookContext> {
  const revalidations = new WeakMap<Connection<CollabHookContext>, Revalidation>();
  const random = deps.random ?? Math.random;
  const hookDeps: SafeHookDeps = {
    logger: deps.logger,
    hookErrors: () => deps.metrics()?.collabHookErrorsTotal ?? null,
  };

  // ---- the shared steps of onAuthenticate and onTokenSync ---------------------------------------

  /** Steps 1 and 2: the ticket and the session, with the close-table reason split. */
  const identify = async (token: string): Promise<Identity> => {
    const ticket = deps.tickets.consume(token);
    if (ticket === null)
      throw new CollabRejection('unauthorized', { auditReason: 'ticket_invalid' });
    return reloadIdentity(ticket.sessionId, ticket.userId);
  };

  /** Session identity after an authorization barrier, without consuming the one-use ticket again. */
  const reloadIdentity = async (sessionId: SessionId, userId: UserId): Promise<Identity> => {
    const live = await deps.sessions.loadLiveSession(sessionId);
    if (live === null)
      throw new CollabRejection('unauthorized', { auditReason: 'session_missing' });
    if (isDeadSession(live)) {
      if (live.dead === 'expired') {
        throw new CollabRejection('unauthorized', { auditReason: 'session_expired' });
      }
      throw new CollabRejection('revoked', { auditReason: `session_${live.dead}` });
    }
    if (live.userId !== userId) {
      deps.logger.error(
        { event: 'authz.denied', reason: TICKET_SESSION_MISMATCH, sessionId },
        'a ticket named a session of another user',
      );
      throw new CollabRejection('unauthorized', { auditReason: TICKET_SESSION_MISMATCH });
    }
    return { principal: live, sessionId };
  };

  /**
   * Steps 3 to 6: the name, the row, the two decisions. `trace.vaultId` is set as soon as the row is
   * known, so a refusal after that point is audited against the vault; `denyAs` says how a deny is
   * reported — a refusal at authentication, a revocation on a live re-validation (04 §8.7).
   */
  const authorizeDocument = async (
    documentName: string,
    identity: Identity,
    trace: { vaultId: VaultId | null },
    denyAs: 'refuse' | 'revoke',
  ): Promise<Authorization> => {
    const parsed = parseDocName(documentName);
    if (parsed === null)
      throw new CollabRejection('protocol-error', { auditReason: 'bad_document_name' });

    let resolved: Resolved;
    let noteId: NoteId | null = null;
    if (parsed.channel === 'note') {
      const note = await deps.reads.resolveNote(parsed.id);
      if (note === null || note.nodeKind !== 'note' || note.initializedAt === null) {
        throw new CollabRejection('note-not-found');
      }
      if (note.deletedAt !== null) throw new CollabRejection('note-trashed');
      noteId = NoteId.parse(parsed.id);
      const closing = deps.gateway.closingReason(noteId);
      if (closing !== null) throw new CollabRejection(closing);
      resolved = note;
    } else {
      const vault = await deps.reads.resolveVault(parsed.id);
      if (vault === null) throw new CollabRejection('unauthorized');
      resolved = vault;
    }
    if (resolved.vaultStatus === 'archived') throw new CollabRejection('vault-archived');
    if (resolved.vaultStatus !== 'active') throw new CollabRejection('note-not-found');

    const vaultId = resolved.vault.id;
    trace.vaultId = vaultId;
    const read = await deps.authorizeDetailed(
      identity.principal,
      parsed.channel === 'note' ? 'note:read' : 'vault:read',
      { vaultId, vault: resolved.vault, surface: 'collab' },
    );
    if (read.decision !== 'allow') {
      const refusal =
        parsed.channel === 'note' && read.decision.deny === 'not_found'
          ? 'note-not-found'
          : 'unauthorized';
      throw new CollabRejection(denyAs === 'revoke' ? 'revoked' : refusal, {
        auditReason: `deny_${read.decision.deny}`,
      });
    }
    let readOnly = true;
    if (parsed.channel === 'note') {
      const write = await deps.authorize(identity.principal, 'note:write', {
        vaultId,
        vault: resolved.vault,
        member: read.member,
        surface: 'collab',
      });
      readOnly = write !== 'allow';
    }
    return {
      resolved,
      vaultId,
      noteId,
      member: read.member,
      readOnly,
      role: read.member?.role ?? 'manager',
    };
  };

  /** Step 8: the epoch table, from the rows already read. */
  const seedEpochs = (identity: Identity, authorization: Authorization): void => {
    deps.epochs.user(identity.principal.userId, identity.principal.authzVersion);
    deps.epochs.member(
      authorization.vaultId,
      identity.principal.userId,
      authorization.member?.version ?? NO_MEMBERSHIP_VERSION,
    );
  };

  /** The per-user document-connection cap (04 §7.6), counted over every live connection. */
  const countConnectionsOf = (userId: UserId): number => {
    let count = 0;
    for (const document of deps.documents().values()) {
      const connections: Connection<CollabHookContext>[] = document.getConnections();
      for (const connection of connections) {
        if (connection.context.userId === userId) count += 1;
      }
    }
    return count;
  };

  const logRejection = (
    payload: {
      readonly documentName: string;
      readonly socketId: string;
      readonly context: CollabHookContext;
    },
    rejection: CollabRejection,
    identity: Identity | null,
    vaultId: VaultId | null,
  ): void => {
    deps.logger.warn(
      {
        event: 'collab.connection.rejected',
        documentName: payload.documentName,
        socketId: payload.socketId,
        requestId: payload.context.requestId,
        reason: rejection.reason,
        detail: rejection.auditReason,
        userId: identity?.principal.userId,
      },
      'a collaboration connection was refused',
    );
    // Only a security-relevant refusal with a known vault is audited; a cap refusal is operational.
    if (vaultId === null || rejection.reason === 'rate-limited') return;
    void deps.audit.record({
      action: 'collab.connection.rejected',
      vaultId,
      userId: identity?.principal.userId ?? null,
      sessionId: identity?.sessionId ?? null,
      noteId:
        parseDocName(payload.documentName)?.channel === 'note'
          ? (parseDocName(payload.documentName)?.id ?? null)
          : null,
      reason: rejection.auditReason,
      ip: payload.context.ip,
      requestId: payload.context.requestId,
      subject: identity?.sessionId ?? payload.socketId,
    });
  };

  /** Any error that is not a typed marker becomes a refusal: the identity hooks fail closed. */
  const failClosed = (error: unknown): never => {
    if (isHookSignal(error)) throw error;
    deps.logger.error(
      { err: error, event: 'collab.hook.error', hook: 'onAuthenticate' },
      'an identity hook failed unexpectedly and refused the document',
    );
    throw unexpectedRejection(error, 'internal_error');
  };

  // ---- re-validation timers (04 §7.4, §8.7) ----------------------------------------------------

  const jitteredIntervalMs = (): number => {
    const jitter = (random() * 2 - 1) * LIMITS.TOKEN_REVALIDATION_JITTER_MS;
    return Math.max(MS_PER_MINUTE, Math.round(LIMITS.TOKEN_REVALIDATION_MS + jitter));
  };

  const armRevalidation = (connection: Connection<CollabHookContext>): void => {
    const existing = revalidations.get(connection) ?? { interval: null, grace: null };
    existing.interval?.cancel();
    existing.interval = deps.clock.after(jitteredIntervalMs(), () => {
      existing.interval = null;
      connection.requestToken();
      existing.grace?.cancel();
      existing.grace = deps.clock.after(LIMITS.TOKEN_REVALIDATION_GRACE_MS, () => {
        existing.grace = null;
        deps.logger.warn(
          {
            event: 'collab.connection.closed',
            reason: 'unauthorized',
            detail: 'revalidation_grace_elapsed',
          },
          'a connection did not answer the re-validation request inside the grace window',
        );
        connection.readOnly = true;
        connection.close(closeEventFor('unauthorized'));
      });
    });
    revalidations.set(connection, existing);
  };

  const cancelRevalidation = (connection: Connection<CollabHookContext>): void => {
    const timers = revalidations.get(connection);
    if (timers === undefined) return;
    timers.interval?.cancel();
    timers.grace?.cancel();
    revalidations.delete(connection);
  };

  /**
   * A fence may start and finish while an identity/database read is awaiting I/O. The revision
   * catches both that race and a currently blocked command; only these exceptional paths reload a
   * session. A confirmed rollback resumes without closing a still-valid connection.
   */
  const settleCommand = async (identity: Identity, initialRevision: number): Promise<Identity> => {
    let current = identity;
    let revision = initialRevision;
    for (;;) {
      const waiting = deps.sessionFence.wait(current.principal.userId);
      if (waiting !== null) {
        // eslint-disable-next-line no-await-in-loop -- every overlapping barrier must settle
        await waiting;
        continue;
      }
      if (revision === deps.sessionFence.revision) return current;
      revision = deps.sessionFence.revision;
      // eslint-disable-next-line no-await-in-loop -- a command may race this session read too
      current = await reloadIdentity(current.sessionId, current.principal.userId);
    }
  };

  const authorizeStable = async (
    documentName: string,
    identity: Identity,
    trace: { vaultId: VaultId | null },
    denyAs: 'refuse' | 'revoke',
    initialRevision: number,
  ): Promise<{ identity: Identity; authorization: Authorization }> => {
    let current = identity;
    let revision = initialRevision;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- reread only after a real authorization command
      current = await settleCommand(current, revision);
      revision = deps.sessionFence.revision;
      // eslint-disable-next-line no-await-in-loop -- role reads must belong to the same fence revision
      const authorization = await authorizeDocument(documentName, current, trace, denyAs);
      if (
        revision === deps.sessionFence.revision &&
        !deps.sessionFence.blocked(current.principal.userId)
      ) {
        return { identity: current, authorization };
      }
    }
  };

  // ---- the hooks ---------------------------------------------------------------------------------

  const onAuthenticate = async (
    data: onAuthenticatePayload<CollabHookContext>,
  ): Promise<CollabHookContext> => {
    let identity: Identity | null = null;
    const trace: { vaultId: VaultId | null } = { vaultId: null };
    try {
      await deps.faults.delay('auth.slow');
      const revision = deps.sessionFence.revision;
      identity = await identify(data.token);
      const stable = await authorizeStable(data.documentName, identity, trace, 'refuse', revision);
      identity = stable.identity;
      const { authorization } = stable;
      if (countConnectionsOf(identity.principal.userId) >= deps.limits.maxConnectionsPerUser) {
        throw new CollabRejection('rate-limited', { auditReason: 'connections_per_user' });
      }
      deps.channel.set(data, authorization.resolved);
      seedEpochs(identity, authorization);
      data.connectionConfig.readOnly = authorization.readOnly;
      const principal = identity.principal;
      const filled: AuthenticatedContext = {
        sessionId: identity.sessionId,
        userId: principal.userId,
        vaultId: authorization.vaultId,
        noteId: authorization.noteId,
        role: authorization.role,
        isServerAdmin: principal.isServerAdmin,
        authzEpoch: {
          userAuthzVersion: principal.authzVersion,
          memberVersion: authorization.member?.version ?? NO_MEMBERSHIP_VERSION,
        },
        ip: data.context.ip,
        requestId: data.context.requestId,
        connectedAt: data.context.connectedAt,
        clientName: principal.sessionKind,
        clientVersion: readClientVersion(data.requestHeaders),
      };
      // In place, so `IridiumLimits.onAuthenticate` (the next extension of the same event) reads it,
      // and returned, so Hocuspocus merges it into the connection's context.
      Object.assign(data.context, filled);
      deps.logger.info(
        {
          event: 'collab.connection.accepted',
          documentName: data.documentName,
          socketId: data.socketId,
          requestId: data.context.requestId,
          userId: principal.userId,
          role: authorization.role,
          readOnly: authorization.readOnly,
        },
        'a collaboration connection was authenticated',
      );
      return data.context;
    } catch (error) {
      const rejection = isHookSignal(error) && error instanceof CollabRejection ? error : null;
      if (rejection !== null) {
        logRejection(data, rejection, identity, trace.vaultId);
        throw rejection;
      }
      return failClosed(error);
    }
  };

  const onTokenSync = async (data: onTokenSyncPayload<CollabHookContext>): Promise<void> => {
    const connection = data.connection;
    try {
      const current = authenticated(connection.context);
      const revision = deps.sessionFence.revision;
      let identity = await identify(data.token);
      if (identity.principal.userId !== current.userId) {
        throw new CollabRejection('unauthorized', { auditReason: TICKET_SESSION_MISMATCH });
      }
      const stable = await authorizeStable(
        data.documentName,
        identity,
        { vaultId: null },
        'revoke',
        revision,
      );
      identity = stable.identity;
      const { authorization } = stable;
      seedEpochs(identity, authorization);
      const context = connection.context;
      const roleChanged = context.role !== authorization.role;
      context.role = authorization.role;
      context.authzEpoch = {
        userAuthzVersion: identity.principal.authzVersion,
        memberVersion: authorization.member?.version ?? NO_MEMBERSHIP_VERSION,
      };
      context.sessionId = identity.sessionId;
      context.isServerAdmin = identity.principal.isServerAdmin;
      deps.gateway.applyReadOnly(connection, authorization.readOnly);
      if (roleChanged) {
        connection.sendStateless(encodeStateless({ v: 1, t: 'role', role: authorization.role }));
      }
      const timers = revalidations.get(connection);
      timers?.grace?.cancel();
      if (timers !== undefined) timers.grace = null;
      armRevalidation(connection);
    } catch (error) {
      if (error instanceof CollabRejection) {
        deps.logger.warn(
          {
            event: 'collab.connection.closed',
            documentName: data.documentName,
            reason: error.reason,
            detail: error.auditReason,
          },
          're-validation closed a connection',
        );
        throw error;
      }
      return failClosed(error);
    }
  };

  /**
   * The epoch check of 04 §8.6, per message, in constant time; the only database access is the
   * re-authorization on a genuine mismatch, which rewrites both the table and the context so the next
   * message performs no I/O.
   */
  const beforeHandleMessage = async (
    data: beforeHandleMessagePayload<CollabHookContext>,
  ): Promise<void> => {
    const connection = data.connection;
    const context = authenticated(connection.context);
    if (deps.sessionFence.blocked(context.userId)) {
      try {
        await settleCommand(
          {
            sessionId: context.sessionId,
            principal: {
              kind: 'user',
              userId: context.userId,
              sessionId: context.sessionId,
              sessionKind: context.clientName === 'desktop' ? 'desktop' : 'web',
              isServerAdmin: context.isServerAdmin,
              authzVersion: context.authzEpoch.userAuthzVersion,
              lastAuthenticatedAt: new Date(context.connectedAt),
            },
          },
          deps.sessionFence.revision,
        );
      } catch (error) {
        if (isHookSignal(error)) throw error;
        deps.logger.error(
          { err: error, event: 'authz.epoch_mismatch' },
          'session recheck after an authorization barrier failed',
        );
        throw unexpectedRejection(error, 'reauthorize_failed');
      }
    }
    if (context.noteId !== null) {
      const closing = deps.gateway.closingReason(context.noteId);
      if (closing !== null) throw new CollabRejection(closing);
    }
    const header = peekFrame(data.update);
    if (header?.type === FRAME_TYPE.awareness) {
      const entries = decodeAwarenessEntries(data.update, header);
      if (entries === null) return rejectAwareness(connection, context);
      const document = connection.document;
      const ownedClients = document.getClients(connection);
      for (const entry of entries) {
        if (entry.state !== null) {
          validateAwarenessIdentity(connection, context, entry.state);
          if (
            !ownedClients.has(entry.clientId) &&
            (document.awareness.getStates().has(entry.clientId) ||
              document
                .getConnections()
                .some((other) => document.getClients(other).has(entry.clientId)))
          ) {
            rejectAwareness(connection, context);
          }
          continue;
        }
        if (ownedClients.has(entry.clientId)) continue;
        const metadata = document.awareness.meta.get(entry.clientId);
        // A repeated or stale removal of an already absent id is a no-op. A fresh foreign
        // tombstone would poison its clock and suppress that participant's future presence.
        if (
          !document.awareness.getStates().has(entry.clientId) &&
          metadata !== undefined &&
          entry.clock <= metadata.clock
        ) {
          continue;
        }
        rejectAwareness(connection, context);
      }
    }
    if (!deps.epochs.isStale(context)) return;
    try {
      await reauthorizeConnection(connection, context);
    } catch (error) {
      if (isHookSignal(error)) throw error;
      deps.logger.error(
        { err: error, event: 'authz.epoch_mismatch', documentName: data.documentName },
        're-authorizing a stale connection failed; the connection is closed',
      );
      throw unexpectedRejection(error, 'reauthorize_failed');
    }
  };

  /** Steps 4 to 6 again, from the database, writing the table and the context (04 §8.6). */
  const reauthorizeConnection = async (
    connection: Connection<CollabHookContext>,
    context: AuthenticatedContext,
    whileFenced = false,
  ): Promise<void> => {
    const revision = deps.sessionFence.revision;
    const user = await deps.reads.userAuthz(context.userId);
    if (user === null || user.status !== 'active') {
      throw new CollabRejection('revoked', { auditReason: 'user_inactive' });
    }
    const parsed = parseDocName(connection.document.name);
    if (parsed === null) throw new CollabRejection('protocol-error');
    const refreshed = await deps.reads.resolveAuthorization(context);
    if (refreshed === null) throw new CollabRejection('note-not-found');
    const { resolved, member } = refreshed;
    if (resolved.kind === 'note' && resolved.initializedAt === null)
      throw new CollabRejection('note-not-found');
    if (resolved.kind === 'note' && resolved.deletedAt !== null)
      throw new CollabRejection('note-trashed');
    if (resolved.vaultStatus === 'archived') throw new CollabRejection('vault-archived');
    const principal: UserPrincipal = {
      kind: 'user',
      userId: context.userId,
      sessionId: context.sessionId,
      sessionKind: context.clientName === 'desktop' ? 'desktop' : 'web',
      isServerAdmin: user.isServerAdmin,
      authzVersion: user.authzVersion,
      lastAuthenticatedAt: new Date(context.connectedAt),
    };
    const read = await deps.authorizeDetailed(
      principal,
      parsed.channel === 'note' ? 'note:read' : 'vault:read',
      { vaultId: resolved.vault.id, vault: resolved.vault, member, surface: 'collab' },
    );
    if (read.decision !== 'allow')
      throw new CollabRejection('revoked', { auditReason: `deny_${read.decision.deny}` });
    let readOnly = true;
    if (parsed.channel === 'note') {
      const write = await deps.authorize(principal, 'note:write', {
        vaultId: resolved.vault.id,
        vault: resolved.vault,
        member: read.member,
        surface: 'collab',
      });
      readOnly = write !== 'allow';
    }
    if (
      revision !== deps.sessionFence.revision ||
      (!whileFenced && deps.sessionFence.blocked(context.userId))
    ) {
      if (!whileFenced) await settleCommand({ sessionId: context.sessionId, principal }, revision);
      return reauthorizeConnection(connection, context, whileFenced);
    }
    const role = read.member?.role ?? 'manager';
    const memberVersion = read.member?.version ?? NO_MEMBERSHIP_VERSION;
    deps.epochs.user(principal.userId, user.authzVersion);
    deps.epochs.member(resolved.vault.id, principal.userId, memberVersion);
    const live = connection.context;
    const roleChanged = live.role !== role;
    live.role = role;
    live.authzEpoch = { userAuthzVersion: user.authzVersion, memberVersion };
    live.isServerAdmin = principal.isServerAdmin;
    deps.gateway.applyReadOnly(connection, readOnly);
    if (roleChanged) connection.sendStateless(encodeStateless({ v: 1, t: 'role', role }));
    deps.logger.info(
      {
        event: 'authz.epoch_mismatch',
        documentName: connection.document.name,
        userId: principal.userId,
        role,
      },
      'a stale connection was re-authorized from the database',
    );
  };

  const rejectAwareness = (
    connection: Connection<CollabHookContext>,
    context: AuthenticatedContext,
  ): never => {
    deps.logger.warn(
      {
        event: 'collab.awareness.spoof',
        documentName: connection.document.name,
        userId: context.userId,
      },
      'an awareness frame carried another identity, an unowned client id, or an unknown shape',
    );
    void deps.audit.record({
      action: 'collab.write.rejected',
      vaultId: context.vaultId,
      userId: context.userId,
      sessionId: context.sessionId,
      noteId: context.noteId,
      reason: 'awareness_spoof',
      ip: context.ip,
      requestId: context.requestId,
      subject: connection.socketId,
    });
    // The recorded S2 fallback: the throw closes the document connection, and so does this.
    connection.readOnly = true;
    connection.close(closeEventFor('awareness-spoof'));
    throw new CollabRejection('awareness-spoof');
  };

  const validateAwarenessIdentity = (
    connection: Connection<CollabHookContext>,
    context: AuthenticatedContext,
    state: unknown,
  ): AwarenessState | VaultAwarenessState => {
    const schema = context.noteId === null ? VaultAwarenessState : AwarenessState;
    const parsed = schema.safeParse(state);
    if (!parsed.success || parsed.data.user.id !== context.userId) {
      return rejectAwareness(connection, context);
    }
    return parsed.data;
  };

  /** Identity and shape validation of every awareness state (04 §6.4 (4); 05, "Awareness"). */
  const beforeHandleAwareness = async (
    data: beforeHandleAwarenessPayload<CollabHookContext>,
  ): Promise<void> => {
    if (parseDocName(data.documentName)?.channel !== 'note') return;
    const connection = data.connection;
    if (connection === undefined) return;
    const context = authenticated(connection.context);
    for (const state of data.states.values()) {
      const parsed = validateAwarenessIdentity(connection, context, state);
      deps.gateway.setMode(
        data.documentName,
        context.userId,
        'mode' in parsed ? parsed.mode : undefined,
      );
    }
  };
  const connected = async (data: connectedPayload<CollabHookContext>): Promise<void> => {
    const connection = data.connection;
    const context = authenticated(connection.context);
    deps.epochs.retain(context.userId);
    armRevalidation(connection);
    const identity = (await deps.reads.participantIdentity(context.userId)) ?? UNKNOWN_PARTICIPANT;
    deps.gateway.join(connection.document, context, identity);
  };

  const onDisconnect = async (data: onDisconnectPayload<CollabHookContext>): Promise<void> => {
    const context = data.context;
    if (context.userId === undefined) return;
    deps.epochs.release(context.userId);
    // The connection object is not in this payload; its timers are keyed by it and cancelled when
    // the document's remaining connections are walked below.
    const connections: Connection<CollabHookContext>[] = data.document.getConnections();
    for (const connection of connections) {
      if (connection.context === context) cancelRevalidation(connection);
    }
    try {
      deps.gateway.leave(data.document, authenticated(context));
    } catch {
      // A connection that never reached `connected` has no participant entry.
    }
    deps.logger.info(
      {
        event: 'collab.connection.closed',
        documentName: data.documentName,
        socketId: data.socketId,
        userId: context.userId,
      },
      'a collaboration connection closed',
    );
  };

  // Recovery of a REST transaction whose COMMIT reply was lost must inspect each connection's
  // own session, even if another connection already reseeded the shared user epoch. Known denial
  // closes; an unavailable database propagates so the caller retains the admission fence.
  deps.gateway.bindReauthorization(async (connection) => {
    const context = authenticated(connection.context);
    for (;;) {
      const revision = deps.sessionFence.revision;
      try {
        // eslint-disable-next-line no-await-in-loop -- repeat if another mutation crosses these reads
        await reloadIdentity(context.sessionId, context.userId);
        // eslint-disable-next-line no-await-in-loop -- fresh user and membership policy under the fence
        await reauthorizeConnection(connection, context, true);
      } catch (error) {
        if (!(error instanceof CollabRejection)) throw error;
        connection.readOnly = true;
        connection.close(closeEventFor(error.reason));
        return;
      }
      if (revision === deps.sessionFence.revision) return;
    }
  });

  return {
    extensionName: 'IridiumAuth',
    onAuthenticate: safeHook('onAuthenticate', onAuthenticate, hookDeps),
    onTokenSync: safeHook('onTokenSync', onTokenSync, hookDeps),
    beforeHandleMessage: safeHook('beforeHandleMessage', beforeHandleMessage, hookDeps),
    beforeHandleAwareness: safeHook('beforeHandleAwareness', beforeHandleAwareness, hookDeps),
    connected: safeHook('connected', connected, hookDeps),
    onDisconnect: safeHook('onDisconnect', onDisconnect, hookDeps),
  };
}

/** `X-Iridium-Client-Version` on the upgrade, or `null`; the session row does not carry it. */
function readClientVersion(headers: Headers): string | null {
  const value = headers.get('x-iridium-client-version');
  return value === null || value === '' ? null : value;
}
