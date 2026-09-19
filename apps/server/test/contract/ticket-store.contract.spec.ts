/**
 * `ticket-store.contract` (04-auth-and-access-control.md sections 7.2 and 7.3; A24; area:seams):
 * the behaviour every `TicketStore` implementation must have, stated once and run against each
 * binding. At M1 the only binding is the in-process store; the F9 successor (a shared store) is
 * held to the identical contract by adding a row to `IMPLEMENTATIONS`.
 *
 * The contract is TTL, single use with delete-before-verify, the two revocation shapes, and the
 * refusal of anything that is not one of this store's own tickets. Timing is driven by a
 * `ManualClock`, so "single use" and "expires at the TTL" are exact rather than racy.
 */
import { SessionId, UserId } from '@iridium/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryTicketStore,
  type TicketBinding,
  type TicketStore,
} from '../../src/auth/tickets/store.ts';
import { withOtherSecret } from '../support/credentials.ts';
import { ManualClock } from '../support/manual-clock.ts';

const TTL_MS = 60_000;
const SWEEP_MS = 10_000;
const SESSION_A = SessionId.parse('019948c4-0000-7000-8000-0000000000a1');
const SESSION_B = SessionId.parse('019948c4-0000-7000-8000-0000000000b2');
const USER_1 = UserId.parse('019948c4-0000-7000-8000-000000000001');
const USER_2 = UserId.parse('019948c4-0000-7000-8000-000000000002');

interface Harness {
  readonly store: TicketStore;
  readonly clock: ManualClock;
}

interface Implementation {
  readonly name: string;
  create(clock: ManualClock): TicketStore;
}

const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    name: 'InMemoryTicketStore',
    create: (clock) => new InMemoryTicketStore({ clock, ttlMs: TTL_MS, sweepIntervalMs: SWEEP_MS }),
  },
];

const BINDING_A: TicketBinding = { sessionId: SESSION_A, userId: USER_1 };
const BINDING_B: TicketBinding = { sessionId: SESSION_B, userId: USER_1 };
const BINDING_C: TicketBinding = {
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000c3'),
  userId: USER_2,
};

describe('ticket-store.contract [area:seams]', () => {
  describe.each(IMPLEMENTATIONS)('$name', (implementation) => {
    let harness: Harness;

    beforeEach(() => {
      const clock = new ManualClock();
      harness = { store: implementation.create(clock), clock };
    });

    afterEach(() => {
      harness.store.close();
    });

    it('mints a batch of distinct tickets, each bound to its session', () => {
      const tickets = harness.store.issue(BINDING_A, 3);
      expect(tickets).toHaveLength(3);
      expect(new Set(tickets).size).toBe(3);
      for (const ticket of tickets) expect(ticket.startsWith('irid_tkt_')).toBe(true);
      expect(harness.store.size).toBe(3);
    });

    it('consumes a ticket exactly once and returns its binding', () => {
      const [ticket] = harness.store.issue(BINDING_A, 1);
      expect(harness.store.consume(ticket ?? '')).toStrictEqual(BINDING_A);
      expect(harness.store.consume(ticket ?? '')).toBeNull();
      expect(harness.store.size).toBe(0);
    });

    it('deletes the entry before verifying, so a wrong secret still burns the ticket', () => {
      const [ticket] = harness.store.issue(BINDING_A, 1);
      expect(harness.store.consume(withOtherSecret(ticket ?? ''))).toBeNull();
      expect(harness.store.consume(ticket ?? '')).toBeNull();
    });

    it('expires a ticket at the TTL, whether swept or looked up', () => {
      const [swept] = harness.store.issue(BINDING_A, 1);
      const [lazy] = harness.store.issue(BINDING_B, 1);
      harness.clock.jump(harness.clock.now() + TTL_MS);
      // The lazy path refuses on lookup; the swept path is gone once a sweep runs.
      expect(harness.store.consume(lazy ?? '')).toBeNull();
      expect(harness.store.consume(swept ?? '')).toBeNull();
    });

    it('refuses a credential that is not one of its tickets', () => {
      harness.store.issue(BINDING_A, 1);
      expect(harness.store.consume('not a credential')).toBeNull();
      expect(harness.store.consume('irid_ses_0000000000000000_' + 'x'.repeat(49))).toBeNull();
      expect(harness.store.size).toBe(1);
    });

    it('revokes every outstanding ticket of one session, and reports the count', () => {
      harness.store.issue(BINDING_A, 3);
      harness.store.issue(BINDING_B, 2);
      expect(harness.store.revokeSession(SESSION_A)).toBe(3);
      expect(harness.store.size).toBe(2);
    });

    it('revokes a user, optionally keeping one session', () => {
      harness.store.issue(BINDING_A, 2);
      harness.store.issue(BINDING_B, 2);
      harness.store.issue(BINDING_C, 1);
      expect(harness.store.revokeUser(USER_1, SESSION_B)).toBe(2);
      expect(harness.store.size).toBe(3);
      expect(harness.store.revokeUser(USER_1)).toBe(2);
      expect(harness.store.revokeUser(USER_2)).toBe(1);
      expect(harness.store.size).toBe(0);
    });

    it('refuses a non-positive count', () => {
      expect(() => harness.store.issue(BINDING_A, 0)).toThrow(RangeError);
    });
  });
});
