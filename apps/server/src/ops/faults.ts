/**
 * The fault registry (10-testing-and-quality.md, "Fault injection: `IRIDIUM_FAULT`"; D10-6;
 * 05-collaboration-and-durability.md, "Additional fault points").
 *
 * Named points in the product's own code, **inert unless `NODE_ENV === 'test'`**. They exist
 * because the durability properties the plan calls HP-1 and HP-2 cannot be proven any other way: a
 * crash *between* a COMMIT and its acknowledgement is not a state a test can reach from outside the
 * process, and a test-side kill cannot be placed at an instruction boundary.
 *
 * Four rules make that safe rather than merely useful:
 *
 *  1. **`NODE_ENV === 'test'` is the only gate, and it is checked here.** `guards.one-boot-path.guard`
 *     greps `apps/server/src` for `NODE_ENV === 'test'` outside this module and `config/env.ts`, so
 *     test-only behaviour cannot spread into the product boot path. Under any other environment
 *     `fire()` returns `false`, `arm()` refuses, and `/__test__` is never registered.
 *  2. **`config/env.ts` refuses to start** when `IRIDIUM_FAULT` is set outside `NODE_ENV=test`
 *     (`config.test_knob_in_production`), so an armed production process is not a state that exists.
 *  3. **The point names are the testkit's names.** `@iridium/testkit/faults/points.ts` declares the same
 *     points, tests spell them through its `FAULT` constants, and `guards.fault-registry.guard` asserts
 *     the two lists are identical — which is what makes a typo a failing guard rather than a fault that
 *     silently never fires.
 *  4. **A crash point kills the process with `SIGKILL`**, so no `finally`, no drain and no
 *     `Server.destroy()` flush runs. That is the only honest way to test HP-2: `Server.destroy()`
 *     flushes pending stores, which would make the test vacuous.
 *
 * **Lifetimes** are the registry's, not the call site's: a `one-shot` point disarms itself the first time
 * it fires, a `counted` point counts down, `per-connection` fires once per connection the caller
 * identifies, and `until-disarmed` fires until `DELETE /__test__/faults`. `arg` is milliseconds for the
 * two `:<ms>` points and is never a count.
 */
import { NoteId } from '@iridium/contracts';

import type { Clock } from './clock.ts';

/**
 * The one logging method the registry uses. A slice rather than `ServerLogger`, so `ops.faults.unit` can
 * drive the registry without constructing a pino instance and without asserting one into existence.
 */
export interface FaultLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

/** How a point's `:<n>` suffix is read. */
export type FaultArgument = 'none' | 'milliseconds';

/** How long an armed point stays armed. */
export type FaultLifetime = 'one-shot' | 'per-connection' | 'counted' | 'until-disarmed';

/** One registered point. The table below is the product's half of the registry contract. */
export interface FaultPointDescriptor {
  /** The wire string: the `point` field of `POST /__test__/faults` and a member of `IRIDIUM_FAULT`. */
  readonly point: string;
  /** What a `:<n>` suffix means for this point. */
  readonly argument: FaultArgument;
  /** Whether the point disarms itself, counts down, or stays until it is cleared. */
  readonly lifetime: FaultLifetime;
  /** Where in the product the point fires — the sentence a reader needs to find the call site. */
  readonly firesIn: string;
}

/**
 * The registered points, in the order of 10-testing-and-quality.md's fault table followed by the two
 * 05-collaboration-and-durability.md adds and the one 04/06 add for the MCP cookie layers.
 *
 * 12-milestones.md §5.2's `ops` row names seven of them; the other four are named by 10's own table and by
 * 05 and 04, and `@iridium/testkit/faults/points.ts` declares the matching registry. The guard asserts the
 * two registries are equal, so this list is the full set rather than the milestone row's subset.
 */
export const FAULT_POINTS: readonly FaultPointDescriptor[] = Object.freeze([
  {
    point: 'store.throw',
    argument: 'none',
    lifetime: 'counted',
    firesIn: 'NoteWriter.flush() before BEGIN',
  },
  {
    point: 'store.throw-after-commit-before-ack',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn:
      'discard the successful COMMIT result before the writer acknowledges it, without exiting',
  },
  {
    point: 'store.crash-before-commit',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'inside the writer transaction, after INSERT … note_updates, before COMMIT',
  },
  {
    point: 'store.crash-after-commit-before-ack',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: "after COMMIT, before broadcastStateless({t:'persisted'})",
  },
  {
    point: 'store.hold-before-commit',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'hold one writer transaction before COMMIT until the harness disarms the point',
  },
  {
    point: 'store.slow',
    argument: 'milliseconds',
    lifetime: 'until-disarmed',
    firesIn: 'await delay(ms) inside the transaction, after the insert, before COMMIT',
  },
  {
    point: 'store.kill-after-ack',
    argument: 'none',
    lifetime: 'one-shot',
    firesIn: 'the /collab socket layer, immediately after `persisted` is written to the wire',
  },
  {
    point: 'compact.throw',
    argument: 'none',
    lifetime: 'counted',
    firesIn: 'Compactor.run() before writing the snapshot',
  },
  {
    point: 'compact.snapshot-oversize',
    argument: 'none',
    lifetime: 'until-disarmed',
    firesIn: 'the compactor snapshot guard, arming the 64 MB refusal without a 64 MB document',
  },
  {
    point: 'sv.not-recorded',
    argument: 'none',
    lifetime: 'until-disarmed',
    firesIn: 'the writer, forcing the recorded state vector to degrade to zero length (D03-01)',
  },
  {
    point: 'ws.drop-after-ack',
    argument: 'none',
    lifetime: 'per-connection',
    firesIn: 'the /collab socket layer, after `persisted` is written to the wire',
  },
  {
    point: 'auth.slow',
    argument: 'milliseconds',
    lifetime: 'until-disarmed',
    firesIn: 'onAuthenticate',
  },
  {
    point: 'auth.command-after-commit',
    argument: 'milliseconds',
    lifetime: 'one-shot',
    firesIn: 'the owner session command relay after COMMIT, before live revocation delivery',
  },
  {
    point: 'mcp.skip-ignore-cookies',
    argument: 'none',
    lifetime: 'until-disarmed',
    firesIn: 'the /mcp and /mcp/connect route-level `ignoreCookies` hook, which it skips',
  },
]);

/** Every registered point name, for the guard and for the control route's validation. */
export const FAULT_POINT_NAMES: readonly string[] = Object.freeze(
  FAULT_POINTS.map((descriptor) => descriptor.point),
);

/** The descriptor for a point, or `undefined` when the point is not registered. */
export function describeFault(point: string): FaultPointDescriptor | undefined {
  return FAULT_POINTS.find((descriptor) => descriptor.point === point);
}

/** One armed point. */
export interface ArmedFault {
  readonly point: string;
  /** Milliseconds for a `milliseconds` point; `undefined` otherwise. */
  readonly arg: number | undefined;
  /** Remaining firings for a `counted` point; `undefined` means "until disarmed". */
  readonly remaining: number | undefined;
  /** Optional runtime selector for the two post-acknowledgement wire faults. */
  readonly ack?: FaultAckTarget;
}

/** Match an actual wire acknowledgement newer than the selected note's committed baseline. */
export interface FaultAckTarget {
  readonly noteId: string;
  readonly afterSeq: number;
}

/** The outbound frame's real identity, supplied only by the collaboration transport. */
export interface FaultAcknowledgement {
  readonly noteId: string;
  readonly seq: number;
}

function isAckTarget(value: unknown): value is FaultAckTarget {
  return (
    typeof value === 'object' &&
    value !== null &&
    'noteId' in value &&
    NoteId.safeParse(value.noteId).success &&
    'afterSeq' in value &&
    typeof value.afterSeq === 'number' &&
    Number.isSafeInteger(value.afterSeq) &&
    value.afterSeq >= 0
  );
}

/** What a caller asks for when arming. */
export interface ArmFaultRequest {
  readonly point: string;
  readonly arg?: number | undefined;
  /** `0` disarms — which is what the testkit's `ArmedFault.disarm()` sends. */
  readonly count?: number | undefined;
  /** Validated centrally, including requests from the test-only HTTP control route. */
  readonly ack?: unknown;
}

/** Why an arm request was refused. Refusals are the caller's bug, so each names the reason. */
export type ArmRefusal =
  | 'not_test_env'
  | 'unknown_point'
  | 'argument_required'
  | 'argument_not_accepted'
  | 'count_not_accepted'
  | 'ack_not_accepted'
  | 'invalid_ack'
  | 'invalid_number';

/** The outcome of `arm()`. */
export type ArmOutcome =
  | { readonly armed: true; readonly fault: ArmedFault }
  | { readonly armed: false; readonly refused: ArmRefusal };

/** What `fire()` tells the call site. */
export interface FaultFiring {
  /** Whether the point is armed and fired on this call. */
  readonly fired: boolean;
  /** The `:<ms>` argument, when the point carries one. */
  readonly arg: number | undefined;
}

const NOT_FIRED: FaultFiring = Object.freeze({ fired: false, arg: undefined });

/** `process.kill(process.pid, 'SIGKILL')`, injected so a unit test can observe the call. */
export type HardKill = () => void;

export interface FaultRegistryOptions {
  /** `config.env`. The registry is inert unless this is `test`. */
  readonly nodeEnv: string;
  /** `IRIDIUM_FAULT`, already parsed out of the environment by `config/env.ts`. */
  readonly spec?: string | null;
  readonly clock: Clock;
  readonly logger: FaultLogger;
  /** Overridden only by `ops.faults.unit`, which must not kill the test runner. */
  readonly hardKill?: HardKill;
}

/**
 * The registry.
 *
 * There is exactly one per Fastify instance, decorated as `app.faults`, and it holds the only
 * `NODE_ENV === 'test'` comparison in the server outside `config/env.ts`.
 */
export class FaultRegistry {
  readonly #armed = new Map<string, ArmedFault>();
  readonly #perConnectionFired = new Set<string>();
  readonly #holds = new Map<string, Set<() => void>>();
  readonly #enabled: boolean;
  readonly #clock: Clock;
  readonly #logger: FaultLogger;
  readonly #hardKill: HardKill;

  constructor(options: FaultRegistryOptions) {
    // The one gate. `guards.one-boot-path.guard` asserts this comparison appears nowhere else.
    this.#enabled = options.nodeEnv === 'test';
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#hardKill =
      options.hardKill ??
      ((): void => {
        process.kill(process.pid, 'SIGKILL');
      });

    if (!this.#enabled) return;
    for (const request of parseFaultSpec(options.spec ?? '')) {
      const outcome = this.arm(request);
      if (!outcome.armed) {
        // A spawn-time spec that cannot be honoured is a harness bug and must be loud: the suite would
        // otherwise pass by never reaching the fault it was written to drive.
        throw new FaultSpecError(request.point, outcome.refused);
      }
    }
  }

  /** Whether the registry is active at all (`NODE_ENV === 'test'`). */
  get enabled(): boolean {
    return this.#enabled;
  }

  /** Every armed point, for `GET`-less introspection in tests and for the drain's log line. */
  get armed(): readonly ArmedFault[] {
    return [...this.#armed.values()];
  }

  /** Arms, re-arms or (with `count: 0`) disarms one point. */
  arm(request: ArmFaultRequest): ArmOutcome {
    if (!this.#enabled) return { armed: false, refused: 'not_test_env' };
    const descriptor = describeFault(request.point);
    if (descriptor === undefined) return { armed: false, refused: 'unknown_point' };

    if (request.count === 0) {
      this.#armed.delete(request.point);
      this.#perConnectionFired.clear();
      this.#release(request.point);
      return { armed: true, fault: { point: request.point, arg: undefined, remaining: 0 } };
    }

    if (descriptor.argument === 'milliseconds') {
      if (request.arg === undefined) return { armed: false, refused: 'argument_required' };
      if (!isNonNegativeInteger(request.arg)) return { armed: false, refused: 'invalid_number' };
    } else if (request.arg !== undefined) {
      return { armed: false, refused: 'argument_not_accepted' };
    }

    if (request.count !== undefined) {
      if (descriptor.lifetime !== 'counted') return { armed: false, refused: 'count_not_accepted' };
      if (!isNonNegativeInteger(request.count)) return { armed: false, refused: 'invalid_number' };
    }

    let ack: FaultAckTarget | undefined;
    if (request.ack !== undefined) {
      if (request.point !== 'store.kill-after-ack' && request.point !== 'ws.drop-after-ack')
        return { armed: false, refused: 'ack_not_accepted' };
      if (!isAckTarget(request.ack)) return { armed: false, refused: 'invalid_ack' };
      ack = { noteId: NoteId.parse(request.ack.noteId), afterSeq: request.ack.afterSeq };
    }

    const fault: ArmedFault = {
      point: request.point,
      arg: descriptor.argument === 'milliseconds' ? request.arg : undefined,
      remaining: descriptor.lifetime === 'counted' ? request.count : undefined,
      ...(ack === undefined ? {} : { ack }),
    };
    this.#armed.set(request.point, fault);
    for (const key of this.#perConnectionFired)
      if (key.startsWith(`${request.point}:`)) this.#perConnectionFired.delete(key);
    this.#logger.warn({ point: fault.point, arg: fault.arg }, 'fault point armed');
    return { armed: true, fault };
  }

  /** Clears every armed point (`DELETE /__test__/faults`). */
  disarmAll(): void {
    this.#armed.clear();
    this.#perConnectionFired.clear();
    for (const point of this.#holds.keys()) this.#release(point);
  }

  /**
   * Whether a point fires on this call, consuming its lifetime.
   *
   * `connectionId` is required by the one `per-connection` point (`ws.drop-after-ack`): the fault fires
   * once per connection, so the caller supplies the identity the registry counts against.
   */
  fire(point: string, connectionId?: string, acknowledgement?: FaultAcknowledgement): FaultFiring {
    if (!this.#enabled) return NOT_FIRED;
    const fault = this.#armed.get(point);
    if (fault === undefined) return NOT_FIRED;
    if (
      fault.ack !== undefined &&
      (acknowledgement === undefined ||
        acknowledgement.noteId !== fault.ack.noteId ||
        acknowledgement.seq <= fault.ack.afterSeq)
    )
      return NOT_FIRED;
    const descriptor = describeFault(point);
    if (descriptor === undefined) return NOT_FIRED;

    switch (descriptor.lifetime) {
      case 'one-shot':
        this.#armed.delete(point);
        break;
      case 'counted': {
        const remaining = fault.remaining;
        if (remaining !== undefined) {
          if (remaining <= 1) this.#armed.delete(point);
          else this.#armed.set(point, { ...fault, remaining: remaining - 1 });
        }
        break;
      }
      case 'per-connection': {
        const key = `${point}:${connectionId ?? ''}`;
        if (this.#perConnectionFired.has(key)) return NOT_FIRED;
        this.#perConnectionFired.add(key);
        break;
      }
      case 'until-disarmed':
        break;
    }
    this.#logger.warn({ event: 'fault.fired', point }, 'fault point fired');
    return { fired: true, arg: fault.arg };
  }

  /**
   * The `store.slow:<ms>` / `auth.slow:<ms>` shape: awaits the armed delay, or returns immediately.
   *
   * The delay comes from the injected `Clock`, so a fault is as drivable as every other timer in the
   * server and `guards.no-sleep.guard` has nothing to complain about.
   */
  async delay(point: string): Promise<void> {
    const firing = this.fire(point);
    const ms = firing.arg;
    if (!firing.fired || ms === undefined || ms === 0) return;
    await new Promise<void>((resolve) => {
      this.#clock.after(ms, resolve);
    });
  }

  /** Hold one instruction boundary until explicit disarm, independently of runner speed. */
  async hold(point: string): Promise<void> {
    if (!this.fire(point).fired) return;
    await new Promise<void>((resolve) => {
      const pending = this.#holds.get(point) ?? new Set<() => void>();
      pending.add(resolve);
      this.#holds.set(point, pending);
    });
  }

  #release(point: string): void {
    const pending = this.#holds.get(point);
    this.#holds.delete(point);
    if (pending !== undefined) for (const resolve of pending) resolve();
  }

  /**
   * The crash shape: `SIGKILL` this process if the point is armed.
   *
   * No `finally`, no drain, no flush — that is the point (HP-2). It returns `void` rather than `never`
   * because it is a no-op when the point is not armed, which is every call in production.
   */
  crash(point: string, acknowledgement?: FaultAcknowledgement): void {
    if (!this.fire(point, undefined, acknowledgement).fired) return;
    this.#logger.warn({ point }, 'fault point is killing this process with SIGKILL');
    this.#hardKill();
  }

  /** The throw shape: raises the caller's error if the point is armed. */
  maybeThrow(point: string, error: () => Error): void {
    if (!this.fire(point).fired) return;
    throw error();
  }
}

/** Thrown when `IRIDIUM_FAULT` names a point or an argument the registry cannot honour. */
export class FaultSpecError extends Error {
  readonly code = 'config.fault_spec_invalid';
  readonly exitCode = 2;

  constructor(point: string, refused: ArmRefusal) {
    super(
      `IRIDIUM_FAULT could not arm "${point}": ${refused}. The registry's points are ` +
        `${FAULT_POINT_NAMES.join(', ')}; a suite spells them through @iridium/testkit's FAULT ` +
        'constants, never as literals, and `guards.fault-registry.guard` asserts the two lists agree.',
    );
    this.name = 'FaultSpecError';
  }
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parses `IRIDIUM_FAULT` — `store.slow:3000,ws.drop-after-ack` — into arm requests.
 *
 * The registry, not the string, decides whether `:<n>` is a duration or a count, which is the same rule
 * `@iridium/testkit/faults/control.ts` implements from the other side.
 */
export function parseFaultSpec(spec: string): readonly ArmFaultRequest[] {
  const requests: ArmFaultRequest[] = [];
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const colon = entry.indexOf(':');
    const point = colon === -1 ? entry : entry.slice(0, colon);
    if (colon === -1) {
      requests.push({ point });
      continue;
    }
    const suffix = Number.parseInt(entry.slice(colon + 1), 10);
    const descriptor = describeFault(point);
    if (descriptor?.argument === 'milliseconds') requests.push({ point, arg: suffix });
    else requests.push({ point, count: suffix });
  }
  return requests;
}
