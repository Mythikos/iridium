/**
 * The `/collab` mount of 05-collaboration-and-durability.md, "Mounting on `/collab`", as far as M0
 * can write it: `@fastify/websocket` with the frame cap, the Origin allowlist as a `preValidation`
 * hook, and the `handleConnection` / `handleMessage` / `handleClose` forwarding. The per-IP and
 * per-process socket caps and the awareness pre-dispatch filter are M1's; they do not change the
 * question S2 asks.
 */
import fastifyWebsocket from '@fastify/websocket';
import type { Hocuspocus } from '@hocuspocus/server';
import { LIMITS } from '@iridium/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';

import { sendProblem } from '../../../src/security/problem.ts';

export interface CollabMountOptions {
  /** The literal `Origin` values accepted: `PUBLIC_ORIGIN` and the desktop scheme. */
  readonly allowlist: readonly string[];
  readonly publicOrigin: string;
  readonly maxPayload?: number;
  /** Observed by the spike: one entry per accepted socket, in order. */
  readonly onSocket?: (info: { readonly requestId: string; readonly origin: string }) => void;
  /** Observed by the spike: every `close` the socket reported to Hocuspocus. */
  readonly onSocketClose?: (event: { readonly code: number; readonly reason: string }) => void;
}

/** `IncomingHttpHeaders` → the `Headers` the Hocuspocus `Request` carries. */
export function toHeaders(raw: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/** `ws` hands a `Buffer`, a `Buffer[]` or an `ArrayBuffer`; Hocuspocus wants one `Uint8Array`. */
export function toUint8Array(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** The CSWSH guard of 04-auth-and-access-control.md: absent `Origin` → 403, no bypass switch. */
export function originAllowlist(
  allowlist: readonly string[],
): (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined> {
  return async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === undefined || !allowlist.includes(origin)) {
      request.log.warn(
        { event: 'authz.origin_rejected', route: '/collab', originPresent: origin !== undefined },
        'websocket origin rejected',
      );
      await sendProblem(request, reply, 'forbidden', {
        detail:
          origin === undefined
            ? 'The /collab upgrade carried no Origin header.'
            : 'The Origin header is not on the allowlist.',
      });
      return reply;
    }
    return undefined;
  };
}

export async function mountCollab(
  app: FastifyInstance,
  hocuspocus: Hocuspocus,
  options: CollabMountOptions,
): Promise<void> {
  await app.register(fastifyWebsocket, {
    options: { maxPayload: options.maxPayload ?? LIMITS.WS_MAX_PAYLOAD_BYTES },
  });

  app.get(
    '/collab',
    {
      websocket: true,
      config: { auth: { public: true } },
      preValidation: [originAllowlist(options.allowlist)],
    },
    (socket, request) => {
      const webRequest = new Request(`${options.publicOrigin}${request.url}`, {
        headers: toHeaders(request.headers),
      });
      const connection = hocuspocus.handleConnection(socket, webRequest, {
        ip: request.ip,
        requestId: request.id,
      });
      options.onSocket?.({ requestId: request.id, origin: request.headers.origin ?? '' });
      socket.on('message', (data: WebSocket.RawData) => {
        connection.handleMessage(toUint8Array(data));
      });
      socket.on('close', (code: number, reason: Buffer) => {
        const event = { code, reason: reason.toString() };
        options.onSocketClose?.(event);
        connection.handleClose(event);
      });
      socket.on('error', (error: Error) => {
        request.log.warn({ err: error, requestId: request.id }, 'collab.socket.error');
      });
    },
  );
}
