/**
 * `auth.tickets.unit` (04-auth-and-access-control.md sections 7.2 and 7.3; A24): the in-process
 * store's own mechanics — the ten-second sweep on the injected clock, lazy expiry on lookup, the
 * delete-before-verify order, the per-session and per-user revocations (the bus subscriber's two
 * moves), and `close()` releasing the timer. The implementation-independent contract is
 * `ticket-store.contract`.
 */
import { SessionId, UserId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { withOtherSecret } from '../../../test/support/credentials.ts';
import { ManualClock } from '../../../test/support/manual-clock.ts';
import { InMemoryTicketStore } from './store.ts';

const SESSION_A = SessionId.parse('019948c4-0000-7000-8000-0000000000a1');
const SESSION_B = SessionId.parse('019948c4-0000-7000-8000-0000000000b2');
const USER_1 = UserId.parse('019948c4-0000-7000-8000-000000000001');
const USER_2 = UserId.parse('019948c4-0000-7000-8000-000000000002');
const TTL_MS = 60_000;
const SWEEP_MS = 10_000;

function store(clock: ManualClock = new ManualClock()) {
  return {
    clock,
    store: new InMemoryTicketStore({ clock, ttlMs: TTL_MS, sweepIntervalMs: SWEEP_MS }),
  };
}

describe('auth.tickets.unit [area:auth]', () => {
  it('sweeps expired entries on the injected timer and lazily on lookup', async () => {
    const { clock, store: subject } = store();
    const [ticket] = subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 1);
    expect(clock.pendingTimers).toBe(1);
    await clock.advance(TTL_MS - 1);
    expect(subject.size).toBe(1);
    await clock.advance(SWEEP_MS);
    expect(subject.size).toBe(0);
    expect(subject.consume(ticket ?? '')).toBeNull();
    // Lazy path: an entry that expired between sweeps is refused at lookup and removed.
    const [late] = subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 1);
    clock.jump(clock.now() + TTL_MS);
    expect(subject.consume(late ?? '')).toBeNull();
    expect(subject.size).toBe(0);
    subject.close();
    expect(clock.pendingTimers).toBe(0);
  });

  it('deletes the entry before verifying, so a wrong secret burns the ticket', () => {
    const { store: subject } = store();
    const [ticket] = subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 1);
    const raw = ticket ?? '';
    expect(subject.consume(withOtherSecret(raw))).toBeNull();
    expect(subject.size).toBe(0);
    expect(subject.consume(raw)).toBeNull();
  });

  it('refuses a credential that is not a ticket and an unknown id without touching the map', () => {
    const { store: subject } = store();
    subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 1);
    expect(subject.consume('irid_ses_0000000000000000_' + 'x'.repeat(49))).toBeNull();
    expect(subject.consume('not a credential')).toBeNull();
    expect(subject.consume('irid_tkt_ZZZZZZZZZZZZZZZZ_' + '0'.repeat(49))).toBeNull();
    expect(subject.size).toBe(1);
  });

  it('drops the tickets of one session, of one user, or of one user except a kept session', () => {
    const { store: subject } = store();
    subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 3);
    subject.issue({ sessionId: SESSION_B, userId: USER_1 }, 2);
    subject.issue(
      { sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000c3'), userId: USER_2 },
      1,
    );
    expect(subject.revokeSession(SESSION_A)).toBe(3);
    expect(subject.size).toBe(3);
    expect(subject.revokeUser(USER_1, SESSION_B)).toBe(0);
    expect(subject.revokeUser(USER_1)).toBe(2);
    expect(subject.size).toBe(1);
    expect(subject.revokeUser(USER_2)).toBe(1);
    expect(subject.size).toBe(0);
  });

  it('refuses a non-positive count', () => {
    const { store: subject } = store();
    expect(() => subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 0)).toThrow(RangeError);
    expect(() => subject.issue({ sessionId: SESSION_A, userId: USER_1 }, 1.5)).toThrow(RangeError);
  });

  it('tolerates close() twice', () => {
    const { store: subject } = store();
    subject.close();
    subject.close();
    expect(subject.sweepExpired()).toBe(0);
  });
});
