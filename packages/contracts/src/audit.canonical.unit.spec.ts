import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTION_CHAIN,
  AUDIT_ACTIONS,
  AUDIT_SCHEMA_VERSION,
  AUDIT_TARGETS_MAX,
  AuditAction,
  auditChainPreimage,
  AuditCanonicalError,
  canonicalJson,
  chainIdForVault,
  ChainId,
  GENESIS_CHAIN_HASH,
  SERVER_CHAIN_ID,
  vaultIdFromChainId,
  type AuditChainPayload,
  type CanonicalValue,
} from './audit.ts';
import { newId } from './ids.ts';
import { toTimestamp } from './time.ts';

/** One reverse solidus, and one code-point helper, so this file carries no literal control byte. */
const BACKSLASH = '\\';
const code = (value: number): string => String.fromCodePoint(value);

const VAULT_ID = '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091';
const ACTOR_ID = '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8092';
const GENESIS_HASH_BYTES = 32;

/**
 * The fixed vector. Written out by hand rather than derived, because a canonicalisation asserted
 * against its own implementation asserts nothing: this string is what a second implementation — the
 * verifier, or an auditor's own script — must produce for the same row.
 */
const FIXED_PAYLOAD: AuditChainPayload = {
  prev_id: 41,
  occurred_at: '2026-09-11T14:03:22.418771Z',
  schema_version: AUDIT_SCHEMA_VERSION,
  chain_id: chainIdForVault(VAULT_ID),
  action: 'node.created',
  actor_type: 'user',
  actor_id: ACTOR_ID,
  actor_display: 'Editor A',
  credential_type: 'session',
  vault_id: VAULT_ID,
  target_type: 'node',
  target_id: '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8093',
  outcome: 'success',
  context: { ip: '203.0.113.7', request_id: '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8094' },
};

const FIXED_CANONICAL =
  '{"action":"node.created","actor_display":"Editor A",' +
  '"actor_id":"018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8092","actor_type":"user",' +
  '"chain_id":"vault:018f3a2e7b1c7d3e9a4b2c5d6e7f8091",' +
  '"context":{"ip":"203.0.113.7","request_id":"018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8094"},' +
  '"credential_type":"session","occurred_at":"2026-09-11T14:03:22.418771Z","outcome":"success",' +
  '"prev_id":41,"schema_version":1,"target_id":"018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8093",' +
  '"target_type":"node","vault_id":"018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091"}';

/**
 * The refusal `canonicalJson` raises for a value it cannot encode. A named helper rather than a
 * `try`/`catch` around an assertion: an `expect` inside a `catch` is an assertion that never runs
 * when the call unexpectedly succeeds.
 */
/** The chains a group of actions is written to, for the two groups whose scope is a rule. */
function chainsOf(prefix: string): readonly string[] {
  return AUDIT_ACTIONS.filter((action) => action.startsWith(prefix)).map(
    (action) => AUDIT_ACTION_CHAIN[action],
  );
}

function refusalOf(value: CanonicalValue): AuditCanonicalError {
  try {
    canonicalJson(value);
  } catch (error) {
    if (error instanceof AuditCanonicalError) return error;
    throw error;
  }
  throw new Error('canonicalJson accepted a value it must refuse');
}

describe('audit.canonical.unit [area:audit]', () => {
  describe('the closed vocabulary', () => {
    it('assigns every action to exactly one chain', () => {
      expect(Object.keys(AUDIT_ACTION_CHAIN).toSorted()).toStrictEqual(AUDIT_ACTIONS.toSorted());
      const unscoped = AUDIT_ACTIONS.filter(
        (action) =>
          AUDIT_ACTION_CHAIN[action] !== 'vault' && AUDIT_ACTION_CHAIN[action] !== 'server',
      );
      expect(unscoped).toStrictEqual([]);
      expect(AUDIT_ACTIONS.map((action) => AuditAction.safeParse(action).success)).toStrictEqual(
        AUDIT_ACTIONS.map(() => true),
      );
      expect(AuditAction.safeParse('note.deleted').success).toBe(false);
    });

    it('writes every oauth action to the server chain and every node action to a vault chain', () => {
      expect(chainsOf('oauth.')).not.toHaveLength(0);
      expect(new Set(chainsOf('oauth.'))).toStrictEqual(new Set(['server']));
      expect(new Set(chainsOf('node.'))).toStrictEqual(new Set(['vault']));
    });

    it('spells a vault chain without hyphens so it fits VARCHAR(40)', () => {
      const chainId = chainIdForVault(VAULT_ID);
      expect(chainId).toBe('vault:018f3a2e7b1c7d3e9a4b2c5d6e7f8091');
      expect(chainId.length).toBeLessThanOrEqual(40);
      expect(vaultIdFromChainId(chainId)).toBe(VAULT_ID);
      expect(chainIdForVault(VAULT_ID.toUpperCase())).toBe(chainId);
      expect(vaultIdFromChainId(SERVER_CHAIN_ID)).toBeNull();
      expect(ChainId.safeParse(SERVER_CHAIN_ID).success).toBe(true);
      expect(ChainId.safeParse(chainId).success).toBe(true);
      expect(ChainId.safeParse(`vault:${VAULT_ID}`).success).toBe(false);
    });

    it('starts a chain from 32 zero bytes at schema version 1', () => {
      expect(GENESIS_CHAIN_HASH).toHaveLength(GENESIS_HASH_BYTES);
      expect([...GENESIS_CHAIN_HASH].every((byte) => byte === 0)).toBe(true);
      expect(AUDIT_SCHEMA_VERSION).toBe(1);
      expect(AUDIT_TARGETS_MAX).toBe(1000);
    });
  });

  describe('canonicalJson (RFC 8785)', () => {
    it('matches the fixed vector for a whole row', () => {
      expect(auditChainPreimage(FIXED_PAYLOAD)).toBe(FIXED_CANONICAL);
    });

    it('sorts keys by UTF-16 code unit, whatever order they were built in', () => {
      expect(canonicalJson({ b: 1, a: 2, A: 3, ä: 4, Z: 5 })).toBe(
        '{"A":3,"Z":5,"a":2,"b":1,"ä":4}',
      );
      const reordered: AuditChainPayload = {
        context: FIXED_PAYLOAD.context,
        outcome: FIXED_PAYLOAD.outcome,
        prev_id: FIXED_PAYLOAD.prev_id,
        occurred_at: FIXED_PAYLOAD.occurred_at,
        schema_version: FIXED_PAYLOAD.schema_version,
        chain_id: FIXED_PAYLOAD.chain_id,
        action: FIXED_PAYLOAD.action,
        actor_type: FIXED_PAYLOAD.actor_type,
        actor_id: ACTOR_ID,
        actor_display: 'Editor A',
        credential_type: FIXED_PAYLOAD.credential_type,
        vault_id: VAULT_ID,
        target_type: 'node',
        target_id: '018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8093',
      };
      expect(auditChainPreimage(reordered)).toBe(FIXED_CANONICAL);
    });

    it('emits no insignificant whitespace', () => {
      expect(canonicalJson({ a: [1, 2], b: { c: 'd' } })).toBe('{"a":[1,2],"b":{"c":"d"}}');
    });

    it('omits an absent member and keeps an explicit null', () => {
      expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
      const withReason: AuditChainPayload = { ...FIXED_PAYLOAD, reason: 'stated' };
      expect(auditChainPreimage(withReason)).toContain('"reason":"stated"');
      expect(auditChainPreimage(FIXED_PAYLOAD)).not.toContain('"reason"');
    });

    it('preserves array order', () => {
      expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
      expect(
        canonicalJson({
          targets: [
            { type: 'node', id: 'b' },
            { type: 'node', id: 'a' },
          ],
        }),
      ).toBe('{"targets":[{"id":"b","type":"node"},{"id":"a","type":"node"}]}');
    });

    it('escapes only what RFC 8785 requires, and keeps UTF-8 text literal', () => {
      expect(canonicalJson('a"b')).toBe(`"a${BACKSLASH}"b"`);
      expect(canonicalJson(`a${BACKSLASH}b`)).toBe(`"a${BACKSLASH}${BACKSLASH}b"`);
      const shortForms = [0x0a, 0x09, 0x0d, 0x08, 0x0c].map(code).join('');
      expect(canonicalJson(shortForms)).toBe(
        `"${BACKSLASH}n${BACKSLASH}t${BACKSLASH}r${BACKSLASH}b${BACKSLASH}f"`,
      );
      expect(canonicalJson(code(0x01))).toBe(`"${BACKSLASH}u0001"`);
      expect(canonicalJson(code(0x1f))).toBe(`"${BACKSLASH}u001f"`);
      // Printable non-ASCII stays literal: the hash is over UTF-8 bytes, not over escapes.
      const astral = code(0x1_f6_00);
      expect(canonicalJson(`café ${astral} 中`)).toBe(`"café ${astral} 中"`);
      // U+007F is printable as far as RFC 8785 is concerned: only below U+0020 is escaped.
      expect(canonicalJson(code(0x7f))).toBe(`"${code(0x7f)}"`);
    });

    it('uses the shortest round-trip number form', () => {
      expect(canonicalJson(1)).toBe('1');
      expect(canonicalJson(-0)).toBe('0');
      expect(canonicalJson(1.5)).toBe('1.5');
      expect(canonicalJson(1e21)).toBe('1e+21');
      expect(canonicalJson(0.1)).toBe('0.1');
      expect(canonicalJson(true)).toBe('true');
      expect(canonicalJson(false)).toBe('false');
      expect(canonicalJson(null)).toBe('null');
    });

    it('emits JSON that parses back to the row it covered', () => {
      const once = auditChainPreimage(FIXED_PAYLOAD);
      const reparsed: unknown = JSON.parse(once);
      // The fixed point of 03-data-model.md section 12.2: nothing was added, dropped or coerced on
      // the way out, so canonicalising the parsed row again yields the same bytes.
      expect(reparsed).toStrictEqual({ ...FIXED_PAYLOAD });
      expect(auditChainPreimage(FIXED_PAYLOAD)).toBe(once);
    });

    it('refuses a value that has no reproducible encoding, naming the path', () => {
      expect(() => canonicalJson(Number.NaN)).toThrow(AuditCanonicalError);
      expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/not a finite number/);
      const loneSurrogate = { metadata: { before: code(0xd8_00) } };
      expect(() => canonicalJson(loneSurrogate)).toThrow(/unpaired surrogate/);
      expect(refusalOf(loneSurrogate).path).toBe('metadata.before');
      expect(refusalOf(Number.NaN).path).toBe('');
    });
  });

  describe('auditChainPreimage', () => {
    it('refuses a timestamp that is not the fixed six-digit form', () => {
      expect(() =>
        auditChainPreimage({ ...FIXED_PAYLOAD, occurred_at: '2026-09-11T14:03:22Z' }),
      ).toThrow(/ffffffZ/);
      expect(() =>
        auditChainPreimage({ ...FIXED_PAYLOAD, occurred_at: '2026-09-11T14:03:22.418Z' }),
      ).toThrow(AuditCanonicalError);
      expect(() =>
        auditChainPreimage({ ...FIXED_PAYLOAD, occurred_at: toTimestamp(new Date(0)) }),
      ).not.toThrow();
    });

    it('refuses a chain id that is neither the server chain nor a vault chain', () => {
      expect(() => auditChainPreimage({ ...FIXED_PAYLOAD, chain_id: `vault:${VAULT_ID}` })).toThrow(
        /forks it/,
      );
      const { vault_id: _unscoped, ...serverScoped } = FIXED_PAYLOAD;
      expect(() =>
        auditChainPreimage({ ...serverScoped, chain_id: SERVER_CHAIN_ID }),
      ).not.toThrow();
    });

    it('covers a bulk action through targets', () => {
      const preimage = auditChainPreimage({
        ...FIXED_PAYLOAD,
        action: 'node.trashed',
        targets: [
          { type: 'node', id: newId(), path: 'Projects/Roadmap.md' },
          { type: 'node', id: newId() },
        ],
      });
      expect(preimage).toContain('"targets":[');
      expect(preimage).toContain('"path":"Projects/Roadmap.md"');
    });
  });
});
