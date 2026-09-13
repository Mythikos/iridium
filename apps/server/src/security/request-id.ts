/**
 * Request ids (ARCH-14).
 *
 * A request id is a UUIDv7, so it sorts with the audit and access rows it produced. An inbound
 * `X-Request-Id` is honoured **only** when the immediate peer is inside `TRUST_PROXY` and the value
 * matches `^[A-Za-z0-9._-]{8,128}$`; otherwise one is generated. Both halves matter: without the
 * peer check any client could correlate itself into someone else's trace, and without the pattern
 * any client could inject log content into every line the request produces.
 *
 * The id is echoed as `X-Request-Id` on every response and is carried in `ProblemDetails.requestId`,
 * `audit_events.context.request_id` and `access_log.request_id`.
 */
import { newId } from '@iridium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ipInRanges, type IpRange } from './ip-range.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** The correlation id of ARCH-14: inbound when trusted and well-formed, generated otherwise. */
    requestId: string;
  }
}

/** The header both directions use. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** ARCH-14's accepted shape for an inbound id. */
export const INBOUND_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

/** Whether the immediate peer may supply forwarded headers, including `X-Request-Id`. */
export function peerIsTrustedProxy(
  request: FastifyRequest,
  trustProxy: readonly IpRange[],
): boolean {
  if (trustProxy.length === 0) return false;
  return ipInRanges(request.socket.remoteAddress, trustProxy);
}

/** Resolves the id for one request. */
export function resolveRequestId(request: FastifyRequest, trustProxy: readonly IpRange[]): string {
  const inbound = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  if (
    candidate !== undefined &&
    INBOUND_REQUEST_ID_PATTERN.test(candidate) &&
    peerIsTrustedProxy(request, trustProxy)
  ) {
    return candidate;
  }
  return newId();
}

/** Assigns the id, echoes it and attaches a child logger carrying it (ARCH-15). */
export function attachRequestId(
  request: FastifyRequest,
  reply: FastifyReply,
  trustProxy: readonly IpRange[],
): void {
  const requestId = resolveRequestId(request, trustProxy);
  request.requestId = requestId;
  request.log = request.log.child({ requestId });
  reply.header(REQUEST_ID_HEADER, requestId);
}
