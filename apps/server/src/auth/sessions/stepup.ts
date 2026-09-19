/**
 * Step-up ("sudo mode", 04-auth-and-access-control.md section 4.6; D04-09; D04-10).
 *
 * A route declared `stepUp: true` requires `now − last_authenticated_at ≤ session_policy.stepUpMinutes`
 * (the `STEP_UP_WINDOW_MIN` floor at M1). The check is evaluated *last*, after existence and
 * permission, so the prompt never reveals that an action would otherwise be allowed; that ordering
 * lives in `authorize()` and the route policy, and this module holds only the arithmetic.
 */

/** Whether the window is still open at `nowMs`. */
export function stepUpSatisfied(
  lastAuthenticatedAt: Date,
  nowMs: number,
  windowMs: number,
): boolean {
  return nowMs - lastAuthenticatedAt.getTime() <= windowMs;
}

/** When the window closes — `stepUpExpiresAt` of `POST /auth/reauthenticate`. */
export function stepUpExpiresAt(lastAuthenticatedAt: Date, windowMs: number): Date {
  return new Date(lastAuthenticatedAt.getTime() + windowMs);
}
