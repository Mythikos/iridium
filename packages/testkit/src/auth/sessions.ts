/**
 * Signing in (10-testing-and-quality.md, "Seeding, tickets, sessions"; 09-api-reference.md §2.1).
 *
 * Two shapes, because the product has two: a web login puts its credential in the `__Host-` cookie
 * and never repeats it in the body, while a desktop login returns an `irid_ses_…` bearer for the
 * Electron main process to hold (A26). The harness models the difference rather than smoothing it
 * over, because it is exactly what the CSRF guard and the "cookies are ignored when a bearer is
 * present" rule of §1.3 are written against: a cookie client sends `X-Iridium-Client: web` and an
 * `Origin`, a bearer client sends neither and must still be accepted.
 *
 * There is no test-only sign-in. Every session here is the product's own
 * `POST /api/v1/auth/sessions`, which is what `guards.no-test-auth.guard` exists to keep true.
 */

import type { RestClient } from '../clients/rest-client.ts';
import { createCookieJar, type CookieJar } from './cookie-jar.ts';

/** `POST /api/v1/auth/sessions`, relative to the client's `basePath`. */
export const SESSIONS_PATH = '/auth/sessions';

/** `DELETE /api/v1/auth/sessions/current`. */
export const CURRENT_SESSION_PATH = '/auth/sessions/current';

/** `POST /api/v1/auth/reauthenticate`. */
export const REAUTHENTICATE_PATH = '/auth/reauthenticate';

/** What a sign-in needs. `SeededUser` satisfies it structurally. */
export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/** The `session` member of a `201`, narrowed to what a harness reads. */
export interface SignedInSession {
  readonly id: string;
  readonly kind: string;
}

/** The result of a web sign-in: the jar holds the credential, the client carries the jar. */
export interface WebSignIn {
  readonly client: RestClient;
  readonly jar: CookieJar;
  readonly session: SignedInSession;
  readonly userId: string;
}

/** The result of a desktop sign-in: the bearer is the credential and no cookie is sent. */
export interface DesktopSignIn {
  readonly client: RestClient;
  readonly token: string;
  readonly session: SignedInSession;
  readonly userId: string;
}

interface SessionCreatedBody {
  readonly token?: unknown;
  readonly user?: { readonly id?: unknown };
  readonly session?: { readonly id?: unknown; readonly kind?: unknown };
}

function readSession(body: unknown, where: string): { session: SignedInSession; userId: string } {
  const parsed: SessionCreatedBody = typeof body === 'object' && body !== null ? body : {};
  const id = parsed.session?.id;
  const kind = parsed.session?.kind;
  const userId = parsed.user?.id;
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof userId !== 'string') {
    throw new Error(
      `@iridium/testkit: ${where} answered 201 without a user and session: ${JSON.stringify(body)}`,
    );
  }
  return { session: { id, kind }, userId };
}

function refused(where: string, status: number, body: unknown): Error {
  return new Error(
    `@iridium/testkit: ${where} answered ${String(status)}: ${JSON.stringify(body)}`,
  );
}

/**
 * `POST /auth/sessions {client:'web'}`.
 *
 * The returned client shares the jar the cookie landed in, so every later call on it is the same
 * browser profile. A second principal gets a second jar: sharing one is how a test accidentally
 * proves nothing.
 */
export async function signInWeb(rest: RestClient, credentials: Credentials): Promise<WebSignIn> {
  const jar = createCookieJar();
  const client = rest.as({ client: 'web', jar });
  const response = await client.post(SESSIONS_PATH, {
    json: { email: credentials.email, password: credentials.password, client: 'web' },
  });
  if (response.status !== 201) {
    throw refused(`${SESSIONS_PATH} {client:'web'}`, response.status, response.body);
  }
  const { session, userId } = readSession(response.body, SESSIONS_PATH);
  return { client, jar, session, userId };
}

/** `POST /auth/sessions {client:'desktop'}`: the bearer the Electron main process would store. */
export async function signInDesktop(
  rest: RestClient,
  credentials: Credentials,
  deviceName = 'testkit',
): Promise<DesktopSignIn> {
  const response = await rest.as({ client: 'desktop' }).post(SESSIONS_PATH, {
    json: {
      email: credentials.email,
      password: credentials.password,
      client: 'desktop',
      deviceName,
    },
  });
  if (response.status !== 201) {
    throw refused(`${SESSIONS_PATH} {client:'desktop'}`, response.status, response.body);
  }
  const body: SessionCreatedBody =
    typeof response.body === 'object' && response.body !== null ? response.body : {};
  if (typeof body.token !== 'string') {
    throw new Error(
      `@iridium/testkit: a desktop sign-in answered 201 without a bearer: ${JSON.stringify(response.body)}`,
    );
  }
  const { session, userId } = readSession(response.body, SESSIONS_PATH);
  return {
    client: rest.as({ client: 'desktop', bearer: body.token }),
    token: body.token,
    session,
    userId,
  };
}

/** `POST /auth/reauthenticate`: refresh the step-up window an admin route requires. */
export async function stepUp(client: RestClient, password: string): Promise<void> {
  const response = await client.post(REAUTHENTICATE_PATH, { json: { password } });
  if (response.status !== 200) {
    throw refused(REAUTHENTICATE_PATH, response.status, response.body);
  }
}

/** `DELETE /auth/sessions/current`: sign out. Idempotent, so a second call is still `204`. */
export async function signOut(client: RestClient): Promise<void> {
  const response = await client.del(CURRENT_SESSION_PATH);
  if (response.status !== 204) {
    throw refused(CURRENT_SESSION_PATH, response.status, response.body);
  }
}

/** `DELETE /me/sessions/:sessionId`: revoke one of the caller's own sessions (a foreign id is 404). */
export async function revokeOwnSession(client: RestClient, sessionId: string): Promise<void> {
  const path = `/me/sessions/${encodeURIComponent(sessionId)}`;
  const response = await client.del(path);
  if (response.status !== 204) {
    throw refused(path, response.status, response.body);
  }
}
