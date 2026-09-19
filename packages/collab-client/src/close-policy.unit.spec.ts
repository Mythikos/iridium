/**
 * `close-policy.unit` — what the client does after a per-document close
 * (05-collaboration-and-durability.md, *Client state machine* mapping table and *Reconnection
 * semantics*; 09-api-reference.md section 3.6).
 *
 * The policy is the half of a close that has consequences: a reason classified as transient when it
 * is terminal produces the close/reconnect loop the plan names as the failure mode, and a reason
 * classified as terminal when it is transient leaves a note dead until the user reloads. The table
 * below is the plan's mapping column, written out, and the backoff assertions are the ladder D05-06
 * fixes.
 */

import { COLLAB_CLOSE_REASONS, type CollabCloseReason } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { reattachDelayMs } from './clock.ts';
import { type ClosePolicy, closePolicy } from './close-policy.ts';

/** The reasons the plan calls terminal for the document: the provider is destroyed, never retried. */
const TERMINAL: readonly CollabCloseReason[] = [
  'revoked',
  'awareness-spoof',
  'protocol-error',
  'too-large',
  'note-trashed',
  'note-not-found',
  'vault-archived',
];

/** The reasons that come back on their own, with the backoff ladder of D05-06. */
const TRANSIENT: readonly CollabCloseReason[] = [
  'capacity',
  'unavailable',
  'no-owner-lease',
  'shutdown',
];

describe('close-policy.unit [area:collab]', () => {
  it('decides every close reason the contract declares', () => {
    for (const reason of COLLAB_CLOSE_REASONS) {
      const policy: ClosePolicy = closePolicy(reason, 'close-frame');
      expect(['never', 'once', 'repeat']).toContain(policy.reattach);
      expect(['immediate', 'backoff', 'grace']).toContain(policy.when);
    }
  });

  it.each(TERMINAL)('never re-attaches after %s', (reason) => {
    expect(closePolicy(reason, 'close-frame').reattach).toBe('never');
  });

  it.each(TRANSIENT)('re-attaches %s with backoff until it succeeds', (reason) => {
    expect(closePolicy(reason, 'close-frame')).toEqual({
      reattach: 'repeat',
      when: 'backoff',
      dormant: false,
      probesSession: false,
    });
  });

  it('re-attaches once with fresh tickets after a routine ticket expiry', () => {
    expect(closePolicy('unauthorized', 'auth-denied')).toEqual({
      reattach: 'once',
      when: 'immediate',
      dormant: false,
      probesSession: true,
    });
  });

  it('waits out the grace window a coordinated trash asked for', () => {
    expect(closePolicy('note-closing', 'close-frame')).toEqual({
      reattach: 'repeat',
      when: 'grace',
      dormant: false,
      probesSession: false,
    });
  });

  it('re-checks the session after the two reasons that can mean it ended', () => {
    const probing = COLLAB_CLOSE_REASONS.filter(
      (reason) => closePolicy(reason, 'close-frame').probesSession,
    );
    // Neither close is evidence about the session — one `GET /auth/me` is (D07-40) — but these are
    // the two that can mean it ended, so they are the two that ask.
    expect([...probing]).toEqual(['unauthorized', 'revoked']);
  });

  it('keeps the two policies of one rate-limited reason apart (D05-25)', () => {
    expect(closePolicy('rate-limited', 'close-frame')).toEqual({
      reattach: 'once',
      when: 'backoff',
      dormant: false,
      probesSession: false,
    });
    // The per-user attachment cap is still full, so every retry would be refused again: the note
    // goes dormant and a human frees an attachment by pausing a note in another window.
    expect(closePolicy('rate-limited', 'auth-denied')).toEqual({
      reattach: 'never',
      when: 'immediate',
      dormant: true,
      probesSession: false,
    });
  });

  it('is the same policy whether or not a reason without a second policy arrived as a denial', () => {
    for (const reason of COLLAB_CLOSE_REASONS) {
      if (reason === 'rate-limited') continue;
      expect(closePolicy(reason, 'auth-denied')).toEqual(closePolicy(reason, 'close-frame'));
    }
  });

  describe('the re-attach ladder', () => {
    const FLOOR_MS = 5_000;
    const CEILING_MS = 60_000;

    it('draws the delay from the whole window, floor included', () => {
      expect(reattachDelayMs(1, () => 0)).toBe(FLOOR_MS);
      expect(reattachDelayMs(1, () => 1)).toBe(FLOOR_MS);
      expect(reattachDelayMs(2, () => 1)).toBe(2 * FLOOR_MS);
      expect(reattachDelayMs(2, () => 0)).toBe(FLOOR_MS);
    });

    it('doubles up to the ceiling and never above it', () => {
      for (let attempt = 1; attempt <= 20; attempt += 1) {
        const longest = reattachDelayMs(attempt, () => 1);
        expect(longest).toBeGreaterThanOrEqual(FLOOR_MS);
        expect(longest).toBeLessThanOrEqual(CEILING_MS);
      }
      expect(reattachDelayMs(5, () => 1)).toBe(CEILING_MS);
      expect(reattachDelayMs(12, () => 1)).toBe(CEILING_MS);
    });

    it('is monotone in the attempt count, so a longer outage waits longer', () => {
      for (let attempt = 1; attempt < 12; attempt += 1) {
        expect(reattachDelayMs(attempt + 1, () => 1)).toBeGreaterThanOrEqual(
          reattachDelayMs(attempt, () => 1),
        );
      }
    });

    it('jitters, so a restarted server is not met by a thundering herd', () => {
      const spread = new Set([0.1, 0.3, 0.5, 0.9].map((draw) => reattachDelayMs(4, () => draw)));
      expect(spread.size).toBe(4);
    });
  });
});
