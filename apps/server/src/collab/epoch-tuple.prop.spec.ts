// oxlint-disable vitest/no-standalone-expect -- `it.prop(...)(name, fn)` is the
// @fast-check/vitest form; each `expect` runs inside the property's own test body.
/**
 * `collab.epoch-tuple.prop` — the authorization epoch is a tuple, never a sum
 * (04-auth-and-access-control.md §8.2, §8.6; D04-13; HP-3).
 *
 * Two independent counters — `users.authz_version` and `vault_members.version` — are compared
 * component by component by `EpochTable.isStale`. A sum would let a compensating pair of bumps
 * (+1, −1) hide a change; the properties below state that no two distinct tuples compare fresh,
 * that a bump of either counter makes every earlier tuple stale, and that a `removed` membership
 * or a missing entry is stale whatever the connection claims.
 */
import { it } from '@fast-check/vitest';
import { UserId, VaultId } from '@iridium/contracts';
import { PROP } from '@iridium/testkit';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { EpochTable, NO_MEMBERSHIP_VERSION } from '../authz/epochs.ts';

const USER = UserId.parse('0190f2a0-0000-7000-8000-00000000e001');
const VAULT = VaultId.parse('0190f2a0-0000-7000-8000-00000000e0a0');

const version = fc.integer({ min: 0, max: 1_000_000 });
const tuple = fc.record({ userAuthzVersion: version, memberVersion: version });

function tableOf(user: number, member: number | 'removed'): EpochTable {
  const table = new EpochTable();
  table.retain(USER);
  table.user(USER, user);
  table.member(VAULT, USER, member);
  return table;
}

function subject(authzEpoch: { userAuthzVersion: number; memberVersion: number }): {
  userId: UserId;
  vaultId: VaultId;
  authzEpoch: { userAuthzVersion: number; memberVersion: number };
} {
  return { userId: USER, vaultId: VAULT, authzEpoch };
}

describe('collab.epoch-tuple.prop [hp:HP-3]', () => {
  it.prop([tuple], PROP)('a connection whose tuple equals the table is fresh', (epoch) => {
    const table = tableOf(epoch.userAuthzVersion, epoch.memberVersion);
    expect(table.isStale(subject(epoch))).toBe(false);
  });

  it.prop([tuple, tuple], PROP)('no two distinct tuples compare fresh, sums included', (a, b) => {
    fc.pre(a.userAuthzVersion !== b.userAuthzVersion || a.memberVersion !== b.memberVersion);
    const table = tableOf(a.userAuthzVersion, a.memberVersion);
    expect(table.isStale(subject(b))).toBe(true);
  });

  it.prop([tuple, fc.integer({ min: 1, max: 1_000 })], PROP)(
    'a bump of either counter makes every earlier tuple stale',
    (epoch, bump) => {
      const userBumped = tableOf(epoch.userAuthzVersion + bump, epoch.memberVersion);
      const memberBumped = tableOf(epoch.userAuthzVersion, epoch.memberVersion + bump);
      expect(userBumped.isStale(subject(epoch))).toBe(true);
      expect(memberBumped.isStale(subject(epoch))).toBe(true);
    },
  );

  it.prop([version, version], PROP)(
    'a compensating pair of bumps is still a change',
    (user, member) => {
      // The sum is unchanged: (user + 1) + (member - 1) === user + member.
      fc.pre(member >= 1);
      const table = tableOf(user + 1, member - 1);
      expect(table.isStale(subject({ userAuthzVersion: user, memberVersion: member }))).toBe(true);
    },
  );

  it.prop([tuple], PROP)('a removed membership and a missing entry are stale', (epoch) => {
    const removed = tableOf(epoch.userAuthzVersion, 'removed');
    expect(removed.isStale(subject(epoch))).toBe(true);
    const empty = new EpochTable();
    expect(empty.isStale(subject(epoch))).toBe(true);
    const noMembership = tableOf(epoch.userAuthzVersion, NO_MEMBERSHIP_VERSION);
    expect(
      noMembership.isStale(
        subject({ userAuthzVersion: epoch.userAuthzVersion, memberVersion: NO_MEMBERSHIP_VERSION }),
      ),
    ).toBe(false);
  });
});
