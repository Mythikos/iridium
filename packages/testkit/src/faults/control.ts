/**
 * Arming and disarming fault points (10-testing-and-quality.md, "Fault injection: `IRIDIUM_FAULT`").
 *
 * Two surfaces, one vocabulary:
 *
 * - **at spawn** — `IRIDIUM_FAULT=store.slow:3000,ws.drop-after-ack` in the child or container
 *   environment, rendered by `formatFaultEnv`;
 * - **at runtime** — `POST /__test__/faults {point, arg?, count?}` and `DELETE /__test__/faults`,
 *   a namespace that exists only when `NODE_ENV === 'test'`, wrapped by `createFaultControl`.
 *
 * `srv.faults.arm(FAULT.storeThrow, { count: 1 })` returns a handle whose `disarm()` clears it, so a
 * test never leaves a fault armed for the next one. Point strings are never written as literals: the
 * spec is built from a `FAULT` constant and validated against the registry before it leaves the
 * process, which is what makes a typo a synchronous error rather than a fault that silently never fires.
 */
import type { RestClient } from '../clients/rest-client.ts';
import type { FaultPoint } from './points.ts';
import { describeFault } from './points.ts';

/** The test-only control route (10-testing-and-quality.md; `config.auth = 'test-only'`, skeleton A27). */
export const FAULT_CONTROL_PATH = '/__test__/faults';

/** The environment variable the product reads at boot when `NODE_ENV === 'test'`. */
export const FAULT_ENV_VAR = 'IRIDIUM_FAULT';

export interface FaultSpec {
  readonly point: FaultPoint;
  /** The `:<n>` suffix of a `milliseconds` point, e.g. `store.slow:3000`. */
  readonly arg?: number;
  /** How many times a `counted` point fires before disarming itself. Omitted means "until disarmed". */
  readonly count?: number;
}

export interface ArmedFault {
  readonly spec: FaultSpec;
  /** Clear this point. Idempotent: disarming twice is not an error. */
  disarm(): Promise<void>;
}

export interface FaultControl {
  /** Arm one point and return its handle. */
  arm(point: FaultPoint, options?: { arg?: number; count?: number }): Promise<ArmedFault>;
  /** Clear every armed point (`DELETE /__test__/faults`). */
  disarmAll(): Promise<void>;
}

function assertInteger(value: number, label: string, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `@iridium/testkit: ${label} must be an integer >= ${minimum}, got ${String(value)}`,
    );
  }
}

/**
 * Reject a spec the registry cannot honour before it reaches the wire or the child environment.
 * Returns the spec so callers can validate and use in one expression.
 */
export function assertValidFaultSpec(spec: FaultSpec): FaultSpec {
  const descriptor = describeFault(spec.point);
  if (descriptor === undefined) {
    throw new Error(
      `@iridium/testkit: "${spec.point}" is not a registered fault point. Use a FAULT constant from @iridium/testkit/faults/points.ts.`,
    );
  }
  if (descriptor.argument === 'milliseconds') {
    if (spec.arg === undefined) {
      throw new Error(
        `@iridium/testkit: ${spec.point} requires a duration, e.g. ${spec.point}:3000`,
      );
    }
    assertInteger(spec.arg, `${spec.point} duration`, 0);
  } else if (spec.arg !== undefined) {
    throw new Error(`@iridium/testkit: ${spec.point} takes no argument`);
  }
  if (spec.count !== undefined) {
    if (descriptor.lifetime !== 'counted') {
      throw new Error(
        `@iridium/testkit: ${spec.point} is ${descriptor.lifetime}, so it takes no count`,
      );
    }
    assertInteger(spec.count, `${spec.point} count`, 1);
  }
  return spec;
}

/** `store.slow:3000`, `store.throw:2`, `ws.drop-after-ack`. */
export function formatFaultSpec(spec: FaultSpec): string {
  assertValidFaultSpec(spec);
  const suffix = spec.arg ?? spec.count;
  return suffix === undefined ? spec.point : `${spec.point}:${String(suffix)}`;
}

/** The `IRIDIUM_FAULT` value for a set of specs, in the order given. */
export function formatFaultEnv(specs: readonly FaultSpec[]): string {
  return specs.map((spec) => formatFaultSpec(spec)).join(',');
}

/** The inverse of `formatFaultSpec`; the registry decides whether `:<n>` is a duration or a count. */
export function parseFaultSpec(raw: string): FaultSpec {
  const colon = raw.indexOf(':');
  // The registry, not an assertion, is what turns a string back into a point: `describeFault`
  // returns the descriptor whose `point` is already the narrowed union member.
  const descriptor = describeFault(colon === -1 ? raw : raw.slice(0, colon));
  if (descriptor === undefined) {
    throw new Error(`@iridium/testkit: "${raw}" names no registered fault point`);
  }
  const point = descriptor.point;
  if (colon === -1) {
    return assertValidFaultSpec({ point });
  }
  const suffix = Number.parseInt(raw.slice(colon + 1), 10);
  if (Number.isNaN(suffix)) {
    throw new Error(`@iridium/testkit: "${raw}" has a non-numeric argument`);
  }
  return assertValidFaultSpec(
    descriptor.argument === 'milliseconds' ? { point, arg: suffix } : { point, count: suffix },
  );
}

/** The inverse of `formatFaultEnv`. An empty string is an empty list, not an error. */
export function parseFaultEnv(raw: string): readonly FaultSpec[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => parseFaultSpec(part));
}

/** Wrap the test-only control route of a running server. */
export function createFaultControl(rest: RestClient): FaultControl {
  const disarmAll = async (): Promise<void> => {
    const response = await rest.request('DELETE', FAULT_CONTROL_PATH);
    if (response.status >= 400) {
      throw new Error(
        `@iridium/testkit: DELETE ${FAULT_CONTROL_PATH} answered ${String(response.status)}. The test namespace exists only when NODE_ENV=test.`,
      );
    }
  };

  return {
    async arm(point, options = {}): Promise<ArmedFault> {
      const spec = assertValidFaultSpec({
        point,
        ...(options.arg === undefined ? {} : { arg: options.arg }),
        ...(options.count === undefined ? {} : { count: options.count }),
      });
      const response = await rest.request('POST', FAULT_CONTROL_PATH, { json: spec });
      if (response.status >= 400) {
        throw new Error(
          `@iridium/testkit: arming ${formatFaultSpec(spec)} answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
        );
      }
      let disarmed = false;
      return {
        spec,
        async disarm(): Promise<void> {
          if (disarmed) {
            return;
          }
          disarmed = true;
          const cleared = await rest.request('POST', FAULT_CONTROL_PATH, {
            json: { point: spec.point, count: 0 },
          });
          if (cleared.status >= 400) {
            throw new Error(
              `@iridium/testkit: disarming ${spec.point} answered ${String(cleared.status)}`,
            );
          }
        },
      };
    },
    disarmAll,
  };
}
