/**
 * The typed markers a hook throws to make Hocuspocus refuse, close or veto
 * (09-api-reference.md §3.8; 05-collaboration-and-durability.md, "Instance configuration").
 *
 * Hocuspocus 4.7.0 reads two fields off a rejected hook promise: `onAuthenticate` sends
 * `PermissionDenied(error.reason)` for that document, `beforeHandleMessage` and `onTokenSync` call
 * `connection.close({ code: error.code, reason: error.reason })`, and `beforeUnloadDocument` treats
 * any rejection as a veto. Every one of those is a *signal*, not a failure, so the markers are the
 * only values `safeHook` lets escape a hook body — anything else is logged, counted and swallowed
 * (D14-09). The reason vocabulary and the code each reason travels with are `@iridium/contracts`',
 * so a hook cannot invent a close reason the client state machine does not key on.
 */
import { SkipFurtherHooksError } from '@hocuspocus/common';
import { COLLAB_CLOSE_CODES, type CollabCloseReason } from '@iridium/contracts';

/** The base of every value a hook may throw on purpose. `safeHook` rethrows these and nothing else. */
export abstract class HookSignal extends Error {}

/** "Refuse this document", carrying the reason a client keys on and the code a socket close carries. */
export class CollabRejection extends HookSignal {
  readonly reason: CollabCloseReason;
  readonly code: number;
  /** A short machine word for the audit row's `reason`, defaulting to the close reason. */
  readonly auditReason: string;

  constructor(reason: CollabCloseReason, options: { readonly auditReason?: string } = {}) {
    super(`collab: ${reason}`);
    this.name = 'CollabRejection';
    this.reason = reason;
    this.code = COLLAB_CLOSE_CODES[reason];
    this.auditReason = options.auditReason ?? reason;
  }
}

/** "Do not unload yet": the `beforeUnloadDocument` veto, with the condition that held. */
export class UnloadVeto extends HookSignal {
  readonly condition: string;

  constructor(condition: string) {
    super(`unload vetoed: ${condition}`);
    this.name = 'UnloadVeto';
    this.condition = condition;
  }
}

/**
 * "The store did not complete": the `onStoreDocument` rejection that keeps a document in memory. It
 * wraps the writer's own error so Hocuspocus's "Document stays in memory to avoid data loss" line
 * carries the real cause.
 */
export class StoreRejected extends HookSignal {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(`store rejected: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'StoreRejected';
    this.cause = cause;
  }
}

/**
 * Whether a thrown value is one of the markers — or Hocuspocus's own `SkipFurtherHooksError`, the
 * one library value a hook throws on purpose: the vault channel's `onStoreDocument` ends the store
 * chain with it, and `storeDocumentHooks` recognises it by `instanceof` (12-milestones.md §5.2).
 */
export function isHookSignal(value: unknown): value is HookSignal | SkipFurtherHooksError {
  return value instanceof HookSignal || value instanceof SkipFurtherHooksError;
}

/** The `{ code, reason }` a per-document close carries for a reason (09 §3.6). */
export function closeEventFor(reason: CollabCloseReason): {
  code: number;
  reason: CollabCloseReason;
} {
  return { code: COLLAB_CLOSE_CODES[reason], reason };
}
