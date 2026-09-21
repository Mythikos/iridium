/** Additional upload budget and simultaneous-stream cap (08 §9.7), after global REST admission. */
import { LIMITS } from '@iridium/contracts';

import type { Clock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';

const MINUTE_MS = 60_000;

/** Process-owned gate; scope is the principal and vault, never an attacker-selected filename. */
export class AttachmentUploadAdmission {
  readonly #clock: Clock;
  readonly #windows = new Map<string, { readonly until: number; count: number }>();
  #active = 0;
  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Returns an idempotent release callback. Refusals allocate no stream or temporary file. */
  enter(principalKey: string, vaultId: string): () => void {
    const now = this.#clock.now();
    for (const [key, window] of this.#windows) if (window.until <= now) this.#windows.delete(key);
    const key = `${principalKey}:${vaultId}`;
    let window = this.#windows.get(key);
    if (window === undefined) {
      if (this.#windows.size >= LIMITS.REST_RATE_LIMIT_CACHE_MAX_ENTRIES)
        throw new ProblemError('capacity', { retryAfterMs: MINUTE_MS });
      window = { until: now + MINUTE_MS, count: 0 };
      this.#windows.set(key, window);
    }
    if (window.count >= LIMITS.ATTACHMENT_UPLOADS_PER_MINUTE)
      throw new ProblemError('rate_limited', { retryAfterMs: window.until - now });
    if (this.#active >= LIMITS.ATTACHMENT_UPLOAD_CONCURRENCY)
      throw new ProblemError('capacity', { retryAfterMs: MINUTE_MS });
    window.count += 1;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}
