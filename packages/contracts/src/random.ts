/**
 * The one randomness seam of this package. Identifiers and credentials are the only things it
 * generates, and both take their bytes from `globalThis.crypto.getRandomValues` — available in
 * Node 24 and in every supported browser, so the `core` package needs no `node:*` import
 * (02-system-architecture.md, "Identifiers").
 */

/** Fills `bytes` with cryptographically strong random values. */
export type FillRandom = (bytes: Uint8Array) => void;

interface WebCryptoLike {
  getRandomValues: <T extends Uint8Array>(array: T) => T;
}

/**
 * Web Crypto is not in the `es2024` lib and this package declares no DOM or Node types, so the
 * global is declared here with the one member Iridium uses. It is an ambient declaration rather
 * than a cast off `globalThis`, so the `typeof` guard below is a real check and not a lie the
 * type system was talked into.
 */
declare const crypto: WebCryptoLike | undefined;

/** Web Crypto, or a clear failure: a silent fallback to `Math.random` would be a vulnerability. */
export const fillRandom: FillRandom = (bytes: Uint8Array): void => {
  if (typeof crypto === 'undefined') {
    throw new TypeError('globalThis.crypto is required to generate identifiers and credentials');
  }
  crypto.getRandomValues(bytes);
};
