/**
 * The writer half of the OpenAPI coverage gate (10-testing-and-quality.md, "REST — OpenAPI contract";
 * D10-10).
 *
 * The rule has two directions and two owners. `openapi.contract` and the Redocly lint hold the
 * *document* to the code; this holds the *tests* to the document — every documented
 * `(operationId, status)` pair must be exercised somewhere in the `integration` + `contract` run.
 * The failing is `scripts/check-openapi-coverage.ts`'s, in the one CI job that sees every lane; what
 * happens here is the recording it aggregates.
 *
 * So this module wraps the testkit's `toMatchOpenApi` matcher: every response the oracle accepts is
 * recorded. Each file owns one recorder and writes a fresh report under `reports/openapi-coverage/`;
 * worker ids and processes can be reused across files. The directory and the file shape are the ones
 * that script reads, and `IRIDIUM_TEST_OPENAPI_COVERAGE_REPORTS` moves both.
 *
 * A suite opts in by calling `registerRecordingOpenApiMatcher()` instead of the testkit's
 * `registerOpenApiMatcher()`. The shared auth harness opts in for every real REST response it drives;
 * a suite that also registers gets the same recorder without replacing its observations or hooks.
 *
 * **Call it while the file is being collected, never from inside a hook.** It registers an `afterAll`,
 * and Vitest binds a hook to the suite it is *collecting*; one registered from inside a running
 * `beforeAll` is attached to nothing, so the worker's report is silently never written and the gate
 * reads an empty run as "no test exercised anything".
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  registerOpenApiMatcher,
  type OpenApiOracle,
  type OpenApiOracleOptions,
} from '@iridium/testkit';
import { afterAll, expect } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Where the workers write. `scripts/check-openapi-coverage.ts` reads the same two values. */
export const COVERAGE_REPORTS_ENV = 'IRIDIUM_TEST_OPENAPI_COVERAGE_REPORTS';

/** The default directory, relative to the repository root. */
export const COVERAGE_REPORTS_DEFAULT = join('reports', 'openapi-coverage');

/** One exercised pair, as the report file carries it. */
export interface CoveragePair {
  readonly operationId: string;
  readonly status: number;
}

/** One recorder's report file. */
export interface CoverageReport {
  readonly pairs: readonly CoveragePair[];
}

/** The directory this run writes to; relative values are repository-relative. */
export function coverageReportsDirectory(): string {
  const configured = process.env[COVERAGE_REPORTS_ENV]?.trim();
  if (configured === undefined || configured === '') {
    return join(REPO_ROOT, COVERAGE_REPORTS_DEFAULT);
  }
  return isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
}

/** A fresh report path, unique even when a worker process writes more than once. */
export function coverageReportPath(): string {
  const worker = process.env['VITEST_WORKER_ID'] ?? '1';
  return join(
    coverageReportsDirectory(),
    `worker-${worker}-${String(process.pid)}-${randomUUID()}.json`,
  );
}

/** The pairs recorded so far in this worker, deduplicated and ordered. */
export function recordedPairs(recorded: ReadonlySet<string>): readonly CoveragePair[] {
  return [...recorded].toSorted().map((key) => {
    const separator = key.lastIndexOf(' ');
    return {
      operationId: key.slice(0, separator),
      status: Number(key.slice(separator + 1)),
    };
  });
}

/** Writes a new report without overwriting another file's observations. */
export function writeCoverageReport(pairs: readonly CoveragePair[]): string {
  const path = coverageReportPath();
  mkdirSync(coverageReportsDirectory(), { recursive: true });
  const report: CoverageReport = { pairs };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return path;
}

/** What a suite gets back: the oracle, and a view of what this file has recorded. */
export interface RecordingOpenApiMatcher {
  readonly oracle: OpenApiOracle;
  /** `"<operationId> <status>"` for every response the oracle accepted so far. */
  readonly recorded: ReadonlySet<string>;
}

interface Registration {
  readonly options: OpenApiOracleOptions;
  readonly matcher: RecordingOpenApiMatcher;
}

class RecordingRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordingRegistrationError';
  }
}

/** The registry owns one oracle, observation set and teardown hook per collected test file. */
class RecordingMatcherRegistry {
  readonly #registrations = new Map<string, Registration>();
  readonly #registerTeardown: typeof afterAll;

  constructor(registerTeardown: typeof afterAll) {
    this.#registerTeardown = registerTeardown;
  }

  register(file: string, options: OpenApiOracleOptions): RecordingOpenApiMatcher {
    const existing = this.#registrations.get(file);
    if (existing !== undefined) {
      if (
        existing.options.source !== options.source ||
        existing.options.configureAjv !== options.configureAjv
      ) {
        throw new RecordingRegistrationError(
          `${file} registered OpenAPI coverage with different oracle options; use one document and ` +
            'Ajv configuration for every registration in that test file.',
        );
      }
      return existing.matcher;
    }

    const matcher = createRecordingMatcher(options);
    this.#registerTeardown(() => {
      writeCoverageReport(recordedPairs(matcher.recorded));
      this.#registrations.delete(file);
    });
    this.#registrations.set(file, { options: { ...options }, matcher });
    return matcher;
  }
}

const RECORDING_MATCHERS = new RecordingMatcherRegistry(afterAll);

function createRecordingMatcher(options: OpenApiOracleOptions): RecordingOpenApiMatcher {
  const oracle = registerOpenApiMatcher(options);
  const recorded = new Set<string>();

  expect.extend({
    async toMatchOpenApi(received: unknown, operationId: string, status: number) {
      const subject = {
        status:
          typeof received === 'object' && received !== null && 'status' in received
            ? Number(Reflect.get(received, 'status'))
            : Number.NaN,
        contentType:
          typeof received === 'object' && received !== null && 'contentType' in received
            ? toNullableString(Reflect.get(received, 'contentType'))
            : null,
        body:
          typeof received === 'object' && received !== null && 'body' in received
            ? Reflect.get(received, 'body')
            : undefined,
      };
      if (!Number.isFinite(subject.status)) {
        return {
          pass: false,
          message: () =>
            'toMatchOpenApi expects a testkit RestResponse (or {status, contentType, body})',
        };
      }
      const result = await oracle.check(subject, operationId, status);
      if (result.pass) recorded.add(`${operationId} ${String(status)}`);
      return { pass: result.pass, message: () => result.message };
    },
  });

  return { oracle, recorded };
}

/**
 * Registers one recording matcher per test file. Repeated calls share observations and teardown.
 * Only oracle-accepted responses count: a wrong expected status or malformed body is not coverage.
 */
export function registerRecordingOpenApiMatcher(
  options: OpenApiOracleOptions = {},
): RecordingOpenApiMatcher {
  const file = expect.getState().testPath;
  if (typeof file !== 'string' || file === '') {
    throw new RecordingRegistrationError(
      'OpenAPI coverage has no active test file; register it while a Vitest file is being collected.',
    );
  }
  return RECORDING_MATCHERS.register(file, options);
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
