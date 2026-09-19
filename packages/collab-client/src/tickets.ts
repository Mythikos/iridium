/**
 * The provider's `token` getter (09-api-reference.md section 3.2; 05-collaboration-and-durability.md,
 * *Reconnection semantics*).
 *
 * A ticket is a single-use 60 s credential that travels in the Hocuspocus **auth message** and never
 * in the URL (skeleton A24), so every document attachment and every reconnect needs a fresh one. The
 * batch itself belongs to whoever owns the REST client — `POST /api/v1/auth/collab-tickets` returns
 * up to `LIMITS.TICKET_BATCH_MAX` of them, which is why a window with a dozen open notes makes one
 * request rather than a dozen — and reaches this package as a `TicketSource`.
 *
 * What this module owns is the retry the plan requires of the getter: three retries with backoff on
 * a `429` or a network failure, "so a transient ticket outage never closes a healthy connection".
 * The retry lives here rather than in the source because the provider calls the getter on every
 * socket open, and a single failed call is answered by the provider with `authenticationFailed` —
 * that is, a document that is up would go down for a rate limit that clears in a second.
 */

import type { CollabClock } from './clock.ts';

/**
 * Why a ticket could not be obtained.
 *
 * `status` is what decides a retry, so it is part of the contract rather than a message a caller has
 * to parse: `429` and a `null` status (no response at all — DNS, a dropped socket, a timeout) are
 * the two transient cases 09-api-reference.md section 3.2 names. Anything else — a `401` from an
 * expired session, a `403` from a revoked one — is a decision the server has made and retrying it
 * would only spend the caller's rate budget.
 */
export class CollabTicketError extends Error {
  /** The HTTP status the ticket request answered with, or `null` when no response arrived. */
  readonly status: number | null;

  constructor(
    message: string,
    options: { readonly status: number | null; readonly cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CollabTicketError';
    this.status = options.status;
  }
}

/** The batch of collaboration tickets, owned by whoever owns the REST client. */
export interface TicketSource {
  /**
   * One unused ticket, refilling the batch when it runs low. Rejects with a `CollabTicketError`
   * when the batch could not be refilled.
   */
  next(): Promise<string>;
  /**
   * Discard the unused tickets from the rejected ticket's batch. A server restart invalidates its
   * in-memory ticket store; retrying with the next cached ticket would repeat the same refusal.
   * A late rejection from an older batch must not discard its replacement.
   */
  invalidate(rejectedTicket: string): void;
}

/** Retries after the first attempt, per 09-api-reference.md section 3.2 ("retries three times"). */
const TICKET_RETRY_ATTEMPTS = 3;

/**
 * The first backoff step, doubling per retry: 200 ms, 400 ms, 800 ms before the three retries.
 *
 * The plan fixes the count and not the ladder. These are the two numbers that make the ladder
 * shorter than the ticket TTL (`LIMITS.TICKET_TTL_S`) by an order of magnitude, so a ticket drawn
 * before the first attempt is still valid when the last one sends it, and shorter than the socket's
 * own 1 s reconnect delay, so a getter that will fail anyway does not hold the socket open longer
 * than a reconnect would have taken.
 */
const TICKET_RETRY_STEP_MS = 200;
const TICKET_RETRY_FACTOR = 2;

/** Is this rejection one of the two transient cases the getter retries? */
export function isRetryableTicketFailure(reason: unknown): boolean {
  if (!(reason instanceof CollabTicketError)) return false;
  return reason.status === null || reason.status === 429;
}

/** What `createTicketGetter` needs. */
export interface TicketGetterOptions {
  readonly source: TicketSource;
  readonly clock: CollabClock;
  /**
   * Injected for the same reason the clock is: a jittered ladder that draws from a global cannot be
   * asserted. Pass a constant for the deterministic ladder.
   */
  readonly random?: () => number;
}

/**
 * The `token` option of a `HocuspocusProvider`: one fresh ticket per call, retried three times with
 * jittered backoff on a `429` or a network failure.
 *
 * A rejection is left to the provider, which turns it into `authenticationFailed` for that document
 * alone — the shared socket and the window's other notes are unaffected, which is the property the
 * per-document ticket exists for.
 */
export function createTicketGetter(options: TicketGetterOptions): () => Promise<string> {
  const random = options.random ?? Math.random;
  return async (): Promise<string> => {
    let attempt = 0;
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop -- each attempt exists because the last failed
        return await options.source.next();
      } catch (error) {
        if (attempt >= TICKET_RETRY_ATTEMPTS || !isRetryableTicketFailure(error)) throw error;
        const window = TICKET_RETRY_STEP_MS * TICKET_RETRY_FACTOR ** attempt;
        attempt += 1;
        // eslint-disable-next-line no-await-in-loop -- the backoff is the point of the loop
        await sleep(options.clock, Math.round(window * random()));
      }
    }
  };
}

/** A cancel-free delay on the injected clock: nothing in this package waits on a global timer. */
function sleep(clock: CollabClock, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.after(ms, resolve);
  });
}
