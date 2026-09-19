/**
 * The injected clock of the collaboration client.
 *
 * Every deadline the client owns — the baseline re-request of D05-05, the re-attach backoff of
 * D05-06, the ticket retry, the registry's release delay — is scheduled through a `CollabClock` that
 * its owner passes in, so a test drives them without sleeping (docs/repository-guide.md, *Concurrency*;
 * 10-testing-and-quality.md, deterministic time). Nothing in this package reads wall time or calls a
 * global timer except `systemCollabClock` below.
 *
 * The interface is this package's own rather than the server's `apps/server/src/ops/clock.ts`: that
 * one is a `server` module an `iso` package may not import, and it carries `date()` and `monotonic()`
 * for `DATETIME(6)` parameters and readiness probes, which no client deadline needs.
 */

/** A cancellable timer handle, free of any host's timer type so a fake clock can return one. */
export interface CollabTimer {
  cancel(): void;
}

/** Wall time and timers, injected. */
export interface CollabClock {
  /** Milliseconds since the Unix epoch — the `now` a `tick` event carries. */
  now(): number;
  /** Runs `fn` once after `ms`; the handle cancels it. */
  after(ms: number, fn: () => void): CollabTimer;
}

/**
 * The host's real timers.
 *
 * `@iridium/collab-client` compiles with `lib: ["es2024"]` and `types: []` — it must run in a
 * browser, in Electron's renderer and in Node without declaring any of them — so neither the DOM's
 * nor Node's `setTimeout` declaration is in scope, and the two globals every one of those hosts does
 * provide are reached through one narrowed view of `globalThis`. This is the only place in the
 * package that touches a global.
 */
interface HostTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// The package declares no host library, so the two timer globals every supported host provides are
// narrowed here, once.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
const HOST_TIMERS = globalThis as unknown as HostTimers;

/** The real clock, for a host that has no reason to supply its own. */
export const systemCollabClock: CollabClock = Object.freeze({
  now(): number {
    return Date.now();
  },
  after(ms: number, fn: () => void): CollabTimer {
    const handle = HOST_TIMERS.setTimeout(fn, ms);
    return {
      cancel: (): void => {
        HOST_TIMERS.clearTimeout(handle);
      },
    };
  },
});

/**
 * The exponential backoff ladder the client re-attaches a document on: 5 s doubling to 60 s, with
 * jitter (05-collaboration-and-durability.md D05-06, *Client state machine* rule 3).
 *
 * `attempt` is 1-based. The jitter is drawn over the whole window rather than added to it, so a
 * thousand clients whose server restarted do not re-attach in the same 50 ms.
 */
const REATTACH_BACKOFF_FLOOR_MS = 5_000;
const REATTACH_BACKOFF_CEILING_MS = 60_000;

/**
 * The delay before re-attach attempt `attempt`, in milliseconds.
 *
 * `random` is injected for the same reason the clock is: a retry ladder that draws from a global
 * cannot be asserted. Pass a constant to get the deterministic ladder.
 */
export function reattachDelayMs(attempt: number, random: () => number): number {
  const uncapped = REATTACH_BACKOFF_FLOOR_MS * 2 ** Math.max(0, attempt - 1);
  const window = Math.min(uncapped, REATTACH_BACKOFF_CEILING_MS);
  return Math.round(REATTACH_BACKOFF_FLOOR_MS + (window - REATTACH_BACKOFF_FLOOR_MS) * random());
}
