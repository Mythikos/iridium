/**
 * `authz-bus.contract` (04-auth-and-access-control.md section 8.3; D04-14; F9; area:seams): the
 * behaviour every `AuthzBus` implementation must have — synchronous fan-out in registration order,
 * idempotent unsubscribe, one delivery per event, and isolation of a throwing subscriber from its
 * neighbours and from the publisher. At M1 the only binding is the in-process bus; the F9 successor
 * (a cross-process fan-out) is held to the same contract by adding a row to `IMPLEMENTATIONS`.
 */
import { SessionId, UserId, VaultId } from '@iridium/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

import { InProcessAuthzBus, type AuthzBus, type AuthzEvent } from '../../src/authz/bus.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const SESSION = SessionId.parse('019948c4-0000-7000-8000-0000000000aa');
const REVOKED: AuthzEvent = {
  type: 'session.revoked',
  userId: USER,
  sessionId: SESSION,
  reason: 'logout',
};
const ARCHIVED: AuthzEvent = { type: 'vault.archived', vaultId: VAULT };

interface Implementation {
  readonly name: string;
  /** A bus and the handler-error log it writes, so isolation can be asserted uniformly. */
  create(): { readonly bus: AuthzBus; readonly errors: { type: string; error: unknown }[] };
}

const IMPLEMENTATIONS: readonly Implementation[] = [
  {
    name: 'InProcessAuthzBus',
    create: () => {
      const errors: { type: string; error: unknown }[] = [];
      const bus = new InProcessAuthzBus({
        onHandlerError: (type, error) => errors.push({ type, error }),
      });
      return { bus, errors };
    },
  },
];

describe('authz-bus.contract [area:seams]', () => {
  describe.each(IMPLEMENTATIONS)('$name', (implementation) => {
    let bus: AuthzBus;
    let errors: { type: string; error: unknown }[];

    beforeEach(() => {
      ({ bus, errors } = implementation.create());
    });

    it('delivers each published event once to every subscriber', () => {
      const first: AuthzEvent[] = [];
      const second: AuthzEvent[] = [];
      bus.subscribe((event) => first.push(event));
      bus.subscribe((event) => second.push(event));
      bus.publish(REVOKED);
      bus.publish(ARCHIVED);
      expect(first).toStrictEqual([REVOKED, ARCHIVED]);
      expect(second).toStrictEqual([REVOKED, ARCHIVED]);
      expect(bus.subscriberCount).toBe(2);
    });

    it('fans out in registration order', () => {
      const order: string[] = [];
      bus.subscribe(() => order.push('a'));
      bus.subscribe(() => order.push('b'));
      bus.subscribe(() => order.push('c'));
      bus.publish(ARCHIVED);
      expect(order).toStrictEqual(['a', 'b', 'c']);
    });

    it('stops delivering to an unsubscribed handler, idempotently', () => {
      const seen: AuthzEvent[] = [];
      const off = bus.subscribe((event) => seen.push(event));
      bus.publish(REVOKED);
      off();
      off();
      bus.publish(ARCHIVED);
      expect(seen).toStrictEqual([REVOKED]);
      expect(bus.subscriberCount).toBe(0);
    });

    it('never skips or double-delivers to a neighbour when a handler unsubscribes mid-fan-out', () => {
      const seen: string[] = [];
      const off = bus.subscribe(() => {
        seen.push('first');
        off();
      });
      bus.subscribe(() => seen.push('second'));
      bus.publish(REVOKED);
      bus.publish(ARCHIVED);
      expect(seen).toStrictEqual(['first', 'second', 'second']);
    });

    it('isolates a throwing subscriber from its neighbours and from the publisher', () => {
      const seen: string[] = [];
      bus.subscribe(() => {
        throw new Error('broke');
      });
      bus.subscribe(() => seen.push('after'));
      expect(() => {
        bus.publish(ARCHIVED);
      }).not.toThrow();
      expect(seen).toStrictEqual(['after']);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.type).toBe('vault.archived');
    });
  });
});
