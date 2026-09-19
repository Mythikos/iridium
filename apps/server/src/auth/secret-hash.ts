/**
 * The at-rest form of every high-entropy credential secret (04-auth-and-access-control.md section
 * 2.2; A31; `SECRET_VERIFICATION` in `@iridium/contracts/tokens.ts`).
 *
 * `secretHash(secret) = SHA-256(ascii(secret43))`: the digest is taken over the 43-character base62
 * string exactly as presented, never over decoded bytes, so every store and verifier computes the
 * same value. No pepper: a 256-bit CSPRNG secret is not brute-forceable, and a database dump yields
 * hashes that cannot be turned back into credentials.
 *
 * The comparison is `crypto.timingSafeEqual`, and when no row exists it runs against a fixed 32-byte
 * buffer anyway, so a response time cannot distinguish "unknown id" from "wrong secret".
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { ABSENT_SECRET_HASH } from '@iridium/contracts';

/** `SHA-256(ascii(secret43))`, the 32 bytes stored in every `secret_hash BINARY(32)` column. */
export function secretHash(secret: string): Buffer {
  return createHash('sha256').update(secret, 'ascii').digest();
}

/**
 * Constant-time comparison of a presented secret against a stored digest. A `null` digest — the
 * row does not exist — still performs one full comparison against the absent-row buffer.
 */
export function secretMatches(secret: string, storedHash: Uint8Array | null): boolean {
  const presented = secretHash(secret);
  if (storedHash === null) {
    timingSafeEqual(presented, ABSENT_SECRET_HASH);
    return false;
  }
  if (storedHash.byteLength !== presented.byteLength) {
    timingSafeEqual(presented, ABSENT_SECRET_HASH);
    return false;
  }
  return timingSafeEqual(presented, storedHash);
}
