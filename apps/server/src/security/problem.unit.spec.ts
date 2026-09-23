/** The HTTP failure boundary accepts unknown throws and emits only the closed problem vocabulary. */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';

import {
  ERROR_CODES,
  ERROR_CODE_STATUS,
  LIMITS,
  NoteId,
  newId,
  ProblemDetails,
} from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildWithoutDatabase,
  NO_DATABASE_HOST,
  type NoDatabaseApp,
} from '../../test/support/no-database-app.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { createLogger } from '../ops/logging.ts';
import {
  classifyError,
  isEnvelopeExempt,
  logLevelForStatus,
  ProblemError,
  sendProblem,
  statusOf,
  toProblemDetails,
} from './problem.ts';

/** Actual HTTP covers router methods that light-my-request's declaration does not expose. */
async function requestMethod(
  origin: string,
  method: string,
  path: string,
): Promise<{
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  json(): unknown;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, origin),
      {
        method,
        headers: { host: NO_DATABASE_HOST, 'x-iridium-client': 'desktop' },
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            json: (): unknown => JSON.parse(chunks.join('')),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Sends a hand-written request head and returns the raw answer. `httpRequest` cannot express a head
 * the parser must refuse, so the 431 seam is only reachable through a socket.
 */
async function rawRequest(origin: string, head: string): Promise<string> {
  const { port, hostname } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => socket.write(head));
    const chunks: string[] = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(chunks.join('')));
  });
}

/** The `X-Request-Id` a raw answer echoes in its head, or `null` when it echoes none. */
function echoedRequestId(answer: string): string | null {
  const head = answer.slice(0, answer.indexOf('\r\n\r\n'));
  const match = /^x-request-id:\s*(\S+)\s*$/im.exec(head);
  return match?.[1] ?? null;
}

const REQUEST_ID = newId();
const INTERNAL_DETAIL = 'private storage failure, never sent to the client';

describe('security.problem.unit [area:security]', () => {
  it('preserves every deliberate problem code, its extensions and its logging status', () => {
    for (const code of ERROR_CODES) {
      const extensions = { detail: `refused ${code}` };
      const error = new ProblemError(code, extensions);
      expect(error.name).toBe('ProblemError');
      expect(error.message).toBe(extensions.detail);
      expect(classifyError(error)).toEqual({ code, extensions });
      expect(statusOf(error)).toBe(ERROR_CODE_STATUS[code]);
      expect(logLevelForStatus(statusOf(error))).toBe(
        ERROR_CODE_STATUS[code] < 500 ? 'warn' : 'error',
      );
      expect(ProblemDetails.parse(toProblemDetails(code, REQUEST_ID))).toMatchObject({
        code,
        status: ERROR_CODE_STATUS[code],
        requestId: REQUEST_ID,
      });
    }
    expect(new ProblemError('forbidden').message).toBe('You do not have permission to do that');
  });

  it('carries only declared wire extensions and omits logging and header instructions', () => {
    const current = { version: 7 };
    const errors = [{ path: 'body.name', message: 'invalid', code: 'invalid_name' }];
    const references = [{ noteId: NoteId.parse(newId()), path: 'reference.md' }];
    const body = toProblemDetails('stale_version', REQUEST_ID, {
      current,
      errors,
      references,
      detail: 'reload the current representation',
      headers: { 'x-internal': 'instruction' },
      event: 'auth.login.failed',
    });
    expect(ProblemDetails.parse(body)).toEqual({
      type: 'urn:iridium:problem:stale_version',
      title: 'This has changed since you loaded it',
      status: 409,
      code: 'stale_version',
      requestId: REQUEST_ID,
      current,
      errors,
      references,
      detail: 'reload the current representation',
    });
    expect(toProblemDetails('busy', REQUEST_ID).retryAfterMs).toBe(1000);
    expect(toProblemDetails('not_ready', REQUEST_ID).retryAfterMs).toBe(5000);
    expect(toProblemDetails('rate_limited', REQUEST_ID).retryAfterMs).toBeUndefined();
    expect(toProblemDetails('rate_limited', REQUEST_ID, { retryAfterMs: 0 }).retryAfterMs).toBe(0);
  });

  it('gives schema validation priority over a built-in code and the rate limiter', () => {
    expect(
      classifyError({
        code: 'FST_ERR_CTP_BODY_TOO_LARGE',
        statusCode: 429,
        message: 'invalid schema',
        validationContext: 'query',
        validation: [{ instancePath: '/limit', message: 'must be positive', keyword: 'minimum' }],
      }),
    ).toEqual({
      code: 'validation_failed',
      extensions: {
        detail: 'invalid schema',
        errors: [{ path: 'query/limit', message: 'must be positive', code: 'minimum' }],
      },
    });
  });

  it('uses safe defaults for absent or mistyped validation fields', () => {
    expect(
      classifyError({
        message: 42,
        validationContext: 7,
        validation: [{ instancePath: false, message: null, keyword: 9 }, {}],
      }),
    ).toEqual({
      code: 'validation_failed',
      extensions: {
        detail: 'the request did not match its schema',
        errors: [
          { path: 'body', message: 'invalid', code: 'invalid' },
          { path: 'body', message: 'invalid', code: 'invalid' },
        ],
      },
    });
  });

  it.each([
    { params: { code: 'direct_policy' }, expected: 'direct_policy' },
    {
      params: { code: 'direct_policy', params: { code: 'nested_policy' } },
      expected: 'direct_policy',
    },
    { params: { params: { code: 'nested_policy' } }, expected: 'nested_policy' },
    { params: { code: 7, params: { code: 'nested_policy' } }, expected: 'nested_policy' },
    { params: undefined, expected: 'custom' },
    { params: null, expected: 'custom' },
    { params: 'bad', expected: 'custom' },
    { params: {}, expected: 'custom' },
    { params: { params: null }, expected: 'custom' },
    { params: { params: 'bad' }, expected: 'custom' },
    { params: { params: { code: 7 } }, expected: 'custom' },
  ])('uses a declared policy code only when it is a string: $params', ({ params, expected }) => {
    expect(
      classifyError({ validation: [{ keyword: 'custom', params }] }).extensions.errors,
    ).toEqual([{ path: 'body', message: 'invalid', code: expected }]);
  });

  it.each([
    { fastifyCode: 'FST_ERR_CTP_BODY_TOO_LARGE', code: 'payload_too_large' },
    { fastifyCode: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', code: 'unsupported_media' },
    { fastifyCode: 'FST_ERR_CTP_EMPTY_JSON_BODY', code: 'validation_failed' },
    { fastifyCode: 'FST_ERR_CTP_INVALID_JSON_BODY', code: 'validation_failed' },
    { fastifyCode: 'FST_ERR_CTP_INVALID_CONTENT_LENGTH', code: 'validation_failed' },
    { fastifyCode: 'FST_ERR_VALIDATION', code: 'validation_failed' },
    { fastifyCode: 'FST_ERR_NOT_FOUND', code: 'not_found' },
  ])('maps $fastifyCode before the status-code fallback', ({ fastifyCode, code }) => {
    const classified = classifyError({
      code: fastifyCode,
      statusCode: 429,
      message: 'public explanation',
      validation: [],
    });
    expect(classified).toEqual({
      code,
      extensions: code === 'not_found' ? {} : { detail: 'public explanation' },
    });
    expect(classifyError({ code: fastifyCode })).toEqual({
      code,
      extensions: code === 'not_found' ? {} : { detail: '' },
    });
  });

  it('maps the third-party 429 fallback with a safe default detail', () => {
    expect(classifyError({ statusCode: 429, message: 'retry later' })).toEqual({
      code: 'rate_limited',
      extensions: { detail: 'retry later' },
    });
    expect(classifyError({ statusCode: 429 })).toEqual({
      code: 'rate_limited',
      extensions: { detail: 'rate limited' },
    });
  });

  it.each([
    undefined,
    null,
    true,
    42,
    'thrown string',
    new Error(INTERNAL_DETAIL),
    { code: 'unknown', message: INTERNAL_DETAIL },
    { code: 'constructor' },
    { code: 'toString' },
    { code: '__proto__' },
    { code: 42 },
    { code: {} },
    { validation: 'invalid' },
    { validation: { length: 1 } },
    { validation: [null] },
    { validation: [42] },
    { validation: [[]] },
    { validation: [] },
  ])(
    'classifies an unrecognized or malformed throw as server_error without leaking detail: %j',
    (error) => {
      expect(classifyError(error)).toEqual({ code: 'server_error', extensions: {} });
    },
  );

  it.each([undefined, null, '429', 0, 399, 600, 500.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'never trusts an invalid claimed HTTP status: %j',
    (statusCode) => {
      expect(statusOf({ statusCode })).toBe(500);
    },
  );

  it.each([400, 429, 499, 500, 503, 599])(
    'preserves a valid claimed error status %s',
    (statusCode) => {
      expect(statusOf({ statusCode })).toBe(statusCode);
    },
  );

  it('recognizes complete exempt path segments without exempting lookalike REST paths', () => {
    for (const path of ['/mcp', '/mcp/connect', '/oauth/token', '/oauth/revoke', '/oauth/register'])
      expect(isEnvelopeExempt(path)).toBe(true);
    for (const path of ['/mcpx', '/oauth/tokenize', '/oauth/revoked', '/api/v1/oauth/token'])
      expect(isEnvelopeExempt(path)).toBe(false);
  });

  describe('the installed error boundary', () => {
    let harness: NoDatabaseApp;
    let origin: string;
    const lines: string[] = [];

    beforeAll(async () => {
      harness = await buildWithoutDatabase({
        logger: createLogger({
          level: 'debug',
          format: 'json',
          instanceId: 'problem-unit',
          destination: {
            write(line) {
              lines.push(line);
            },
          },
        }),
      });
      await harness.app.register(
        async (api) => {
          api.get('/__probe__/forbidden', { config: { auth: { public: true } } }, async () => {
            throw new ProblemError('forbidden');
          });
          api.get('/__probe__/malformed', { config: { auth: { public: true } } }, async () => {
            throw Object.assign(new Error(INTERNAL_DETAIL), { validation: { length: 1 } });
          });
          api.get(
            '/__probe__/retry',
            { config: { auth: { public: true } } },
            async (request, reply) =>
              sendProblem(request, reply, 'rate_limited', { retryAfterMs: 1501 }),
          );
          api.get(
            '/__probe__/retry-header',
            { config: { auth: { public: true } } },
            async (request, reply) =>
              sendProblem(request, reply, 'unavailable', {
                retryAfterMs: 1501,
                headers: { 'retry-after': '7', 'www-authenticate': 'Bearer' },
              }),
          );
          // Parametric, so a segment past `maxParamLength` reaches the router's own refusal. A static
          // path never parses a parameter, and a long one simply falls through to a 404.
          api.get('/__probe__/param/:value', { config: { auth: { public: true } } }, async () => ({
            reached: true,
          }));
          api.post(
            '/__probe__/json',
            { config: { auth: { public: true } }, bodyLimit: 32 },
            async () => ({ accepted: true }),
          );
        },
        { prefix: '/api/v1' },
      );
      // This unit exercises the installed body parser/error boundary. Ownership has its own real
      // database integration proof; script only that admission dependency for this no-DB fixture.
      vi.spyOn(harness.app.collab.ownerLease, 'captureFence').mockReturnValue({
        assertActive: vi.fn<OwnerFence['assertActive']>(),
        assertCurrent: vi.fn<OwnerFence['assertCurrent']>().mockResolvedValue(undefined),
      });
      origin = await harness.app.listen({ host: '127.0.0.1', port: 0 });
    });

    afterAll(async () => {
      await harness.close();
    });

    it.each([
      { path: 'forbidden', status: 403, code: 'forbidden', level: 'warn' },
      { path: 'malformed', status: 500, code: 'server_error', level: 'error' },
    ])('emits a valid $code body and logs it at $level', async ({ path, status, code, level }) => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/__probe__/${path}`,
        headers: { host: NO_DATABASE_HOST },
      });
      const body = ProblemDetails.parse(response.json());
      expect(response.statusCode).toBe(status);
      expect(body).toMatchObject({ code, status, requestId: response.headers['x-request-id'] });
      expect(body.detail).toBeUndefined();
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).not.toContain(INTERNAL_DETAIL);
      const entries = lines.map((line): unknown => JSON.parse(line));
      expect(entries).toContainEqual(
        expect.objectContaining({ level, code, msg: 'request failed' }),
      );
    });

    it.each([
      { path: 'retry', seconds: '2', status: 429, authenticate: undefined },
      { path: 'retry-header', seconds: '7', status: 503, authenticate: 'Bearer' },
    ])(
      'sends the $path retry instructions without overwriting an explicit header',
      async ({ path, seconds, status, authenticate }) => {
        const response = await harness.app.inject({
          method: 'GET',
          url: `/api/v1/__probe__/${path}`,
          headers: { host: NO_DATABASE_HOST },
        });
        expect(response.statusCode).toBe(status);
        expect(response.headers['retry-after']).toBe(seconds);
        expect(ProblemDetails.parse(response.json()).retryAfterMs).toBe(1501);
        expect(response.headers['www-authenticate']).toBe(authenticate);
      },
    );

    it('rejects malformed UTF-8 JSON at an actual auth route without a server error', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sessions',
        headers: {
          host: NO_DATABASE_HOST,
          'x-iridium-client': 'desktop',
          'content-type': 'application/json',
        },
        payload: Buffer.from([6, 223, 37, 72, 139, 99, 71, 66]),
      });
      expect(response.statusCode).toBe(422);
      expect(ProblemDetails.parse(response.json()).code).toBe('validation_failed');
    });

    it('refuses an unsupported QUERY on a registered route without a server error', async () => {
      const response = await requestMethod(
        origin,
        'QUERY',
        '/api/v1/notes/00000000-0000-7000-8000-000000000000',
      );
      expect(response.statusCode).toBe(405);
      expect(response.headers['allow']).toBe('GET, HEAD');
      expect(ProblemDetails.parse(response.json()).code).toBe('method_not_allowed');
    });

    it('distinguishes wrong methods on real parameterized paths from absent paths', async () => {
      const wrongMethod = await requestMethod(
        origin,
        'TRACE',
        '/api/v1/notes/00000000-0000-7000-8000-000000000000?ignored=true',
      );
      expect(wrongMethod.statusCode).toBe(405);
      expect(wrongMethod.headers['allow']).toBe('GET, HEAD');
      const absent = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/absent-route',
        headers: { host: NO_DATABASE_HOST },
      });
      expect(absent.statusCode).toBe(404);
      expect(absent.headers['allow']).toBeUndefined();
      expect(ProblemDetails.parse(absent.json()).code).toBe('not_found');
    });

    it.each(['/healthz', '/readyz', '/metrics'])(
      'checks unsupported ops methods on %s',
      async (path) => {
        const response = await requestMethod(origin, 'TRACE', path);
        expect(response.statusCode).toBe(405);
        expect(response.headers['allow']).toBe('GET, HEAD');
        expect(response.headers['content-security-policy']).toContain("default-src 'none'");
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(ProblemDetails.parse(response.json()).code).toBe('method_not_allowed');
      },
    );

    it('preserves health and metrics access policies', async () => {
      const health = await harness.app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
      const metrics = await harness.app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.statusCode).toBe(404);
    });

    it('accepts valid JSON through the same parser and admission fixture', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/__probe__/json',
        headers: {
          host: NO_DATABASE_HOST,
          'x-iridium-client': 'desktop',
          'content-type': 'application/json',
        },
        payload: '{}',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: true });
    });

    it.each([
      { payload: '', contentType: 'application/json', status: 422, code: 'validation_failed' },
      { payload: '{', contentType: 'application/json', status: 422, code: 'validation_failed' },
      {
        payload: JSON.stringify({ text: 'x'.repeat(40) }),
        contentType: 'application/json',
        status: 413,
        code: 'payload_too_large',
      },
      {
        payload: 'unrecognized',
        contentType: 'application/x-unknown',
        status: 415,
        code: 'unsupported_media',
      },
    ])(
      'maps the real body parser refusal to $code',
      async ({ payload, contentType, status, code }) => {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/v1/__probe__/json',
          headers: {
            host: NO_DATABASE_HOST,
            'x-iridium-client': 'desktop',
            'content-type': contentType,
          },
          payload,
        });
        expect(response.statusCode).toBe(status);
        expect(ProblemDetails.parse(response.json())).toMatchObject({ code, status });
      },
    );

    it('answers a refused request head with a problem document rather than plain JSON', async () => {
      // Past the configured head budget, so the parser refuses the head outright. Derived from
      // the limit rather than pinned, so raising the budget keeps proving the same seam.
      const oversized = 'x'.repeat(LIMITS.REQUEST_HEADERS_MAX_BYTES + 8_000);
      const answer = await rawRequest(
        origin,
        `GET /api/v1/__probe__/forbidden HTTP/1.1\r\nHost: ${NO_DATABASE_HOST}\r\nX-Pad: ${oversized}\r\n\r\n`,
      );
      expect(answer).toContain('431 Request Header Fields Too Large');
      expect(answer).toContain('application/problem+json');
      const body: unknown = JSON.parse(answer.slice(answer.indexOf('{')));
      const problem = ProblemDetails.parse(body);
      expect(problem).toMatchObject({ code: 'request_headers_too_large', status: 431 });
      // ARCH-14: the id the body carries is the one the response echoes.
      expect(echoedRequestId(answer)).toBe(problem.requestId);
    });

    it('answers a URL the router refuses with a problem document rather than plain JSON', async () => {
      // Past Fastify's default `maxParamLength` of 100 on a parametric route, so the router refuses
      // before any hook runs. The status is asserted exactly: this test once accepted any status of
      // 400 or more, passed on a plain 404, and so never saw that the refusal lost its request id.
      const answer = await rawRequest(
        origin,
        `GET /api/v1/__probe__/param/${'p'.repeat(200)} HTTP/1.1\r\nHost: ${NO_DATABASE_HOST}\r\nConnection: close\r\n\r\n`,
      );
      expect(answer).toContain('414 URI Too Long');
      expect(answer).toContain('application/problem+json');
      const body: unknown = JSON.parse(answer.slice(answer.indexOf('{')));
      const problem = ProblemDetails.parse(body);
      expect(problem).toMatchObject({ code: 'uri_too_long', status: 414 });
      expect(echoedRequestId(answer)).toBe(problem.requestId);
    });
  });
});
