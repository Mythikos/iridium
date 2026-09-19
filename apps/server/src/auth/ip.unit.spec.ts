/**
 * `auth.ip.unit` (03-data-model.md sections 3 and 12.1): the `VARBINARY(16)` form of a peer
 * address — four bytes for IPv4, sixteen for IPv6, the mapped form collapsed to its IPv4, and
 * `null` for anything that is not an address — and the rendering `GET /me/sessions` reads back.
 * The secret-hash helper the same rows depend on is asserted beside it.
 */
import { ABSENT_SECRET_HASH } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { ipFromBytes, ipToBytes } from './ip.ts';
import { secretHash, secretMatches } from './secret-hash.ts';

describe('auth.ip.unit [area:auth]', () => {
  it('stores IPv4 as four bytes and renders it back', () => {
    expect(ipToBytes('203.0.113.7')).toStrictEqual(Buffer.from([203, 0, 113, 7]));
    expect(ipFromBytes(Buffer.from([203, 0, 113, 7]))).toBe('203.0.113.7');
  });

  it('collapses an IPv4-mapped IPv6 address to the address it maps', () => {
    expect(ipToBytes('::ffff:10.0.0.1')).toStrictEqual(Buffer.from([10, 0, 0, 1]));
    expect(ipToBytes('::FFFF:10.0.0.1')).toStrictEqual(Buffer.from([10, 0, 0, 1]));
  });

  it('stores IPv6 as sixteen bytes, expanding :: and an embedded dotted quad', () => {
    expect(ipToBytes('2001:db8::1')).toStrictEqual(
      Buffer.from([0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
    );
    expect(ipToBytes('::1')).toStrictEqual(
      Buffer.from([...Array.from({ length: 15 }, () => 0), 1]),
    );
    expect(ipToBytes('2001:db8:0:0:0:0:0:2')?.at(-1)).toBe(2);
    expect(ipToBytes('64:ff9b::1.2.3.4')?.subarray(12)).toStrictEqual(Buffer.from([1, 2, 3, 4]));
    expect(ipToBytes('::ffff:0:1.2.3.4')?.subarray(12)).toStrictEqual(Buffer.from([1, 2, 3, 4]));
    expect(ipFromBytes(ipToBytes('2001:db8::1'))).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('answers null for a non-address and for bytes of an impossible length', () => {
    expect(ipToBytes('not an address')).toBeNull();
    expect(ipToBytes(undefined)).toBeNull();
    expect(ipToBytes(null)).toBeNull();
    expect(ipToBytes('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(ipToBytes('::ffff:999.0.0.1')).toBeNull();
    expect(ipFromBytes(null)).toBeNull();
    expect(ipFromBytes(Buffer.from([1, 2, 3]))).toBeNull();
  });

  it('hashes a secret over its ASCII text and compares in constant time, absent rows included', () => {
    const secret = 'A'.repeat(43);
    const digest = secretHash(secret);
    expect(digest).toHaveLength(32);
    expect(secretMatches(secret, digest)).toBe(true);
    expect(secretMatches('B'.repeat(43), digest)).toBe(false);
    expect(secretMatches(secret, null)).toBe(false);
    expect(secretMatches(secret, Buffer.alloc(31))).toBe(false);
    expect(ABSENT_SECRET_HASH).toHaveLength(32);
  });
});
