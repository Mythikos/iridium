/**
 * The two host seams `note-session.unit` drives: a clock a test advances by hand, and a ticket
 * source whose answers a test dictates.
 *
 * 10-testing-and-quality.md, *Time*: a deadline is asserted by advancing an injected clock and never
 * by sleeping, which is why `NoteSession` takes a `CollabClock` and reads no wall time of its own.
 * `setTimeout` sleeps are banned in test files for the same reason.
 */

import type { CollabClock, CollabTimer } from '../src/clock.ts';
import { CollabTicketError, type TicketSource } from '../src/tickets.ts';

interface ScheduledTask {
  readonly at: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** Four microtask turns: enough for a timer's continuation to reach its next `await`. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Wall time and timers under the test's control. */
export class ManualClock implements CollabClock {
  #now: number;
  readonly #tasks: ScheduledTask[] = [];

  constructor(startAt = 1_000) {
    this.#now = startAt;
  }

  now(): number {
    return this.#now;
  }

  after(ms: number, fn: () => void): CollabTimer {
    const task: ScheduledTask = { at: this.#now + ms, fn, cancelled: false };
    this.#tasks.push(task);
    return {
      cancel: (): void => {
        task.cancelled = true;
      },
    };
  }

  /** How many timers are armed and still live, so a test can prove one was cancelled. */
  get armed(): number {
    return this.#tasks.filter((task) => !task.cancelled).length;
  }

  /**
   * Run every timer due within `ms`, in order, letting each one's continuation run before the next
   * timer is considered — which is how a real event loop orders them, and what makes a retry ladder
   * that re-arms from inside a callback observable.
   */
  async advance(ms: number): Promise<void> {
    // Let whatever is already in flight arm its timer before time moves: a retry ladder schedules
    // its next wait from inside the rejection handler, one microtask after the attempt failed.
    await settle();
    const target = this.#now + ms;
    for (;;) {
      const next = this.#nextDue(target);
      if (next === undefined) break;
      this.#now = next.at;
      next.cancelled = true;
      next.fn();
      // eslint-disable-next-line no-await-in-loop -- a timer's continuation runs before the next
      await settle();
    }
    this.#now = target;
    await settle();
  }

  #nextDue(target: number): ScheduledTask | undefined {
    let best: ScheduledTask | undefined;
    for (const task of this.#tasks) {
      if (task.cancelled || task.at > target) continue;
      if (best === undefined || task.at < best.at) best = task;
    }
    return best;
  }
}

/** A ticket source whose answers the test dictates, in order. */
export class ScriptedTickets implements TicketSource {
  readonly issued: string[] = [];
  readonly invalidated: string[] = [];

  invalidate(ticket: string): void {
    this.invalidated.push(ticket);
  }
  #answers: (string | CollabTicketError)[];

  constructor(answers: (string | CollabTicketError)[] = []) {
    this.#answers = answers;
  }

  /** Queue the next answers, replacing whatever is left. */
  script(answers: (string | CollabTicketError)[]): void {
    this.#answers = answers;
  }

  next(): Promise<string> {
    const answer = this.#answers.shift();
    if (answer === undefined) {
      const ticket = `irid_tkt_${String(this.issued.length + 1)}`;
      this.issued.push(ticket);
      return Promise.resolve(ticket);
    }
    if (answer instanceof CollabTicketError) return Promise.reject(answer);
    this.issued.push(answer);
    return Promise.resolve(answer);
  }
}
