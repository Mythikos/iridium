/** Missing historical key material is an actionable readiness failure (ARCH-09, A47). */
import { newId } from '@iridium/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditWriter } from '../../src/audit/chain.ts';
import { createAuditKeys } from '../../src/audit/keys.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { desktopClient, startAuthServer, type AuthTestServer } from '../support/auth-app.ts';
import { seedUser } from '../support/seed.ts';

let context: AuthTestServer;
beforeAll(async () => {
  context = await startAuthServer();
});
afterAll(async () => {
  await context.stop();
});

describe('audit.key-readiness.integration [area:audit]', () => {
  it.each([
    { value: '9', reason: 'audit_key_version is 9' },
    { value: 'invalid', reason: 'audit_key_version must be a positive safe integer' },
  ])(
    'keeps an unavailable promoted key ($value) degraded, then recovers after metadata repair',
    async ({ value, reason }) => {
      const user = await seedUser(context, { email: 'audit-degraded@iridium.test' });
      await context.db
        .updateTable('schema_meta')
        .set({ value })
        .where('key', '=', 'audit_key_version')
        .execute();
      let degraded: AuthTestServer | null = null;
      try {
        // Exercise failed audit signing on the actual serving owner, not a standby admission gate.
        await context.app.collab.ownerLease.relinquish();
        degraded = await startAuthServer({ waitForReady: false });
        expect(degraded.app.collab.ownerLease.held).toBe(true);
        const failed = await degraded.app.inject('/readyz');
        expect(failed.statusCode).toBe(503);
        expect(
          failed.json<{ checks: { name: string; status: string; detail: string }[] }>().checks,
        ).toContainEqual(
          expect.objectContaining({
            name: 'key_versions',
            status: 'fail',
            detail: expect.stringContaining(reason),
          }),
        );
        const refusedLogin = await desktopClient(degraded).post('/auth/sessions', {
          json: { email: user.email, password: user.password, client: 'desktop' },
        });
        expect(refusedLogin.status).toBe(503);
        expect(refusedLogin.body).toMatchObject({ code: 'unavailable' });
        expect(await degraded.db.selectFrom('sessions').select('id').execute()).toEqual([]);
        const audit = degraded.app.audit;
        const db = degraded.db;
        const before = await db.selectFrom('audit_events').select('id').execute();
        const originalUser = await db
          .selectFrom('users')
          .select('display_name')
          .where('id', '=', idBytes(user.id))
          .executeTakeFirstOrThrow();
        const mutation = () =>
          db.transaction().execute(async (trx) => {
            await trx
              .updateTable('users')
              .set({ display_name: 'audited change' })
              .where('id', '=', idBytes(user.id))
              .execute();
            return audit.record(trx, {
              action: 'admin.user.updated',
              actorType: 'system',
              credentialType: 'system',
              targetType: 'user',
              targetId: user.id,
              outcome: 'success',
              context: {},
            });
          });
        await expect(mutation()).rejects.toMatchObject({ code: 'unavailable' });
        expect(
          await db
            .selectFrom('users')
            .select('display_name')
            .where('id', '=', idBytes(user.id))
            .executeTakeFirstOrThrow(),
        ).toEqual(originalUser);
        expect(await db.selectFrom('audit_events').select('id').execute()).toEqual(before);
        await context.db
          .updateTable('schema_meta')
          .set({ value: '1' })
          .where('key', '=', 'audit_key_version')
          .execute();
        const restored = await degraded.app.inject('/readyz');
        expect(
          restored.json<{ checks: { name: string; status: string }[] }>().checks,
        ).toContainEqual(expect.objectContaining({ name: 'key_versions', status: 'ok' }));
        expect(degraded.app.audit.signingVersion).toBe(1);
        await expect(mutation()).resolves.toMatchObject({ keyVersion: 1 });
      } finally {
        await context.db
          .updateTable('schema_meta')
          .set({ value: '1' })
          .where('key', '=', 'audit_key_version')
          .execute();
        await degraded?.stop();
        await expect(context.app.collab.ownerLease.tryAcquire()).resolves.toBe(true);
        await context.app.readiness.evaluate();
      }
    },
  );

  it.each([
    { missingAudit: true, missingPepper: false, expected: 'AUDIT_HMAC_KEY v2' },
    { missingAudit: false, missingPepper: true, expected: 'AUTH_PASSWORD_PEPPER v3' },
    {
      missingAudit: true,
      missingPepper: true,
      expected: 'AUDIT_HMAC_KEY v2; AUTH_PASSWORD_PEPPER v3',
    },
  ])(
    'names every missing historical family: $expected',
    async ({ missingAudit, missingPepper, expected }) => {
      if (missingAudit) {
        // An old, correctly signed row restored with a secrets bundle that lost its historical key.
        const writer = new AuditWriter({
          keys: createAuditKeys({
            signingVersion: 2,
            keyring: {
              highest: 2,
              versions: new Map([[2, new TextEncoder().encode('retired-audit-key-not-a-secret')]]),
              sources: new Map([[2, { kind: 'value' }]]),
            },
          }),
          clock: context.clock,
        });
        await context.db.transaction().execute((trx) =>
          writer.record(trx, {
            action: 'user.login.succeeded',
            actorType: 'system',
            credentialType: 'system',
            outcome: 'success',
            context: { request_id: newId() },
          }),
        );
      }
      if (missingPepper) {
        const user = await seedUser(context, { email: 'historical-pepper@iridium.test' });
        await context.db
          .updateTable('user_credentials')
          .set({ pepper_version: 3 })
          .where('user_id', '=', idBytes(user.id))
          .execute();
      }
      const response = await context.app.inject('/readyz');
      expect(response.statusCode).toBe(503);
      const body = response.json<{ checks: { name: string; status: string; detail: string }[] }>();
      expect(body.checks.find((check) => check.name === 'key_versions')).toMatchObject({
        status: 'fail',
        detail: `rows reference key versions that are not configured: ${expected}`,
      });
      // The promoted signing key remains configured: a missing historical key is not a downgrade.
      expect(context.app.audit.signingVersion).toBe(1);
    },
  );
});
