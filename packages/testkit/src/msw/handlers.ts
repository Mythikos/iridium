/**
 * msw 2.15.0 handler skeleton (12-milestones.md §4.3, *"msw handler skeleton from `openapi.json`"*).
 *
 * The client-side harnesses — `MemoryHost` and the `component` project's inventory — need a server
 * that answers the REST surface without one running. The generated half of that comes from
 * `packages/contracts/openapi/openapi.json` through the `pnpm gen` pipeline; this module is the part
 * that is written by hand and does not regenerate: the origin convention, the `ProblemDetails` shape
 * every error must have (09-api-reference.md §1.4), and the rule that an operation with no stub
 * answers `501 not_implemented` rather than falling through to the network.
 *
 * The last point is the whole reason the default is not "passthrough": a component test whose request
 * escapes to a real socket is a test that passes for the wrong reason, and msw's `onUnhandledRequest`
 * is a warning rather than a failure by default.
 */
import { HttpResponse, http } from 'msw';
import type { RequestHandler } from 'msw';

import { GENERATED_OPERATIONS } from './generated/operations.ts';

/** The origin component tests use. It is never resolved: msw intercepts before DNS. */
export const MSW_ORIGIN = 'https://iridium.test';

/** Every REST path is relative to this (09-api-reference.md §2). */
export const MSW_API_BASE: string = `${MSW_ORIGIN}/api/v1`;

/** An RFC 9457 document in Iridium's shape (09-api-reference.md §1.4). */
export function problemDetails(o: {
  status: number;
  code: string;
  title?: string;
  detail?: string;
  instance?: string;
}): Response {
  return HttpResponse.json(
    {
      type: `https://iridium.test/problems/${o.code}`,
      title: o.title ?? o.code.replaceAll('_', ' '),
      status: o.status,
      code: o.code,
      ...(o.detail === undefined ? {} : { detail: o.detail }),
      ...(o.instance === undefined ? {} : { instance: o.instance }),
    },
    { status: o.status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export type HttpMethodLower = 'get' | 'put' | 'post' | 'patch' | 'delete' | 'head' | 'options';

export interface OperationStub {
  readonly method: HttpMethodLower;
  /** Relative to `MSW_API_BASE` unless it starts with `http`. */
  readonly path: string;
  readonly operationId: string;
}

/**
 * Build a handler per operation that answers `501 not_implemented`, naming the operation. A suite then
 * overrides the handful it cares about with `server.use(...)`, and anything it forgot fails loudly
 * with the operation id instead of reaching the network.
 */
export function notImplementedHandlers(operations: readonly OperationStub[]): RequestHandler[] {
  return operations.map((operation) =>
    http[operation.method](
      operation.path.startsWith('http') ? operation.path : `${MSW_API_BASE}${operation.path}`,
      () =>
        problemDetails({
          status: 501,
          code: 'not_implemented',
          detail: `No msw stub for ${operation.operationId}; add one with server.use().`,
        }),
    ),
  );
}

/**
 * Derive the operation list from an OpenAPI document, so the stub set follows the contract instead of
 * a hand-kept list. `pnpm gen` writes `packages/contracts/openapi/openapi.json`; until it does, callers
 * pass a document of their own.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function operationsFromOpenApi(
  document: Readonly<Record<string, unknown>>,
): OperationStub[] {
  const operations: OperationStub[] = [];
  const paths = document['paths'];
  if (!isRecord(paths)) {
    return operations;
  }
  const methods: readonly HttpMethodLower[] = [
    'get',
    'put',
    'post',
    'patch',
    'delete',
    'head',
    'options',
  ];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const method of methods) {
      const operation = item[method];
      if (!isRecord(operation)) {
        continue;
      }
      const operationId = operation['operationId'];
      if (typeof operationId !== 'string') {
        continue;
      }
      // OpenAPI templates `{id}`; msw matches `:id`.
      operations.push({
        method,
        path: path.replaceAll(/\{([^}]+)\}/g, ':$1'),
        operationId,
      });
    }
  }
  return operations;
}

/**
 * The baseline handler set. It carries the routes that exist outside `/api/v1` and are needed before
 * any operation is stubbed; the per-operation stubs come from `notImplementedHandlers` over the
 * generated operation list.
 */
export const handlers: RequestHandler[] = [
  http.get(`${MSW_ORIGIN}/healthz`, () => HttpResponse.json({ status: 'ok' })),
  http.get(`${MSW_ORIGIN}/readyz`, () => HttpResponse.json({ status: 'ok' })),
  ...notImplementedHandlers(GENERATED_OPERATIONS),
];
