/** The real boot path keeps audit readiness honest before any database is reachable (ARCH-02). */
import { describe, expect, it } from 'vitest';

import { buildWithoutDatabase } from '../../test/support/no-database-app.ts';

describe('audit.plugin.unit [area:audit]', () => {
  it.each([
    { configured: false, status: 'fail', detail: 'no AUDIT_HMAC_KEY version is configured' },
    {
      configured: true,
      status: 'warn',
      detail: 'waiting for a reachable database to compare key versions with schema_meta',
    },
  ])(
    'reports $status while the database is absent and key configuration is $configured',
    async ({ configured, status, detail }) => {
      const harness = await buildWithoutDatabase({
        extraEnv: configured ? { AUDIT_HMAC_KEY: 'audit-offline-not-a-secret' } : {},
      });
      try {
        await harness.app.ready();
        const response = await harness.app.inject('/readyz');
        const body = response.json<{
          checks: { name: string; status: string; detail: string }[];
        }>();
        expect(body.checks.find((check) => check.name === 'key_versions')).toMatchObject({
          status,
          detail,
        });
        await expect(
          Promise.resolve().then(() => harness.app.audit.signingVersion),
        ).rejects.toMatchObject({
          code: 'unavailable',
        });
        expect(harness.app.database.dbApp).toBeNull();
      } finally {
        await harness.close();
      }
    },
  );
});
