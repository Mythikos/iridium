import { describe, expect, it, vi } from 'vitest';

import {
  CANONICAL_ID_PATTERN,
  createIdGenerator,
  ID_BYTE_LENGTH,
  ID_SCHEMAS,
  idFromBytes,
  idSchema,
  idTimestamp,
  idToBytes,
  isCanonicalId,
  isJsonSafeInteger,
  JSON_SAFE_INT_MAX,
  newId,
  NoteId,
  Revision,
  RevisionId,
  toCanonicalId,
  toJsonSafeInteger,
  TokenLookupId,
  VaultId,
} from './ids.ts';

/** A generator whose clock and randomness are pinned, so every assertion here is exact. */
function pinned(nowValues: number[], byte = 0): () => string {
  let index = 0;
  const generate = createIdGenerator({
    now: () => nowValues[Math.min(index++, nowValues.length - 1)] ?? 0,
    fillRandom: (bytes) => bytes.fill(byte),
  });
  return () => generate();
}

describe('contracts.ids.unit [area:contracts]', () => {
  describe('newId', () => {
    it('produces the canonical lowercase form', () => {
      const id = newId();
      expect(id).toMatch(CANONICAL_ID_PATTERN);
      expect(id).toBe(id.toLowerCase());
      expect(id).toHaveLength(36);
    });

    it('sets version 7 and variant 10', () => {
      const bytes = idToBytes(newId());
      expect((bytes[6] ?? 0) >>> 4).toBe(0x7);
      expect((bytes[8] ?? 0) >>> 6).toBe(0b10);
    });

    it('encodes the generating millisecond in the first 48 bits', () => {
      const now = 1_789_000_000_123;
      const id = pinned([now])();
      expect(idTimestamp(id)).toBe(now);
    });

    it('increments the 12-bit counter within one millisecond', () => {
      const generate = pinned([1_789_000_000_123, 1_789_000_000_123, 1_789_000_000_123]);
      const [first, second, third] = [generate(), generate(), generate()];
      expect(idToBytes(first)[7]).toBe(0);
      expect(idToBytes(second)[7]).toBe(1);
      expect(idToBytes(third)[7]).toBe(2);
      expect(first < second).toBe(true);
      expect(second < third).toBe(true);
    });

    it('waits for the next millisecond rather than reordering when the counter would overflow', () => {
      // The counter is seeded from the pinned random bytes, so 0xFF 0xFF seeds it at its maximum:
      // the second id in the same millisecond cannot increment and must move to the next one.
      let calls = 0;
      const generate = createIdGenerator({
        now: () => (calls++ < 2 ? 1_789_000_000_123 : 1_789_000_000_124),
        fillRandom: (bytes) => bytes.fill(0xff),
      });
      const first = generate();
      const second = generate();
      expect(idTimestamp(first)).toBe(1_789_000_000_123);
      expect(idTimestamp(second)).toBe(1_789_000_000_124);
      expect(first < second).toBe(true);
    });

    it('never repeats an id across a burst', () => {
      const ids = new Set(Array.from({ length: 1_000 }, () => newId()));
      expect(ids.size).toBe(1_000);
    });

    it('fails loudly on a host with no Web Crypto rather than inventing randomness', () => {
      vi.stubGlobal('crypto', undefined);
      try {
        expect(() => createIdGenerator()()).toThrow(/globalThis.crypto is required/);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('the canonical string codec', () => {
    it('round-trips through BINARY(16)', () => {
      const id = newId();
      const bytes = idToBytes(id);
      expect(bytes).toHaveLength(ID_BYTE_LENGTH);
      expect(idFromBytes(bytes)).toBe(id);
    });

    it('accepts an uppercase id and normalises it', () => {
      const id = newId();
      expect(idToBytes(id.toUpperCase())).toStrictEqual(idToBytes(id));
      expect(toCanonicalId(id.toUpperCase())).toBe(id);
    });

    it('refuses anything that is not a canonical UUIDv7', () => {
      expect(isCanonicalId('018f3a2e-7b1c-7d3e-9a4b-2c5d6e7f8091')).toBe(true);
      // A v4 id: the version nibble is the only difference.
      expect(isCanonicalId('018f3a2e-7b1c-4d3e-9a4b-2c5d6e7f8091')).toBe(false);
      expect(isCanonicalId('not-an-id')).toBe(false);
      expect(toCanonicalId('not-an-id')).toBeNull();
      expect(() => idToBytes('not-an-id')).toThrow(/canonical UUIDv7/);
      expect(() => idFromBytes(new Uint8Array(15))).toThrow(/16 bytes/);
    });

    it('never echoes the whole input in a codec error', () => {
      const secretish = 'irid_pat_0123456789ABCDEF_notreallyasecretbutlongenoughxx';
      expect(() => idToBytes(secretish)).toThrow(/irid_pat…/);
      // A short input has nothing to elide, so it is reported as it stands.
      expect(() => idToBytes('nope')).toThrow(/: nope$/);
    });
  });

  describe('idSchema', () => {
    it('brands every entity the data model identifies by UUIDv7', () => {
      expect(Object.keys(ID_SCHEMAS)).toStrictEqual([
        'user',
        'session',
        'token',
        'vault',
        'node',
        'note',
        'attachment',
        'job',
        'request',
        'instance',
        'oauthClient',
        'oauthConsent',
      ]);
    });

    it('accepts the canonical form case-insensitively and emits lowercase', () => {
      const id = newId();
      expect(VaultId.parse(id.toUpperCase())).toBe(id);
      expect(idSchema('vault').parse(id)).toBe(id);
      expect(NoteId.parse(id.toUpperCase())).toBe(id);
    });

    it('refuses a non-v7 UUID and a non-UUID', () => {
      expect(VaultId.safeParse('018f3a2e-7b1c-4d3e-9a4b-2c5d6e7f8091').success).toBe(false);
      expect(VaultId.safeParse('').success).toBe(false);
      expect(VaultId.safeParse('018f3a2e7b1c7d3e9a4b2c5d6e7f8091').success).toBe(false);
    });

    it('validates the 16-character base62 credential lookup id separately', () => {
      expect(TokenLookupId.parse('0123456789AbCdEf')).toBe('0123456789AbCdEf');
      expect(TokenLookupId.safeParse('0123456789AbCdE').success).toBe(false);
      expect(TokenLookupId.safeParse('0123456789AbCdE-').success).toBe(false);
    });
  });

  describe('the 2^53 bound on wire integers', () => {
    it('is 2^53 - 1', () => {
      expect(JSON_SAFE_INT_MAX).toBe(2 ** 53 - 1);
      expect(JSON_SAFE_INT_MAX).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('accepts a revision and a revision id inside the bound', () => {
      expect(Revision.parse(0)).toBe(0);
      expect(Revision.parse(JSON_SAFE_INT_MAX)).toBe(JSON_SAFE_INT_MAX);
      expect(RevisionId.parse(1)).toBe(1);
      expect(RevisionId.safeParse(0).success).toBe(false);
      expect(Revision.safeParse(-1).success).toBe(false);
      expect(Revision.safeParse(1.5).success).toBe(false);
      expect(Revision.safeParse(JSON_SAFE_INT_MAX + 2).success).toBe(false);
    });

    it('refuses to narrow a BIGINT UNSIGNED that a JSON number cannot carry', () => {
      expect(isJsonSafeInteger(BigInt(JSON_SAFE_INT_MAX))).toBe(true);
      expect(isJsonSafeInteger(BigInt(JSON_SAFE_INT_MAX) + 1n)).toBe(false);
      expect(isJsonSafeInteger(-1n)).toBe(false);
      expect(isJsonSafeInteger(-1)).toBe(false);
      expect(isJsonSafeInteger(1.5)).toBe(false);
      expect(isJsonSafeInteger(JSON_SAFE_INT_MAX + 2)).toBe(false);
      expect(toJsonSafeInteger(42n)).toBe(42);
      expect(toJsonSafeInteger(42)).toBe(42);
      expect(() => toJsonSafeInteger(BigInt(JSON_SAFE_INT_MAX) + 1n)).toThrow(/JSON number/);
    });
  });
});
