/**
 * `restClient` — the REST driver every server suite uses (10-testing-and-quality.md, "`@iridium/testkit`";
 * 12-milestones.md §4.3, *"restClient (undici fetch + `X-Iridium-Client: web` + cookie jar)"*).
 *
 * It is Node's global `fetch` (undici) plus three things the product's own web transport does and a
 * bare `fetch` does not: it sends `X-Iridium-Client` and `X-Iridium-Client-Version` on every request,
 * it carries a cookie jar so a cookie principal survives across calls, and it parses the response the
 * way `ProblemDetails` and `text/markdown` require. The CSRF guard of 02-system-architecture.md is
 * therefore exercised rather than bypassed: a cookie principal on an unsafe method reaches the server
 * with the header the guard looks for, exactly as the browser client sends it.
 *
 * `@iridium/api-client`'s generated `openapi-fetch` types replace the `string` path parameter when
 * `pnpm gen` has an `openapi.json` to generate from; the shape of this module does not change then,
 * only the type of `path`.
 */
import { strongEtag } from '@iridium/contracts';

import type { CookieJar } from '../auth/cookie-jar.ts';
import { createCookieJar } from '../auth/cookie-jar.ts';

/** The values `X-Iridium-Client` may carry (02-system-architecture.md, "Client identification"). */
export type IridiumClientKind = 'web' | 'desktop' | 'bridge' | 'cli';

/** Every REST path in 09-api-reference.md §2 is relative to this prefix. */
export const API_BASE_PATH = '/api/v1';

/** The header the CSRF guard reads for cookie principals on unsafe methods. */
export const CLIENT_HEADER = 'X-Iridium-Client';

/** The header the `minClientVersion` gate reads. */
export const CLIENT_VERSION_HEADER = 'X-Iridium-Client-Version';

/**
 * The two headers a browser sends on a same-origin unsafe request, and the CSRF guard checks
 * (04-auth-and-access-control.md §4.4).
 *
 * The guard is mounted globally and `CSRF_EXEMPT_ROUTES` is a closed enumeration that does not
 * include `/__test__/faults`, so a cookie-capable harness that omitted these would be answered
 * `403 csrf_rejected` — which is why the plan states the rule for test clients in the same breath as
 * for browsers: *"Test clients that use cookies send `X-Iridium-Client: web` and an `Origin` equal to
 * `PUBLIC_ORIGIN`; there is no bypass switch."*
 */
export const ORIGIN_HEADER = 'Origin';
export const FETCH_SITE_HEADER = 'Sec-Fetch-Site';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RestRequestInit {
  /** Parsed and sent as JSON. Mutually exclusive with `body`. */
  readonly json?: unknown;
  /** Sent verbatim. Set `headers['content-type']` yourself. */
  readonly body?: NonNullable<RequestInit['body']>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly signal?: AbortSignal;
  /** Per-request `Authorization: Bearer …`, overriding the client's. */
  readonly bearer?: string;
  /**
   * `If-Match`, built by `@iridium/contracts`' `strongEtag` when given a version number and sent
   * verbatim when given a string (09-api-reference.md §1.2).
   *
   * A number is the common case — every M1 body that carries a validator carries it as `version` —
   * and a string is what the stale-version and malformed-validator cases need (`W/"…"`, `*`, a list).
   */
  readonly ifMatch?: number | string;
}

export interface RestResponse<T = unknown> {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  /** The `Content-Type` media type without parameters, lowercased, or `null`. */
  readonly contentType: string | null;
  /** JSON body parsed, `text/*` as a string, an empty body as `undefined`, anything else as bytes. */
  readonly body: T;
  /** The request URL, after query serialisation. */
  readonly url: string;
  /** The consumed `Response`, for header and redirect assertions. */
  readonly response: Response;
}

export interface RestClient {
  readonly origin: string;
  readonly basePath: string;
  readonly jar: CookieJar;
  readonly client: IridiumClientKind;
  /** The bearer credential in use, if any. */
  readonly bearer: string | undefined;

  /** Request an **origin-relative** path: `/readyz`, `/metrics`, `/__test__/faults`, `/collab`. */
  request<T = unknown>(
    method: HttpMethod,
    path: string,
    init?: RestRequestInit,
  ): Promise<RestResponse<T>>;

  /** Request a path relative to `basePath`: `api('GET', '/vaults')` is `GET /api/v1/vaults`. */
  api<T = unknown>(
    method: HttpMethod,
    path: string,
    init?: RestRequestInit,
  ): Promise<RestResponse<T>>;

  get<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>>;
  post<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>>;
  put<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>>;
  patch<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>>;
  del<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>>;

  /** A client on the same origin with a different credential. The jar is **not** shared. */
  as(o: {
    bearer?: string;
    client?: IridiumClientKind;
    jar?: CookieJar;
    originHeader?: string | null;
    fetchSite?: string | null;
  }): RestClient;
}

export interface RestClientOptions {
  /** Optional assertion/observation of the actual parsed wire response, before the caller sees it. */
  readonly onResponse?: (response: RestResponse, method: HttpMethod) => Promise<void>;
  /** `http://127.0.0.1:<port>`; no trailing slash is required. */
  readonly origin: string;
  /** Defaults to `'web'`, the value the CSRF guard accepts for cookie principals. */
  readonly client?: IridiumClientKind;
  /** Defaults to `DEFAULT_CLIENT_VERSION`. */
  readonly clientVersion?: string;
  /** `irid_ses_…` (desktop session) or `irid_pat_…` (integration token). */
  readonly bearer?: string;
  /** Share a jar to continue an existing session; omit for a fresh profile. */
  readonly jar?: CookieJar;
  /** Defaults to `API_BASE_PATH`. */
  readonly basePath?: string;
  /** Injected for the msw-backed client harnesses; defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The `Origin` a cookie principal sends on an unsafe method. Defaults to the client's own origin,
   * which the harness sets as `PUBLIC_ORIGIN`; `app://iridium` is what the desktop host sends, and
   * `null` omits the header — the case `security.csrf.integration` asserts is refused.
   */
  readonly originHeader?: string | null;
  /** `Sec-Fetch-Site` on an unsafe cookie request; defaults to `same-origin`, `null` omits it. */
  readonly fetchSite?: string | null;
}

/**
 * What the harness reports as its client version. It is deliberately below every real release, so a
 * `minClientVersion` gate that starts rejecting old clients fails loudly in the suite first.
 */
export const DEFAULT_CLIENT_VERSION = '0.0.0';

const UNSAFE_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

function mediaType(headers: Headers): string | null {
  const raw = headers.get('content-type');
  if (raw === null) {
    return null;
  }
  const semicolon = raw.indexOf(';');
  return (semicolon === -1 ? raw : raw.slice(0, semicolon)).trim().toLowerCase();
}

/*
 * The return type is deliberately inferred rather than declared: `JSON.parse` yields `any`, so the
 * caller's declared `T` is satisfied by assignment instead of by a type assertion. The alternative —
 * `as T` — is the assertion `typescript/no-unsafe-type-assertion` exists to catch, and it would be
 * exactly as unchecked; the honest statement is "the caller declares the shape the route documents,
 * and `toMatchOpenApi` is what verifies it."
 */
// eslint-disable-next-line typescript/explicit-function-return-type -- the shape is the route's, declared by the caller; see above
async function readBody(response: Response, type: string | null) {
  if (response.status === 204 || response.status === 304) {
    return undefined;
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    return undefined;
  }
  if (type === null) {
    return new Uint8Array(buffer);
  }
  if (
    type === 'application/json' ||
    type === 'application/problem+json' ||
    type.endsWith('+json')
  ) {
    return JSON.parse(new TextDecoder().decode(buffer));
  }
  if (type.startsWith('text/')) {
    return new TextDecoder().decode(buffer);
  }
  return new Uint8Array(buffer);
}

function joinPath(origin: string, path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(
      `@iridium/testkit: restClient paths are absolute and start with "/", got "${path}"`,
    );
  }
  return `${origin.replace(/\/+$/, '')}${path}`;
}

function withQuery(url: string, query: RestRequestInit['query']): string {
  if (query === undefined) {
    return url;
  }
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.append(key, String(value));
    }
  }
  return parsed.toString();
}

class FetchRestClient implements RestClient {
  readonly origin: string;
  readonly basePath: string;
  readonly jar: CookieJar;
  readonly client: IridiumClientKind;
  readonly bearer: string | undefined;
  readonly #clientVersion: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #originHeader: string | null;
  readonly #fetchSite: string | null;
  readonly #onResponse: RestClientOptions['onResponse'];

  constructor(options: RestClientOptions) {
    this.origin = options.origin.replace(/\/+$/, '');
    this.basePath = options.basePath ?? API_BASE_PATH;
    this.jar = options.jar ?? createCookieJar();
    this.client = options.client ?? 'web';
    this.bearer = options.bearer;
    this.#clientVersion = options.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onResponse = options.onResponse;
    this.#originHeader = options.originHeader === undefined ? this.origin : options.originHeader;
    this.#fetchSite = options.fetchSite === undefined ? 'same-origin' : options.fetchSite;
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    init: RestRequestInit = {},
  ): Promise<RestResponse<T>> {
    const url = withQuery(joinPath(this.origin, path), init.query);
    const headers = new Headers();
    headers.set(CLIENT_HEADER, this.client);
    headers.set(CLIENT_VERSION_HEADER, this.#clientVersion);

    const bearer = init.bearer ?? this.bearer;
    if (bearer !== undefined) {
      headers.set('authorization', `Bearer ${bearer}`);
    }

    // A bearer principal never sends cookies (09-api-reference.md §1.3: "When present, cookies are
    // ignored entirely"), so the harness does not send them either — otherwise a test could not tell
    // which credential the server actually honoured.
    if (bearer === undefined) {
      const cookie = this.jar.header(new URL(url).pathname);
      if (cookie !== undefined) {
        headers.set('cookie', cookie);
      }
      // What a browser sends that `fetch` in Node does not. A bearer request is CSRF-exempt by
      // construction (a header no cross-site form can set), so only the cookie branch needs them.
      if (isUnsafeMethod(method)) {
        if (this.#originHeader !== null) {
          headers.set(ORIGIN_HEADER, this.#originHeader);
        }
        if (this.#fetchSite !== null) {
          headers.set(FETCH_SITE_HEADER, this.#fetchSite);
        }
      }
    }

    if (init.ifMatch !== undefined) {
      headers.set(
        'if-match',
        typeof init.ifMatch === 'number' ? strongEtag(init.ifMatch) : init.ifMatch,
      );
    }

    let body: NonNullable<RequestInit['body']> | undefined;
    if (init.json !== undefined) {
      if (init.body !== undefined) {
        throw new Error('@iridium/testkit: restClient takes either `json` or `body`, not both');
      }
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    } else if (init.body !== undefined) {
      body = init.body;
    }

    for (const [key, value] of Object.entries(init.headers ?? {})) {
      headers.set(key, value);
    }

    const response = await this.#fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
      redirect: 'manual',
    });

    this.jar.acceptFrom(response);
    const contentType = mediaType(response.headers);
    const parsed: T = await readBody(response, contentType);

    const result: RestResponse<T> = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      contentType,
      body: parsed,
      url,
      response,
    };
    await this.#onResponse?.(result, method);
    return result;
  }

  api<T = unknown>(
    method: HttpMethod,
    path: string,
    init?: RestRequestInit,
  ): Promise<RestResponse<T>> {
    return this.request<T>(method, `${this.basePath}${path}`, init);
  }

  get<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>> {
    return this.api<T>('GET', path, init);
  }

  post<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>> {
    return this.api<T>('POST', path, init);
  }

  put<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>> {
    return this.api<T>('PUT', path, init);
  }

  patch<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>> {
    return this.api<T>('PATCH', path, init);
  }

  del<T = unknown>(path: string, init?: RestRequestInit): Promise<RestResponse<T>> {
    return this.api<T>('DELETE', path, init);
  }

  as(o: {
    bearer?: string;
    client?: IridiumClientKind;
    jar?: CookieJar;
    originHeader?: string | null;
    fetchSite?: string | null;
  }): RestClient {
    return new FetchRestClient({
      origin: this.origin,
      basePath: this.basePath,
      clientVersion: this.#clientVersion,
      fetch: this.#fetch,
      ...(this.#onResponse === undefined ? {} : { onResponse: this.#onResponse }),
      client: o.client ?? this.client,
      jar: o.jar ?? createCookieJar(),
      originHeader: o.originHeader === undefined ? this.#originHeader : o.originHeader,
      fetchSite: o.fetchSite === undefined ? this.#fetchSite : o.fetchSite,
      ...(o.bearer === undefined ? {} : { bearer: o.bearer }),
    });
  }
}

/** True for the methods the CSRF guard treats as unsafe (02-system-architecture.md §"Request flow"). */
export function isUnsafeMethod(method: HttpMethod): boolean {
  return UNSAFE_METHODS.has(method);
}

/** Build a REST client against a running server. */
export function restClient(options: RestClientOptions): RestClient {
  return new FetchRestClient(options);
}
