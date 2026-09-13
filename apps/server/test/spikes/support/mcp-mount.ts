/**
 * The S14 mount: one `createMcpHandler` instance behind `reply.hijack()` on the real `buildApp`,
 * mounted twice so the two response-writing choices can be compared under identical guards.
 *
 *   - `/mcp` — the plan's wiring verbatim (06-mcp-and-agent-access.md, "Mounting the two MCP routes"):
 *     `toNodeHandler(handler)` writes status, headers and body straight to `reply.raw`;
 *   - `/mcp-owned` — the same handler through its web-standard face: `toWebRequest` + `handler.fetch`,
 *     with Iridium writing the `Response` to `reply.raw` and mapping the SDK's `500` to the plan's
 *     `{"error":"server_error"}` body.
 *
 * Both routes carry the plan's `onRequest` guards (`hostHeaderValidation([hostname])`,
 * `rejectBrowserOrigin`) and a `preHandler` that records the request id, so the spec can prove the
 * Iridium chain ran in front of the SDK. The factory is the stub of the register row — one `echo` tool
 * and one static resource — and can be told to throw once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { LIMITS } from '@iridium/contracts';
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';
import {
  toNodeHandler,
  toWebRequest,
  type NodeIncomingMessageLike,
} from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { z } from 'zod';

import type { SpikeApp } from './app.ts';

export const RESOURCE_URI = 'iridium://spike/static';
export const MOUNTS = ['/mcp', '/mcp-owned'] as const;
const METHODS: HTTPMethods[] = ['GET', 'POST', 'DELETE'];

const AUTH = { token: 'spike-token', clientId: 'spike', scopes: ['read'] };

/** The per-request record the factory keeps: which era the SDK asked for, and whether it threw. */
export interface FactoryCall {
  readonly era: 'legacy' | 'modern';
  readonly threw: boolean;
}

export interface McpMountState {
  readonly factoryCalls: FactoryCall[];
  readonly factoryState: { throwNext: boolean };
  /** `createMcpHandler`'s `onerror` — factory throws and rejected requests, reporting only. */
  readonly handlerErrors: string[];
  /** `toNodeHandler`'s `onerror` — adapter-level failures (conversion or `fetch` throwing). */
  readonly adapterErrors: string[];
  /** Errors that reached the route's own `catch` after `reply.hijack()`. */
  readonly routeCatches: string[];
  /** One entry per request that reached the route's `preHandler`. */
  readonly chain: { readonly requestId: string; readonly url: string }[];
  /** `console.warn` output during `createMcpHandler` construction (D06-25). */
  readonly constructionWarnings: string[];
  /**
   * One entry per `onResponse` hook invocation on the two mounts — D06-18 reads the per-call access
   * record from that hook, so it must still fire for a hijacked reply.
   */
  readonly responses: {
    readonly requestId: string;
    readonly url: string;
    readonly statusCode: number;
  }[];
}

/**
 * Node's `IncomingMessage` declares `method?: string | undefined`; the SDK's duck type declares
 * `method?: string`, which `exactOptionalPropertyTypes` refuses although the runtime shape is the
 * same. The product will carry this one cast at the same boundary.
 */
function asNodeRequest(raw: IncomingMessage): NodeIncomingMessageLike {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above: a typing-only mismatch
  return Object.assign(raw, { auth: AUTH }) as unknown as NodeIncomingMessageLike;
}

function writeServerError(raw: ServerResponse): void {
  raw.writeHead(500, { 'content-type': 'application/json' });
  raw.end('{"error":"server_error"}');
}

/** The plan's `onMcpHostError`: never append a second body to a response that has started. */
export function onMcpHostError(raw: ServerResponse): void {
  if (raw.headersSent) {
    raw.destroy();
    return;
  }
  writeServerError(raw);
}

/** Write a web-standard `Response` to a Node response, honouring back-pressure. */
export async function writeWebResponse(response: Response, raw: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  raw.writeHead(response.status, headers);
  if (response.body === null) {
    raw.end();
    return;
  }
  for await (const chunk of response.body) {
    if (!raw.write(chunk)) {
      await new Promise<void>((resolve) => raw.once('drain', resolve));
    }
  }
  raw.end();
}

/** The plan's `rejectBrowserOrigin`: the predicate is `origin !== undefined` and nothing else. */
export async function rejectBrowserOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.headers.origin !== undefined) {
    await reply.code(403).send({ error: 'origin_not_allowed' });
  }
}

export function mountMcp(spike: SpikeApp): McpMountState {
  const state: McpMountState = {
    factoryCalls: [],
    factoryState: { throwNext: false },
    handlerErrors: [],
    adapterErrors: [],
    routeCatches: [],
    chain: [],
    constructionWarnings: [],
    responses: [],
  };

  const factory = async (ctx: { era: 'legacy' | 'modern' }): Promise<McpServer> => {
    if (state.factoryState.throwNext) {
      state.factoryState.throwNext = false;
      state.factoryCalls.push({ era: ctx.era, threw: true });
      throw new Error('factory boom');
    }
    state.factoryCalls.push({ era: ctx.era, threw: false });
    const server = new McpServer(
      { name: 'iridium-spike', version: '0.0.0' },
      {
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
        },
      },
    );
    server.registerTool(
      'echo',
      { description: 'Echoes the text back', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    server.registerResource(
      'spike-static',
      RESOURCE_URI,
      { description: 'A static resource', mimeType: 'text/plain' },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'static resource body' }],
      }),
    );
    return server;
  };

  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    state.constructionWarnings.push(args.map(String).join(' '));
  };
  let handler: ReturnType<typeof createMcpHandler>;
  try {
    handler = createMcpHandler(factory, {
      legacy: 'stateless',
      responseMode: 'json',
      onerror: (error) => state.handlerErrors.push(error.message),
    });
  } finally {
    console.warn = originalWarn;
  }
  const node = toNodeHandler(handler, {
    onerror: (error) => state.adapterErrors.push(error.message),
  });

  const recordChain = async (request: FastifyRequest): Promise<void> => {
    state.chain.push({ requestId: request.requestId, url: request.url });
  };
  const recordResponse = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // After `hijack()` Fastify's `reply.statusCode` is not the one written; read the raw response.
    state.responses.push({
      requestId: request.requestId,
      url: request.url,
      statusCode: reply.raw.statusCode,
    });
  };
  const mount = {
    method: METHODS,
    config: { auth: { public: true } as const, rateLimit: false as const },
    bodyLimit: LIMITS.BODY_MAX_BYTES_MCP,
    onRequest: [hostHeaderValidation([spike.publicHostname]), rejectBrowserOrigin],
    preHandler: [recordChain],
    onResponse: [recordResponse],
  };

  spike.app.route({
    ...mount,
    url: '/mcp',
    handler: async (request, reply) => {
      reply.hijack();
      try {
        await node(asNodeRequest(request.raw), reply.raw, request.body);
      } catch (error) {
        state.routeCatches.push(error instanceof Error ? error.message : String(error));
        onMcpHostError(reply.raw);
      }
    },
  });

  spike.app.route({
    ...mount,
    url: '/mcp-owned',
    handler: async (request, reply) => {
      reply.hijack();
      const raw = reply.raw;
      const abort = new AbortController();
      raw.on('close', () => {
        if (!raw.writableFinished) abort.abort();
      });
      try {
        const webRequest = await toWebRequest(asNodeRequest(request.raw), request.body, {
          signal: abort.signal,
        });
        const response = await handler.fetch(webRequest, {
          authInfo: AUTH,
          parsedBody: request.body,
        });
        if (response.status === 500) {
          await response.body?.cancel();
          writeServerError(raw);
          return;
        }
        await writeWebResponse(response, raw);
      } catch (error) {
        state.routeCatches.push(error instanceof Error ? error.message : String(error));
        onMcpHostError(raw);
      }
    },
  });

  spike.app.addHook('onClose', async () => {
    await handler.close();
  });
  return state;
}
