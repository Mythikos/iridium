/**
 * `authz.bus-after-commit.unit` (04-auth-and-access-control.md section 8.3; D04-14; HP-3): an
 * `AuthzBus` event is published only from the deferred list a transaction flushes after COMMIT,
 * never inside it, so a rolled-back change cannot revoke anybody; fan-out is synchronous, in
 * registration order, and one failing subscriber neither blocks another nor fails the publisher.
 */
import { NoteId, SessionId, UserId, VaultId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import {
  AUTHZ_EVENT_TYPES,
  DeferredAuthzEvents,
  InProcessAuthzBus,
  type AuthzEvent,
} from './bus.ts';

const USER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const VAULT = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const SESSION = SessionId.parse('019948c4-0000-7000-8000-0000000000aa');
const NOTE = NoteId.parse('019948c4-0000-7000-8000-00000000000e');

function bus() {
  const errors: { eventType: string; error: unknown }[] = [];
  const subject = new InProcessAuthzBus({
    onHandlerError: (eventType, error) => errors.push({ eventType, error }),
  });
  return { subject, errors };
}

/** A transaction helper of the shape `withTransaction()` has: effects run only after a commit. */
async function transaction<T>(
  work: (deferred: DeferredAuthzEvents) => Promise<T>,
  publishTo: InProcessAuthzBus,
): Promise<T> {
  const deferred = new DeferredAuthzEvents();
  const result = await work(deferred);
  deferred.flush(publishTo);
  return result;
}

describe('authz.bus-after-commit.unit [hp:HP-3]', () => {
  it('publishes nothing when the transaction rolls back', async () => {
    const { subject } = bus();
    const seen: AuthzEvent[] = [];
    subject.subscribe((event) => seen.push(event));
    await expect(
      transaction(async (deferred) => {
        deferred.push({
          type: 'membership.removed',
          userId: USER,
          vaultId: VAULT,
          userAuthzVersion: 2,
        });
        throw new Error('rolled back');
      }, subject),
    ).rejects.toThrow('rolled back');
    expect(seen).toStrictEqual([]);
  });

  it('publishes every deferred event once, in order, after the work resolved', async () => {
    const { subject } = bus();
    const seen: AuthzEvent[] = [];
    subject.subscribe((event) => seen.push(event));
    await transaction(async (deferred) => {
      deferred.push({
        type: 'session.revoked',
        userId: USER,
        sessionId: SESSION,
        reason: 'logout',
      });
      deferred.push({ type: 'user.disabled', userId: USER });
      expect(seen).toStrictEqual([]);
      expect(deferred.pending).toHaveLength(2);
    }, subject);
    expect(seen.map((event) => event.type)).toStrictEqual(['session.revoked', 'user.disabled']);
    const deferred = new DeferredAuthzEvents();
    deferred.flush(subject);
    expect(seen).toHaveLength(2);
  });

  it('fans out synchronously in registration order, so the reconciler always runs first', () => {
    const { subject } = bus();
    const order: string[] = [];
    subject.subscribe(() => order.push('reconciler'));
    subject.subscribe(() => order.push('gateway'));
    subject.subscribe(() => order.push('tickets'));
    subject.publish({ type: 'vault.archived', vaultId: VAULT });
    expect(order).toStrictEqual(['reconciler', 'gateway', 'tickets']);
    expect(subject.subscriberCount).toBe(3);
  });

  it('isolates a throwing subscriber: the others still run and the publisher never sees the throw', () => {
    const { subject, errors } = bus();
    const seen: string[] = [];
    subject.subscribe(() => {
      throw new Error('subscriber broke');
    });
    subject.subscribe(() => seen.push('second'));
    expect(() =>
      subject.publish({
        type: 'note.trashed',
        vaultId: VAULT,
        noteId: NOTE,
      }),
    ).not.toThrow();
    expect(seen).toStrictEqual(['second']);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.eventType).toBe('note.trashed');
    expect(subject.handlerErrorCount).toBe(1);
  });

  it('unsubscribes idempotently and never skips a neighbour during fan-out', () => {
    const { subject } = bus();
    const seen: string[] = [];
    const first = subject.subscribe(() => {
      seen.push('first');
      first();
    });
    subject.subscribe(() => seen.push('second'));
    subject.publish({ type: 'user.disabled', userId: USER });
    first();
    subject.publish({ type: 'user.disabled', userId: USER });
    expect(seen).toStrictEqual(['first', 'second', 'second']);
    expect(subject.subscriberCount).toBe(1);
  });

  it('names the closed event vocabulary of section 8.3', () => {
    expect(AUTHZ_EVENT_TYPES).toStrictEqual([
      'user.disabled',
      'user.password_changed',
      'session.revoked',
      'token.revoked',
      'membership.removed',
      'membership.role_changed',
      'vault.archived',
      'note.trashed',
      'note.purged',
    ]);
  });

  it('acknowledges only after asynchronous subscribers settle, without delaying later invocation', async () => {
    const { subject, errors } = bus();
    const pending = Promise.withResolvers<void>();
    const order: string[] = [];
    subject.subscribe(() => {
      order.push('first');
      return pending.promise;
    });
    subject.subscribe(() => order.push('second'));
    const outcome = subject.publishAndWait({ type: 'user.disabled', userId: USER });
    expect(order).toEqual(['first', 'second']);
    let acknowledged = false;
    void outcome.then(() => {
      acknowledged = true;
      return undefined;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    pending.resolve();
    await expect(outcome).resolves.toBe(true);
    expect(errors).toEqual([]);
  });

  it('reports asynchronous failure to durable delivery and observes it for ordinary publication', async () => {
    const { subject, errors } = bus();
    subject.subscribe(async () => {
      throw new Error('async gateway sweep failed');
    });
    const seen: AuthzEvent[] = [];
    subject.subscribe((event) => seen.push(event));
    await expect(subject.publishAndWait({ type: 'user.disabled', userId: USER })).resolves.toBe(
      false,
    );
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(1);
    subject.publish({ type: 'user.disabled', userId: USER });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(2);
    expect(subject.handlerErrorCount).toBe(2);
  });

  it('refuses to acknowledge a synchronous failure and acknowledges an empty subscriber set', async () => {
    const { subject } = bus();
    await expect(subject.publishAndWait({ type: 'user.disabled', userId: USER })).resolves.toBe(
      true,
    );
    subject.subscribe(() => {
      throw new Error('synchronous failure');
    });
    await expect(subject.publishAndWait({ type: 'user.disabled', userId: USER })).resolves.toBe(
      false,
    );
  });
});
