/**
 * The two non-2xx paths that never reach a route, and therefore never reach the error boundary of
 * `problem.ts`.
 *
 * Fastify answers both itself, in `application/json`: a URL past `maxParamLength` is written
 * directly by the router (`FST_ERR_MAX_PARAM_LENGTH`, 414), and a request whose head the HTTP
 * parser refuses never becomes a request at all (`HPE_HEADER_OVERFLOW`, 431; a timeout, 408; any
 * other parse failure, 400). 09-api-reference.md section 1.5 admits no exception: every non-2xx
 * answer is an RFC 9457 problem document. These two seams restore that.
 *
 * The socket path cannot use `sendProblem`: a client error arrives with a raw socket and no
 * `Reply`, so the response is written by hand. It is the one place in the server that serialises a
 * problem document without Fastify.
 */
import type { Socket } from 'node:net';

import { newId, type ErrorCode } from '@iridium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { PROBLEM_CONTENT_TYPE, sendProblem, toProblemDetails } from './problem.ts';
import { attachRequestId, REQUEST_ID_HEADER } from './request-id.ts';

/** Fastify's pre-routing framework errors, mapped to the closed vocabulary. */
const FRAMEWORK_CODE_MAP: Readonly<Record<string, ErrorCode>> = Object.freeze({
  FST_ERR_MAX_PARAM_LENGTH: 'uri_too_long',
  FST_ERR_BAD_URL: 'malformed_request',
  FST_ERR_ASYNC_CONSTRAINT: 'malformed_request',
});

/** Node's parser failures, mapped to the closed vocabulary. */
const CLIENT_CODE_MAP: Readonly<Record<string, ErrorCode>> = Object.freeze({
  HPE_HEADER_OVERFLOW: 'request_headers_too_large',
  ERR_HTTP_REQUEST_TIMEOUT: 'request_timeout',
});

/** The `code` of an error-like value, or `null` when it carries none. */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Fastify's `frameworkErrors` seam: answers a pre-routing refusal as a problem document.
 *
 * The router refuses before the first `onRequest` hook runs, so nothing has assigned the request id
 * yet. It is attached here the same way the security plugin's hook does, including the rule that an
 * inbound `X-Request-Id` is honoured only from a trusted proxy. Without it the problem document went
 * out without the `requestId` every `ProblemDetails` requires and without the echoed header
 * (ARCH-14, ARCH-15); the full administrator fuzz profile found the 414 that way.
 *
 * @param error The framework error Fastify refused the request with.
 * @param request The partially built request; no hook has run on it.
 * @param reply The reply Fastify created for this refusal.
 */
export function applyFrameworkError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  attachRequestId(request, reply, request.server.trustProxyRanges);
  const code = FRAMEWORK_CODE_MAP[codeOf(error) ?? ''] ?? 'malformed_request';
  // `sendProblem` returns the reply, which Fastify treats as thenable; this seam wants no value.
  void sendProblem(request, reply, code);
}

/**
 * Fastify's `clientErrorHandler` seam: answers a parser refusal as a problem document.
 *
 * A destroyed socket and a reset connection are not answered — there is nothing to answer on, and
 * Fastify's own handler makes the same exemption.
 *
 * @param error The parser error Node reported.
 * @param socket The raw socket the refused request arrived on.
 */
export function applyClientError(error: unknown, socket: Socket): void {
  const raw = codeOf(error);
  if (raw === 'ECONNRESET' || socket.destroyed) return;

  const code = CLIENT_CODE_MAP[raw ?? ''] ?? 'malformed_request';
  // No request was ever parsed, so there is no inbound id to consider: one is generated, carried in
  // the body and echoed like every other response's (ARCH-14).
  const requestId = newId();
  const body = toProblemDetails(code, requestId);
  const payload = JSON.stringify(body);
  // `Connection: close` because the parser stopped mid-frame: whatever follows on this socket
  // cannot be framed, so the connection is not reusable whatever the client believes.
  socket.end(
    `HTTP/1.1 ${String(body.status)} ${REASON_PHRASES[body.status] ?? 'Error'}\r\n` +
      `Content-Type: ${PROBLEM_CONTENT_TYPE}\r\n` +
      `${REQUEST_ID_HEADER}: ${requestId}\r\n` +
      `Content-Length: ${String(Buffer.byteLength(payload))}\r\n` +
      'Connection: close\r\n\r\n' +
      payload,
  );
}

/** The reason phrases of the four statuses this module answers with. */
const REASON_PHRASES: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  408: 'Request Timeout',
  414: 'URI Too Long',
  431: 'Request Header Fields Too Large',
});
