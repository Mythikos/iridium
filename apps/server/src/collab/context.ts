/**
 * The connection context as the hooks see it (09-api-reference.md §3.2; 05-collaboration-and-durability.md,
 * "Connection context and document names").
 *
 * `IridiumCollabContext` is the wire contract's complete member list, and a hook that runs after
 * `onAuthenticate` reads it typed — here with the branded ids the server's own modules take, which
 * are subtypes of the contract's strings. Before that hook, Hocuspocus carries only what
 * `handleConnection` seeded — the peer address, the request id and the connect instant — so the
 * generic the server is built with is the honest union of the two phases, and `authenticated()` is
 * the one narrowing every later hook performs. A missing member there is a bug in the hook order,
 * reported as `unauthorized` rather than as an `undefined` deep inside a writer.
 *
 * Four members are mutable on purpose: `onTokenSync`, the epoch re-authorization and
 * `CollabGateway.changeRole` rewrite the role, the epoch tuple, the session and the admin flag on a
 * live connection (04 §8.4, §8.6, §8.7), and a Hocuspocus context is a mutable object by design.
 */
import type {
  AuthzEpoch,
  IridiumCollabContext,
  NoteId,
  Role,
  SessionId,
  UserId,
  VaultId,
} from '@iridium/contracts';

import type { OwnerGeneration } from './owner-lease.ts';
import { CollabRejection } from './rejection.ts';

/** What `handleConnection` seeds, before `onAuthenticate` fills the rest. */
export interface PreAuthContext {
  readonly ip: string;
  readonly requestId: string;
  readonly connectedAt: number;
  /** The owner lifetime captured by the WebSocket upgrade, never replaced during reauthorization. */
  readonly ownerGeneration?: OwnerGeneration;
}

/**
 * The members every hook after `onAuthenticate` reads: the wire contract, with branded ids. A
 * readonly snapshot — a hook that rewrites the role, the epoch tuple, the session or the admin flag
 * on a live connection (04 §8.4, §8.6, §8.7) writes `connection.context`, the object Hocuspocus
 * carries, never this view.
 */
export interface AuthenticatedContext extends PreAuthContext, IridiumCollabContext {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly vaultId: VaultId;
  readonly noteId: NoteId | null;
  readonly role: Role;
  readonly isServerAdmin: boolean;
  readonly authzEpoch: AuthzEpoch;
  readonly clientName: string | null;
  readonly clientVersion: string | null;
}

/** The connection's own context object, with the four members a live re-authorization rewrites. */
export type MutableAuthenticatedFields = {
  -readonly [K in 'sessionId' | 'role' | 'isServerAdmin' | 'authzEpoch']: AuthenticatedContext[K];
};

/** The origin context of a server-originated edit (04 §6.9; 05, "Document model" origin table). */
export interface ServerEditOrigin {
  readonly reason: 'restore' | 'import' | 'repair';
  readonly revisionId?: number;
}

/**
 * The Hocuspocus context generic: the seeded members always present, the wire context's members after
 * authentication (the four re-authorization writes mutable, the identity readonly), and — on a
 * `DirectConnection` only — the server-edit origin the writer maps to `note_updates.origin`.
 */
export type CollabHookContext = PreAuthContext &
  Partial<Omit<AuthenticatedContext, keyof PreAuthContext | keyof MutableAuthenticatedFields>> &
  Partial<MutableAuthenticatedFields> &
  Partial<ServerEditOrigin>;

/**
 * Narrows a hook context to the authenticated shape.
 *
 * @throws CollabRejection `unauthorized` when the context was never filled — a hook order bug, never
 * a client condition.
 */
export function authenticated(context: CollabHookContext | undefined): AuthenticatedContext {
  if (
    context === undefined ||
    context.sessionId === undefined ||
    context.userId === undefined ||
    context.vaultId === undefined ||
    context.noteId === undefined ||
    context.role === undefined ||
    context.isServerAdmin === undefined ||
    context.authzEpoch === undefined ||
    context.clientName === undefined ||
    context.clientVersion === undefined
  ) {
    throw new CollabRejection('unauthorized', { auditReason: 'context_missing' });
  }
  return {
    sessionId: context.sessionId,
    userId: context.userId,
    vaultId: context.vaultId,
    noteId: context.noteId,
    role: context.role,
    isServerAdmin: context.isServerAdmin,
    authzEpoch: context.authzEpoch,
    ip: context.ip,
    requestId: context.requestId,
    connectedAt: context.connectedAt,
    clientName: context.clientName,
    clientVersion: context.clientVersion,
  };
}
