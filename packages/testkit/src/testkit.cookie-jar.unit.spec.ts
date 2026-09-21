import { describe, expect, it } from 'vitest';

import { createCookieJar, parseSetCookie, pathMatches } from './auth/cookie-jar.ts';
import { CLIENT_HEADER, CLIENT_VERSION_HEADER, restClient } from './clients/rest-client.ts';

const SESSION = '__Host-iridium_session';

/** `fetch`'s first parameter is a string, a `URL` or a `Request`; only the last has `.url`. */
function requestedUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

describe('testkit.cookie-jar.unit [area:testkit]', () => {
  it('stores a Set-Cookie and renders it as a Cookie header', () => {
    const jar = createCookieJar();
    jar.accept(`${SESSION}=abc123; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(jar.get(SESSION)).toBe('abc123');
    expect(jar.header('/api/v1/vaults')).toBe(`${SESSION}=abc123`);
    expect(jar.cookies()).toHaveLength(1);
    expect(jar.cookies()[0]?.httpOnly).toBe(true);
    expect(jar.cookies()[0]?.secure).toBe(true);
    expect(jar.cookies()[0]?.sameSite).toBe('Lax');
  });

  it('forgets a cookie a sign-out deletes with Max-Age=0', () => {
    const jar = createCookieJar();
    jar.accept(`${SESSION}=abc123; Path=/`);
    jar.accept(`${SESSION}=; Path=/; Max-Age=0`);
    expect(jar.get(SESSION)).toBeUndefined();
    expect(jar.header()).toBeUndefined();
  });

  it('lets Max-Age win over Expires, as RFC 6265 §5.3 requires', () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    const cookie = parseSetCookie('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60', now);
    expect(cookie?.expiresAt).toBe(now + 60_000);
  });

  it('drops a cookie once its lifetime has passed', () => {
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    const jar = createCookieJar();
    jar.accept('short=1; Path=/; Max-Age=30', now);
    jar.accept('long=1; Path=/; Max-Age=3600', now);
    expect(jar.header('/', now + 10_000)).toBe('short=1; long=1');
    expect(jar.header('/', now + 60_000)).toBe('long=1');
    expect(jar.cookies(now + 60_000)).toHaveLength(1);
  });

  it('matches paths the way a browser does', () => {
    expect(pathMatches('/', '/api/v1/vaults')).toBe(true);
    expect(pathMatches('/api/v1', '/api/v1')).toBe(true);
    expect(pathMatches('/api/v1', '/api/v1/vaults')).toBe(true);
    expect(pathMatches('/api/v1', '/api/v12')).toBe(false);
    expect(pathMatches('/api/v1/', '/api/v1/vaults')).toBe(true);
    expect(pathMatches('/oauth', '/api/v1')).toBe(false);
  });

  it('sends the longest-path cookie first and keeps scoped cookies apart', () => {
    const jar = createCookieJar();
    jar.accept('root=1; Path=/');
    jar.accept('scoped=2; Path=/oauth');
    expect(jar.header('/oauth/consent')).toBe('scoped=2; root=1');
    expect(jar.header('/api/v1/meta')).toBe('root=1');
  });

  it('keeps two cookies of the same name on different paths apart', () => {
    const jar = createCookieJar();
    jar.accept('csrf=root; Path=/');
    jar.accept('csrf=oauth; Path=/oauth');
    expect(jar.get('csrf', '/oauth/consent')).toBe('oauth');
    expect(jar.get('csrf', '/api/v1/meta')).toBe('root');
  });

  it('ignores a header with no usable name/value pair', () => {
    expect(parseSetCookie('')).toBeNull();
    expect(parseSetCookie('=novalue')).toBeNull();
    expect(parseSetCookie('novalue')).toBeNull();
  });

  it('sends the client identification headers and the jar on every request', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const jar = createCookieJar();
    jar.accept(`${SESSION}=abc123; Path=/`);
    const client = restClient({
      origin: 'https://iridium.test/',
      jar,
      fetch: async (input, init) => {
        seen.push({ url: requestedUrl(input), headers: new Headers(init?.headers ?? {}) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const response = await client.get('/vaults', { query: { limit: 2 } });

    expect(response.status).toBe(200);
    expect(response.body).toStrictEqual({ ok: true });
    expect(response.contentType).toBe('application/json');
    const sent = seen[0];
    expect(sent?.url).toBe('https://iridium.test/api/v1/vaults?limit=2');
    expect(sent?.headers.get(CLIENT_HEADER)).toBe('web');
    expect(sent?.headers.get(CLIENT_VERSION_HEADER)).toBe('0.0.0');
    expect(sent?.headers.get('cookie')).toBe(`${SESSION}=abc123`);
  });

  it('sends a bearer credential instead of cookies, never both', async () => {
    const seen: Headers[] = [];
    const jar = createCookieJar();
    jar.accept(`${SESSION}=abc123; Path=/`);
    const client = restClient({
      origin: 'https://iridium.test',
      jar,
      bearer: 'irid_pat_0123456789abcdef',
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers ?? {}));
        return new Response(null, { status: 204 });
      },
    });

    const response = await client.del('/sessions/current');

    expect(response.status).toBe(204);
    expect(response.body).toBeUndefined();
    expect(seen[0]?.get('authorization')).toBe('Bearer irid_pat_0123456789abcdef');
    expect(seen[0]?.get('cookie')).toBeNull();
  });

  it('preserves an empty Markdown representation while bodyless status codes remain undefined', async () => {
    const client = restClient({
      origin: 'https://iridium.test',
      fetch: async () =>
        new Response('', {
          status: 200,
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    });
    const response = await client.get('/notes/empty/markdown');
    expect(response.status).toBe(200);
    expect(response.body).toBe('');
  });

  it('accepts Set-Cookie from a response and refuses json plus body together', async () => {
    const client = restClient({
      origin: 'https://iridium.test',
      fetch: async () =>
        new Response('{}', {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'set-cookie': `${SESSION}=fresh; Path=/; HttpOnly`,
          },
        }),
    });

    await client.post('/auth/sessions', { json: { email: 'admin@iridium.test' } });
    expect(client.jar.get(SESSION)).toBe('fresh');

    await expect(client.post('/auth/sessions', { json: {}, body: 'x' })).rejects.toThrow(
      /either `json` or `body`/,
    );
    await expect(client.request('GET', 'readyz')).rejects.toThrow(/absolute and start with/);
  });

  it('gives a derived client its own jar unless one is handed over', () => {
    const client = restClient({ origin: 'https://iridium.test' });
    client.jar.accept('a=1; Path=/');
    expect(client.as({ bearer: 'irid_ses_x' }).jar.get('a')).toBeUndefined();
    expect(client.as({ jar: client.jar }).jar.get('a')).toBe('1');
  });
});
