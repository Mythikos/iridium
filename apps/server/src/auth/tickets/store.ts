/**
 * Collaboration tickets (04-auth-and-access-control.md section 7; A24; A26; ARCH-19).
 *
 * A ticket is a short-lived, single-use, server-side credential presented inside the Hocuspocus
 * auth message after the socket is open. It is not ambient, not replayable, and it binds the
 * connection to a concrete `{sessionId, userId}` — never to a document name — so the revocation
 * machinery of section 8 can address it and `onAuthenticate` always re-resolves the document.
 *
 * `TicketStore` is the interface; `InMemoryTicketStore` is the MVP binding (a `Map` keyed by the
 * public id, holding the SHA-256 of the secret). A process restart empties it and providers fetch
 * new tickets. `ticket-store.contract` is the suite any future implementation must pass unchanged.
 *
 * `consume()` deletes the entry *before* checking the secret and the expiry (section 7.3): a
 * replay of the same ticket always fails, an observed id cannot be kept alive by submitting wrong
 * secrets, and a racing double-use resolves to exactly one winner because `Map.delete` is atomic on
 * the single-threaded loop.
 */
import { mintToken, parseToken, type SessionId, type UserId } from '@iridium/contracts';

import type { Clock, TimerHandle } from '../../ops/clock.ts';
import { secretHash, secretMatches } from '../secret-hash.ts';

/** What a ticket proves: this socket belongs to live session `sessionId` of user `userId`. */
export interface TicketBinding {
  readonly sessionId: SessionId;
  readonly userId: UserId;
}

/** The store every ticket producer and consumer is written against. */
export interface TicketStore {
  /** Mints `count` tickets bound to one session; the raw credentials are returned exactly once. */
  issue(binding: TicketBinding, count: number): readonly string[];
  /** Single use: the entry is removed whether or not the checks pass. */
  consume(raw: string): TicketBinding | null;
  /** Drops every outstanding ticket of a session (the bus subscriber of section 8.3). */
  revokeSession(sessionId: SessionId): number;
  /** Drops every outstanding ticket of a user, except those of `keep` when given. */
  revokeUser(userId: UserId, keep?: SessionId): number;
  /** Outstanding tickets, expired ones included until the next sweep or lookup. */
  readonly size: number;
  /** Evict expired entries on a maintenance tick as well as the low-latency local timer. */
  sweepExpired(): number;
  /** Stops the sweep timer. The owner calls it once, on shutdown. */
  close(): void;
}

interface TicketEntry {
  readonly secretHash: Buffer;
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly expiresAt: number;
}

/** What the in-memory store needs. Numbers arrive from configuration and `LIMITS`. */
export interface InMemoryTicketStoreOptions {
  readonly clock: Clock;
  /** `COLLAB_TICKET_TTL_S`, default `LIMITS.TICKET_TTL_S`, in milliseconds. */
  readonly ttlMs: number;
  /** How often expired entries are swept; section 7.2 says every 10 s. */
  readonly sweepIntervalMs: number;
}

/** The MVP store: a `Map` in this process (03-data-model.md section 3). */
export class InMemoryTicketStore implements TicketStore {
  readonly #entries = new Map<string, TicketEntry>();
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #sweep: TimerHandle | null;

  constructor(options: InMemoryTicketStoreOptions) {
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs;
    this.#sweep = options.clock.every(options.sweepIntervalMs, () => {
      this.sweepExpired();
    });
  }

  get size(): number {
    return this.#entries.size;
  }

  issue(binding: TicketBinding, count: number): readonly string[] {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(`ticket count must be a positive integer, received ${String(count)}`);
    }
    const expiresAt = this.#clock.now() + this.#ttlMs;
    const tickets: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const minted = mintToken('tkt');
      this.#entries.set(minted.tokenId, {
        secretHash: secretHash(minted.secret),
        sessionId: binding.sessionId,
        userId: binding.userId,
        expiresAt,
      });
      tickets.push(minted.raw);
    }
    return tickets;
  }

  consume(raw: string): TicketBinding | null {
    const parsed = parseToken(raw);
    if (parsed === null || parsed.kind !== 'tkt') return null;
    const entry = this.#entries.get(parsed.tokenId);
    if (entry === undefined) return null;
    this.#entries.delete(parsed.tokenId);
    if (!secretMatches(parsed.secret, entry.secretHash)) return null;
    if (this.#clock.now() >= entry.expiresAt) return null;
    return { sessionId: entry.sessionId, userId: entry.userId };
  }

  revokeSession(sessionId: SessionId): number {
    return this.#drop((entry) => entry.sessionId === sessionId);
  }

  revokeUser(userId: UserId, keep?: SessionId): number {
    return this.#drop((entry) => entry.userId === userId && entry.sessionId !== keep);
  }

  /** Removes expired entries; also run lazily by `consume`. Answers how many were dropped. */
  sweepExpired(): number {
    const now = this.#clock.now();
    return this.#drop((entry) => now >= entry.expiresAt);
  }

  close(): void {
    this.#sweep?.cancel();
    this.#sweep = null;
  }

  #drop(predicate: (entry: TicketEntry) => boolean): number {
    let dropped = 0;
    for (const [tokenId, entry] of this.#entries) {
      if (predicate(entry)) {
        this.#entries.delete(tokenId);
        dropped += 1;
      }
    }
    return dropped;
  }
}
