/**
 * `auth.audit-bounding.unit` (04-auth-and-access-control.md section 11.4; D04-16; D04-17): a
 * bounded failure event is written on the first failure of a key, once per window afterwards, and
 * always when a block is applied; the audited email hash is salted under the pepper and never the
 * address; and the detached sink writes nothing until a writer is bound.
 */
import { describe, expect, it } from 'vitest';

import {
  DetachedAuditSink,
  emailKeyAuditHash,
  FailureAuditGate,
  LOGIN_FAILED_AUDIT_WINDOW_MS,
  TOKEN_DENIED_AUDIT_WINDOW_MS,
} from './audit.ts';

describe('auth.audit-bounding.unit [area:auth]', () => {
  it('writes the first failure of a key, suppresses the rest of the window, and writes again after it', () => {
    let now = 0;
    const gate = new FailureAuditGate(LOGIN_FAILED_AUDIT_WINDOW_MS, () => now);
    expect(gate.shouldWrite('a')).toBe(true);
    expect(gate.shouldWrite('a')).toBe(false);
    expect(gate.shouldWrite('b')).toBe(true);
    expect(gate.size).toBe(2);
    now = LOGIN_FAILED_AUDIT_WINDOW_MS - 1;
    expect(gate.shouldWrite('a')).toBe(false);
    now = LOGIN_FAILED_AUDIT_WINDOW_MS;
    expect(gate.shouldWrite('a')).toBe(true);
    // Pruning keeps the map bounded by the keys seen inside one window.
    expect(gate.size).toBe(1);
  });

  it('always writes a forced event and resets the window from it', () => {
    let now = 0;
    const gate = new FailureAuditGate(LOGIN_FAILED_AUDIT_WINDOW_MS, () => now);
    expect(gate.shouldWrite('a')).toBe(true);
    now = 10;
    expect(gate.shouldWrite('a', true)).toBe(true);
    now = LOGIN_FAILED_AUDIT_WINDOW_MS + 5;
    expect(gate.shouldWrite('a')).toBe(false);
    now = LOGIN_FAILED_AUDIT_WINDOW_MS + 10;
    expect(gate.shouldWrite('a')).toBe(true);
  });

  it('states the two windows of D04-16', () => {
    expect(LOGIN_FAILED_AUDIT_WINDOW_MS).toBe(60_000);
    expect(TOKEN_DENIED_AUDIT_WINDOW_MS).toBe(600_000);
  });

  it('hashes the address under the pepper: stable per pepper, different per pepper, never the address', () => {
    const pepperA = new Uint8Array(32).fill(1);
    const pepperB = new Uint8Array(32).fill(2);
    const hash = emailKeyAuditHash('ada@example.test', pepperA);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(emailKeyAuditHash('ada@example.test', pepperA)).toBe(hash);
    expect(emailKeyAuditHash('ada@example.test', pepperB)).not.toBe(hash);
    expect(emailKeyAuditHash('bob@example.test', pepperA)).not.toBe(hash);
    expect(hash).not.toContain('ada');
  });

  it('writes nothing until a writer is bound, then one transaction per event', async () => {
    const sink = new DetachedAuditSink(() => null);
    expect(sink.bound).toBe(false);
    await expect(
      sink.record({
        action: 'user.login.failed',
        actorType: 'user',
        credentialType: 'none',
        outcome: 'failure',
        context: {},
      }),
    ).resolves.toBe(false);
    const recorded: unknown[] = [];
    sink.bind({ record: async (_trx, event) => recorded.push(event) });
    expect(sink.bound).toBe(true);
    // Still nothing without a database.
    await expect(
      sink.record({
        action: 'user.login.failed',
        actorType: 'user',
        credentialType: 'none',
        outcome: 'failure',
        context: {},
      }),
    ).resolves.toBe(false);
    expect(recorded).toHaveLength(0);
  });
});
