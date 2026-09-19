import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test/support/manual-clock.ts';
import { SocketAwarenessWindows } from './server.ts';

const NOTE = 'note:0190f2a0-0000-7000-8000-000000000001';
const OTHER = 'note:0190f2a0-0000-7000-8000-000000000002';

describe('collab.awareness-windows.unit [hp:HP-5]', () => {
  it('bounds distinct document retention and uses only one timer until idle expiry', async () => {
    const clock = new ManualClock();
    const windows = new SocketAwarenessWindows(clock);
    for (let index = 0; index < LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET; index++) {
      expect(
        windows.take(`note:0190f2a0-0000-7000-8000-${index.toString().padStart(12, '0')}`),
      ).toBe(true);
    }
    expect(windows.size).toBe(LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET);
    expect(clock.pendingTimers).toBe(1);
    expect(windows.take('note:0190f2a0-0000-7000-8000-ffffffffffff')).toBe(false);
    expect(windows.size).toBe(LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET);
    await clock.advance(999);
    expect(windows.size).toBe(LIMITS.AWARENESS_DOCUMENTS_PER_SOCKET);
    await clock.advance(1);
    expect(windows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    expect(windows.take(OTHER)).toBe(true);
    windows.close();
    expect(windows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });

  it('keeps independent fixed quotas and expires staggered windows without inbound traffic', async () => {
    const clock = new ManualClock();
    const windows = new SocketAwarenessWindows(clock);
    for (let index = 0; index < LIMITS.AWARENESS_MESSAGES_PER_SECOND; index++) {
      expect(windows.take(NOTE)).toBe(true);
    }
    expect(windows.take(NOTE)).toBe(false);
    await clock.advance(500);
    expect(windows.take(OTHER)).toBe(true);
    expect(windows.take(NOTE)).toBe(false);
    expect(clock.pendingTimers).toBe(1);
    await clock.advance(500);
    expect(windows.size).toBe(1);
    expect(clock.pendingTimers).toBe(1);
    await clock.advance(500);
    expect(windows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    windows.close();
  });

  it('removes expired entries when a message arrives before a delayed timer callback', async () => {
    const clock = new ManualClock();
    const windows = new SocketAwarenessWindows(clock);
    expect(windows.take(NOTE)).toBe(true);
    clock.jump(clock.now() + 1_000);
    expect(windows.take(OTHER)).toBe(true);
    expect(windows.size).toBe(1);
    expect(clock.pendingTimers).toBe(1);
    await clock.advance(1_000);
    expect(windows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    windows.close();
  });

  it('cancels all retention and cannot resurrect resources after physical close', async () => {
    const clock = new ManualClock();
    const windows = new SocketAwarenessWindows(clock);
    expect(windows.take(NOTE)).toBe(true);
    windows.close();
    windows.close();
    expect(windows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
    expect(windows.take(OTHER)).toBe(false);
    await clock.advance(10_000);
    expect(windows.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });
});
