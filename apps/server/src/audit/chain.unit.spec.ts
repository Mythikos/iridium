/**
 * `audit.chain.unit` verifies chain selection, canonical signatures, stored fields, bounded reads and
 * fail-closed key handling (03-data-model.md section 12.2; A47). Scripted SQL transport exposes write
 * ordering and verifier inputs while retaining the production Kysely compiler and audit services.
 *
 * `audit.chain.integration` owns real lock contention, the 32-writer race, MySQL JSON round-trips,
 * durable tamper detection and the `45000` immutability trigger.
 */
import { createHmac } from 'node:crypto';

import {
  AUDIT_TARGETS_MAX,
  auditChainPreimage,
  idToBytes,
  type AuditChainPayload,
  AUDIT_ACTIONS,
  AUDIT_ACTION_CHAIN,
  chainIdForVault,
  SERVER_CHAIN_ID,
} from '@iridium/contracts';
import type { Selectable } from 'kysely';
import { describe, expect, it } from 'vitest';

import { fakeDatabase, type QueryScript } from '../../test/support/fake-driver.ts';
import { ManualClock } from '../../test/support/manual-clock.ts';
import type { AuditEventsTable } from '../db/schema.ts';
import {
  AuditChainMismatchError,
  AuditChainUnresolvedError,
  verifyChain,
  listChainIds,
  AuditKeyMissingError,
  AuditValueNotJsonError,
  AuditWriter,
  auditHash,
  chainIdFor,
  GENESIS_HASH,
  type AuditEventInput,
} from './chain.ts';
import { AuditKeyVersionDowngradeError, createAuditKeys } from './keys.ts';

const VAULT_ID = '0190f2a0-0000-7000-8000-0000000000aa';
const KEY_V1 = new TextEncoder().encode('audit-key-v1-not-a-secret');
const KEY_V2 = new TextEncoder().encode('audit-key-v2-not-a-secret');

function keyring(versions: ReadonlyMap<number, Uint8Array>): {
  versions: ReadonlyMap<number, Uint8Array>;
  highest: number;
  sources: ReadonlyMap<number, { kind: 'value' }>;
} {
  return {
    versions,
    highest: versions.size === 0 ? 0 : Math.max(...versions.keys()),
    sources: new Map([...versions.keys()].map((version) => [version, { kind: 'value' as const }])),
  };
}

/**
 * The message a call refused with, or `''` when it did not refuse.
 *
 * Returning the message rather than asserting inside a `catch` keeps every `expect` unconditional: an
 * assertion that only runs when the call happened to throw passes when it did not.
 */
function refusalMessage(call: () => void): string {
  try {
    call();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const PAYLOAD = {
  prev_id: 0,
  occurred_at: '2026-09-13T12:00:00.123000Z',
  schema_version: 1,
  chain_id: SERVER_CHAIN_ID,
  action: 'user.login.succeeded',
  actor_type: 'user',
  credential_type: 'session',
  outcome: 'success',
  context: { request_id: '0190f2a0-0000-7000-8000-0000000000bb' },
} as const;

describe('audit.chain.unit [area:audit]', () => {
  describe('which chain a row goes to (§12.6)', () => {
    it('sends every server-scoped action to the server chain, with or without a vault id', () => {
      expect(chainIdFor('user.login.succeeded', null)).toBe(SERVER_CHAIN_ID);
      expect(chainIdFor('admin.user.disabled', VAULT_ID)).toBe(SERVER_CHAIN_ID);
    });

    it('sends a vault-scoped action to vault:<32 hex>, never to the hyphenated form', () => {
      const chainId = chainIdFor('node.created', VAULT_ID);
      expect(chainId).toBe(chainIdForVault(VAULT_ID));
      expect(chainId).toMatch(/^vault:[0-9a-f]{32}$/);
      // D03-05 and invariant I-19: the canonical hyphenated form is 42 characters and would not fit
      // VARCHAR(40), and two spellings of one chain would fork it.
      expect(chainId).not.toContain('-');
      expect(chainId.length).toBeLessThanOrEqual(40);
    });

    it('refuses a vault-scoped action with no vault id rather than defaulting to the server chain', () => {
      expect(() => chainIdFor('node.created', null)).toThrow(AuditChainUnresolvedError);
      expect(() => chainIdFor('node.created', undefined)).toThrow(AuditChainUnresolvedError);
    });

    it('resolves a chain for every action in the closed vocabulary', () => {
      // Exhaustive over the vocabulary, so an action added to `@iridium/contracts` without a chain
      // assignment fails here rather than at the first attempt to write it.
      for (const action of AUDIT_ACTIONS) {
        const scope = AUDIT_ACTION_CHAIN[action];
        expect(scope === 'server' || scope === 'vault').toBe(true);
        expect(chainIdFor(action, VAULT_ID)).toBe(
          scope === 'server' ? SERVER_CHAIN_ID : chainIdForVault(VAULT_ID),
        );
      }
    });
  });

  describe('the HMAC over the pre-image', () => {
    it('starts a chain from 32 zero bytes', () => {
      expect(GENESIS_HASH).toHaveLength(32);
      expect(GENESIS_HASH.every((byte) => byte === 0)).toBe(true);
    });

    it('is deterministic and 32 bytes wide', () => {
      const first = auditHash(KEY_V1, GENESIS_HASH, PAYLOAD);
      const second = auditHash(KEY_V1, GENESIS_HASH, PAYLOAD);
      expect(first).toHaveLength(32);
      expect(first.equals(second)).toBe(true);
    });

    it('covers prev_hash, so the same row at a different position hashes differently', () => {
      const atGenesis = auditHash(KEY_V1, GENESIS_HASH, PAYLOAD);
      const afterSomething = auditHash(KEY_V1, Buffer.alloc(32, 7), PAYLOAD);
      expect(atGenesis.equals(afterSomething)).toBe(false);
    });

    it('covers prev_id, so a re-ordered row is detectable even with a forged id', () => {
      const first = auditHash(KEY_V1, GENESIS_HASH, PAYLOAD);
      const moved = auditHash(KEY_V1, GENESIS_HASH, { ...PAYLOAD, prev_id: 1 });
      expect(first.equals(moved)).toBe(false);
    });

    it('changes with the key version, which is what makes a rotation a new signature', () => {
      expect(
        auditHash(KEY_V1, GENESIS_HASH, PAYLOAD).equals(auditHash(KEY_V2, GENESIS_HASH, PAYLOAD)),
      ).toBe(false);
    });

    it('is independent of the order the payload members were written in', () => {
      // RFC 8785 sorts the keys, which is what lets the writer and the verifier build the object in
      // whatever order reads best without changing a single byte of the hash.
      const reordered = {
        context: PAYLOAD.context,
        outcome: PAYLOAD.outcome,
        action: PAYLOAD.action,
        chain_id: PAYLOAD.chain_id,
        actor_type: PAYLOAD.actor_type,
        credential_type: PAYLOAD.credential_type,
        schema_version: PAYLOAD.schema_version,
        occurred_at: PAYLOAD.occurred_at,
        prev_id: PAYLOAD.prev_id,
      };
      expect(
        auditHash(KEY_V1, GENESIS_HASH, reordered).equals(auditHash(KEY_V1, GENESIS_HASH, PAYLOAD)),
      ).toBe(true);
    });

    it('refuses a timestamp that is not the fixed six-digit form', () => {
      // One instant must have exactly one spelling, or two verifications of one row disagree.
      expect(() =>
        auditHash(KEY_V1, GENESIS_HASH, { ...PAYLOAD, occurred_at: '2026-09-13T12:00:00.123Z' }),
      ).toThrow(/YYYY-MM-DDTHH:MM:SS\.ffffffZ/);
    });

    it('refuses a chain id that is neither server nor vault:<32 hex>', () => {
      expect(() =>
        auditHash(KEY_V1, GENESIS_HASH, { ...PAYLOAD, chain_id: `vault:${VAULT_ID}` }),
      ).toThrow(/32 lowercase hex/);
    });
  });

  describe('the keyring', () => {
    it('signs with the promoted version and verifies with any configured one', () => {
      const keys = createAuditKeys({
        keyring: keyring(
          new Map([
            [1, KEY_V1],
            [2, KEY_V2],
          ]),
        ),
        signingVersion: 2,
      });
      expect(keys.signingVersion).toBe(2);
      expect(keys.keyFor(1)).toBe(KEY_V1);
      expect(keys.keyFor(2)).toBe(KEY_V2);
      expect(keys.keyFor(3)).toBeUndefined();
    });

    it('refuses to build a writer whose promoted version this host does not carry', () => {
      // A stale or restored environment file that no longer carries the promoted version would otherwise
      // sign new rows with a retired key and fork the chain at the rotation boundary.
      expect(() =>
        createAuditKeys({ keyring: keyring(new Map([[1, KEY_V1]])), signingVersion: 2 }),
      ).toThrow(AuditKeyVersionDowngradeError);
    });

    it('names the configured versions in the refusal, so an operator knows what to install', () => {
      const message = refusalMessage(() => {
        createAuditKeys({ keyring: keyring(new Map([[1, KEY_V1]])), signingVersion: 3 });
      });
      expect(message).toContain('audit_key_version is 3');
      expect(message).toContain('v1');
      expect(message).toContain('AUDIT_HMAC_KEY_V3_FILE');
    });
  });
});

const LOCK_ONLY: QueryScript = (query) => {
  if (query.sql.startsWith('insert into `audit_chain_heads`')) return { rows: [] };
  if (query.sql.startsWith('select')) return { rows: [{ last_id: 0, last_hash: GENESIS_HASH }] };
  throw new Error(`A refused audit event reached a storage mutation: ${query.sql}`);
};

/** These cases substitute only SQL transport; Kysely compiles the product's actual statements. */
describe('audit.chain.unit [area:audit] writer refusal boundaries', () => {
  const event: AuditEventInput = {
    action: 'user.login.succeeded',
    actorType: 'system',
    credentialType: 'system',
    outcome: 'success',
    context: {},
  };
  function writer() {
    return new AuditWriter({
      keys: createAuditKeys({ keyring: keyring(new Map([[1, KEY_V1]])), signingVersion: 1 }),
      clock: new ManualClock(),
    });
  }

  it('refuses an unavailable signing key before acquiring any audit row lock', async () => {
    const fake = fakeDatabase({ script: LOCK_ONLY });
    const missing = new AuditWriter({
      keys: { signingVersion: 7, keyFor: () => undefined },
      clock: new ManualClock(),
    });
    try {
      expect(missing.signingVersion).toBe(7);
      await expect(
        fake.db.transaction().execute((trx) => missing.record(trx, event)),
      ).rejects.toMatchObject({
        code: 'audit.key_version_missing',
        keyVersion: 7,
        name: AuditKeyMissingError.name,
      });
      expect(fake.executed).toEqual([]);
      expect(fake.lifecycle).toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });

  it.each([
    ['function', () => 'not JSON'],
    ['bigint', 1n],
    ['symbol', Symbol('not JSON')],
    ['Date', new Date('2026-09-17T00:00:00Z')],
    ['Buffer', Buffer.from('not JSON')],
  ])('refuses nested %s metadata and rolls back without appending a row', async (_kind, value) => {
    const fake = fakeDatabase({ script: LOCK_ONLY });
    try {
      const rejected = fake.db.transaction().execute((trx) =>
        writer().record(trx, {
          ...event,
          metadata: { nested: [null, true, 3, 'ok', { forbidden: value }] },
        }),
      );
      await expect(rejected).rejects.toThrow(AuditValueNotJsonError);
      await expect(rejected).rejects.toThrow('metadata.nested[4].forbidden');
      expect(fake.executed.some((query) => query.sql.includes('insert into `audit_events`'))).toBe(
        false,
      );
      expect(fake.lifecycle).toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });

  it('propagates a head-storage failure instead of treating it as a duplicate genesis race', async () => {
    const failure = new Error('audit storage unavailable');
    const fake = fakeDatabase({ script: () => ({ throws: failure }) });
    try {
      await expect(
        fake.db.transaction().execute((trx) => writer().record(trx, event)),
      ).rejects.toBe(failure);
      expect(fake.executed).toHaveLength(1);
      expect(fake.lifecycle).toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });

  it('re-reads a duplicate genesis race under FOR UPDATE before validating the event', async () => {
    const fake = fakeDatabase({
      script: (query) =>
        query.sql.startsWith('insert')
          ? {
              throws: {
                code: 'ER_DUP_ENTRY',
                errno: 1062,
                sqlState: '23000',
                message: "Duplicate entry 'server' for key 'PRIMARY'",
              },
            }
          : { rows: [{ last_id: 3, last_hash: GENESIS_HASH }] },
    });
    try {
      await expect(
        fake.db.transaction().execute((trx) =>
          writer().record(trx, {
            ...event,
            metadata: { forbidden: new Date() },
          }),
        ),
      ).rejects.toThrow(AuditValueNotJsonError);
      expect(fake.executed).toHaveLength(2);
      expect(fake.executed[1]?.sql).toContain('for update');
      expect(fake.lifecycle).toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });

  it('refuses a head that remains absent after the genesis upsert', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    try {
      await expect(
        fake.db.transaction().execute((trx) => writer().record(trx, event)),
      ).rejects.toThrow('could be neither created nor read');
      expect(fake.executed).toHaveLength(2);
      expect(fake.lifecycle).toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });
});

/** Independent HMAC oracle; never sign a verifier fixture with the mutated writer/hash helper. */
function referenceHash(previous: Buffer, payload: AuditChainPayload, key = KEY_V1): Buffer {
  return createHmac('sha256', key)
    .update(previous)
    .update(auditChainPreimage(payload), 'utf8')
    .digest();
}

const ACTOR_ID = '0190f2a0-0000-7000-8000-0000000000ab';
const DELEGATOR_ID = '0190f2a0-0000-7000-8000-0000000000ac';
const CREDENTIAL_ID = '0190f2a0-0000-7000-8000-0000000000ad';
const TARGET_ID = '0190f2a0-0000-7000-8000-0000000000ae';
const FULL_PAYLOAD = {
  ...PAYLOAD,
  actor_id: ACTOR_ID,
  actor_display: 'Audit actor',
  on_behalf_of_user_id: DELEGATOR_ID,
  credential_id: CREDENTIAL_ID,
  vault_id: VAULT_ID,
  target_type: 'node',
  target_id: TARGET_ID,
  targets: [{ type: 'node', id: TARGET_ID, path: '/Docs/One' }],
  reason: 'verified',
  metadata: { nested: [null, false, 2, 'value', { z: 'last', a: 'first' }] },
} satisfies AuditChainPayload;
const VERIFY_KEYS = {
  signingVersion: 2,
  keyFor: (version: number) => (version === 1 ? KEY_V1 : version === 2 ? KEY_V2 : undefined),
};

type AuditRow = Selectable<AuditEventsTable>;

function fixtureRow(
  options: {
    id?: number;
    previousId?: number;
    previousHash?: Buffer;
    full?: boolean;
    version?: 1 | 2;
  } = {},
): AuditRow {
  const {
    id = 7,
    previousId = 0,
    previousHash = GENESIS_HASH,
    full = false,
    version = 1,
  } = options;
  const payload = { ...(full ? FULL_PAYLOAD : PAYLOAD), prev_id: previousId };
  return {
    id,
    occurred_at: new Date('2026-09-13T12:00:00.123Z'),
    schema_version: 1,
    chain_id: SERVER_CHAIN_ID,
    action: 'user.login.succeeded',
    actor_type: 'user',
    actor_id: full ? Buffer.from(idToBytes(ACTOR_ID)) : null,
    actor_display: full ? 'Audit actor' : null,
    on_behalf_of_user_id: full ? Buffer.from(idToBytes(DELEGATOR_ID)) : null,
    credential_type: 'session',
    credential_id: full ? Buffer.from(idToBytes(CREDENTIAL_ID)) : null,
    vault_id: full ? Buffer.from(idToBytes(VAULT_ID)) : null,
    target_type: full ? 'node' : null,
    target_id: full ? Buffer.from(idToBytes(TARGET_ID)) : null,
    targets: full ? [{ type: 'node', id: TARGET_ID, path: '/Docs/One' }] : null,
    outcome: 'success',
    reason: full ? 'verified' : null,
    context: PAYLOAD.context,
    metadata: full ? { nested: [null, false, 2, 'value', { z: 'last', a: 'first' }] } : null,
    prev_hash: previousHash,
    hash: referenceHash(previousHash, payload, version === 1 ? KEY_V1 : KEY_V2),
    key_version: version,
  };
}

function verificationDatabase(
  rows: readonly AuditRow[],
  head: { last_id: number; last_hash: Buffer } | null,
) {
  return fakeDatabase({
    script: (query) => {
      if (query.sql.includes('from `audit_events`')) {
        const [chain, after, limit] = query.parameters;
        if (
          !query.sql.includes('where `chain_id` = ? and `id` > ? order by `id` asc limit ?') ||
          chain !== SERVER_CHAIN_ID ||
          limit !== 500 ||
          typeof after !== 'number'
        )
          throw new Error(
            'Verification must use the selected chain, ascending cursor and bounded page.',
          );
        return { rows: rows.filter((row) => row.id > after).slice(0, 500) };
      }
      expect(query.sql).toContain('from `audit_chain_heads` where `chain_id` = ?');
      expect(query.parameters).toEqual([SERVER_CHAIN_ID]);
      return { rows: head === null ? [] : [head] };
    },
  });
}

describe('audit.chain.unit [area:audit] signed storage and verification', () => {
  it('appends the exact signed payload and advances only the locked chain to the returned insert ID', async () => {
    const previousHash = Buffer.alloc(32, 7);
    const fake = fakeDatabase({
      script: (query) => {
        if (query.sql.startsWith('insert into `audit_chain_heads`')) return { insertId: 0n };
        if (query.sql.startsWith('select'))
          return { rows: [{ last_id: 23, last_hash: previousHash }] };
        if (query.sql.startsWith('insert into `audit_events`')) return { insertId: 41n };
        return { numAffectedRows: 1n };
      },
    });
    const clock = new ManualClock('2026-09-13T12:00:00.123Z');
    const writer = new AuditWriter({ keys: VERIFY_KEYS, clock });
    const event: AuditEventInput = {
      action: 'user.login.succeeded',
      chainId: SERVER_CHAIN_ID,
      actorType: 'user',
      actorId: ACTOR_ID,
      actorDisplay: 'Audit actor',
      onBehalfOfUserId: DELEGATOR_ID,
      credentialType: 'session',
      credentialId: CREDENTIAL_ID,
      vaultId: VAULT_ID,
      targetType: 'node',
      targetId: TARGET_ID,
      targets: FULL_PAYLOAD.targets,
      outcome: 'success',
      reason: 'verified',
      context: PAYLOAD.context,
      metadata: FULL_PAYLOAD.metadata,
    };
    try {
      const expectedHash = referenceHash(previousHash, { ...FULL_PAYLOAD, prev_id: 23 }, KEY_V2);
      const recorded = await fake.db.transaction().execute((trx) => writer.record(trx, event));
      expect(recorded).toEqual({
        id: 41,
        chainId: SERVER_CHAIN_ID,
        occurredAt: clock.date(),
        keyVersion: 2,
        prevHash: previousHash,
        hash: expectedHash,
      });
      expect(fake.executed).toHaveLength(4);
      expect(fake.executed[0]?.sql).toContain(
        'on duplicate key update `chain_id` = `audit_chain_heads`.`chain_id`',
      );
      expect(fake.executed[1]?.sql).toContain('for update');
      expect(fake.executed[2]?.sql).toContain('insert into `audit_events`');
      expect(fake.executed[2]?.parameters).toEqual([
        clock.date(),
        1,
        SERVER_CHAIN_ID,
        'user.login.succeeded',
        'user',
        Buffer.from(idToBytes(ACTOR_ID)),
        'Audit actor',
        Buffer.from(idToBytes(DELEGATOR_ID)),
        'session',
        Buffer.from(idToBytes(CREDENTIAL_ID)),
        Buffer.from(idToBytes(VAULT_ID)),
        'node',
        Buffer.from(idToBytes(TARGET_ID)),
        JSON.stringify(FULL_PAYLOAD.targets),
        'success',
        'verified',
        JSON.stringify(PAYLOAD.context),
        JSON.stringify(FULL_PAYLOAD.metadata),
        previousHash,
        expectedHash,
        2,
      ]);
      expect(fake.executed[3]?.sql).toBe(
        'update `audit_chain_heads` set `last_id` = ?, `last_hash` = ? where `chain_id` = ?',
      );
      expect(fake.executed[3]?.parameters).toEqual([41, expectedHash, SERVER_CHAIN_ID]);
      expect(fake.lifecycle).toContain('commit');
      expect(fake.lifecycle).not.toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });

  it.each([
    undefined,
    [],
    Array.from({ length: AUDIT_TARGETS_MAX }, () => ({ type: 'node', id: TARGET_ID })),
    Array.from({ length: AUDIT_TARGETS_MAX + 1 }, () => ({ type: 'node', id: TARGET_ID })),
  ])(
    'keeps capped targets, null fields and metadata identical in storage and the signature: %#',
    async (targets) => {
      const fake = fakeDatabase({
        script: (query) =>
          query.sql.startsWith('select')
            ? { rows: [{ last_id: 0, last_hash: GENESIS_HASH }] }
            : query.sql.startsWith('insert into `audit_events`')
              ? { insertId: 17n }
              : { numAffectedRows: 1n },
      });
      const writer = new AuditWriter({
        keys: VERIFY_KEYS,
        clock: new ManualClock('2026-09-13T12:00:00.123Z'),
      });
      const capped =
        targets === undefined || targets.length === 0
          ? undefined
          : targets.slice(0, AUDIT_TARGETS_MAX);
      const metadata =
        targets === undefined
          ? null
          : {
              keep: true,
              ...((targets?.length ?? 0) > AUDIT_TARGETS_MAX ? { targets_truncated: true } : {}),
            };
      try {
        const recorded = await fake.db.transaction().execute((trx) =>
          writer.record(trx, {
            action: 'user.login.succeeded',
            actorType: 'user',
            actorId: null,
            actorDisplay: null,
            onBehalfOfUserId: null,
            credentialType: 'session',
            credentialId: null,
            vaultId: null,
            targetType: null,
            targetId: null,
            reason: null,
            outcome: 'success',
            context: PAYLOAD.context,
            metadata: targets === undefined ? null : { keep: true, omitted: undefined },
            ...(targets === undefined ? {} : { targets }),
          }),
        );
        const payload = {
          ...PAYLOAD,
          ...(metadata === null ? {} : { metadata }),
          ...(capped === undefined ? {} : { targets: capped }),
        };
        expect(recorded.hash).toEqual(referenceHash(GENESIS_HASH, payload, KEY_V2));
        const parameters = fake.executed[2]?.parameters;
        expect(parameters?.slice(5, 13)).toEqual([
          null,
          null,
          null,
          'session',
          null,
          null,
          null,
          null,
        ]);
        expect(parameters?.[13]).toBe(capped === undefined ? null : JSON.stringify(capped));
        expect(parameters?.[15]).toBeNull();
        expect(parameters?.[17]).toBe(metadata === null ? null : JSON.stringify(metadata));
      } finally {
        await fake.db.destroy();
      }
    },
  );

  it('rejects an explicit wrong chain before touching storage', async () => {
    const fake = fakeDatabase({ script: LOCK_ONLY });
    try {
      const writer = new AuditWriter({ keys: VERIFY_KEYS, clock: new ManualClock() });
      await expect(
        fake.db.transaction().execute((trx) =>
          writer.record(trx, {
            action: 'node.created',
            vaultId: VAULT_ID,
            chainId: SERVER_CHAIN_ID,
            actorType: 'system',
            credentialType: 'system',
            outcome: 'success',
            context: {},
          }),
        ),
      ).rejects.toMatchObject({ name: AuditChainMismatchError.name, code: 'audit.chain_mismatch' });
      expect(fake.executed).toEqual([]);
      expect(fake.lifecycle).toContain('rollback');
    } finally {
      await fake.db.destroy();
    }
  });

  it.each([false, true])(
    'verifies independent signed rows with nullable/full columns: %s',
    async (full) => {
      const row = fixtureRow({ full });
      const fake = verificationDatabase([row], { last_id: row.id, last_hash: row.hash });
      try {
        await expect(verifyChain(fake.db, SERVER_CHAIN_ID, VERIFY_KEYS)).resolves.toEqual({
          chainId: SERVER_CHAIN_ID,
          rows: 1,
          lastId: 7,
          ok: true,
          divergence: null,
        });
        expect(fake.executed).toHaveLength(2);
      } finally {
        await fake.db.destroy();
      }
    },
  );

  it('continues a full page with the preceding signed ID/hash and verifies a rotated historical key', async () => {
    const rows: AuditRow[] = [];
    let previousId = 0;
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < 501; index += 1) {
      const row = fixtureRow({
        id: index * 2 + 7,
        previousId,
        previousHash,
        version: index === 500 ? 2 : 1,
      });
      rows.push(row);
      previousId = row.id;
      previousHash = row.hash;
    }
    const fake = verificationDatabase(rows, { last_id: previousId, last_hash: previousHash });
    try {
      await expect(verifyChain(fake.db, SERVER_CHAIN_ID, VERIFY_KEYS)).resolves.toEqual({
        chainId: SERVER_CHAIN_ID,
        rows: 501,
        lastId: 1007,
        ok: true,
        divergence: null,
      });
      expect(fake.executed.map((query) => query.parameters)).toEqual([
        [SERVER_CHAIN_ID, 0, 500],
        [SERVER_CHAIN_ID, 1005, 500],
        [SERVER_CHAIN_ID],
      ]);
    } finally {
      await fake.db.destroy();
    }
  });

  it.each([
    [{ prev_hash: Buffer.alloc(3) }, 'prev_hash_mismatch'],
    [{ prev_hash: Buffer.alloc(32, 9) }, 'prev_hash_mismatch'],
    [{ hash: Buffer.alloc(3) }, 'hash_mismatch'],
    [{ hash: Buffer.alloc(32, 9) }, 'hash_mismatch'],
    [{ actor_display: 'forged' }, 'hash_mismatch'],
    [{ action: 'invented.action' }, 'unknown_action'],
    [{ key_version: 99 }, 'key_version_missing'],
  ] as const)('fails closed at the exact divergent row: %j', async (alteration, reason) => {
    const row = { ...fixtureRow(), ...alteration };
    const fake = verificationDatabase([row], null);
    try {
      await expect(verifyChain(fake.db, SERVER_CHAIN_ID, VERIFY_KEYS)).resolves.toEqual({
        chainId: SERVER_CHAIN_ID,
        rows: 1,
        lastId: 0,
        ok: false,
        divergence: { id: 7, occurredAt: row.occurred_at, action: row.action, reason },
      });
      expect(fake.executed).toHaveLength(1);
    } finally {
      await fake.db.destroy();
    }
  });

  it.each(['missing', 'id', 'hash', 'length'] as const)(
    'refuses a missing or inconsistent final head: %s',
    async (variant) => {
      const row = fixtureRow();
      const head =
        variant === 'missing'
          ? null
          : {
              last_id: variant === 'id' ? 8 : 7,
              last_hash:
                variant === 'length'
                  ? Buffer.alloc(3)
                  : variant === 'hash'
                    ? Buffer.alloc(32, 9)
                    : row.hash,
            };
      const fake = verificationDatabase([row], head);
      try {
        const verified = await verifyChain(fake.db, SERVER_CHAIN_ID, VERIFY_KEYS);
        expect(verified).toEqual({
          chainId: SERVER_CHAIN_ID,
          rows: 1,
          lastId: 7,
          ok: false,
          divergence:
            head === null
              ? null
              : {
                  id: head.last_id,
                  occurredAt: null,
                  action: 'audit_chain_heads',
                  reason: 'head_mismatch',
                },
        });
      } finally {
        await fake.db.destroy();
      }
    },
  );

  it.each([null, { last_id: 0, last_hash: GENESIS_HASH }])(
    'accepts an unwritten empty chain: %#',
    async (head) => {
      const fake = verificationDatabase([], head);
      try {
        await expect(verifyChain(fake.db, SERVER_CHAIN_ID, VERIFY_KEYS)).resolves.toEqual({
          chainId: SERVER_CHAIN_ID,
          rows: 0,
          lastId: 0,
          ok: true,
          divergence: null,
        });
      } finally {
        await fake.db.destroy();
      }
    },
  );

  it('lists every head in chain order without reading events', async () => {
    const fake = fakeDatabase({
      script: () => ({ rows: [{ chain_id: 'server' }, { chain_id: chainIdForVault(VAULT_ID) }] }),
    });
    try {
      await expect(listChainIds(fake.db)).resolves.toEqual(['server', chainIdForVault(VAULT_ID)]);
      expect(fake.executed.map((query) => query.sql)).toEqual([
        'select `chain_id` from `audit_chain_heads` order by `chain_id` asc',
      ]);
    } finally {
      await fake.db.destroy();
    }
  });
});
