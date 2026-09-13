/**
 * The cookie jar `restClient` carries (10-testing-and-quality.md, "Seeding, tickets, sessions";
 * 12-milestones.md §4.3, *"restClient (undici fetch + `X-Iridium-Client: web` + cookie jar)"*).
 *
 * Scope is deliberate: Iridium's web client is same-origin by construction — the SPA is served by the
 * server at `<PUBLIC_ORIGIN>/app/*` and the session cookie is `__Host-iridium_session`, whose prefix
 * forbids a `Domain` attribute altogether (04-auth-and-access-control.md). The jar therefore keys on
 * `(name, path)` and ignores `Domain`; what it does implement is the part a session test depends on:
 * path-prefix matching, `Max-Age`/`Expires` expiry, and the `Max-Age=0` deletion a sign-out sends.
 */

export interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly path: string;
  /** Epoch milliseconds, or `undefined` for a session cookie. */
  readonly expiresAt: number | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: string | undefined;
}

export interface CookieJar {
  /** Record every `Set-Cookie` of a response. Expired and `Max-Age=0` cookies are removed. */
  acceptFrom(response: Response, now?: number): void;
  /** Record one raw `Set-Cookie` header value. */
  accept(setCookie: string, now?: number): void;
  /** The `Cookie` request-header value for a path, or `undefined` when nothing matches. */
  header(path?: string, now?: number): string | undefined;
  /** One cookie's value, or `undefined`. */
  get(name: string, path?: string, now?: number): string | undefined;
  /** Every live cookie, longest path first — the order the `Cookie` header uses. */
  cookies(now?: number): readonly Cookie[];
  /** Set a cookie directly. Used by the desktop and bridge harnesses, never to forge a session. */
  set(cookie: Cookie): void;
  /** Forget one cookie. */
  remove(name: string, path?: string): void;
  /** Forget everything. */
  clear(): void;
}

/** RFC 6265 §5.1.4: a request path matches a cookie path exactly, or below a `/`-terminated prefix. */
export function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) {
    return true;
  }
  if (!requestPath.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Parse one `Set-Cookie` header value. Returns `null` for a header with no usable name/value pair. */
export function parseSetCookie(raw: string, now: number = Date.now()): Cookie | null {
  const parts = raw.split(';');
  const pair = parts[0];
  if (pair === undefined) {
    return null;
  }
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    return null;
  }
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name === '') {
    return null;
  }

  let path = '/';
  let expiresAt: number | undefined;
  let secure = false;
  let httpOnly = false;
  let sameSite: string | undefined;
  let maxAge: number | undefined;

  for (const attribute of parts.slice(1)) {
    const attrEq = attribute.indexOf('=');
    const attrName = (attrEq === -1 ? attribute : attribute.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? '' : attribute.slice(attrEq + 1).trim();
    switch (attrName) {
      case 'path': {
        path = attrValue === '' ? '/' : attrValue;
        break;
      }
      case 'max-age': {
        const parsed = Number.parseInt(attrValue, 10);
        if (!Number.isNaN(parsed)) {
          maxAge = parsed;
        }
        break;
      }
      case 'expires': {
        const parsed = Date.parse(attrValue);
        if (!Number.isNaN(parsed)) {
          expiresAt = parsed;
        }
        break;
      }
      case 'secure': {
        secure = true;
        break;
      }
      case 'httponly': {
        httpOnly = true;
        break;
      }
      case 'samesite': {
        sameSite = attrValue;
        break;
      }
      default: {
        break;
      }
    }
  }

  // Max-Age wins over Expires (RFC 6265 §5.3 step 3); Max-Age=0 is the deletion a sign-out sends.
  if (maxAge !== undefined) {
    expiresAt = now + maxAge * 1000;
  }

  return { name, value, path, expiresAt, secure, httpOnly, sameSite };
}

class InMemoryCookieJar implements CookieJar {
  /** name → path → cookie. Two levels rather than a composite key, so no separator can collide. */
  readonly #byName = new Map<string, Map<string, Cookie>>();

  acceptFrom(response: Response, now: number = Date.now()): void {
    for (const raw of response.headers.getSetCookie()) {
      this.accept(raw, now);
    }
  }

  accept(setCookie: string, now: number = Date.now()): void {
    const cookie = parseSetCookie(setCookie, now);
    if (cookie === null) {
      return;
    }
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
      this.remove(cookie.name, cookie.path);
      return;
    }
    this.set(cookie);
  }

  cookies(now: number = Date.now()): readonly Cookie[] {
    const live: Cookie[] = [];
    for (const [name, byPath] of this.#byName) {
      for (const [path, cookie] of byPath) {
        if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
          byPath.delete(path);
          continue;
        }
        live.push(cookie);
      }
      if (byPath.size === 0) {
        this.#byName.delete(name);
      }
    }
    // RFC 6265 §5.4: longer paths first. `sort` is stable, so insertion order breaks ties and the
    // rendered header is deterministic.
    return live.toSorted((a, b) => b.path.length - a.path.length);
  }

  header(path: string = '/', now: number = Date.now()): string | undefined {
    const matching = this.cookies(now).filter((c) => pathMatches(c.path, path));
    if (matching.length === 0) {
      return undefined;
    }
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  get(name: string, path: string = '/', now: number = Date.now()): string | undefined {
    return this.cookies(now).find((c) => c.name === name && pathMatches(c.path, path))?.value;
  }

  set(cookie: Cookie): void {
    let byPath = this.#byName.get(cookie.name);
    if (byPath === undefined) {
      byPath = new Map<string, Cookie>();
      this.#byName.set(cookie.name, byPath);
    }
    byPath.set(cookie.path, cookie);
  }

  remove(name: string, path: string = '/'): void {
    const byPath = this.#byName.get(name);
    if (byPath === undefined) {
      return;
    }
    byPath.delete(path);
    if (byPath.size === 0) {
      this.#byName.delete(name);
    }
  }

  clear(): void {
    this.#byName.clear();
  }
}

/** A fresh, empty jar. One jar is one browser profile: never share one between two principals. */
export function createCookieJar(): CookieJar {
  return new InMemoryCookieJar();
}
