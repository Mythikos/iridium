/**
 * `EpochReconciler` — the first `AuthzBus` subscriber (04-auth-and-access-control.md section 8.6;
 * D04-13; D04-14).
 *
 * It writes the post-commit version numbers an event carries into the epoch table, so a connection
 * that sends a message during the gateway's sweep already sees the new epoch and
 * `beforeHandleMessage` refuses the write without a query. The events whose transaction bumped
 * `users.authz_version` without carrying the number — `user.disabled`, `user.password_changed`, and
 * a `session.revoked` by an administrator (section 8.2) — invalidate by making the user's entry
 * unknown: the next message re-authorises from the database and re-seeds the table, which is the
 * fail-safe path of section 8.6. A self-revocation (`logout`, a device `replaced`) bumps nothing,
 * so it leaves the user's other connections fresh; the gateway closes the revoked session's own.
 */
import type { AuthzBus, AuthzEvent, Unsubscribe } from './bus.ts';
import type { EpochTable } from './epochs.ts';

/** Applies bus events to the table. One per process, registered before every other subscriber. */
export class EpochReconciler {
  readonly #table: EpochTable;
  #unsubscribe: Unsubscribe | null = null;

  constructor(table: EpochTable) {
    this.#table = table;
  }

  /** Subscribes to the bus. Registered first, by the authz plugin. */
  attach(bus: AuthzBus): void {
    this.#unsubscribe?.();
    this.#unsubscribe = bus.subscribe((event) => {
      this.apply(event);
    });
  }

  /** Detaches, for the `collab.token-sync.integration` case that runs with the bus removed. */
  detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** The reconciliation of one event; exported for the unit test. */
  apply(event: AuthzEvent): void {
    switch (event.type) {
      case 'membership.removed':
        this.#table.user(event.userId, event.userAuthzVersion);
        this.#table.member(event.vaultId, event.userId, 'removed');
        return;
      case 'membership.role_changed':
        this.#table.user(event.userId, event.userAuthzVersion);
        this.#table.member(event.vaultId, event.userId, event.memberVersion);
        return;
      case 'user.disabled':
      case 'user.password_changed':
        // The bump happened in the transaction but the event does not carry the number: an
        // impossible version makes every connection of the user stale until it re-seeds.
        this.#table.user(event.userId, Number.NaN);
        return;
      case 'session.revoked':
        // Only an administrator's revocation bumps `authz_version` (section 3.8); the others touch
        // one session, whose connections the gateway closes, and leave the user's epoch alone.
        if (event.reason === 'admin') this.#table.user(event.userId, Number.NaN);
        return;
      case 'token.revoked':
      case 'vault.archived':
      case 'note.trashed':
      case 'note.purged':
        // Nothing for the epoch table: tokens never authenticate `/collab`, and the gateway closes
        // documents for the other three.
        return;
    }
  }
}
