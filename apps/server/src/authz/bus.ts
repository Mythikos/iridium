/**
 * `AuthzBus` — turning a committed database change into an action on live connections
 * (04-auth-and-access-control.md section 8.3; D04-14; ARCH-19; HP-3).
 *
 * **Publish after COMMIT, never inside the transaction.** A service collects the events its
 * transaction will justify and publishes them once `execute()` resolved; publishing inside the
 * transaction would close a user's connections for a change that then rolled back
 * (`authz.bus-after-commit.unit`).
 *
 * **Synchronous fan-out.** Subscribers run on the same tick, so by the time the HTTP handler
 * returns, the epoch table is already updated and the connections are already closed. Each handler
 * is wrapped in `try/catch` with an `error`-level log plus the `iridium_authz_bus_handler_errors_total`
 * counter; one failing subscriber cannot block another or fail the request that triggered it.
 *
 * **In-process today, interface forever.** `InProcessAuthzBus` is the MVP binding; a Redis
 * implementation is a drop-in, and `authz-bus.contract` is the suite it must pass unchanged.
 * Subscriber order is fixed by registration order: the `EpochReconciler` first, then the
 * `CollabGateway`, then the `TicketStore`, then telemetry.
 */
import type { NoteId, Role, SessionId, TokenId, UserId, VaultId } from '@iridium/contracts';

import type { SessionRevokedReason } from '../db/schema.ts';

/** The events of section 8.3, carrying post-commit version numbers where a subscriber needs them. */
export type AuthzEvent =
  | { readonly type: 'user.disabled'; readonly userId: UserId }
  | {
      readonly type: 'user.password_changed';
      readonly userId: UserId;
      readonly keepSessionId?: SessionId;
    }
  | {
      readonly type: 'session.revoked';
      readonly userId: UserId;
      readonly sessionId: SessionId;
      readonly reason: SessionRevokedReason;
    }
  | { readonly type: 'token.revoked'; readonly userId: UserId; readonly tokenId: TokenId }
  | {
      readonly type: 'membership.removed';
      readonly userId: UserId;
      readonly vaultId: VaultId;
      readonly userAuthzVersion: number;
    }
  | {
      readonly type: 'membership.role_changed';
      readonly userId: UserId;
      readonly vaultId: VaultId;
      readonly role: Role;
      readonly userAuthzVersion: number;
      readonly memberVersion: number;
    }
  | { readonly type: 'vault.archived'; readonly vaultId: VaultId }
  | { readonly type: 'note.trashed'; readonly vaultId: VaultId; readonly noteId: NoteId }
  | { readonly type: 'note.purged'; readonly vaultId: VaultId; readonly noteId: NoteId };

/** The event names, as data, so a test can assert the vocabulary is closed. @internal */
export const AUTHZ_EVENT_TYPES: readonly AuthzEvent['type'][] = [
  'user.disabled',
  'user.password_changed',
  'session.revoked',
  'token.revoked',
  'membership.removed',
  'membership.role_changed',
  'vault.archived',
  'note.trashed',
  'note.purged',
];

/** A subscriber. */
// Ignored synchronous return values remain valid (as with a void callback); returned promises
// are awaited by durable delivery and observed by ordinary fire-and-forget publication.
export type AuthzHandler = (event: AuthzEvent) => unknown;

/** Returned by `subscribe`; idempotent. */
export type Unsubscribe = () => void;

/** The bus every publisher and subscriber is written against. */
export interface AuthzBus {
  /** Synchronous fan-out to every subscriber in registration order; never throws to the caller. */
  publish(event: AuthzEvent): void;
  /** Same synchronous invocation order, with an acknowledgement after every handler settles. */
  publishAndWait(event: AuthzEvent): Promise<boolean>;
  subscribe(handler: AuthzHandler): Unsubscribe;
  /** Live subscribers, for the contract suite. */
  readonly subscriberCount: number;
}

/** What the in-process bus reports a handler failure to. */
export interface AuthzBusObserver {
  /** Called once per failing handler with the event type and the thrown value. */
  onHandlerError(eventType: AuthzEvent['type'], error: unknown): void;
}

/** The MVP binding (F9): exact and instantaneous fan-out inside one process. */
export class InProcessAuthzBus implements AuthzBus {
  /**
   * Keyed by a per-subscription symbol rather than by the handler: a `Map` keeps registration
   * order, its `delete` is idempotent, and the same function subscribed twice is two subscriptions.
   */
  readonly #handlers = new Map<symbol, AuthzHandler>();
  readonly #observer: AuthzBusObserver;
  #handlerErrors = 0;

  constructor(observer: AuthzBusObserver) {
    this.#observer = observer;
  }

  get subscriberCount(): number {
    return this.#handlers.size;
  }

  /** Handler failures so far — the value `iridium_authz_bus_handler_errors_total` publishes. */
  get handlerErrorCount(): number {
    return this.#handlerErrors;
  }

  publish(event: AuthzEvent): void {
    void this.publishAndWait(event);
  }

  async publishAndWait(event: AuthzEvent): Promise<boolean> {
    const outcomes: Promise<boolean>[] = [];
    // Invoke every snapshot subscriber now, in registration order; await only after fan-out.
    // A slow handler cannot delay the next handler's immediate security side effects.
    for (const handler of Array.from(this.#handlers.values())) {
      try {
        outcomes.push(
          Promise.resolve(handler(event)).then(
            () => true,
            (error: unknown) => this.#failed(event, error),
          ),
        );
      } catch (error) {
        outcomes.push(Promise.resolve(this.#failed(event, error)));
      }
    }
    return (await Promise.all(outcomes)).every(Boolean);
  }

  #failed(event: AuthzEvent, error: unknown): false {
    this.#handlerErrors += 1;
    this.#observer.onHandlerError(event.type, error);
    return false;
  }

  subscribe(handler: AuthzHandler): Unsubscribe {
    const subscription = Symbol('authz-subscription');
    this.#handlers.set(subscription, handler);
    return () => {
      this.#handlers.delete(subscription);
    };
  }
}

/**
 * The deferred-effects helper of section 8.3: a service pushes the events its transaction
 * justifies into one of these and `flush()` publishes them after COMMIT. A rolled-back transaction
 * simply never flushes.
 * @internal Exercised by the unit contract; not part of the production module API.
 */
export class DeferredAuthzEvents {
  readonly #events: AuthzEvent[] = [];

  push(event: AuthzEvent): void {
    this.#events.push(event);
  }

  /** The collected events, in order. */
  get pending(): readonly AuthzEvent[] {
    return this.#events;
  }

  /** Publishes every collected event once, in order, and empties the list. */
  flush(bus: AuthzBus): void {
    const events = this.#events.splice(0, this.#events.length);
    for (const event of events) bus.publish(event);
  }
}
