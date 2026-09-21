/** Permission-driven M2 viewer enforcement over the real route and OpenAPI inventories (D10-26). */
import { ProblemDetails, matrixAllows } from '@iridium/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import {
  ADMIN_FLAG_CASES,
  HISTORY_CASES,
  authorizationRowCounts,
  expectAuthorizationInventory,
  permissionCaseEntries,
  seedAuthorization,
  type AuthorizationFixture,
} from '../support/authz-content-fixture.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

const PERMITTED = permissionCaseEntries().filter((entry) =>
  matrixAllows('viewer', entry.permission),
);
const REFUSED = permissionCaseEntries().filter(
  (entry) => !matrixAllows('viewer', entry.permission),
);
const HISTORY_PERMITTED = Object.entries(HISTORY_CASES).filter(([, testCase]) =>
  matrixAllows('viewer', testCase.permission),
);
const HISTORY_REFUSED = Object.entries(HISTORY_CASES).filter(
  ([, testCase]) => !matrixAllows('viewer', testCase.permission),
);

let context: AuthTestServer;
let fixture: AuthorizationFixture;

registerRecordingOpenApiMatcher();

beforeAll(async () => {
  context = await startAuthServer({ extraEnv: { JOBS_ENABLED: 'false' } });
});

beforeEach(async () => {
  fixture = await seedAuthorization(context);
});

afterAll(async () => {
  await context.stop();
});

describe('authz.rest-viewer.integration [spec:viewer-enforcement]', () => {
  it('binds every policy and case to the actual registered and documented operations', () => {
    expect(PERMITTED.length + REFUSED.length).toBeGreaterThan(0);
    expectAuthorizationInventory(context.app);
  });

  describe.each(['active', 'archived'] as const)('%s vault reads', (status) => {
    beforeEach(async () => {
      if (status === 'archived') {
        const response = await fixture.adminClient.post(
          `/vaults/${fixture.target.vaultId}/archive`,
          { ifMatch: 1, json: { confirm: true } },
        );
        if (response.status !== 200)
          throw new Error(`Archive fixture failed: ${JSON.stringify(response.body)}`);
      }
    });

    it.each(PERMITTED)(
      '$operationId returns its documented success',
      async ({ operationId, route, testCase }) => {
        const response = await testCase.request(fixture.viewerClient, fixture.target);
        const success = route.responses
          .filter((entry) => entry.status >= 200 && entry.status < 300)
          .map((entry) => entry.status);
        expect(success, `${operationId} refused a permission the viewer holds`).toContain(
          response.status,
        );
        await expect(response).toMatchOpenApi(operationId, response.status);
      },
    );

    it.each(HISTORY_PERMITTED)(
      '%s permits the history-gated variant',
      async (_surface, testCase) => {
        const response = await testCase.request(fixture.viewerClient, fixture.target);
        expect(response.status).toBe(200);
        await expect(response).toMatchOpenApi(testCase.operationId, 200);
      },
    );
  });

  it.each(REFUSED)(
    '$operationId refuses with 403 and changes no business or audit table count',
    async ({ operationId, testCase }) => {
      const before = await authorizationRowCounts(context);
      const response = await testCase.request(fixture.viewerClient, fixture.target);
      expect(response.status).toBe(403);
      expect(ProblemDetails.parse(response.body).code).toBe('forbidden');
      await expect(response).toMatchOpenApi(operationId, 403);
      expect(await authorizationRowCounts(context), operationId).toStrictEqual(before);
    },
  );

  it.each(Object.entries(ADMIN_FLAG_CASES))(
    '%s refuses the administrative documentation without durable changes',
    async (operationId, testCase) => {
      const before = await authorizationRowCounts(context);
      const response = await testCase.request(fixture.viewerClient);
      expect(response.status).toBe(403);
      expect(ProblemDetails.parse(response.body).code).toBe('forbidden');
      await expect(response).toMatchOpenApi(operationId, 403);
      expect(await authorizationRowCounts(context)).toStrictEqual(before);
    },
  );

  it.each(HISTORY_REFUSED)(
    '%s refuses the history mutation without rows or revocation events',
    async (_surface, testCase) => {
      const before = await authorizationRowCounts(context);
      const events: unknown[] = [];
      const unsubscribe = context.app.authz.bus.subscribe((event) => events.push(event));
      try {
        const response = await testCase.request(fixture.viewerClient, fixture.target);
        expect(response.status).toBe(403);
        expect(ProblemDetails.parse(response.body).code).toBe('forbidden');
        await expect(response).toMatchOpenApi(testCase.operationId, 403);
        expect(await authorizationRowCounts(context)).toStrictEqual(before);
        expect(events).toEqual([]);
      } finally {
        unsubscribe();
      }
    },
  );

  it('returns the viewer role while a server administrator remains an implied manager', async () => {
    const viewer = await fixture.viewerClient.get<{ role: string; effectiveRole: string }>(
      `/vaults/${fixture.target.vaultId}`,
    );
    expect(viewer.status).toBe(200);
    expect(viewer.body).toMatchObject({ role: 'viewer', effectiveRole: 'viewer' });
    const admin = await fixture.adminClient.get<{ role: string | null; effectiveRole: string }>(
      `/vaults/${fixture.target.vaultId}`,
    );
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ role: null, effectiveRole: 'manager' });
    expect(
      await context.db
        .selectFrom('vault_members')
        .select('user_id')
        .where('vault_id', '=', idBytes(fixture.target.vaultId))
        .where('user_id', '=', idBytes(fixture.admin.id))
        .execute(),
    ).toEqual([]);
  });
});
