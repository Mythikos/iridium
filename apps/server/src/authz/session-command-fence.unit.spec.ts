import { newId, UserId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { SessionCommandFence } from './session-command-fence.ts';

describe('authz.session-command-fence.unit [area:authz] [hp:HP-3]', () => {
  it('the steady path does not wait; a scoped fence leaves other users alone and survives repeated begin', async () => {
    const fence = new SessionCommandFence();
    const user = UserId.parse(newId());
    const other = UserId.parse(newId());
    const changes: { userId: UserId | null; blocked: boolean; observed: boolean }[] = [];
    const unsubscribe = fence.subscribe((userId, blocked) => {
      changes.push({ userId, blocked, observed: fence.blocked(user) });
    });
    expect(fence.revision).toBe(0);
    expect(fence.blocked(user)).toBe(false);
    expect(fence.wait(user)).toBeNull();
    fence.finish('unknown');
    expect(fence.revision).toBe(0);
    fence.begin('scoped', user);
    fence.begin('scoped', user);
    expect(fence.revision).toBe(1);
    expect(fence.blocked(user)).toBe(true);
    expect(fence.blocked(other)).toBe(false);
    expect(fence.wait(other)).toBeNull();
    let resumed = false;
    const blocked = fence.wait(user)?.then(() => {
      resumed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    fence.finish('scoped');
    await blocked;
    expect(resumed).toBe(true);
    expect(fence.revision).toBe(2);
    expect(fence.blocked(user)).toBe(false);
    expect(fence.wait(user)).toBeNull();
    fence.finish('scoped');
    expect(fence.revision).toBe(2);
    expect(changes).toEqual([
      { userId: user, blocked: true, observed: true },
      { userId: user, blocked: false, observed: false },
    ]);
    unsubscribe();
    fence.begin('unobserved', other);
    fence.finish('unobserved');
    expect(changes).toHaveLength(2);
  });

  it('an overlapping global command keeps every covered waiter fenced until both outcomes are known', async () => {
    const fence = new SessionCommandFence();
    const user = UserId.parse(newId());
    const other = UserId.parse(newId());
    fence.begin('scoped', user);
    fence.begin('global', null);
    expect(fence.blocked(other)).toBe(true);
    let resumed = false;
    const blocked = fence.wait(user)?.then(() => {
      resumed = true;
      return undefined;
    });
    const globalOnly = fence.wait(other);
    fence.finish('global');
    await globalOnly;
    expect(fence.blocked(other)).toBe(false);
    expect(resumed).toBe(false);
    expect(fence.blocked(user)).toBe(true);
    fence.finish('scoped');
    await blocked;
    expect(resumed).toBe(true);
    expect(fence.revision).toBe(4);
  });
});
