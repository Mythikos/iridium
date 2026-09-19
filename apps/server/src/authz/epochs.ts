/**
 * The in-process epoch table (04-auth-and-access-control.md sections 8.2 and 8.6; A23; D04-13).
 *
 * A connection's `authzEpoch` is the **tuple** `{userAuthzVersion, memberVersion}`, never a sum: a
 * sum is not injective, so a simultaneous membership bump and role change could cancel out. The
 * table stores the two counters independently and `isStale` compares each.
 *
 * Entries exist only for users with at least one live `/collab` connection, refcounted per user:
 * `onAuthenticate` calls `retain`, the close path and `afterUnloadDocument` call `release`, and only
 * the transition to zero runs the private forget. A refcount rather than a "last connection?" scan
 * keeps a second window of the same user from having its entry dropped underneath it. The table is
 * bounded by the connection cap (5 000), not by the user count.
 *
 * A missing entry for a live connection is stale by definition: table and connection disagree, so
 * re-validating and re-seeding is the fail-safe answer — and self-limiting, because one message
 * pays two lookups and the rest pay nothing.
 */
import type { AuthzEpoch, UserId, VaultId } from '@iridium/contracts';

/**
 * The numeric sentinel of "no membership row" (a server admin without one), never `'removed'`.
 */
export const NO_MEMBERSHIP_VERSION = 0;

/** A membership entry: the row's version, or the reconciler's post-deletion marker. */
export type MemberEpoch = number | 'removed';

/** What `isStale` reads off a connection: the subset of `IridiumCollabContext` it needs. */
export interface EpochSubject {
  readonly userId: UserId;
  readonly vaultId: VaultId;
  readonly authzEpoch: AuthzEpoch;
}

function memberKey(vaultId: VaultId, userId: UserId): `${VaultId}:${UserId}` {
  return `${vaultId}:${userId}`;
}

/** The table. One per process, owned by the authz plugin, shared with the collab server. */
export class EpochTable {
  readonly #users = new Map<UserId, number>();
  readonly #members = new Map<`${VaultId}:${UserId}`, MemberEpoch>();
  readonly #refs = new Map<UserId, number>();

  /** Seeds or refreshes a user's `authz_version`. */
  user(userId: UserId, version: number): void {
    this.#users.set(userId, version);
  }

  /** Seeds or refreshes a membership's version, or marks it removed. */
  member(vaultId: VaultId, userId: UserId, version: MemberEpoch): void {
    this.#members.set(memberKey(vaultId, userId), version);
  }

  /** The stored user epoch, or `undefined` when the user has no live connection. */
  userEpoch(userId: UserId): number | undefined {
    return this.#users.get(userId);
  }

  /** The stored membership epoch, or `undefined` when none was seeded. */
  memberEpoch(vaultId: VaultId, userId: UserId): MemberEpoch | undefined {
    return this.#members.get(memberKey(vaultId, userId));
  }

  /**
   * Whether a connection's tuple disagrees with the table in either component, the membership is
   * marked removed, or the user has no entry at all.
   */
  isStale(subject: EpochSubject): boolean {
    const user = this.#users.get(subject.userId);
    if (user === undefined || user !== subject.authzEpoch.userAuthzVersion) return true;
    const member = this.#members.get(memberKey(subject.vaultId, subject.userId));
    if (member === undefined || member === 'removed') return true;
    return member !== subject.authzEpoch.memberVersion;
  }

  /** One more live connection for the user (`onAuthenticate`). */
  retain(userId: UserId): void {
    this.#refs.set(userId, (this.#refs.get(userId) ?? 0) + 1);
  }

  /** One fewer live connection; the transition to zero forgets the user's entries. */
  release(userId: UserId): void {
    const count = this.#refs.get(userId);
    if (count === undefined) return;
    if (count > 1) {
      this.#refs.set(userId, count - 1);
      return;
    }
    this.#refs.delete(userId);
    this.#forget(userId);
  }

  /** Live connections of a user, for the contract suite. */
  refCount(userId: UserId): number {
    return this.#refs.get(userId) ?? 0;
  }

  /** Users with at least one entry, for the bound assertion. */
  get size(): number {
    return this.#users.size;
  }

  #forget(userId: UserId): void {
    this.#users.delete(userId);
    for (const key of this.#members.keys()) {
      if (key.endsWith(`:${userId}`)) this.#members.delete(key);
    }
  }
}
