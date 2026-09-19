/**
 * The problem-mapping registry: how an area's own error classes become `ProblemDetails`
 * (09-api-reference.md §1.4, §1.5; ARCH-12; skeleton A6).
 *
 * `security/problem.ts` maps what every route can raise — a deliberate `ProblemError`, a zod validation
 * failure, Fastify's own codes, the rate limiter — and answers `server_error` for everything else. That
 * last branch is correct as a default and wrong as a destination: an area that raises a named error
 * carrying a remedy (`stale_version` with the current representation, `capacity`, `content_invalid`)
 * needs that error to reach the client as itself, and the alternative to a registry is a growing
 * `instanceof` chain inside the one module every area would then have to edit.
 *
 * **The contract for another stream.** Register one mapper per area, at that area's boot step, naming the
 * area:
 *
 * ```ts
 * app.problems.register('db', (error) => toProblem(error));            // apps/server/src/db/failure.ts
 * app.problems.register('collab', (error) =>
 *   error instanceof AdmissionRefusedError ? new ProblemError('capacity', { detail: error.message }) : null);
 * ```
 *
 * A mapper returns `null` for an error it does not own, and the first mapper that returns a
 * `ProblemError` wins. Registration order is boot order, which is the order the areas themselves are
 * layered in, so a later area cannot shadow an earlier one's mapping by accident; registering the same
 * name twice replaces that area's mapper rather than adding a second one, because an area has exactly one
 * mapping table.
 *
 * **A mapper must not throw.** One that does is caught, logged, and treated as "not mine": an error
 * handler that fails while handling an error is how a 500 becomes a hung request.
 */
import type { ProblemError } from './problem.ts';

/** One area's mapping: the `ProblemError` an error becomes, or `null` when the area does not own it. */
export type ProblemMapper = (error: unknown) => ProblemError | null;

/** What the registry reports when a mapper itself failed. */
export interface MapperFailure {
  readonly area: string;
  readonly error: unknown;
}

/**
 * The registry. One instance per Fastify instance, decorated as `app.problems`.
 *
 * It is a class rather than a module-level map because module-level mutable state would be shared between
 * two `buildApp()` calls in one process — which is exactly what the `in-process` test mode does.
 */
export class ProblemRegistry {
  readonly #mappers = new Map<string, ProblemMapper>();
  readonly #failures: MapperFailure[] = [];

  /** Registers (or replaces) one area's mapper. */
  register(area: string, mapper: ProblemMapper): void {
    this.#mappers.set(area, mapper);
  }

  /** The areas that have registered, in registration order — what `guards.error-shape.guard` reads. */
  get areas(): readonly string[] {
    return [...this.#mappers.keys()];
  }

  /** Mapper failures observed so far, so a test can assert that none happened. */
  get failures(): readonly MapperFailure[] {
    return this.#failures;
  }

  /**
   * The first `ProblemError` any registered area produces for this error, or `null` when no area owns it —
   * in which case `security/problem.ts`'s own classification decides.
   */
  map(error: unknown): ProblemError | null {
    for (const [area, mapper] of this.#mappers) {
      let mapped: ProblemError | null;
      try {
        mapped = mapper(error);
      } catch (mapperError) {
        this.#failures.push({ area, error: mapperError });
        continue;
      }
      if (mapped !== null) return mapped;
    }
    return null;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The problem-mapping registry. Each area registers its own error classes at its boot step; the one
     * error handler consults it before falling back to `server_error`.
     */
    problems: ProblemRegistry;
  }
}
