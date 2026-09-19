/**
 * Session lifetimes by kind (04-auth-and-access-control.md section 4.1; A26).
 *
 * The environment values are the security floor: `session_policy` in `server_settings` may tighten
 * them from M7 and never loosen them. At M1 the floor is the policy.
 */
import type { SessionKind } from '../../db/schema.ts';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** The four lifetimes, in milliseconds, plus the step-up window. */
export interface SessionTtls {
  readonly webIdleMs: number;
  readonly webAbsoluteMs: number;
  readonly desktopIdleMs: number;
  readonly desktopAbsoluteMs: number;
  readonly stepUpWindowMs: number;
}

/** The configuration slice the lifetimes are read from (`config.auth`). */
export interface SessionTtlConfig {
  readonly sessionWebIdleHours: number;
  readonly sessionWebAbsoluteDays: number;
  readonly sessionDesktopIdleDays: number;
  readonly sessionDesktopAbsoluteDays: number;
  readonly stepUpWindowMinutes: number;
}

/** Converts the configured hours, days and minutes to milliseconds once. */
export function sessionTtlsFromConfig(config: SessionTtlConfig): SessionTtls {
  return {
    webIdleMs: config.sessionWebIdleHours * MS_PER_HOUR,
    webAbsoluteMs: config.sessionWebAbsoluteDays * MS_PER_DAY,
    desktopIdleMs: config.sessionDesktopIdleDays * MS_PER_DAY,
    desktopAbsoluteMs: config.sessionDesktopAbsoluteDays * MS_PER_DAY,
    stepUpWindowMs: config.stepUpWindowMinutes * 60_000,
  };
}

/** The idle window of a kind. */
export function idleMs(ttls: SessionTtls, kind: SessionKind): number {
  return kind === 'web' ? ttls.webIdleMs : ttls.desktopIdleMs;
}

/** The absolute lifetime of a kind. */
export function absoluteMs(ttls: SessionTtls, kind: SessionKind): number {
  return kind === 'web' ? ttls.webAbsoluteMs : ttls.desktopAbsoluteMs;
}

/** `LEAST(now + idle(kind), absolute_expires_at)` — the sliding idle expiry never passes the cap. */
export function nextIdleExpiry(
  ttls: SessionTtls,
  kind: SessionKind,
  nowMs: number,
  absoluteExpiresAt: Date,
): Date {
  return new Date(Math.min(nowMs + idleMs(ttls, kind), absoluteExpiresAt.getTime()));
}
