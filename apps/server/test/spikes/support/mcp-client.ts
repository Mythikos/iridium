/**
 * `@modelcontextprotocol/client` 2.0.0, loaded from the workspace copy `@iridium/testkit` pins.
 *
 * The package is a dependency of the testkit, not of `apps/server`, so it is imported by path from
 * `packages/testkit/node_modules` — the honest expression of "the harness drives the server with the
 * client the repository already pins". The surface used is declared here.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { REPO_ROOT } from '@iridium/testkit';

export interface ToolResultLike {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly isError?: boolean;
}

export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ readonly tools: readonly { readonly name: string }[] }>;
  callTool(params: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
  }): Promise<ToolResultLike>;
  listResources(): Promise<{
    readonly resources: readonly { readonly uri: string; readonly name: string }[];
  }>;
  readResource(params: { readonly uri: string }): Promise<{
    readonly contents: readonly { readonly uri: string; readonly text?: string }[];
  }>;
  getProtocolEra(): 'legacy' | 'modern' | undefined;
  getNegotiatedProtocolVersion(): string | undefined;
  getServerVersion(): { readonly name: string; readonly version: string } | undefined;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface McpClientModule {
  readonly Client: new (
    info: { readonly name: string; readonly version: string },
    options?: Record<string, unknown>,
  ) => McpClientLike;
  readonly StreamableHTTPClientTransport: new (
    url: URL,
    options?: { readonly fetch?: FetchLike; readonly requestInit?: RequestInit },
  ) => unknown;
}

const CLIENT_ENTRY = join(
  REPO_ROOT,
  'packages',
  'testkit',
  'node_modules',
  '@modelcontextprotocol',
  'client',
  'dist',
  'index.mjs',
);

let loaded: Promise<McpClientModule> | undefined;

function isMcpClientModule(value: unknown): value is McpClientModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Client' in value &&
    typeof value.Client === 'function' &&
    'StreamableHTTPClientTransport' in value &&
    typeof value.StreamableHTTPClientTransport === 'function'
  );
}

export function loadMcpClientModule(): Promise<McpClientModule> {
  loaded ??= (async () => {
    const module: unknown = await import(pathToFileURL(CLIENT_ENTRY).href);
    if (!isMcpClientModule(module)) {
      throw new Error(`${CLIENT_ENTRY} does not export Client and StreamableHTTPClientTransport`);
    }
    return module;
  })();
  return loaded;
}

/** One HTTP exchange as the transport saw it — the wire trace the S14 note reports. */
export interface WireRecord {
  readonly method: string;
  readonly path: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly rpcMethod: string | null;
}

const TRACED_REQUEST_HEADERS = [
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'content-type',
  'accept',
];
const TRACED_RESPONSE_HEADERS = ['mcp-session-id', 'mcp-protocol-version', 'content-type'];

function pick(headers: Headers, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

function rpcMethodOf(body: RequestInit['body']): string | null {
  if (typeof body !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item: unknown) =>
          typeof item === 'object' && item !== null && 'method' in item ? String(item.method) : '?',
        )
        .join('+');
    }
    if (typeof parsed === 'object' && parsed !== null && 'method' in parsed)
      return String(parsed.method);
  } catch {
    return null;
  }
  return null;
}

/** A `fetch` that records every exchange into `trace` and passes the `Response` through untouched. */
export function tracingFetch(trace: WireRecord[]): FetchLike {
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const response = await fetch(request);
    trace.push({
      method: request.method,
      path: new URL(request.url).pathname,
      requestHeaders: pick(request.headers, TRACED_REQUEST_HEADERS),
      status: response.status,
      responseHeaders: pick(response.headers, TRACED_RESPONSE_HEADERS),
      rpcMethod: rpcMethodOf(init?.body),
    });
    return response;
  };
}
