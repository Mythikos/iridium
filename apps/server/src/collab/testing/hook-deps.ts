/**
 * The world the hook unit suites authenticate against: users, vaults, memberships, notes and
 * sessions as rows in maps, with the **real** authorizer, ticket store, epoch table and gateway
 * over them. Only the two I/O ports — `CollabReads` and `loadLiveSession` — are doubles, so a suite
 * exercises the product's own decision code (`decide()`, the epoch tuple, the ticket single-use
 * rule) and not a re-statement of it.
 *
 * The payload builders produce the exact Hocuspocus 4.7 shapes, over a real `Document` and a real
 * `Connection` whose socket records what was sent. `instance` is the one member no hook reads; it is
 * the value below rather than a `Hocuspocus`, because `guards.one-boot-path.guard` allows exactly
 * one construction site in the tree.
 */
import type {
  afterLoadDocumentPayload,
  afterUnloadDocumentPayload,
  beforeHandleAwarenessPayload,
  beforeHandleMessagePayload,
  beforeUnloadDocumentPayload,
  connectedPayload,
  Connection,
  Document,
  Extension,
  Hocuspocus,
  onAuthenticatePayload,
  onDisconnectPayload,
  onLoadDocumentPayload,
  onStatelessPayload,
  onStoreDocumentPayload,
  onTokenSyncPayload,
} from '@hocuspocus/server';
import {
  LIMITS,
  newId,
  NoteId,
  SessionId,
  UserId,
  VaultId,
  type Role,
  type UserPrincipal,
} from '@iridium/contracts';

import { ManualClock } from '../../../test/support/manual-clock.ts';
import type { LiveSessionCheck, SessionDeadReason } from '../../auth/sessions/verify.ts';
import { InMemoryTicketStore } from '../../auth/tickets/store.ts';
import { createAuthorizer, type Authorizer, type MembershipLookup } from '../../authz/authorize.ts';
import { EpochTable } from '../../authz/epochs.ts';
import { SessionCommandFence } from '../../authz/session-command-fence.ts';
import type { NodeKind, UserStatus, VaultStatus } from '../../db/schema.ts';
import { createMetrics } from '../../ops/metrics.ts';
import type { CollabAuditEvent } from '../audit.ts';
import type { AuthenticatedContext, CollabHookContext } from '../context.ts';
import { CollabGateway } from '../gateway.ts';
import type { AuthExtensionDeps } from '../hooks/auth.ts';
import {
  ResolutionChannel,
  type CollabReads,
  type ParticipantIdentity,
  type ResolvedNote,
  type ResolvedVault,
  type UserAuthzRow,
} from '../hooks/resolution.ts';
import type { CollabMetrics } from '../metrics.ts';
import { recordingLogger, type RecordingLogger } from '../persistence/testing/harness.ts';
import { COLLAB_HOOK_NAMES, type CollabHookName } from '../safe-hook.ts';
import { fakeGatewayServer } from './fake-hocuspocus.ts';

/** Where every world starts; suites advance the clock from here. */
export const WORLD_START = '2026-09-14T12:00:00.000Z';

/** The step-up window the world's authorizer runs with. */
const STEP_UP_WINDOW_MS = 600_000;

/** How often the ticket store sweeps; irrelevant to the suites, which never let it fire. */
const TICKET_SWEEP_MS = 10_000;

export interface WorldUser {
  status: UserStatus;
  authzVersion: number;
  isServerAdmin: boolean;
  name: string;
  colorHue: number;
}

export interface WorldVault {
  status: VaultStatus;
  mcpEnabled: boolean;
}

export interface WorldMember {
  role: Role;
  version: number;
}

export interface WorldNote {
  vaultId: VaultId;
  nodeKind: NodeKind;
  deletedAt: Date | null;
  initializedAt: Date | null;
  snapshotSize: number;
}

/** The audit sink the suites hand the hooks: it records instead of writing a row. */
export interface RecordingAudit {
  readonly events: CollabAuditEvent[];
  record(event: CollabAuditEvent): Promise<boolean>;
}

export function recordingAudit(): RecordingAudit {
  const events: CollabAuditEvent[] = [];
  return {
    events,
    record: async (event): Promise<boolean> => {
      events.push(event);
      return true;
    },
  };
}

function memberKey(vaultId: VaultId, userId: UserId): string {
  return `${vaultId}|${userId}`;
}

/** The rows and the product components that read them. */
export class FakeWorld {
  readonly clock: ManualClock;
  readonly users = new Map<UserId, WorldUser>();
  readonly vaults = new Map<VaultId, WorldVault>();
  readonly members = new Map<string, WorldMember>();
  readonly notes = new Map<NoteId, WorldNote>();
  readonly sessions = new Map<SessionId, LiveSessionCheck>();
  readonly tickets: InMemoryTicketStore;
  readonly epochs = new EpochTable();
  readonly sessionFence = new SessionCommandFence();
  readonly authorizer: Authorizer;
  readonly reads: CollabReads;
  /** Every `CollabReads` call, by method name, for the steady-state assertions. */
  readonly readLog: string[] = [];
  /** When set, every read throws it: the "dbApp is not connected" case. */
  readsFailure: Error | null = null;

  constructor(clock: ManualClock = new ManualClock(Date.parse(WORLD_START))) {
    this.clock = clock;
    this.tickets = new InMemoryTicketStore({
      clock,
      ttlMs: LIMITS.TICKET_TTL_S * 1000,
      sweepIntervalMs: TICKET_SWEEP_MS,
    });
    const lookup: MembershipLookup = async (vaultId, userId) => {
      const vault = this.vaults.get(vaultId);
      if (vault === undefined) return { vault: null, member: null };
      const parsed = UserId.safeParse(userId);
      const member = parsed.success ? this.members.get(memberKey(vaultId, parsed.data)) : undefined;
      return {
        vault: { id: vaultId, status: vault.status, mcp_enabled: vault.mcpEnabled },
        member: member === undefined ? null : { role: member.role, version: member.version },
      };
    };
    this.authorizer = createAuthorizer({
      lookup,
      now: () => clock.now(),
      stepUpWindowMs: STEP_UP_WINDOW_MS,
      mcpServerEnabled: () => true,
    });
    this.reads = {
      resolveNote: async (noteId): Promise<ResolvedNote | null> => {
        this.#read('resolveNote');
        const parsed = NoteId.safeParse(noteId);
        const note = parsed.success ? this.notes.get(parsed.data) : undefined;
        if (note === undefined) return null;
        const vault = this.vaults.get(note.vaultId);
        if (vault === undefined) return null;
        return {
          kind: 'note',
          vault: { id: note.vaultId, status: vault.status, mcp_enabled: vault.mcpEnabled },
          vaultStatus: vault.status,
          nodeKind: note.nodeKind,
          deletedAt: note.deletedAt,
          initializedAt: note.initializedAt,
          snapshotSize: note.snapshotSize,
        };
      },
      resolveVault: async (vaultId): Promise<ResolvedVault | null> => {
        this.#read('resolveVault');
        const parsed = VaultId.safeParse(vaultId);
        const vault = parsed.success ? this.vaults.get(parsed.data) : undefined;
        if (vault === undefined || !parsed.success) return null;
        return {
          kind: 'vault',
          vault: { id: parsed.data, status: vault.status, mcp_enabled: vault.mcpEnabled },
          vaultStatus: vault.status,
        };
      },
      userAuthz: async (userId): Promise<UserAuthzRow | null> => {
        this.#read('userAuthz');
        const user = this.users.get(userId);
        return user === undefined
          ? null
          : {
              authzVersion: user.authzVersion,
              status: user.status,
              isServerAdmin: user.isServerAdmin,
            };
      },
      resolveAuthorization: async (target) => {
        this.#read('resolveAuthorization');
        const vault = this.vaults.get(target.vaultId);
        if (vault === undefined) return null;
        const shared = {
          vault: { id: target.vaultId, status: vault.status, mcp_enabled: vault.mcpEnabled },
          vaultStatus: vault.status,
        };
        const note = target.noteId === null ? null : this.notes.get(target.noteId);
        if (target.noteId !== null && (note === undefined || note?.vaultId !== target.vaultId))
          return null;
        const resolved: ResolvedNote | ResolvedVault =
          note === null || note === undefined
            ? { kind: 'vault', ...shared }
            : {
                kind: 'note',
                ...shared,
                nodeKind: note.nodeKind,
                deletedAt: note.deletedAt,
                initializedAt: note.initializedAt,
                snapshotSize: note.snapshotSize,
              };
        const member = this.members.get(memberKey(target.vaultId, target.userId));
        return { resolved, member: member ?? null };
      },
      participantIdentity: async (userId): Promise<ParticipantIdentity | null> => {
        this.#read('participantIdentity');
        const user = this.users.get(userId);
        return user === undefined ? null : { name: user.name, colorHue: user.colorHue };
      },
    };
  }

  #read(method: string): void {
    this.readLog.push(method);
    if (this.readsFailure !== null) throw this.readsFailure;
  }

  user(overrides: Partial<WorldUser> = {}): UserId {
    const id = UserId.parse(newId());
    this.users.set(id, {
      status: 'active',
      authzVersion: 1,
      isServerAdmin: false,
      name: `user-${id.slice(-4)}`,
      colorHue: this.users.size * 37,
      ...overrides,
    });
    return id;
  }

  vault(overrides: Partial<WorldVault> = {}): VaultId {
    const id = VaultId.parse(newId());
    this.vaults.set(id, { status: 'active', mcpEnabled: true, ...overrides });
    return id;
  }

  member(vaultId: VaultId, userId: UserId, role: Role, version = 1): void {
    this.members.set(memberKey(vaultId, userId), { role, version });
  }

  removeMember(vaultId: VaultId, userId: UserId): void {
    this.members.delete(memberKey(vaultId, userId));
  }

  memberOf(vaultId: VaultId, userId: UserId): WorldMember | undefined {
    return this.members.get(memberKey(vaultId, userId));
  }

  note(vaultId: VaultId, overrides: Partial<Omit<WorldNote, 'vaultId'>> = {}): NoteId {
    const id = NoteId.parse(newId());
    this.notes.set(id, {
      vaultId,
      nodeKind: 'note',
      deletedAt: null,
      initializedAt: this.clock.date(),
      snapshotSize: 0,
      ...overrides,
    });
    return id;
  }

  /** A live session of `userId`, as `loadLiveSession` would answer it. */
  session(userId: UserId, overrides: Partial<UserPrincipal> = {}): SessionId {
    const id = SessionId.parse(newId());
    const user = this.users.get(userId);
    this.sessions.set(id, {
      kind: 'user',
      userId,
      sessionId: id,
      sessionKind: 'web',
      isServerAdmin: user?.isServerAdmin ?? false,
      authzVersion: user?.authzVersion ?? 1,
      lastAuthenticatedAt: this.clock.date(),
      ...overrides,
    });
    return id;
  }

  deadSession(dead: SessionDeadReason): SessionId {
    const id = SessionId.parse(newId());
    this.sessions.set(id, { dead });
    return id;
  }

  /** One single-use ticket bound to the session and the user. */
  ticket(sessionId: SessionId, userId: UserId): string {
    const [ticket] = this.tickets.issue({ sessionId, userId }, 1);
    if (ticket === undefined) throw new Error('the ticket store issued nothing');
    return ticket;
  }

  /** A live session and a ticket for it, the ordinary way a connection authenticates. */
  credentials(userId: UserId): { readonly sessionId: SessionId; readonly ticket: string } {
    const sessionId = this.session(userId);
    return { sessionId, ticket: this.ticket(sessionId, userId) };
  }
}

/** Everything a hook suite reads back after driving the extension. */
export interface HookHarness {
  readonly world: FakeWorld;
  readonly clock: ManualClock;
  readonly logger: RecordingLogger;
  readonly audit: RecordingAudit;
  readonly metrics: CollabMetrics;
  readonly documents: Map<string, Document>;
  readonly gateway: CollabGateway;
  readonly channel: ResolutionChannel;
  /** The fault-delay points the hooks awaited, in order. */
  readonly delays: string[];
  readonly deps: AuthExtensionDeps;
}

export interface HookHarnessOptions {
  readonly world?: FakeWorld;
  readonly maxConnectionsPerUser?: number;
  readonly random?: () => number;
  /** Resolves a delay point; the default resolves at once. */
  readonly delay?: (point: string) => Promise<void>;
}

/** The dependencies of `createAuthExtension`, over the world. */
export function hookHarness(options: HookHarnessOptions = {}): HookHarness {
  const world = options.world ?? new FakeWorld();
  const logger = recordingLogger();
  const audit = recordingAudit();
  const metrics: CollabMetrics = createMetrics(world.clock.now());
  const documents = new Map<string, Document>();
  const gateway = new CollabGateway({
    clock: world.clock,
    logger,
    authorize: world.authorizer.authorize,
    reads: world.reads,
    applyWriterLatches: () => undefined,
    principalBlocked: (userId) => world.sessionFence.blocked(userId),
  });
  gateway.bind(fakeGatewayServer(documents));
  world.sessionFence.subscribe((userId) => gateway.refreshPrincipalFence(userId));
  const channel = new ResolutionChannel();
  const delays: string[] = [];
  const deps: AuthExtensionDeps = {
    tickets: world.tickets,
    sessions: {
      loadLiveSession: async (sessionId) => world.sessions.get(sessionId) ?? null,
    },
    authorize: world.authorizer.authorize,
    authorizeDetailed: world.authorizer.authorizeDetailed,
    epochs: world.epochs,
    sessionFence: world.sessionFence,
    reads: world.reads,
    gateway,
    audit,
    channel,
    clock: world.clock,
    logger,
    faults: {
      delay: async (point): Promise<void> => {
        delays.push(point);
        await options.delay?.(point);
      },
    },
    limits: { maxConnectionsPerUser: options.maxConnectionsPerUser ?? LIMITS.CONNECTIONS_PER_USER },
    documents: () => documents,
    metrics: () => metrics,
    ...(options.random === undefined ? {} : { random: options.random }),
  };
  return {
    world,
    clock: world.clock,
    logger,
    audit,
    metrics,
    documents,
    gateway,
    channel,
    delays,
    deps,
  };
}

// ---- payloads ----------------------------------------------------------------------------------

/**
 * The `instance` member of every payload. No Iridium hook reads it, and the one construction site
 * of a `Hocuspocus` is the collab plugin's (`guards.one-boot-path.guard`).
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hooks never dereference `instance`; see above
export const NO_INSTANCE: Hocuspocus = null as unknown as Hocuspocus;

const REQUEST_URL = 'http://127.0.0.1/collab';

/** What `handleConnection` seeds before `onAuthenticate`. */
export function preAuthContext(
  clock: ManualClock,
  overrides: Partial<CollabHookContext> = {},
): CollabHookContext {
  return { ip: '203.0.113.7', requestId: newId(), connectedAt: clock.now(), ...overrides };
}

/** A filled context, as a hook after `onAuthenticate` sees it. */
export function authenticatedContext(
  clock: ManualClock,
  fields: {
    readonly userId: UserId;
    readonly sessionId: SessionId;
    readonly vaultId: VaultId;
    readonly noteId: NoteId | null;
    readonly role?: Role;
    readonly isServerAdmin?: boolean;
    readonly authzEpoch?: AuthenticatedContext['authzEpoch'];
  },
): CollabHookContext {
  return {
    ...preAuthContext(clock),
    userId: fields.userId,
    sessionId: fields.sessionId,
    vaultId: fields.vaultId,
    noteId: fields.noteId,
    role: fields.role ?? 'editor',
    isServerAdmin: fields.isServerAdmin ?? false,
    authzEpoch: fields.authzEpoch ?? { userAuthzVersion: 1, memberVersion: 1 },
    clientName: 'web',
    clientVersion: null,
  };
}

export function authenticatePayload(o: {
  readonly documentName: string;
  readonly token: string;
  readonly context: CollabHookContext;
  readonly headers?: Readonly<Record<string, string>>;
  readonly socketId?: string;
}): onAuthenticatePayload<CollabHookContext> {
  const request = new Request(REQUEST_URL, { headers: o.headers ?? {} });
  return {
    context: o.context,
    documentName: o.documentName,
    instance: NO_INSTANCE,
    requestHeaders: request.headers,
    requestParameters: new URLSearchParams(),
    request,
    socketId: o.socketId ?? newId(),
    token: o.token,
    connectionConfig: { readOnly: false, isAuthenticated: false },
    providerVersion: null,
  };
}

export function tokenSyncPayload(
  connection: Connection<CollabHookContext>,
  token: string,
): onTokenSyncPayload<CollabHookContext> {
  return {
    context: connection.context,
    document: connection.document,
    documentName: connection.document.name,
    instance: NO_INSTANCE,
    requestHeaders: connection.request.headers,
    requestParameters: new URLSearchParams(),
    socketId: connection.socketId,
    token,
    connectionConfig: { readOnly: connection.readOnly, isAuthenticated: true },
    connection,
  };
}

export function messagePayload(
  connection: Connection<CollabHookContext>,
  update: Uint8Array,
): beforeHandleMessagePayload<CollabHookContext> {
  return {
    clientsCount: connection.document.getConnectionsCount(),
    context: connection.context,
    document: connection.document,
    documentName: connection.document.name,
    instance: NO_INSTANCE,
    requestHeaders: connection.request.headers,
    requestParameters: new URLSearchParams(),
    update,
    socketId: connection.socketId,
    connection,
  };
}

export function awarenessPayload(
  connection: Connection<CollabHookContext>,
  states: Map<number, Record<string, unknown>>,
): beforeHandleAwarenessPayload<CollabHookContext> {
  return {
    awareness: connection.document.awareness,
    clientsCount: connection.document.getConnectionsCount(),
    context: connection.context,
    document: connection.document,
    documentName: connection.document.name,
    instance: NO_INSTANCE,
    requestHeaders: connection.request.headers,
    requestParameters: new URLSearchParams(),
    states,
    socketId: connection.socketId,
    transactionOrigin: { source: 'connection', connection },
    connection,
  };
}

export function connectedPayloadFor(
  connection: Connection<CollabHookContext>,
): connectedPayload<CollabHookContext> {
  return {
    context: connection.context,
    documentName: connection.document.name,
    instance: NO_INSTANCE,
    request: connection.request,
    requestHeaders: connection.request.headers,
    requestParameters: new URLSearchParams(),
    socketId: connection.socketId,
    connectionConfig: { readOnly: connection.readOnly, isAuthenticated: true },
    connection,
    providerVersion: null,
  };
}

export function disconnectPayload(
  connection: Connection<CollabHookContext>,
): onDisconnectPayload<CollabHookContext> {
  return {
    clientsCount: connection.document.getConnectionsCount(),
    context: connection.context,
    document: connection.document,
    documentName: connection.document.name,
    instance: NO_INSTANCE,
    requestHeaders: connection.request.headers,
    requestParameters: new URLSearchParams(),
    socketId: connection.socketId,
  };
}

export function loadPayload(
  document: Document,
  context: CollabHookContext,
): onLoadDocumentPayload<CollabHookContext> {
  return {
    context,
    document,
    documentName: document.name,
    instance: NO_INSTANCE,
    requestHeaders: new Headers(),
    requestParameters: new URLSearchParams(),
    socketId: newId(),
    connectionConfig: { readOnly: false, isAuthenticated: true },
  };
}

export function afterLoadPayload(
  document: Document,
  context: CollabHookContext,
): afterLoadDocumentPayload<CollabHookContext> {
  return loadPayload(document, context);
}

export function statelessPayload(
  connection: Connection<CollabHookContext>,
  payload: string,
): onStatelessPayload {
  return {
    connection,
    documentName: connection.document.name,
    document: connection.document,
    payload,
  };
}

export function storePayload(
  document: Document,
  context: CollabHookContext,
  clientsCount = document.getConnectionsCount(),
): onStoreDocumentPayload<CollabHookContext> {
  return {
    clientsCount,
    document,
    lastContext: context,
    lastTransactionOrigin: null,
    documentName: document.name,
    instance: NO_INSTANCE,
  };
}

export function beforeUnloadPayload(document: Document): beforeUnloadDocumentPayload {
  return { instance: NO_INSTANCE, documentName: document.name, document };
}

export function afterUnloadPayload(documentName: string): afterUnloadDocumentPayload {
  return { instance: NO_INSTANCE, documentName };
}

// ---- invoking a hook ---------------------------------------------------------------------------

/**
 * The registered hook of an extension as a plain async function, or an error naming the missing one.
 * Read through `Reflect` rather than as a property, because `Extension` declares its hooks as method
 * signatures and a detached method reference is what `unbound-method` exists to refuse.
 */
export function hookOf(
  extension: Extension<CollabHookContext>,
  name: CollabHookName,
): (payload: unknown) => Promise<unknown> {
  const fn: unknown = Reflect.get(extension, name);
  if (typeof fn !== 'function') {
    throw new Error(`${extension.extensionName ?? 'the extension'} registers no ${name} hook`);
  }
  return async (payload: unknown): Promise<unknown> => {
    const result: unknown = Reflect.apply(fn, extension, [payload]);
    return result;
  };
}

/** Which of the twelve Iridium hook names an extension registers. */
export function registeredHooks(extension: Extension<CollabHookContext>): CollabHookName[] {
  return COLLAB_HOOK_NAMES.filter((name) => typeof Reflect.get(extension, name) === 'function');
}
