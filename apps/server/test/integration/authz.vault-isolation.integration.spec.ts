/** Foreign and missing identifiers are indistinguishable across every M2 resource surface (D10-39). */
import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { API_ROUTES, ProblemDetails, SearchPage } from '@iridium/contracts';
import { restClient, type RestClient, type RestResponse } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import {
  HISTORY_CASES,
  SESSION_RESOURCE_CASES,
  absentAuthorizationTarget,
  authorizationRowCounts,
  expectAuthorizationInventory,
  isResourceIdRoute,
  permissionCaseEntries,
  seedAuthorization,
  seedRestoredHistory,
  type AuthorizationCase,
  type AuthorizationFixture,
  type AuthorizationTarget,
} from '../support/authz-content-fixture.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

const RESOURCE_CASES = permissionCaseEntries().filter((entry) => isResourceIdRoute(entry.route));
const TIMING_PAIRS = 11;
const REPORT_DIRECTORY = resolve('reports', 'authz');

let context: AuthTestServer;
let fixture: AuthorizationFixture;

registerRecordingOpenApiMatcher();

beforeAll(async () => {
  context = await startAuthServer({ extraEnv: { JOBS_ENABLED: 'false' } });
  await mkdir(REPORT_DIRECTORY, { recursive: true });
});

beforeEach(async () => {
  fixture = await seedAuthorization(context);
});

afterAll(async () => {
  await context.stop();
});

function median(samples: readonly number[]): number {
  const result = samples.toSorted((left, right) => left - right)[Math.floor(samples.length / 2)];
  if (result === undefined) throw new Error('A timing comparison needs nonempty samples.');
  return result;
}

function comparableHeaders(response: RestResponse): Readonly<Record<string, string>> {
  // Request IDs, time, CSP entropy and the per-principal counter vary independently of resource IDs.
  // The nonce format and exact counter decrement are separately asserted below, never ignored.
  return Object.fromEntries(
    [...response.headers.entries()]
      .filter(([name]) => name !== 'date' && name !== 'x-request-id')
      .map(([name, value]) => [
        name,
        name === 'content-security-policy'
          ? value.replace(/'nonce-[a-f\d]{32}'/g, "'nonce-<request>'")
          : name === 'x-ratelimit-remaining'
            ? '<request counter>'
            : value,
      ]),
  );
}

function expectHiddenPair(real: RestResponse, absent: RestResponse, expected: 403 | 404): void {
  expect(real.status).toBe(expected);
  expect(absent.status).toBe(expected);
  const { requestId: realRequestId, ...realProblem } = ProblemDetails.parse(real.body);
  const { requestId: absentRequestId, ...absentProblem } = ProblemDetails.parse(absent.body);
  expect(realRequestId).not.toBe(absentRequestId);
  expect(JSON.stringify(realProblem)).toBe(JSON.stringify(absentProblem));
  expect(realProblem.code).toBe(expected === 404 ? 'not_found' : 'forbidden');
  expectEquivalentHeaders(real, absent);
}

function expectEquivalentHeaders(real: RestResponse, absent: RestResponse): void {
  const realNonce = real.headers
    .get('content-security-policy')
    ?.match(/'nonce-([a-f\d]{32})'/)?.[1];
  const absentNonce = absent.headers
    .get('content-security-policy')
    ?.match(/'nonce-([a-f\d]{32})'/)?.[1];
  expect(realNonce).toMatch(/^[a-f\d]{32}$/);
  expect(absentNonce).toMatch(/^[a-f\d]{32}$/);
  expect(realNonce).not.toBe(absentNonce);
  expect(
    Math.abs(
      Number(real.headers.get('x-ratelimit-remaining')) -
        Number(absent.headers.get('x-ratelimit-remaining')),
    ),
  ).toBe(1);
  expect(comparableHeaders(real)).toEqual(comparableHeaders(absent));
  expect(real.headers.get('etag')).toBeNull();
  expect(absent.headers.get('etag')).toBeNull();
  expect(real.headers.get('last-modified')).toBeNull();
  expect(absent.headers.get('last-modified')).toBeNull();
  expect(real.headers.get('retry-after')).toBe(absent.headers.get('retry-after'));
}

function expectEmptySearchPair(real: RestResponse, absent: RestResponse): void {
  expect(real.status).toBe(200);
  expect(absent.status).toBe(200);
  expect(SearchPage.parse(real.body).results).toEqual([]);
  expect(SearchPage.parse(absent.body).results).toEqual([]);
  expect(real.body).toEqual(absent.body);
  expectEquivalentHeaders(real, absent);
}

const EXPECT_PAIR = {
  200: expectEmptySearchPair,
  403: (real: RestResponse, absent: RestResponse) => expectHiddenPair(real, absent, 403),
  404: (real: RestResponse, absent: RestResponse) => expectHiddenPair(real, absent, 404),
};

async function expectDenialLog(
  response: RestResponse,
  operationId: string,
  expected: 403 | 404,
): Promise<void> {
  const problem = ProblemDetails.parse(response.body);
  await expect
    .poll(async () =>
      context.db
        .selectFrom('access_log')
        .select(['user_id', 'surface', 'action', 'status', 'vault_id', 'note_ids'])
        .where('request_id', '=', idBytes(problem.requestId))
        .execute(),
    )
    .toEqual([
      {
        user_id: idBytes(fixture.outsider.id),
        surface: 'rest',
        action: operationId,
        status: expected === 404 ? 'not_found' : 'denied',
        vault_id: null,
        note_ids: null,
      },
    ]);
}

async function timedRequest(
  testCase: AuthorizationCase,
  target: AuthorizationTarget,
  client: RestClient,
): Promise<{ readonly response: RestResponse; readonly elapsed: number }> {
  const started = performance.now();
  const response = await testCase.request(client, target);
  return { response, elapsed: performance.now() - started };
}

async function proveIsolation(
  operationId: string,
  testCase: AuthorizationCase,
  expected: 200 | 403 | 404,
  surface = operationId,
): Promise<void> {
  const unknown = absentAuthorizationTarget();
  // Exclude the OpenAPI matcher from measured network latency; validate each response after timing.
  const measuredClient = restClient({
    origin: fixture.outsiderClient.origin,
    jar: fixture.outsiderClient.jar,
    originHeader: context.origin,
    client: 'web',
  });
  const counts = await authorizationRowCounts(context);
  const real = await testCase.request(fixture.outsiderClient, fixture.target);
  const absent = await testCase.request(fixture.outsiderClient, unknown);
  EXPECT_PAIR[expected](real, absent);
  await expect(real).toMatchOpenApi(operationId, expected);
  await expect(absent).toMatchOpenApi(operationId, expected);
  if (expected !== 200)
    await Promise.all([
      expectDenialLog(real, operationId, expected),
      expectDenialLog(absent, operationId, expected),
    ]);
  const realLatencies: number[] = [];
  const absentLatencies: number[] = [];
  for (let index = 0; index < TIMING_PAIRS; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- paired sequential requests alternate order to avoid queue contention and warm-cache bias
    const first = await timedRequest(
      testCase,
      index % 2 === 0 ? fixture.target : unknown,
      measuredClient,
    );
    // eslint-disable-next-line no-await-in-loop -- the second sample follows the first with no concurrent request load
    const second = await timedRequest(
      testCase,
      index % 2 === 0 ? unknown : fixture.target,
      measuredClient,
    );
    const onReal = index % 2 === 0 ? first : second;
    const onAbsent = index % 2 === 0 ? second : first;
    EXPECT_PAIR[expected](onReal.response, onAbsent.response);
    // eslint-disable-next-line no-await-in-loop -- verify the just-measured pair before taking the next network samples
    await Promise.all([
      expect(onReal.response).toMatchOpenApi(operationId, expected),
      expect(onAbsent.response).toMatchOpenApi(operationId, expected),
    ]);
    realLatencies.push(onReal.elapsed);
    absentLatencies.push(onAbsent.elapsed);
  }
  const realMedianMs = median(realLatencies);
  const absentMedianMs = median(absentLatencies);
  const ratio = Math.max(realMedianMs, absentMedianMs) / Math.min(realMedianMs, absentMedianMs);
  await appendFile(
    resolve(REPORT_DIRECTORY, 'vault-isolation.jsonl'),
    `${JSON.stringify({ image: inject('iridiumMysql').image, surface, operationId, expected, realLatencies, absentLatencies, realMedianMs, absentMedianMs, ratio })}\n`,
  );
  expect(
    ratio,
    `${operationId}: real ${realMedianMs} ms, missing ${absentMedianMs} ms`,
  ).toBeLessThanOrEqual(2);
  expect(await authorizationRowCounts(context)).toStrictEqual(counts);
}

describe('authz.vault-isolation.integration [spec:viewer-enforcement]', () => {
  it('binds every resource case to the real policies, registrations and checked-in OpenAPI', () => {
    expectAuthorizationInventory(context.app);
    expect(
      [
        ...RESOURCE_CASES.map((entry) => entry.operationId),
        ...Object.keys(SESSION_RESOURCE_CASES),
      ].toSorted(),
    ).toEqual(
      API_ROUTES.filter(isResourceIdRoute)
        .map((entry) => entry.operationId)
        .toSorted(),
    );
  });

  it.each(RESOURCE_CASES)(
    '$operationId hides foreign and missing IDs with identical bodies, headers and bounded timing',
    async ({ operationId, route, testCase }) => {
      expect(isResourceIdRoute(route)).toBe(true);
      // The server-admin policy runs before a job lookup. Both identifiers must therefore return 403.
      const expected = typeof route.auth === 'object' && 'serverAdmin' in route.auth ? 403 : 404;
      await proveIsolation(operationId, testCase, expected);
    },
  );

  it.each(Object.entries(SESSION_RESOURCE_CASES))(
    '%s filters foreign and missing query IDs to the same empty collection',
    async (operationId, testCase) => {
      expect(API_ROUTES.find((route) => route.operationId === operationId)?.auth).toMatchObject({
        session: true,
      });
      await proveIsolation(operationId, testCase, 200);
    },
  );

  describe('foreign-vault revision history', () => {
    beforeEach(async () => {
      await seedRestoredHistory(context, fixture);
    });

    it.each(Object.entries(HISTORY_CASES))(
      '%s hides retained history without rows or live revocation',
      async (surface, testCase) => {
        const retained = await context.db
          .selectFrom('note_revisions')
          .select('kind')
          .where('note_id', '=', idBytes(fixture.target.noteId))
          .execute();
        expect(retained.map((row) => row.kind)).toEqual(
          expect.arrayContaining(['named', 'restore']),
        );
        const events: unknown[] = [];
        const unsubscribe = context.app.authz.bus.subscribe((event) => events.push(event));
        try {
          await proveIsolation(testCase.operationId, testCase, 404, surface);
          expect(events).toEqual([]);
        } finally {
          unsubscribe();
        }
      },
    );
  });

  it('has readable real content for its member, while cross-vault listings reveal no foreign content', async () => {
    const member = await fixture.adminClient.get(`/notes/${fixture.target.noteId}`);
    expect(member.status).toBe(200);
    const vaults = await fixture.outsiderClient.get<{ items: unknown[] }>('/vaults');
    expect(vaults.status).toBe(200);
    expect(vaults.body.items).toEqual([]);
    const search = await fixture.outsiderClient.get('/search', {
      query: { q: 'needle' },
    });
    expect(search.status).toBe(200);
    expect(SearchPage.parse(search.body).results).toEqual([]);
  });
});
