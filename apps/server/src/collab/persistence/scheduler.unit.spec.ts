/**
 * `collab.scheduler.unit` — the round-robin over the persist pool (05-collaboration-and-durability.md,
 * "Global fairness and the persist pool"): at most `slots` turns at once, FIFO admission, a writer that
 * still has work rejoins the back of the ring, and one pathological writer cannot starve the others.
 */
import { describe, expect, it } from 'vitest';

import { WriterScheduler, type Schedulable } from './scheduler.ts';

interface FakeWriter extends Schedulable {
  readonly name: string;
  turns: number;
  work: number;
  release(): void;
  readonly running: boolean;
}

function fakeWriter(name: string, work: number, log: string[]): FakeWriter {
  let running = false;
  let release: (() => void) | null = null;
  const writer: FakeWriter = {
    name,
    turns: 0,
    work,
    get running(): boolean {
      return running;
    },
    release: () => release?.(),
    hasWork: () => writer.work > 0,
    runOne: async () => {
      running = true;
      writer.turns += 1;
      writer.work -= 1;
      log.push(name);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      running = false;
    },
  };
  return writer;
}

const NO_LOG = { error: (): void => undefined };

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('collab.scheduler.unit [area:collab]', () => {
  it('hands out at most `slots` turns at once and admits in FIFO order', async () => {
    const log: string[] = [];
    const scheduler = new WriterScheduler(2, NO_LOG);
    const writers = ['a', 'b', 'c'].map((name) => fakeWriter(name, 1, log));
    for (const writer of writers) scheduler.ready(writer);
    await tick();
    expect(log).toEqual(['a', 'b']);
    expect(scheduler.running).toBe(2);
    expect(scheduler.waiting).toBe(1);
    writers[0]?.release();
    await tick();
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('sends a writer with remaining work to the back of the ring: round-robin, no starvation', async () => {
    const log: string[] = [];
    const scheduler = new WriterScheduler(1, NO_LOG);
    const hog = fakeWriter('hog', 3, log);
    const quiet = fakeWriter('quiet', 1, log);
    scheduler.ready(hog);
    scheduler.ready(quiet);
    for (let step = 0; step < 4; step += 1) {
      // eslint-disable-next-line no-await-in-loop -- one turn per iteration, sequential by design
      await tick();
      const running = [hog, quiet].find((writer) => writer.running);
      running?.release();
    }
    await tick();
    expect(log).toEqual(['hog', 'quiet', 'hog', 'hog']);
  });

  it('ignores a second ready() for a writer already queued or running', async () => {
    const log: string[] = [];
    const scheduler = new WriterScheduler(1, NO_LOG);
    const writer = fakeWriter('w', 1, log);
    scheduler.ready(writer);
    scheduler.ready(writer);
    await tick();
    expect(scheduler.waiting).toBe(0);
    expect(log).toEqual(['w']);
    writer.release();
    await tick();
    expect(writer.turns).toBe(1);
  });

  it('forgets a queued writer and resolves idle() once everything finished', async () => {
    const log: string[] = [];
    const scheduler = new WriterScheduler(1, NO_LOG);
    const first = fakeWriter('first', 1, log);
    const second = fakeWriter('second', 1, log);
    scheduler.ready(first);
    scheduler.ready(second);
    scheduler.forget(second);
    await tick();
    expect(scheduler.waiting).toBe(0);
    let idle = false;
    const waiting = (async (): Promise<void> => {
      await scheduler.idle();
      idle = true;
    })();
    await tick();
    expect(idle).toBe(false);
    first.release();
    await waiting;
    expect(idle).toBe(true);
    expect(log).toEqual(['first']);
  });

  it('keeps the ring turning when a writer turn rejects, and logs the bug', async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const scheduler = new WriterScheduler(1, { error: (fields) => void errors.push(fields) });
    const broken: Schedulable = {
      hasWork: () => false,
      runOne: () => Promise.reject(new Error('turn failed')),
    };
    const healthy = fakeWriter('healthy', 1, log);
    scheduler.ready(broken);
    scheduler.ready(healthy);
    await tick();
    await tick();
    expect(errors).toHaveLength(1);
    expect(log).toEqual(['healthy']);
    healthy.release();
  });
});
