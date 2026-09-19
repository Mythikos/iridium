/**
 * Audit failure is part of the caller's transaction: real SQL refusals and head contention must
 * roll back the mutation, settle within the serving SQL budget, and never append twice on retry.
 */
import { chainIdForVault, newId } from '@iridium/contracts';
import { corruptDeliberately, inspectCreationCounts } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { verifyChain, type AuditEventInput, type AuditKeys } from '../../src/audit/chain.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../../src/audit/keys.ts';
import { classifyDatabaseFailure } from '../../src/db/failure.ts';
import { applyGrants } from '../../src/db/grants.ts';
import { createMaintDb } from '../../src/db/migrator.ts';
import { createUser } from '../../src/users/service.ts';
import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';

let context: AuthTestServer;
let admin: ReturnType<typeof createMaintDb>;
let keys: AuditKeys;

beforeAll(async () => {
  context = await startAuthServer({ extraEnv: { DB_QUERY_TIMEOUT_MS: '2000' } });
  const connectionUrl = new URL(inject('iridiumMysql').rootUri);
  connectionUrl.pathname = new URL(context.app.iridiumConfig.db.appUrl).pathname;
  admin = createMaintDb(connectionUrl.toString());
  keys = createAuditKeys({
    keyring: context.app.iridiumConfig.keys.auditHmac,
    signingVersion: await readPromotedAuditKeyVersion(context.db),
  });
});

afterAll(async () => {
  await admin?.db.destroy();
  await context?.stop();
});

/** Observe every table the real create-user transaction may write, plus the chain position. */
async function creationState(): Promise<unknown> {
  const result = await inspectCreationCounts(context.db);
  const heads = await context.db
    .selectFrom('audit_chain_heads')
    .selectAll()
    .orderBy('chain_id')
    .execute();
  return { counts: result.rows, heads };
}

function eventFor(vaultId: string, requestId: string): AuditEventInput {
  return {
    action: 'node.created',
    vaultId,
    actorType: 'system',
    credentialType: 'cli',
    targetType: 'node',
    targetId: newId(),
    outcome: 'success',
    context: { request_id: requestId },
  };
}

describe('audit.bounded-failures.integration [area:audit]', () => {
  it('rolls back the real create-user row and one-time link when audit INSERT is denied', async () => {
    const before = await creationState();
    const schema = admin.target.database;
    await corruptDeliberately(admin.db, {
      kind: 'revoke-app-privilege',
      schema,
      table: 'audit_events',
      privilege: 'INSERT',
    });
    try {
      await expect(
        createUser(
          {
            db: context.db,
            audit: context.app.audit,
            setpw: context.app.auth.setpw,
            sessionRepository: (transaction) => context.app.auth.sessionRepository(transaction),
          },
          {
            email: 'audit-refused@example.test',
            displayName: 'Rollback fixture',
            isServerAdmin: false,
            actor: { kind: 'cli' },
            context: { request_id: newId() },
            now: context.clock.date(),
          },
        ),
      ).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR', errno: 1142 });
      expect(await creationState()).toEqual(before);
      expect(
        await context.db
          .selectFrom('users')
          .select('id')
          .where('email', '=', 'audit-refused@example.test')
          .execute(),
      ).toEqual([]);
    } finally {
      await applyGrants(admin.db, ['audit_events']);
    }
  });

  it('rolls back earlier business writes and a new head when MySQL refuses the audit row shape', async () => {
    const vaultId = newId();
    const chainId = chainIdForVault(vaultId);
    const before = await context.db
      .selectFrom('schema_meta')
      .select('value')
      .where('key', '=', 'api_version')
      .executeTakeFirstOrThrow();
    await expect(
      context.db.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('schema_meta')
          .set({ value: 'audit-shape-uncommitted' })
          .where('key', '=', 'api_version')
          .execute();
        await context.app.audit.record(transaction, {
          ...eventFor(vaultId, newId()),
          actorDisplay: 'x'.repeat(161),
        });
      }),
    ).rejects.toMatchObject({ code: 'ER_DATA_TOO_LONG', errno: 1406 });
    expect(
      await context.db
        .selectFrom('schema_meta')
        .select('value')
        .where('key', '=', 'api_version')
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(
      await context.db
        .selectFrom('audit_events')
        .select('id')
        .where('chain_id', '=', chainId)
        .execute(),
    ).toEqual([]);
    expect(
      await context.db
        .selectFrom('audit_chain_heads')
        .select('chain_id')
        .where('chain_id', '=', chainId)
        .execute(),
    ).toEqual([]);
  });

  it('bounds a held chain head, rolls back preceding writes, and appends exactly once after caller retry', async () => {
    const vaultId = newId();
    const chainId = chainIdForVault(vaultId);
    const requestId = newId();
    await context.db
      .transaction()
      .execute((transaction) => context.app.audit.record(transaction, eventFor(vaultId, newId())));
    const initialHead = await context.db
      .selectFrom('audit_chain_heads')
      .selectAll()
      .where('chain_id', '=', chainId)
      .executeTakeFirstOrThrow();
    const initialValue = await context.db
      .selectFrom('schema_meta')
      .select('value')
      .where('key', '=', 'api_version')
      .executeTakeFirstOrThrow();
    const event = eventFor(vaultId, requestId);
    const attempt = (): Promise<unknown> =>
      context.db.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('schema_meta')
          .set({ value: 'audit-contention-committed' })
          .where('key', '=', 'api_version')
          .execute();
        return context.app.audit.record(transaction, event);
      });
    try {
      await admin.db.transaction().execute(async (blocker) => {
        await blocker
          .selectFrom('audit_chain_heads')
          .select('chain_id')
          .where('chain_id', '=', chainId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const outcome = await attempt().then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
        expect(outcome.error).toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
        expect(classifyDatabaseFailure(outcome.error)).toEqual({ kind: 'lock_wait_timeout' });
        expect(
          await context.db
            .selectFrom('schema_meta')
            .select('value')
            .where('key', '=', 'api_version')
            .executeTakeFirstOrThrow(),
        ).toEqual(initialValue);
        expect(
          await context.db
            .selectFrom('audit_chain_heads')
            .selectAll()
            .where('chain_id', '=', chainId)
            .executeTakeFirstOrThrow(),
        ).toEqual(initialHead);
        expect(
          await context.db
            .selectFrom('audit_events')
            .select('id')
            .where('chain_id', '=', chainId)
            .execute(),
        ).toHaveLength(1);
      });
      await attempt();
      const rows = await context.db
        .selectFrom('audit_events')
        .select(['id', 'context', 'hash', 'prev_hash'])
        .where('chain_id', '=', chainId)
        .orderBy('id')
        .execute();
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.context.request_id === requestId)).toHaveLength(1);
      expect(rows[1]?.prev_hash).toEqual(initialHead.last_hash);
      expect(await verifyChain(context.db, chainId, keys)).toMatchObject({
        ok: true,
        rows: 2,
        divergence: null,
      });
      expect(
        await context.db
          .selectFrom('schema_meta')
          .select('value')
          .where('key', '=', 'api_version')
          .executeTakeFirstOrThrow(),
      ).toEqual({ value: 'audit-contention-committed' });
    } finally {
      // schema_meta is intentionally preserved by worker cleanup; restore this fixture's row.
      await context.db
        .updateTable('schema_meta')
        .set(initialValue)
        .where('key', '=', 'api_version')
        .execute();
    }
  }, 15_000);
});
