/**
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/generate-msw-handlers.ts` from packages/contracts/openapi/openapi.json.
 * Run `pnpm gen` to regenerate; `gen.drift.guard` fails the `static` job on any difference.
 */

import type { OperationStub } from '../handlers.ts';

/**
 * Every REST operation the committed OpenAPI document declares, in document order.
 *
 * Pass it to `notImplementedHandlers` to get one `501 not_implemented` stub per operation, then
 * override the handful a suite cares about with `server.use(...)`. Anything the suite forgot then
 * fails naming the operation, instead of reaching a real socket.
 */
export const GENERATED_OPERATIONS: readonly OperationStub[] = [];
