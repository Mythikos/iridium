/**
 * The one raiser for `409 invalid_move`, so every refusal on every structural route carries the
 * same closed vocabulary.
 *
 * It lives in its own module because `mutations.ts` imports `service.ts` and `service.ts` needs the
 * raiser: keeping it in either would be a cycle, and keeping a second private copy in `service.ts`
 * is what let that copy narrow the union to three of the four reasons `@iridium/contracts` declares
 * (`cycle` was missing), which is a refusal the route can produce and the shadowing type could not
 * name (09-api-reference.md §2.7; `tree.invalid-move.integration` is exhaustive over the union).
 */
import type { InvalidMoveReason } from '@iridium/contracts';

import { ProblemError } from '../security/problem.ts';

/** A move refusal uses the closed contract vocabulary. */
export function invalidMove(reason: InvalidMoveReason, detail: string): ProblemError {
  return new ProblemError('invalid_move', {
    detail,
    errors: [{ path: 'body.parentId', message: reason, code: reason }],
  });
}
