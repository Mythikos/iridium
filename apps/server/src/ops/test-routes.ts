/**
 * The test-only control namespace `/__test__` (10-testing-and-quality.md D10-6; 12-milestones.md §5.2's
 * `ops` row).
 *
 * Two routes, `POST /__test__/faults {point, arg?, count?, ack?}` and `DELETE /__test__/faults`, and they exist
 * **only when `NODE_ENV === 'test'`** — the whole namespace is never registered otherwise, so the prefix
 * answers `404` from the not-found handler in production and in development alike. Some faults have to be
 * armed mid-session, after a document is loaded; spawning a process per fault would make the chaos suite
 * unaffordable, and confining the mechanism to one prefix with a boot assertion and an absence test is
 * safer than `NODE_ENV` branches scattered through the product.
 *
 * Three properties, each enforced somewhere a reader can check:
 *
 *  - **`config.auth = 'test-only'`.** `authz.route-policy.boot.guard` refuses to start the server when a
 *    `/__test__` route lacks it, *and* when a route outside the prefix declares it.
 *  - **The whole prefix is absent in production.** `routes.test-namespace-absent.integration` asserts the
 *    `404` and asserts the same routes arm faults under `NODE_ENV=test`.
 *  - **The point names are validated against the registry, not against a schema copy.** An unknown point
 *    is `422 validation_failed` naming the registry's points, because a test that silently armed nothing
 *    would pass by never reaching the fault it was written to drive.
 *
 * The namespace is deliberately **not** CSRF-exempt. `CSRF_EXEMPT_ROUTES` is a closed enumeration the boot
 * assertion holds shut (D04-32), and a test-only route is not one of its six members — so the harness sends
 * the `Origin` a browser would, exactly as 04-auth-and-access-control.md §4.4 says a cookie-capable client
 * must ("Test clients that use cookies send `X-Iridium-Client: web` and an `Origin` equal to
 * `PUBLIC_ORIGIN`; there is no bypass switch"). `scratchpad/m1/seams/platform.md` records the one-line
 * change `@iridium/testkit`'s `restClient` needs for that.
 */
import type { FastifyInstance } from 'fastify';

import { ProblemError } from '../security/problem.ts';
import { FAULT_POINT_NAMES, type ArmRefusal, type FaultRegistry } from './faults.ts';

/** The prefix the `test-only` route policy is reserved for. */
export const TEST_NAMESPACE_PREFIX = '/__test__';

/** `POST`/`DELETE /__test__/faults`. */
export const FAULT_CONTROL_PATH = `${TEST_NAMESPACE_PREFIX}/faults`;

/** The body `POST /__test__/faults` accepts, validated against the registry rather than a schema copy. */
interface ArmFaultBody {
  readonly point?: unknown;
  readonly arg?: unknown;
  readonly count?: unknown;
  readonly ack?: unknown;
}

/** One operator-facing sentence per refusal; the harness prints it when an arm call fails. */
const REFUSAL_DETAIL: Readonly<Record<ArmRefusal, string>> = Object.freeze({
  not_test_env: 'The fault registry is inert outside NODE_ENV=test.',
  unknown_point: `Unknown fault point. The registry declares: ${FAULT_POINT_NAMES.join(', ')}.`,
  argument_required: 'This point takes a duration in milliseconds, as point:<ms>.',
  argument_not_accepted: 'This point takes no argument.',
  count_not_accepted: 'This point is not counted, so it takes no count.',
  ack_not_accepted: 'Only the two post-acknowledgement wire faults accept an ack selector.',
  invalid_ack: 'ack requires a canonical noteId and a non-negative safe integer afterSeq.',
  invalid_number: 'arg and count are non-negative integers.',
});

function readOptionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProblemError('validation_failed', {
      detail: `${field} must be a non-negative integer.`,
      errors: [{ path: `body.${field}`, message: 'expected a non-negative integer', code: 'type' }],
    });
  }
  return value;
}

/**
 * Registers the namespace. Called by the ops plugin **only** when the fault registry is enabled, which is
 * the single `NODE_ENV === 'test'` comparison in `ops/faults.ts`.
 */
export function applyTestRoutes(app: FastifyInstance, faults: FaultRegistry): void {
  app.post(FAULT_CONTROL_PATH, { config: { auth: 'test-only' } }, async (request, reply) => {
    const body: ArmFaultBody =
      typeof request.body === 'object' && request.body !== null ? request.body : {};
    if (typeof body.point !== 'string') {
      throw new ProblemError('validation_failed', {
        detail: 'point is required and is one of the registered fault points.',
        errors: [{ path: 'body.point', message: 'expected a fault point name', code: 'required' }],
      });
    }
    const arg = readOptionalInteger(body.arg, 'arg');
    const count = readOptionalInteger(body.count, 'count');
    const outcome = faults.arm({
      point: body.point,
      ...(arg === undefined ? {} : { arg }),
      ...(count === undefined ? {} : { count }),
      ...(body.ack === undefined ? {} : { ack: body.ack }),
    });
    if (!outcome.armed) {
      throw new ProblemError('validation_failed', { detail: REFUSAL_DETAIL[outcome.refused] });
    }
    return reply.code(204).send();
  });

  app.delete(FAULT_CONTROL_PATH, { config: { auth: 'test-only' } }, async (_request, reply) => {
    faults.disarmAll();
    return reply.code(204).send();
  });
}
