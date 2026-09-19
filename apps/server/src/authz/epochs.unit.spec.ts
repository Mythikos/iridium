/**
 * `authz.epochs.unit` (04-auth-and-access-control.md sections 8.2 and 8.6; D04-13): the epoch table
 * compares the tuple `{userAuthzVersion, memberVersion}` component by component (never a sum),
 * treats a missing entry and a `removed` membership as stale, refcounts entries per user so a
 * second window never has its entry dropped underneath it, and the reconciler writes the
 * post-commit numbers an event carries.
 */
import { NoteId, SessionId, TokenId, UserId, VaultId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { InProcessAuthzBus } from './bus.ts';
import { EpochTable, NO_MEMBERSHIP_VERSION } from './epochs.ts';
import { EpochReconciler } from './reconciler.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const OTHER = UserId.parse('019948c4-0000-7000-8000-000000000002');
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const SESSION = SessionId.parse('019948c4-0000-7000-8000-0000000000aa');
const TOKEN = TokenId.parse('019948c4-0000-7000-8000-00000000f001');
const NOTE = NoteId.parse('019948c4-0000-7000-8000-00000000000e');

function subject(user = 4, member = 2) {
  return {
    userId: USER,
    vaultId: VAULT,
    authzEpoch: { userAuthzVersion: user, memberVersion: member },
  };
}

function seeded(): EpochTable {
  const table = new EpochTable();
  table.retain(USER);
  table.user(USER, 4);
  table.member(VAULT, USER, 2);
  return table;
}

describe('authz.epochs.unit [area:authz]', () => {
  it('is fresh when both components match and stale when either differs', () => {
    const table = seeded();
    expect(table.isStale(subject())).toBe(false);
    expect(table.isStale(subject(5, 2))).toBe(true);
    expect(table.isStale(subject(4, 3))).toBe(true);
    // A sum would be injective-blind: 5 + 1 = 4 + 2. The tuple is not fooled.
    table.user(USER, 5);
    table.member(VAULT, USER, 1);
    expect(table.isStale(subject(4, 2))).toBe(true);
  });

  it('treats a missing entry and a removed membership as stale', () => {
    const empty = new EpochTable();
    expect(empty.isStale(subject())).toBe(true);
    const table = seeded();
    table.member(VAULT, USER, 'removed');
    expect(table.isStale(subject())).toBe(true);
    const userOnly = new EpochTable();
    userOnly.user(USER, 4);
    expect(userOnly.isStale(subject())).toBe(true);
  });

  it('uses the numeric sentinel for an admin without a membership row', () => {
    const table = seeded();
    table.member(VAULT, USER, NO_MEMBERSHIP_VERSION);
    expect(NO_MEMBERSHIP_VERSION).toBe(0);
    expect(table.isStale(subject(4, 0))).toBe(false);
  });

  it('refcounts entries per user and forgets only that user on the transition to zero', () => {
    const table = seeded();
    table.retain(OTHER);
    table.user(OTHER, 1);
    table.member(VAULT, OTHER, 1);
    table.retain(USER);
    expect(table.refCount(USER)).toBe(2);
    table.release(USER);
    expect(table.userEpoch(USER)).toBe(4);
    expect(table.memberEpoch(VAULT, USER)).toBe(2);
    table.release(USER);
    expect(table.refCount(USER)).toBe(0);
    expect(table.userEpoch(USER)).toBeUndefined();
    expect(table.memberEpoch(VAULT, USER)).toBeUndefined();
    // The other user's entries — its membership on the same vault included — are untouched.
    expect(table.userEpoch(OTHER)).toBe(1);
    expect(table.memberEpoch(VAULT, OTHER)).toBe(1);
    expect(table.size).toBe(1);
    // Releasing an unknown user is a no-op.
    table.release(UserId.parse('019948c4-0000-7000-8000-000000000003'));
    expect(table.size).toBe(1);
  });

  it('reconciles membership events with their post-commit versions and invalidates user-level ones', () => {
    const table = seeded();
    const reconciler = new EpochReconciler(table);
    reconciler.apply({
      type: 'membership.role_changed',
      userId: USER,
      vaultId: VAULT,
      role: 'viewer',
      userAuthzVersion: 5,
      memberVersion: 3,
    });
    expect(table.isStale(subject(4, 2))).toBe(true);
    expect(table.isStale(subject(5, 3))).toBe(false);
    reconciler.apply({
      type: 'membership.removed',
      userId: USER,
      vaultId: VAULT,
      userAuthzVersion: 6,
    });
    expect(table.memberEpoch(VAULT, USER)).toBe('removed');
    expect(table.isStale(subject(6, 3))).toBe(true);
    table.member(VAULT, USER, 3);
    expect(table.isStale(subject(6, 3))).toBe(false);
    for (const type of ['user.disabled', 'user.password_changed'] as const) {
      table.user(USER, 6);
      reconciler.apply({ type, userId: USER });
      expect(table.isStale(subject(6, 3))).toBe(true);
    }
    table.user(USER, 6);
    reconciler.apply({
      type: 'session.revoked',
      userId: USER,
      sessionId: SESSION,
      reason: 'admin',
    });
    expect(table.isStale(subject(6, 3))).toBe(true);
    table.user(USER, 6);
    // A self-revocation bumps no authz_version: the user's other connections stay fresh.
    for (const reason of ['logout', 'replaced', 'password_change', 'expired'] as const) {
      reconciler.apply({ type: 'session.revoked', userId: USER, sessionId: SESSION, reason });
      expect(table.isStale(subject(6, 3))).toBe(false);
    }
    for (const event of [
      { type: 'token.revoked', userId: USER, tokenId: TOKEN },
      { type: 'vault.archived', vaultId: VAULT },
      { type: 'note.trashed', vaultId: VAULT, noteId: NOTE },
      { type: 'note.purged', vaultId: VAULT, noteId: NOTE },
    ] as const) {
      reconciler.apply(event);
    }
    expect(table.isStale(subject(6, 3))).toBe(false);
  });

  it('attaches as a bus subscriber and detaches cleanly', () => {
    const table = seeded();
    const reconciler = new EpochReconciler(table);
    const bus = new InProcessAuthzBus({ onHandlerError: () => undefined });
    reconciler.attach(bus);
    reconciler.attach(bus);
    expect(bus.subscriberCount).toBe(1);
    bus.publish({ type: 'membership.removed', userId: USER, vaultId: VAULT, userAuthzVersion: 9 });
    expect(table.userEpoch(USER)).toBe(9);
    reconciler.detach();
    reconciler.detach();
    expect(bus.subscriberCount).toBe(0);
    bus.publish({ type: 'membership.removed', userId: USER, vaultId: VAULT, userAuthzVersion: 10 });
    expect(table.userEpoch(USER)).toBe(9);
  });
});
