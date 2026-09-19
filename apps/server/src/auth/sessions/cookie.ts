/**
 * The web session cookie (04-auth-and-access-control.md sections 4.1 and 4.3; T8).
 *
 * `__Host-iridium_session` implies `Secure`, `Path=/` and no `Domain`. `SameSite=Lax` rather than
 * `Strict` so a deep link to a note opens signed in; Lax still blocks the cookie on cross-site
 * `POST`s and cross-site WebSocket handshakes. `Max-Age` equals the seconds until
 * `absolute_expires_at`, so the browser keeps the cookie for exactly the absolute lifetime; idle
 * expiry is enforced server-side and is not represented in the cookie (no re-issue on sliding).
 */
import type { CookieSerializeOptions } from '@fastify/cookie';

/** The cookie name. The `__Host-` prefix is what makes the attributes below mandatory. */
export const SESSION_COOKIE_NAME = '__Host-iridium_session';

/** `Clear-Site-Data` on logout: browser-stored UI state goes with the cookie (section 4.3). */
export const LOGOUT_CLEAR_SITE_DATA = '"cookies","storage"';

const MS_PER_SECOND = 1000;

/** The fixed attributes of every `Set-Cookie` this server writes for a session. */
const FIXED_ATTRIBUTES: CookieSerializeOptions = Object.freeze({
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
});

/** The attributes for issuing a session cookie that lives until `absoluteExpiresAt`. */
export function sessionCookieOptions(
  absoluteExpiresAt: Date,
  nowMs: number,
): CookieSerializeOptions {
  const remainingMs = Math.max(0, absoluteExpiresAt.getTime() - nowMs);
  return { ...FIXED_ATTRIBUTES, maxAge: Math.floor(remainingMs / MS_PER_SECOND) };
}

/** The attributes for clearing the cookie on logout: the same attributes with `Max-Age=0`. */
export function clearedSessionCookieOptions(): CookieSerializeOptions {
  return { ...FIXED_ATTRIBUTES, maxAge: 0 };
}
