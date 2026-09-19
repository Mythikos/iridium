/**
 * Collaboration tickets (10-testing-and-quality.md, "Seeding, tickets, sessions";
 * 09-api-reference.md §2.1 and §3.2; 04-auth-and-access-control.md §7.3).
 *
 * A ticket is a single-use credential bound to `{sessionId, userId}` that lives `TICKET_TTL_S`
 * seconds and travels in the Hocuspocus auth message, never in the URL (skeleton A24). There is no
 * test-only mint: `guards.no-test-auth.guard` greps `apps/server/src/auth` for any `NODE_ENV` branch,
 * so the harness draws its tickets from `POST /api/v1/auth/collab-tickets` with a real session,
 * exactly as the product client does.
 *
 * `restTicketSource` is what makes `NoteClient` the product's client rather than a facsimile: it is
 * the `TicketSource` the product's own `NoteSession` takes, so the retry ladder, the batch refill and
 * the `429` classification under test are `@iridium/collab-client`'s and not the harness's.
 */

import {
  CollabTicketError,
  systemCollabClock,
  type CollabClock,
  type TicketSource,
} from '@iridium/collab-client';
import { LIMITS } from '@iridium/contracts';

import type { RestClient } from '../clients/rest-client.ts';

/** `POST /api/v1/auth/collab-tickets`, relative to the client's `basePath`. */
export const COLLAB_TICKETS_PATH = '/auth/collab-tickets';

/** The response body of `auth.createCollabTickets`. */
interface TicketsCreated {
  readonly tickets: readonly string[];
  readonly expiresIn: number;
}

function isTicketsCreated(body: unknown): body is TicketsCreated {
  return (
    typeof body === 'object' &&
    body !== null &&
    'tickets' in body &&
    Array.isArray(body.tickets) &&
    body.tickets.every((ticket: unknown) => typeof ticket === 'string') &&
    'expiresIn' in body &&
    body.expiresIn === LIMITS.TICKET_TTL_S
  );
}

/**
 * Mint a batch through the real route.
 *
 * A refusal is raised as a `CollabTicketError` carrying the HTTP status rather than a bare `Error`,
 * because that status is what `@iridium/collab-client`'s getter retries on (`429` and a network
 * failure) and what it refuses to retry (`401`, `403`). Losing it here would make the harness's
 * failure mode differ from the product's.
 */
export async function issueTickets(rest: RestClient, count = 1): Promise<readonly string[]> {
  return (await requestTicketBatch(rest, count)).tickets;
}

/** Preserve the server's TTL for clients that retain unused tickets between attachments. */
async function requestTicketBatch(rest: RestClient, count: number): Promise<TicketsCreated> {
  if (!Number.isInteger(count) || count < 1 || count > LIMITS.TICKET_BATCH_MAX) {
    throw new Error(
      `@iridium/testkit: a ticket batch is 1..${String(LIMITS.TICKET_BATCH_MAX)} (LIMITS.TICKET_BATCH_MAX), got ${String(count)}`,
    );
  }
  let response;
  try {
    response = await rest.post(COLLAB_TICKETS_PATH, { json: { count } });
  } catch (error) {
    // No response arrived at all, which is the `status: null` case the getter treats as transient.
    throw new CollabTicketError(`@iridium/testkit: ${COLLAB_TICKETS_PATH} did not answer`, {
      status: null,
      cause: error,
    });
  }
  if (response.status !== 201) {
    throw new CollabTicketError(
      `@iridium/testkit: ${COLLAB_TICKETS_PATH} answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
      { status: response.status },
    );
  }
  if (!isTicketsCreated(response.body)) {
    throw new CollabTicketError(
      `@iridium/testkit: ${COLLAB_TICKETS_PATH} answered 201 with an invalid ticket batch or lifetime`,
      { status: response.status },
    );
  }
  return response.body;
}

export interface RestTicketSourceOptions {
  /** How many tickets one refill asks for. Defaults to 5, which covers a reconnect ladder. */
  readonly batch?: number;
  /** Same clock domain across refills; expiry starts before the request, never after its latency. */
  readonly clock?: Pick<CollabClock, 'now'>;
}

/**
 * The `TicketSource` a `NoteSession` takes: pop one, refill when empty.
 *
 * Concurrent `next()` calls share one refill — a window with several notes attaching at once is the
 * ordinary case, and one request per attachment is exactly what the batch route exists to avoid.
 */
export function restTicketSource(
  rest: RestClient,
  options: RestTicketSourceOptions = {},
): TicketSource {
  const batch = options.batch ?? 5;
  const clock = options.clock ?? systemCollabClock;
  let expiresAt = 0;
  const unused: string[] = [];
  let refilling: Promise<void> | null = null;
  let currentBatch = new Set<string>();

  const refill = async (): Promise<void> => {
    const startedAt = clock.now();
    const response = await requestTicketBatch(rest, batch);
    const issued = response.tickets;
    const deadline = startedAt + response.expiresIn * 1_000;
    if (clock.now() >= deadline) {
      throw new CollabTicketError('@iridium/testkit: the ticket batch expired in transit', {
        status: null,
      });
    }
    if (issued.length === 0) {
      throw new CollabTicketError('@iridium/testkit: the ticket batch came back empty', {
        status: null,
      });
    }
    currentBatch = new Set(issued);
    expiresAt = deadline;
    unused.push(...issued);
  };

  return {
    invalidate(rejectedTicket: string): void {
      if (!currentBatch.has(rejectedTicket)) return;
      unused.length = 0;
      currentBatch.clear();
    },
    async next(): Promise<string> {
      for (;;) {
        if (clock.now() >= expiresAt) {
          unused.length = 0;
          currentBatch.clear();
        }
        const ready = unused.shift();
        if (ready !== undefined) return ready;
        refilling ??= refill().finally(() => {
          refilling = null;
        });
        // eslint-disable-next-line no-await-in-loop -- concurrent callers may consume a whole batch
        await refilling;
      }
    },
  };
}

/**
 * A source that hands out exactly the tickets it was given, then refuses.
 *
 * This is how the single-use rule is tested: the same ticket is presented twice and the second
 * attachment must be refused `unauthorized`. The refusal after the list runs out carries
 * `status: 401`, which the getter does **not** retry, so a test that exhausts the list fails on the
 * assertion it wrote rather than on a retry ladder.
 */
export function fixedTicketSource(...tickets: readonly string[]): TicketSource {
  const remaining = [...tickets];
  return {
    invalidate(): void {
      // Scripted tickets deliberately reproduce refusals; there is no refillable cache.
    },
    next(): Promise<string> {
      const ticket = remaining.shift();
      if (ticket === undefined) {
        return Promise.reject(
          new CollabTicketError('@iridium/testkit: the scripted ticket list is exhausted', {
            status: 401,
          }),
        );
      }
      return Promise.resolve(ticket);
    },
  };
}
