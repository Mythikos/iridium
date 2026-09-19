import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_CHAIN,
  AUDIT_TARGETS_MAX,
  chainIdForVault,
  idToBytes,
  newId,
  SERVER_CHAIN_ID,
  toTimestamp,
  type AuditAction,
} from '@iridium/contracts';
/**
 * `audit.chain.integration` (12-milestones.md §5.4; 03-data-model.md §12.1–§12.3; `A46`, `A47`).
 *
 * The audit chain is the one structure in Iridium whose value is entirely in what it refuses to let happen
 * quietly, so the cases below are the four the milestone names plus the two that make "fails closed" true:
 *
 *  - **32 concurrent writers on one chain never fork it.** The head row is the serialisation point; a
 *    per-row `prev_hash` computed from "the last row I can see" would let two transactions claim one
 *    predecessor, and the assertion is therefore not only "verification passes" but "no two rows claim the
 *    same predecessor".
 *  - **`verify-chain` passes** for a vault chain and for `server`.
 *  - **A tampered row fails verification**, at the exact row. The tamper is an *insert* rather than an
 *    update, because an update is impossible by construction — which is the next case.
 *  - **`UPDATE` and `DELETE` on `audit_events` are refused twice over**: by grant for `iridium_app`, and by
 *    trigger for everyone including `root`. Three independent mechanisms, each failing differently
 *    (§12.3), and this file exercises two of them; the chain itself is the third.
 *  - **A missing key version is a divergence, never a skipped row** (`A47`).
 *  - **Every action of the closed vocabulary can be written and still verifies**, which is what keeps a
 *    chain assignment in `@iridium/contracts` from being wrong for an action nobody has written yet.
 *
 * The suite writes through the product's own `app.audit` and the product's own `dbApp`, so what it proves
 * is the writer every mutating service will call and not a re-implementation of it.
 */
import {
  corruptMysqlDeliberately,
  mysqlAdminByContainerId,
  type MysqlAdmin,
} from '@iridium/testkit';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  listChainIds,
  verifyChain,
  type AuditEventInput,
  type AuditKeys,
} from '../../src/audit/chain.ts';
import { createAuditKeys, readPromotedAuditKeyVersion } from '../../src/audit/keys.ts';
import type { Database } from '../../src/db/schema.ts';
import { startPlatformApp, WORKER_SCHEMA, type PlatformApp } from './platform-app.ts';

/** 12-milestones.md §5.4: "32 concurrent writers never fork the chain". */
const CONCURRENT_WRITERS = 32;

let booted: PlatformApp;
let db: Kysely<Database>;
let keys: AuditKeys;
let admin: MysqlAdmin;

function contextFor(requestId: string): AuditEventInput['context'] {
  return {
    ip: '127.0.0.1',
    user_agent: 'audit.chain.integration',
    request_id: requestId,
    client: 'web',
  };
}

/** One `node.created` on a vault chain, which is the shape most M1 mutations write. */
function vaultEvent(vaultId: string, index: number): AuditEventInput {
  return {
    action: 'node.created',
    actorType: 'user',
    actorId: newId(),
    actorDisplay: `writer ${String(index)}`,
    credentialType: 'session',
    credentialId: newId(),
    vaultId,
    targetType: 'node',
    targetId: newId(),
    outcome: 'success',
    context: contextFor(newId()),
    metadata: { index },
  };
}

/** Writes one event in its own transaction, exactly as a mutating service does. */
async function record(event: AuditEventInput): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await booted.app.audit.record(trx, event);
  });
}

beforeAll(async () => {
  booted = await startPlatformApp();
  const dbApp = booted.app.database.dbApp;
  if (dbApp === null) throw new Error('the audit suite needs a connected database');
  db = dbApp;
  keys = createAuditKeys({
    keyring: booted.app.iridiumConfig.keys.auditHmac,
    signingVersion: await readPromotedAuditKeyVersion(db),
  });
  admin = await mysqlAdminByContainerId(inject('iridiumMysql').containerId);
});

afterAll(async () => {
  await booted.close();
});

describe('audit.chain.integration [area:audit]', () => {
  describe('concurrency', () => {
    it('lets 32 writers onto one chain without forking it', async () => {
      const vaultId = newId();
      const chainId = chainIdForVault(vaultId);

      await Promise.all(
        Array.from({ length: CONCURRENT_WRITERS }, (_unused, index) =>
          record(vaultEvent(vaultId, index)),
        ),
      );

      const rows = await db
        .selectFrom('audit_events')
        .select(['id', 'prev_hash', 'hash'])
        .where('chain_id', '=', chainId)
        .orderBy('id', 'asc')
        .execute();
      expect(rows).toHaveLength(CONCURRENT_WRITERS);

      // No two rows claim the same predecessor, which is the fork the head lock exists to prevent.
      const predecessors = new Set(rows.map((row) => row.prev_hash.toString('hex')));
      expect(predecessors.size).toBe(CONCURRENT_WRITERS);

      // And each row's `prev_hash` is its predecessor's `hash`, in `id` order.
      for (const [index, row] of rows.entries()) {
        const previous = rows[index - 1];
        const expected = previous === undefined ? Buffer.alloc(32) : previous.hash;
        expect(row.prev_hash.equals(expected), `row ${String(row.id)}`).toBe(true);
      }

      const verification = await verifyChain(db, chainId, keys);
      expect(verification).toMatchObject({ ok: true, rows: CONCURRENT_WRITERS, divergence: null });

      const head = await db
        .selectFrom('audit_chain_heads')
        .select(['last_id', 'last_hash'])
        .where('chain_id', '=', chainId)
        .executeTakeFirstOrThrow();
      const last = rows.at(-1);
      expect(head.last_id).toBe(last?.id);
      expect(head.last_hash.equals(last?.hash ?? Buffer.alloc(0))).toBe(true);
    });

    it('keeps two chains independent, so work in different vaults never contends', async () => {
      const first = newId();
      const second = newId();
      await Promise.all([
        ...Array.from({ length: 8 }, (_unused, index) => record(vaultEvent(first, index))),
        ...Array.from({ length: 8 }, (_unused, index) => record(vaultEvent(second, index))),
      ]);
      for (const vaultId of [first, second]) {
        // eslint-disable-next-line no-await-in-loop -- two verifications, each naming its own chain
        const verification = await verifyChain(db, chainIdForVault(vaultId), keys);
        expect({ vaultId, ok: verification.ok, rows: verification.rows }).toEqual({
          vaultId,
          ok: true,
          rows: 8,
        });
      }
    });
  });

  describe('verify-chain', () => {
    it('passes for a vault chain and for the server chain', async () => {
      const vaultId = newId();
      await record(vaultEvent(vaultId, 1));
      await record({
        action: 'user.login.succeeded',
        chainId: SERVER_CHAIN_ID,
        actorType: 'user',
        actorId: newId(),
        credentialType: 'session',
        credentialId: newId(),
        outcome: 'success',
        context: contextFor(newId()),
      });

      expect((await verifyChain(db, chainIdForVault(vaultId), keys)).ok).toBe(true);
      expect((await verifyChain(db, SERVER_CHAIN_ID, keys)).ok).toBe(true);
    });

    it('passes on a chain that was never written', async () => {
      const verification = await verifyChain(db, chainIdForVault(newId()), keys);
      expect(verification).toMatchObject({ ok: true, rows: 0 });
    });

    it('detects a row whose hash does not match its content, at that row', async () => {
      const vaultId = newId();
      const chainId = chainIdForVault(vaultId);
      await record(vaultEvent(vaultId, 1));
      const head = await db
        .selectFrom('audit_chain_heads')
        .select(['last_hash'])
        .where('chain_id', '=', chainId)
        .executeTakeFirstOrThrow();

      // The app role holds `INSERT` on `audit_events` and no `UPDATE`, so a forged *row* is the only tamper
      // the application can even express — and it is the one an attacker with the app credential would use.
      const forged = await db
        .insertInto('audit_events')
        .values({
          occurred_at: booted.app.clock.date(),
          chain_id: chainId,
          action: 'node.created',
          actor_type: 'user',
          actor_id: Buffer.from(idToBytes(newId())),
          credential_type: 'session',
          outcome: 'success',
          context: JSON.stringify(contextFor(newId())),
          prev_hash: head.last_hash,
          hash: Buffer.alloc(32, 0xff),
          key_version: keys.signingVersion,
        })
        .executeTakeFirstOrThrow();

      const verification = await verifyChain(db, chainId, keys);
      expect(verification.ok).toBe(false);
      expect(verification.divergence).toMatchObject({
        id: Number(forged.insertId ?? 0n),
        reason: 'hash_mismatch',
        action: 'node.created',
      });
    });

    it('detects a chain head that no longer matches the last row', async () => {
      const vaultId = newId();
      const chainId = chainIdForVault(vaultId);
      await record(vaultEvent(vaultId, 1));
      // The app role *does* hold `UPDATE` on `audit_chain_heads` (it advances the head on every write) and
      // deliberately no `DELETE`: deleting a head and re-inserting a genesis row would restart a chain that
      // verification would then accept. A rewritten head is therefore detected rather than prevented.
      await db
        .updateTable('audit_chain_heads')
        .set({ last_hash: Buffer.alloc(32, 0x01) })
        .where('chain_id', '=', chainId)
        .execute();

      const verification = await verifyChain(db, chainId, keys);
      expect(verification.ok).toBe(false);
      expect(verification.divergence?.reason).toBe('head_mismatch');
    });

    it('fails closed on a row signed with a key version this host does not carry (A47)', async () => {
      const vaultId = newId();
      const chainId = chainIdForVault(vaultId);
      await record(vaultEvent(vaultId, 1));
      const head = await db
        .selectFrom('audit_chain_heads')
        .select(['last_hash'])
        .where('chain_id', '=', chainId)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('audit_events')
        .values({
          occurred_at: booted.app.clock.date(),
          chain_id: chainId,
          action: 'node.created',
          actor_type: 'system',
          credential_type: 'system',
          outcome: 'success',
          context: JSON.stringify(contextFor(newId())),
          prev_hash: head.last_hash,
          hash: Buffer.alloc(32, 0x02),
          key_version: 99,
        })
        .execute();

      const verification = await verifyChain(db, chainId, keys);
      expect(verification.ok).toBe(false);
      expect(verification.divergence?.reason).toBe('key_version_missing');
    });
  });

  describe('canonical row boundaries', () => {
    it.each([0, AUDIT_TARGETS_MAX, AUDIT_TARGETS_MAX + 1])(
      'round-trips %i targets with delegated identity and nested JSON; truncation is explicit',
      async (count) => {
        const vaultId = newId();
        const delegated = newId();
        const nullPrototype = { text: 'plain data without a prototype', number: 7 };
        Object.setPrototypeOf(nullPrototype, null);
        const targets = Array.from({ length: count }, (_, index) => ({
          type: 'note',
          id: newId(),
          path: `Notes/${String(index)}`,
        }));
        await record({
          ...vaultEvent(vaultId, 1),
          onBehalfOfUserId: delegated,
          reason: 'bulk_operation',
          context: { ip: null, user_agent: null, request_id: newId() },
          targets,
          metadata: {
            omitted: undefined,
            nested: [null, true, 2, 'text', { omitted: undefined, retained: false }],
            nullPrototype,
          },
        });
        const row = await db
          .selectFrom('audit_events')
          .selectAll()
          .where('chain_id', '=', chainIdForVault(vaultId))
          .executeTakeFirstOrThrow();
        expect(row.on_behalf_of_user_id).toEqual(Buffer.from(idToBytes(delegated)));
        expect(row.targets).toEqual(count === 0 ? null : targets.slice(0, AUDIT_TARGETS_MAX));
        expect(row.metadata).toEqual({
          nested: [null, true, 2, 'text', { retained: false }],
          nullPrototype: { text: 'plain data without a prototype', number: 7 },
          ...(count > AUDIT_TARGETS_MAX ? { targets_truncated: true } : {}),
        });
        expect((await verifyChain(db, chainIdForVault(vaultId), keys)).ok).toBe(true);
      },
    );

    it.each(['prev_hash_mismatch', 'unknown_action'] as const)(
      'identifies the first forged row as %s without accepting its head',
      async (reason) => {
        const vaultId = newId();
        const chainId = chainIdForVault(vaultId);
        await record(vaultEvent(vaultId, 1));
        const head = await db
          .selectFrom('audit_chain_heads')
          .select(['last_id', 'last_hash'])
          .where('chain_id', '=', chainId)
          .executeTakeFirstOrThrow();
        const forged = await db
          .insertInto('audit_events')
          .values({
            occurred_at: booted.app.clock.date(),
            chain_id: chainId,
            action: reason === 'unknown_action' ? 'unknown.audit.action' : 'node.created',
            actor_type: 'system',
            credential_type: 'system',
            outcome: 'success',
            context: '{}',
            prev_hash: reason === 'prev_hash_mismatch' ? Buffer.alloc(32, 0xee) : head.last_hash,
            hash: Buffer.alloc(32, 0xaa),
            key_version: keys.signingVersion,
          })
          .executeTakeFirstOrThrow();
        expect(await verifyChain(db, chainId, keys)).toMatchObject({
          ok: false,
          rows: 2,
          lastId: head.last_id,
          divergence: { id: Number(forged.insertId), reason },
        });
      },
    );

    it('enumerates actual chain heads in deterministic order', async () => {
      const initial = await db.selectFrom('audit_chain_heads').select('chain_id').execute();
      const vaults = [newId(), newId()];
      await Promise.all(vaults.map((vaultId, index) => record(vaultEvent(vaultId, index))));
      expect(await listChainIds(db)).toEqual(
        [...initial.map((row) => row.chain_id), ...vaults.map(chainIdForVault)].toSorted(),
      );
    });
  });
  describe('immutability (§12.3)', () => {
    it('refuses UPDATE and DELETE on audit_events for the app role, by grant', async () => {
      const vaultId = newId();
      await record(vaultEvent(vaultId, 1));
      await expect(
        db
          .updateTable('audit_events')
          .set({ reason: 'tampered' })
          .where('chain_id', '=', chainIdForVault(vaultId))
          .execute(),
      ).rejects.toThrow(/command denied|not allowed|append-only/i);
      await expect(
        db.deleteFrom('audit_events').where('chain_id', '=', chainIdForVault(vaultId)).execute(),
      ).rejects.toThrow(/command denied|not allowed|append-only/i);
    });

    it('raises SQLSTATE 45000 from the triggers, which bind even root', async () => {
      const vaultId = newId();
      await record(vaultEvent(vaultId, 1));
      const chainId = chainIdForVault(vaultId);
      // The triggers are the second of the three mechanisms and the only one an operator mistake meets:
      // grants stop the application, the triggers stop everyone, and the chain detects whatever got past
      // both. `root` has every privilege and still cannot do this.
      await expect(
        corruptMysqlDeliberately(admin, {
          kind: 'tamper-audit-reason',
          schema: WORKER_SCHEMA,
          chainId,
        }),
      ).rejects.toThrow(/append-only|45000/i);
      await expect(
        corruptMysqlDeliberately(admin, {
          kind: 'delete-audit-chain',
          schema: WORKER_SCHEMA,
          chainId,
        }),
      ).rejects.toThrow(/append-only|45000/i);
    });
  });

  describe('the closed vocabulary', () => {
    it('writes every action of @iridium/contracts onto the chain its scope names, and verifies', async () => {
      const vaultId = newId();
      // A newly migrated worker already has its migration audit trail. Preserve and verify it.
      const existingServerRows = (await verifyChain(db, SERVER_CHAIN_ID, keys)).rows;
      for (const action of AUDIT_ACTIONS) {
        const scope = AUDIT_ACTION_CHAIN[action];
        // eslint-disable-next-line no-await-in-loop -- one event at a time, in vocabulary order
        await record({
          action,
          actorType: 'system',
          credentialType: 'cli',
          outcome: 'success',
          context: contextFor(newId()),
          ...(scope === 'vault' ? { vaultId } : { chainId: SERVER_CHAIN_ID }),
        });
      }

      const vaultChain = await verifyChain(db, chainIdForVault(vaultId), keys);
      const serverChain = await verifyChain(db, SERVER_CHAIN_ID, keys);
      expect(vaultChain.ok).toBe(true);
      expect(serverChain.ok).toBe(true);
      expect(vaultChain.rows + serverChain.rows).toBe(existingServerRows + AUDIT_ACTIONS.length);
    });

    it('refuses a vault-scoped action with no vault id rather than writing it to the server chain', async () => {
      const orphan: AuditEventInput = {
        action: 'node.created',
        actorType: 'system',
        credentialType: 'cli',
        outcome: 'success',
        context: contextFor(newId()),
      };
      await expect(record(orphan)).rejects.toThrow(/vault-scoped/);
    });

    it('refuses an explicit chainId that disagrees with the action’s scope', async () => {
      await expect(
        record({
          action: 'node.created',
          chainId: SERVER_CHAIN_ID,
          vaultId: newId(),
          actorType: 'system',
          credentialType: 'cli',
          outcome: 'success',
          context: contextFor(newId()),
        }),
      ).rejects.toThrow(/belongs to chain/);
    });
  });

  describe('the stored row and the pre-image are the same values', () => {
    it('stores occurred_at at the precision the pre-image hashed', async () => {
      const vaultId = newId();
      await record(vaultEvent(vaultId, 1));
      const row = await db
        .selectFrom('audit_events')
        .select(['occurred_at'])
        .where('chain_id', '=', chainIdForVault(vaultId))
        .executeTakeFirstOrThrow();
      // `DATETIME(6)` round-trips a JavaScript `Date` exactly, which is what makes the six-digit rendering
      // reproducible from a row read back. A driver that rounded would break every verification.
      expect(toTimestamp(row.occurred_at)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}\.\d{3}000Z$/);
      expect((await verifyChain(db, chainIdForVault(vaultId), keys)).ok).toBe(true);
    });

    it('writes the action name verbatim, so an auditor reads the vocabulary and not a translation', async () => {
      const vaultId = newId();
      const action: AuditAction = 'vault.member.role_changed';
      await record({
        action,
        actorType: 'user',
        actorId: newId(),
        credentialType: 'session',
        vaultId,
        outcome: 'success',
        context: contextFor(newId()),
      });
      const row = await db
        .selectFrom('audit_events')
        .select(['action'])
        .where('chain_id', '=', chainIdForVault(vaultId))
        .executeTakeFirstOrThrow();
      expect(row.action).toBe(action);
    });
  });
});
