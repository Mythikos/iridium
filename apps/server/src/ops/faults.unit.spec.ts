/**
 * `ops.faults.unit` — the fault registry's gate, its lifetimes and its refusals
 * (10-testing-and-quality.md, "Fault injection: `IRIDIUM_FAULT`"; D10-6).
 *
 * The registry is the one place in the server that compares `NODE_ENV` with `'test'`, and the property
 * that matters most is the one a test cannot observe from the outside: **outside `NODE_ENV=test` nothing
 * arms and nothing fires**. Everything else here is a lifetime, and a lifetime that is wrong makes a chaos
 * suite pass by never reaching the fault it was written to drive — which is the failure mode this file and
 * `guards.fault-registry.guard` exist to catch between them.
 *
 * `hardKill` is injected, because the real one is `process.kill(process.pid, 'SIGKILL')` and the test
 * runner is that process.
 *
 */
import { describe, expect, it } from 'vitest';

import type { Clock, TimerHandle } from './clock.ts';
import { FaultRegistry, FaultSpecError, parseFaultSpec, type FaultLogger } from './faults.ts';

/** A clock whose timers fire when the test says so, so `delay()` needs no sleep. */
function manualClock(): Clock & { runPending(): void } {
  const pending: (() => void)[] = [];
  let nowMs = 1_700_000_000_000;
  return {
    now: () => nowMs,
    date: () => new Date(nowMs),
    monotonic: () => nowMs,
    after(ms: number, fn: () => void): TimerHandle {
      nowMs += ms;
      pending.push(fn);
      return { cancel: () => undefined };
    },
    every(_ms: number, _fn: () => void): TimerHandle {
      return { cancel: () => undefined };
    },
    runPending(): void {
      for (const fn of pending.splice(0)) fn();
    },
  };
}

/** The error a `maybeThrow` call site would raise. */
const BOOM = (): Error => new Error('store.throw');

/** A logger that records nothing: the registry's warnings are not this file's subject. */
const SILENT_LOGGER: FaultLogger = { warn: (): void => undefined };

function registry(options: { nodeEnv?: string; spec?: string | null } = {}): {
  faults: FaultRegistry;
  clock: ReturnType<typeof manualClock>;
  kills: number;
} {
  const clock = manualClock();
  const state = { kills: 0 };
  const faults = new FaultRegistry({
    nodeEnv: options.nodeEnv ?? 'test',
    spec: options.spec ?? null,
    clock,
    logger: SILENT_LOGGER,
    hardKill: () => {
      state.kills += 1;
    },
  });
  return {
    faults,
    clock,
    get kills(): number {
      return state.kills;
    },
  };
}

describe('ops.faults.unit [area:ops]', () => {
  it('reports only an actual firing, with the point and no arguments or credentials', () => {
    const observed: Readonly<Record<string, unknown>>[] = [];
    const faults = new FaultRegistry({
      nodeEnv: 'test',
      spec: null,
      clock: manualClock(),
      logger: {
        warn: (fields) => {
          observed.push(fields);
        },
      },
      hardKill: () => undefined,
    });
    faults.fire('store.throw');
    expect(observed).toEqual([]);
    faults.arm({ point: 'store.throw', count: 1 });
    observed.length = 0;
    faults.fire('store.throw');
    faults.fire('store.throw');
    expect(observed).toEqual([{ event: 'fault.fired', point: 'store.throw' }]);
    const disabled = new FaultRegistry({
      nodeEnv: 'production',
      spec: null,
      clock: manualClock(),
      logger: {
        warn: (fields) => {
          observed.push(fields);
        },
      },
      hardKill: () => undefined,
    });
    disabled.fire('store.throw');
    expect(observed).toHaveLength(1);
  });

  describe('the NODE_ENV gate', () => {
    it.each(['production', 'development'])('is inert under NODE_ENV=%s', (nodeEnv) => {
      const { faults } = registry({ nodeEnv });
      expect(faults.enabled).toBe(false);
      expect(faults.arm({ point: 'store.throw' })).toEqual({
        armed: false,
        refused: 'not_test_env',
      });
      expect(faults.fire('store.throw').fired).toBe(false);
      expect(faults.armed).toEqual([]);
    });

    it('ignores IRIDIUM_FAULT entirely outside NODE_ENV=test', () => {
      // `EnvSchema` refuses the variable there and exits 2 before this code runs; the registry is the
      // second of two independent gates, so a hand-built configuration cannot arm anything either.
      const { faults } = registry({ nodeEnv: 'production', spec: 'store.throw' });
      expect(faults.armed).toEqual([]);
    });
  });

  describe('arming at spawn', () => {
    it('parses the documented spec form, with the registry deciding what :<n> means', () => {
      expect(parseFaultSpec('store.slow:3000,ws.drop-after-ack')).toEqual([
        { point: 'store.slow', arg: 3000 },
        { point: 'ws.drop-after-ack' },
      ]);
      // `store.throw` is `counted`, so its suffix is a count and not a duration.
      expect(parseFaultSpec('store.throw:2')).toEqual([{ point: 'store.throw', count: 2 }]);
    });

    it('arms every point IRIDIUM_FAULT named', () => {
      const { faults } = registry({ spec: 'store.slow:1500,ws.drop-after-ack' });
      expect(
        faults.armed.map((fault) => fault.point).toSorted((a, b) => a.localeCompare(b)),
      ).toEqual(['store.slow', 'ws.drop-after-ack']);
    });

    it('refuses to boot on a spec it cannot honour, rather than arming nothing silently', () => {
      expect(() => registry({ spec: 'store.nonexistent' })).toThrow(FaultSpecError);
      // A `milliseconds` point with no duration is the other half of the same mistake.
      expect(() => registry({ spec: 'store.slow' })).toThrow(FaultSpecError);
    });
  });

  describe('arming at runtime', () => {
    it('refuses malformed acknowledgement selectors and selectors on unrelated points', () => {
      const { faults } = registry();
      const noteId = '01980000-0000-7000-8000-000000000001';
      expect(faults.arm({ point: 'store.throw', ack: { noteId, afterSeq: 0 } })).toEqual({
        armed: false,
        refused: 'ack_not_accepted',
      });
      for (const ack of [
        null,
        {},
        { noteId: 'not-a-note', afterSeq: 0 },
        { noteId, afterSeq: -1 },
        { noteId, afterSeq: 0.5 },
        { noteId, afterSeq: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        expect(faults.arm({ point: 'store.kill-after-ack', ack })).toEqual({
          armed: false,
          refused: 'invalid_ack',
        });
      }
      expect(faults.armed).toEqual([]);
    });

    it('refuses an unknown point and names the registry', () => {
      const { faults } = registry();
      expect(faults.arm({ point: 'store.explode' })).toEqual({
        armed: false,
        refused: 'unknown_point',
      });
    });

    it('refuses an argument on a point that takes none, and a count on an uncounted point', () => {
      const { faults } = registry();
      expect(faults.arm({ point: 'store.throw', arg: 5 })).toEqual({
        armed: false,
        refused: 'argument_not_accepted',
      });
      expect(faults.arm({ point: 'store.slow', arg: 5, count: 2 })).toEqual({
        armed: false,
        refused: 'count_not_accepted',
      });
    });

    it('refuses a negative or fractional number', () => {
      const { faults } = registry();
      expect(faults.arm({ point: 'store.slow', arg: -1 })).toEqual({
        armed: false,
        refused: 'invalid_number',
      });
      expect(faults.arm({ point: 'store.throw', count: 1.5 })).toEqual({
        armed: false,
        refused: 'invalid_number',
      });
    });

    it('treats count: 0 as a disarm, which is what the testkit handle sends', () => {
      const { faults } = registry();
      expect(faults.arm({ point: 'store.throw' }).armed).toBe(true);
      expect(faults.arm({ point: 'store.throw', count: 0 }).armed).toBe(true);
      expect(faults.fire('store.throw').fired).toBe(false);
    });
  });

  describe('lifetimes', () => {
    it.each(['store.kill-after-ack', 'ws.drop-after-ack'])(
      'keeps %s armed across baseline replies and other notes until the selected commit',
      (point) => {
        const { faults } = registry();
        const noteId = '01980000-0000-7000-8000-000000000001';
        const otherNote = '01980000-0000-7000-8000-000000000002';
        expect(faults.arm({ point, ack: { noteId, afterSeq: 4 } }).armed).toBe(true);
        expect(faults.fire(point, 'socket').fired).toBe(false);
        expect(faults.fire(point, 'socket', { noteId, seq: 4 }).fired).toBe(false);
        expect(faults.fire(point, 'socket', { noteId: otherNote, seq: 5 }).fired).toBe(false);
        expect(faults.armed).toHaveLength(1);
        expect(faults.fire(point, 'socket', { noteId, seq: 5 }).fired).toBe(true);
        expect(faults.fire(point, 'socket', { noteId, seq: 6 }).fired).toBe(false);
      },
    );

    it('applies the acknowledgement selector at the synchronous crash boundary', () => {
      const scene = registry();
      const noteId = '01980000-0000-7000-8000-000000000001';
      scene.faults.arm({ point: 'store.kill-after-ack', ack: { noteId, afterSeq: 4 } });
      scene.faults.crash('store.kill-after-ack', { noteId, seq: 4 });
      expect(scene.kills).toBe(0);
      scene.faults.crash('store.kill-after-ack', { noteId, seq: 5 });
      expect(scene.kills).toBe(1);
    });

    it('normalizes the selected note ID just like the wire contract', () => {
      const { faults } = registry();
      const noteId = '01980000-0000-7000-8000-00000000000a';
      faults.arm({
        point: 'store.kill-after-ack',
        ack: { noteId: noteId.toUpperCase(), afterSeq: 0 },
      });
      expect(faults.fire('store.kill-after-ack', undefined, { noteId, seq: 1 }).fired).toBe(true);
    });

    it('rearms a selected per-connection fault for a later revision on the same socket', () => {
      const { faults } = registry();
      const noteId = '01980000-0000-7000-8000-000000000001';
      faults.arm({ point: 'ws.drop-after-ack', ack: { noteId, afterSeq: 4 } });
      expect(faults.fire('ws.drop-after-ack', 'socket', { noteId, seq: 5 }).fired).toBe(true);
      faults.arm({ point: 'ws.drop-after-ack', ack: { noteId, afterSeq: 5 } });
      expect(faults.fire('ws.drop-after-ack', 'socket', { noteId, seq: 5 }).fired).toBe(false);
      expect(faults.fire('ws.drop-after-ack', 'socket', { noteId, seq: 6 }).fired).toBe(true);
    });

    it('fires a one-shot point exactly once', () => {
      const { faults } = registry();
      faults.arm({ point: 'store.crash-before-commit' });
      expect(faults.fire('store.crash-before-commit').fired).toBe(true);
      expect(faults.fire('store.crash-before-commit').fired).toBe(false);
    });

    it('holds the owner command boundary for one injected delay and remains inert outside tests', async () => {
      const { faults, clock } = registry();
      faults.arm({ point: 'auth.command-after-commit', arg: 250 });
      let released = false;
      const waiting = faults.delay('auth.command-after-commit').then(() => {
        released = true;
        return undefined;
      });
      await Promise.resolve();
      expect(released).toBe(false);
      clock.runPending();
      await waiting;
      expect(released).toBe(true);
      expect(faults.fire('auth.command-after-commit').fired).toBe(false);
      const production = registry({ nodeEnv: 'production' }).faults;
      expect(production.arm({ point: 'auth.command-after-commit', arg: 250 })).toEqual({
        armed: false,
        refused: 'not_test_env',
      });
      await production.delay('auth.command-after-commit');
      expect(production.fire('auth.command-after-commit').fired).toBe(false);
    });

    it('counts a counted point down and then disarms it', () => {
      const { faults } = registry();
      faults.arm({ point: 'store.throw', count: 2 });
      expect(faults.fire('store.throw').fired).toBe(true);
      expect(faults.fire('store.throw').fired).toBe(true);
      expect(faults.fire('store.throw').fired).toBe(false);
    });

    it('fires a counted point without a count until it is disarmed', () => {
      const { faults } = registry();
      faults.arm({ point: 'store.throw' });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect(faults.fire('store.throw').fired).toBe(true);
      }
      faults.disarmAll();
      expect(faults.fire('store.throw').fired).toBe(false);
    });

    it('fires a per-connection point once per connection', () => {
      const { faults } = registry();
      faults.arm({ point: 'ws.drop-after-ack' });
      expect(faults.fire('ws.drop-after-ack', 'connection-a').fired).toBe(true);
      expect(faults.fire('ws.drop-after-ack', 'connection-a').fired).toBe(false);
      expect(faults.fire('ws.drop-after-ack', 'connection-b').fired).toBe(true);
    });

    it('fires an until-disarmed point every time and carries its argument', () => {
      const { faults } = registry();
      faults.arm({ point: 'auth.slow', arg: 250 });
      expect(faults.fire('auth.slow')).toEqual({ fired: true, arg: 250 });
      expect(faults.fire('auth.slow')).toEqual({ fired: true, arg: 250 });
    });

    it('fires nothing that was never armed', () => {
      const { faults } = registry();
      expect(faults.fire('compact.throw').fired).toBe(false);
    });
  });

  describe('the shapes a call site uses', () => {
    it.each(['point', 'all'] as const)(
      'holds one caller until %s disarm and leaves other callers free',
      async (method) => {
        const { faults, clock } = registry();
        faults.arm({ point: 'store.hold-before-commit' });
        let released = false;
        const waiting = faults.hold('store.hold-before-commit').then(() => {
          released = true;
          return undefined;
        });
        clock.runPending();
        await faults.hold('store.hold-before-commit');
        expect(released).toBe(false);
        if (method === 'point') faults.arm({ point: 'store.hold-before-commit', count: 0 });
        else faults.disarmAll();
        await waiting;
        expect(released).toBe(true);
        const production = registry({ nodeEnv: 'production' }).faults;
        expect(production.arm({ point: 'store.hold-before-commit' }).armed).toBe(false);
        await production.hold('store.hold-before-commit');
      },
    );

    it('delay() waits the armed duration through the injected clock, and not at all otherwise', async () => {
      const { faults, clock } = registry();
      let resolved = false;
      faults.arm({ point: 'store.slow', arg: 3000 });
      const waiting = faults.delay('store.slow').then((): undefined => {
        resolved = true;
        return undefined;
      });
      expect(resolved).toBe(false);
      clock.runPending();
      await waiting;
      expect(resolved).toBe(true);

      // Unarmed: no timer, no await of a pending one.
      faults.disarmAll();
      await faults.delay('store.slow');
    });

    it('crash() SIGKILLs only when the point is armed', () => {
      const armed = registry();
      expect(armed.kills).toBe(0);
      armed.faults.crash('store.crash-after-commit-before-ack');
      expect(armed.kills).toBe(0);
      armed.faults.arm({ point: 'store.crash-after-commit-before-ack' });
      armed.faults.crash('store.crash-after-commit-before-ack');
      expect(armed.kills).toBe(1);
    });

    it('maybeThrow() raises the caller’s error only when the point is armed', () => {
      const { faults } = registry();
      expect(() => faults.maybeThrow('store.throw', BOOM)).not.toThrow();
      faults.arm({ point: 'store.throw', count: 1 });
      expect(() => faults.maybeThrow('store.throw', BOOM)).toThrow('store.throw');
      expect(() => faults.maybeThrow('store.throw', BOOM)).not.toThrow();
    });
  });
});
