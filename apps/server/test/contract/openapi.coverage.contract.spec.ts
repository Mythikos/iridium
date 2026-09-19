/**
 * `openapi.coverage.contract` — the other direction of the OpenAPI contract (D10-10).
 *
 * `openapi.contract` holds the document to the conventions; `toMatchOpenApi` holds each response to
 * the document. What is missing from both is the claim that the document describes nothing nobody
 * produces — a documented `(operationId, status)` pair that no test ever exercises is a promise the
 * server may already have stopped keeping.
 *
 * **The division of labour, because it is easy to expect the wrong half here.** This file is the
 * *writer*: it drives the M1 route set over a real server, asserts every response with
 * `toMatchOpenApi`, and records each pair through `registerRecordingOpenApiMatcher`, which writes one
 * fresh file per recorder under `reports/openapi-coverage/`. The *reader* is
 * `scripts/check-openapi-coverage.ts`, run by `ci.yml › merge-reports` — the one job that sees the
 * `integration` lane's files as well as this one's, and therefore the only place where "no test
 * exercised this pair" can be decided. A comparison made here would either duplicate that job badly
 * or fail on pairs another lane covers.
 *
 * What *is* asserted here is the recording contract itself: the file shape the script reads, the
 * directory the environment moves, idempotent registration, and successful wire observations. The
 * checker is also exercised with isolated documents: range/default responses must remain visible
 * without counting toward another concrete status.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import {
  COVERAGE_REPORTS_ENV,
  coverageReportPath,
  coverageReportsDirectory,
  registerRecordingOpenApiMatcher,
  writeCoverageReport,
  type CoveragePair,
  type CoverageReport,
} from '../support/openapi-coverage.ts';
import { seedUser, signInWeb } from '../support/seed.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const COVERAGE_CHECKER = join(REPO_ROOT, 'scripts', 'check-openapi-coverage.ts');

const DOCUMENT_PATH = fileURLToPath(
  new URL('../../../../packages/contracts/openapi/openapi.json', import.meta.url),
);

const document: unknown = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8'));

const HTTP_OK = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every operation and response key, including range/default declarations. */
function documentedPairs(): ReadonlySet<string> {
  const pairs = new Set<string>();
  const paths = isRecord(document) ? document['paths'] : undefined;
  if (!isRecord(paths)) return pairs;
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue;
    for (const operation of Object.values(item)) {
      if (!isRecord(operation)) continue;
      const operationId = operation['operationId'];
      const responses = operation['responses'];
      if (typeof operationId !== 'string' || !isRecord(responses)) continue;
      for (const status of Object.keys(responses)) {
        pairs.add(`${operationId} ${status}`);
      }
    }
  }
  return pairs;
}

const DOCUMENTED = documentedPairs();

function runCoverageChecker(
  responses: Readonly<Record<string, unknown>>,
  pairs: readonly CoveragePair[],
): { readonly status: number | null; readonly output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'iridium-coverage-check-'));
  const reportDirectory = join(scratch, 'reports');
  const fixturePath = join(scratch, 'openapi.json');
  try {
    mkdirSync(reportDirectory);
    writeFileSync(
      fixturePath,
      JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'Coverage checker fixture', version: '1' },
        paths: {
          '/fixture': { get: { operationId: 'fixture.operation', responses } },
          '/strict': {
            get: {
              operationId: 'strict.operation',
              responses: { 204: { description: 'No body' } },
            },
          },
        },
      }),
    );
    writeFileSync(join(reportDirectory, 'observed.json'), JSON.stringify({ pairs }));
    const result = spawnSync(process.execPath, [COVERAGE_CHECKER, '--document', fixturePath], {
      cwd: REPO_ROOT,
      env: { ...process.env, [COVERAGE_REPORTS_ENV]: reportDirectory },
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.error !== undefined) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let context: AuthTestServer;

// Registered while the file is collected, not inside `beforeAll`: Vitest binds `afterAll` to the
// suite being *collected*, so a hook registered from inside a running hook never fires and the
// worker's report is never written.
const recorder = registerRecordingOpenApiMatcher();
const repeatedRecorder = registerRecordingOpenApiMatcher();

beforeAll(async () => {
  context = await startAuthServer();
});

afterAll(async () => {
  await context.stop();
});

describe('openapi.coverage.contract [area:contracts]', () => {
  it('writes the report shape `scripts/check-openapi-coverage.ts` reads', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'iridium-coverage-'));
    const previous = process.env[COVERAGE_REPORTS_ENV];
    process.env[COVERAGE_REPORTS_ENV] = scratch;
    try {
      const written = writeCoverageReport([
        { operationId: 'meta.get', status: 200 },
        { operationId: 'vaults.list', status: 200 },
      ]);
      expect(written.startsWith(scratch)).toBe(true);
      const parsed: unknown = JSON.parse(readFileSync(written, 'utf8'));
      expect(isRecord(parsed)).toBe(true);
      const report: CoverageReport =
        isRecord(parsed) && Array.isArray(parsed['pairs'])
          ? { pairs: parsed['pairs'] }
          : { pairs: [] };
      expect(report.pairs).toStrictEqual([
        { operationId: 'meta.get', status: 200 },
        { operationId: 'vaults.list', status: 200 },
      ]);
      const emptyReport = writeCoverageReport([]);
      expect(emptyReport).not.toBe(written);
      expect(readdirSync(scratch)).toHaveLength(2);
      expect(JSON.parse(readFileSync(written, 'utf8'))).toStrictEqual(parsed);
      expect(JSON.parse(readFileSync(emptyReport, 'utf8'))).toStrictEqual({ pairs: [] });
    } finally {
      if (previous === undefined) delete process.env[COVERAGE_REPORTS_ENV];
      else process.env[COVERAGE_REPORTS_ENV] = previous;
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('writes fresh paths under the configured report directory', () => {
    const first = coverageReportPath();
    expect(dirname(first)).toBe(coverageReportsDirectory());
    expect(coverageReportPath()).not.toBe(first);
  });

  it('shares observations across repeated file registrations', async () => {
    expect(repeatedRecorder).toBe(recorder);
    const meta = await webClient(context).get('/meta');
    await expect(meta).toMatchOpenApi('meta.get', 200);
    expect(recorder.recorded.has('meta.get 200')).toBe(true);
    expect(repeatedRecorder.recorded.has('meta.get 200')).toBe(true);
    expect(registerRecordingOpenApiMatcher()).toBe(recorder);
  });

  it('refuses conflicting oracle options instead of replacing a live recorder', () => {
    expect(() => registerRecordingOpenApiMatcher({ source: {} })).toThrow(
      /different oracle options/,
    );
    expect(registerRecordingOpenApiMatcher()).toBe(recorder);
  });

  it('does not credit a rejected expected status as an observed response', async () => {
    const meta = await webClient(context).get('/meta');
    await expect(meta).not.toMatchOpenApi('meta.get', 418);
    expect(recorder.recorded.has('meta.get 418')).toBe(false);
    expect(recorder.recorded.has('meta.get 200')).toBe(true);
  });

  it('exercises the documentation operations from both sides of their policy', async () => {
    // The address never carries a word of the password: the policy refuses a `context_word`, and a
    // fixture that tripped it would fail in seeding rather than in the case it is written for.
    const admin = await seedUser(context, {
      email: 'docs-admin@example.test',
      isServerAdmin: true,
    });
    const outsider = await seedUser(context, { email: 'docs-outsider@example.test' });

    const adminClient = webClient(context, await signInWeb(context, admin));
    const outsiderClient = webClient(context, await signInWeb(context, outsider));

    const asAdmin = await adminClient.get('/openapi.json');
    await expect(asAdmin).toMatchOpenApi('meta.openapi', 200);

    const refused = await outsiderClient.get('/openapi.json');
    expect(refused.status).toBe(403);
    await expect(refused).toMatchOpenApi('meta.openapi', 403);
  });

  it('records only pairs matched by an exact, range or default response', () => {
    const undocumented = [...recorder.recorded].filter((pair) => {
      const separator = pair.lastIndexOf(' ');
      const operationId = pair.slice(0, separator);
      const status = pair.slice(separator + 1);
      return (
        !DOCUMENTED.has(pair) &&
        !DOCUMENTED.has(`${operationId} ${status[0]}XX`) &&
        !DOCUMENTED.has(`${operationId} default`)
      );
    });
    expect(undocumented).toStrictEqual([]);
  });

  it('classifies exact, range, default and unmatched observations with oracle precedence', () => {
    const result = runCoverageChecker(
      {
        200: { description: 'Exact success' },
        '2XX': { description: 'Other success' },
        default: { description: 'Other responses' },
      },
      [
        { operationId: 'fixture.operation', status: 200 },
        { operationId: 'fixture.operation', status: 201 },
        { operationId: 'fixture.operation', status: 503 },
        { operationId: 'strict.operation', status: 204 },
        { operationId: 'strict.operation', status: 418 },
        { operationId: 'removed.operation', status: 200 },
      ],
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(
      'all 3 documented (operationId, status) pair(s) were exercised',
    );
    expect(result.output).toContain('2 recorded pair(s) match an exact response status');
    expect(result.output).toContain(
      '1 recorded pair(s) match a response range: fixture.operation 201',
    );
    expect(result.output).toContain(
      '1 recorded pair(s) match a default response: fixture.operation 503',
    );
    expect(result.output).toContain(
      '2 recorded pair(s) have no matching operation/response: removed.operation 200, strict.operation 418',
    );
  });

  it('keeps a concrete status uncovered despite matching range and default observations', () => {
    const result = runCoverageChecker(
      {
        200: { description: 'Read success' },
        201: { description: 'Created' },
        '2XX': { description: 'Other success' },
        default: { description: 'Other responses' },
      },
      [
        { operationId: 'fixture.operation', status: 200 },
        { operationId: 'fixture.operation', status: 202 },
        { operationId: 'fixture.operation', status: 503 },
        { operationId: 'strict.operation', status: 204 },
      ],
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      '1 of 4 documented (operationId, status) pair(s) were never exercised',
    );
    expect(result.output).toContain('`fixture.operation` documents a 201 response');
    expect(result.output).toContain('match a response range: fixture.operation 202');
    expect(result.output).toContain('match a default response: fixture.operation 503');
  });

  it('requires a range-selected observation even when an exact status and default were exercised', () => {
    const result = runCoverageChecker(
      {
        200: { description: 'Exact success' },
        '2XX': { description: 'Other success' },
        default: { description: 'Other responses' },
      },
      [
        { operationId: 'fixture.operation', status: 200 },
        { operationId: 'fixture.operation', status: 503 },
        { operationId: 'strict.operation', status: 204 },
      ],
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      '1 of 3 documented (operationId, status) pair(s) were never exercised',
    );
    expect(result.output).toContain('`fixture.operation` documents a 2XX response');
    expect(result.output).toContain('2 recorded pair(s) match an exact response status');
    expect(result.output).toContain('match a default response: fixture.operation 503');
    expect(result.output).not.toContain('match a response range');
  });

  it('reports the pairs this lane did not reach, for the aggregating job', async () => {
    // Information, not a verdict: the `integration` lane exercises most of the route set, and only
    // `merge-reports` sees both. The assertion is that the document is not *empty* and that the
    // recorder is live — a run that recorded nothing would otherwise look like perfect coverage.
    expect(DOCUMENTED.size).toBeGreaterThan(20);

    // The pair is driven here rather than borrowed from the cases above: the project shuffles its
    // order (`vitest.config.ts`, `sequence.shuffle`), so a case that reads what another one recorded
    // passes or fails by seed. `GET /meta` is public, which is what makes the drive self-contained.
    const meta = await webClient(context).get('/meta');
    expect(meta.status).toBe(HTTP_OK);
    await expect(meta).toMatchOpenApi('meta.get', HTTP_OK);

    expect(recorder.recorded.has(`meta.get ${String(HTTP_OK)}`)).toBe(true);
  });

  it('keeps the CSRF headers a cookie client must send', async () => {
    // The `Origin` a cookie principal sends on an unsafe method is what the CSRF guard reads; the
    // helper is what every suite here uses, and a change to it would silently make these drives
    // exercise the bearer path instead.
    expect(webHeaders(context.origin)).toStrictEqual({ origin: context.origin });
  });
});
