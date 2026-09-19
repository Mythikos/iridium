/**
 * How the auth surfaces write to the audit chain (04-auth-and-access-control.md section 11;
 * D04-16; D04-17).
 *
 * The chain itself — the HMAC, the locked head row, `verify-chain` — is the audit plugin's (boot
 * step 6, `apps/server/src/audit/chain.ts`), and the event vocabulary this area writes is that
 * module's `AuditEventInput`: column names, never a second spelling. What this module owns is the
 * two rules that are the auth surfaces' own:
 *
 *  - **Bounded failure auditing.** `user.login.failed` is written at most once per
 *    `(email_key, ip)` per 60 s and `token.denied` at most once per token id per 10 min, always on
 *    the first failure of a key and always when a block is applied. Every audit insert locks a
 *    chain head, so an anonymous caller must never be able to serialise every writer; the metrics
 *    and the pino line keep the full volume.
 *  - **Salted email hashes.** A failed login records `emailKeyHash`, an HMAC of the address under
 *    the current pepper, and names the account in `actor_display` only when it exists, so a typo
 *    storm cannot fill the permanent history with third-party addresses.
 *
 * `AuditRecorder` is the one member of the writer these routes call, stated structurally so this
 * area is written against the plan's contract (`record(trx, event)` inside the mutating
 * transaction) and the `rest` plugin composes it with the instance's writer: `applyAuthRoutes(app,
 * { audit: app.audit })`.
 */
import { createHmac } from 'node:crypto';

import type { Kysely, Transaction } from 'kysely';

import type { AuditEventContext, AuditEventInput } from '../audit/chain.ts';
import type { Database } from '../db/index.ts';

export type { AuditEventContext, AuditEventInput };

/** The one member of the audit plugin's writer these routes call. */
export interface AuditRecorder {
  record(trx: Transaction<Database>, event: AuditEventInput): Promise<unknown>;
}

/** One key's dedupe state for a bounded failure event. */
interface FailureWindow {
  lastWrittenAt: number;
}

/**
 * Deduplicates a bounded failure event per key per window (D04-16). Entries are pruned on every
 * call, so the map is bounded by the number of distinct keys seen inside one window.
 */
export class FailureAuditGate {
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, FailureWindow>();

  constructor(windowMs: number, now: () => number) {
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /**
   * Whether a row should be written now. `force` is the "always written" case (a block applied or
   * lifted): it writes and resets the window.
   */
  shouldWrite(key: string, force: boolean = false): boolean {
    const nowMs = this.#now();
    for (const [seenKey, window] of this.#seen) {
      if (nowMs - window.lastWrittenAt >= this.#windowMs) this.#seen.delete(seenKey);
    }
    const window = this.#seen.get(key);
    if (!force && window !== undefined) return false;
    this.#seen.set(key, { lastWrittenAt: nowMs });
    return true;
  }

  /** Keys currently inside their window. @internal */
  get size(): number {
    return this.#seen.size;
  }
}

/** `user.login.failed`: at most one row per `(email_key, ip)` per 60 s (D04-16). */
export const LOGIN_FAILED_AUDIT_WINDOW_MS = 60_000;

/** `token.denied`: at most one row per token id per 10 min (D04-16). */
export const TOKEN_DENIED_AUDIT_WINDOW_MS = 600_000;

/** Hex characters of the salted email hash recorded on `user.login.failed`. */
const EMAIL_HASH_HEX_CHARS = 32;

/**
 * The salted hash of a submitted address (D04-17): HMAC-SHA256 under the current pepper, truncated,
 * so an auditor can correlate attempts against one address without the history naming it.
 */
export function emailKeyAuditHash(emailKey: string, pepper: Uint8Array): string {
  return createHmac('sha256', pepper)
    .update(emailKey, 'utf8')
    .digest('hex')
    .slice(0, EMAIL_HASH_HEX_CHARS);
}

/**
 * The sink the authenticate hook and the routes write failure events through when no mutation
 * transaction exists. It is bound to the audit writer late — the audit plugin is boot step 6 and
 * this area is step 4 — and until it is bound, a failure that would have been audited is only
 * logged, which the caller's SIEM line already covers.
 */
export class DetachedAuditSink {
  #recorder: AuditRecorder | null = null;
  readonly #db: () => Kysely<Database> | null;

  constructor(db: () => Kysely<Database> | null) {
    this.#db = db;
  }

  /** Binds the writer. Called once by whoever composes the auth routes. */
  bind(recorder: AuditRecorder): void {
    this.#recorder = recorder;
  }

  /** Whether a writer is bound. */
  get bound(): boolean {
    return this.#recorder !== null;
  }

  /** Writes one event in its own transaction. Answers `false` when nothing could be written. */
  async record(event: AuditEventInput): Promise<boolean> {
    const recorder = this.#recorder;
    const db = this.#db();
    if (recorder === null || db === null) return false;
    await db.transaction().execute((trx) => recorder.record(trx, event));
    return true;
  }
}
