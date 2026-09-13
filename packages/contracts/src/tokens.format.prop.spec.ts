// oxlint-disable vitest/no-standalone-expect -- `test.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.

import { test } from '@fast-check/vitest';
import * as fc from 'fast-check';
import { describe, expect } from 'vitest';

import { PROP } from '../test/prop-budget.ts';
import {
  BASE62_ALPHABET,
  CREDENTIAL_LENGTH,
  crc6,
  mintToken,
  parseToken,
  redactToken,
  scannerRegex,
  TOKEN_CRC_LENGTH,
  TOKEN_KINDS,
  TOKEN_REGEX,
  tokenParseFailure,
} from './tokens.ts';

/** Randomness as a property supplies it: a finite byte source, cycled. */
function bytesFrom(source: Uint8Array): (bytes: Uint8Array) => void {
  let cursor = 0;
  return (bytes) => {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = source[cursor % source.length] ?? 0;
      cursor += 1;
    }
  };
}

const kind = fc.constantFrom(...TOKEN_KINDS);

/**
 * A finite entropy source with at least one byte the rejection sampler accepts — a source of
 * nothing but 248 and above is not randomness, and `mintTokenId` refuses it rather than spinning.
 */
const entropy = fc
  .uint8Array({ minLength: 1, maxLength: 96 })
  .filter((source) => source.some((byte) => byte < 248));

describe('tokens.format.prop [area:tokens]', () => {
  test.prop([kind, entropy], PROP)('minting and parsing are inverses', (tokenKind, source) => {
    const minted = mintToken(tokenKind, bytesFrom(source));
    expect(minted.raw).toHaveLength(CREDENTIAL_LENGTH);
    expect(parseToken(minted.raw)).toStrictEqual({
      kind: tokenKind,
      tokenId: minted.tokenId,
      secret: minted.secret,
    });
    expect(minted.raw.match(scannerRegex())).toStrictEqual([minted.raw]);
  });

  test.prop([kind, entropy, fc.nat(), fc.integer({ min: 0, max: 61 })], PROP)(
    'any single-character mutation fails the CRC or the prefix check',
    (tokenKind, source, offset, alphabetIndex) => {
      const raw = mintToken(tokenKind, bytesFrom(source)).raw;
      const position = offset % raw.length;
      const original = raw.charAt(position);
      const replacement = BASE62_ALPHABET.charAt(alphabetIndex);
      fc.pre(replacement !== original);
      const mutated = raw.slice(0, position) + replacement + raw.slice(position + 1);
      expect(parseToken(mutated)).toBeNull();
      // Either the prefix check fails (the literal `irid_`, the kind, the separators, a length)
      // or the CRC does. Both are offline, so neither costs a database read.
      const failure = tokenParseFailure(mutated);
      expect(['not_a_credential', 'unknown_kind', 'malformed', 'crc_mismatch']).toContain(failure);
    },
  );

  test.prop([fc.string({ maxLength: 120 })], PROP)(
    'parsing is total: an arbitrary string is a credential or it is null',
    (candidate) => {
      const parsed = parseToken(candidate);
      if (parsed === null) {
        expect(parsed).toBeNull();
        return;
      }
      expect(candidate).toMatch(TOKEN_REGEX);
      expect(crc6(candidate.slice(0, -TOKEN_CRC_LENGTH))).toBe(
        candidate.slice(candidate.length - TOKEN_CRC_LENGTH),
      );
    },
  );

  test.prop([kind, entropy], PROP)(
    'the secret never appears in what a failure is allowed to say',
    (tokenKind, source) => {
      const minted = mintToken(tokenKind, bytesFrom(source));
      const corrupted = `${minted.raw.slice(0, -1)}${minted.raw.endsWith('a') ? 'b' : 'a'}`;
      const failure = tokenParseFailure(corrupted) ?? '';
      const redacted = redactToken(corrupted);
      expect(failure).not.toContain(minted.secret);
      expect(redacted).not.toContain(minted.secret);
      expect(redacted).toContain(minted.tokenId);
    },
  );

  test.prop([entropy, entropy], PROP)('two issuances never share a public id', (left, right) => {
    fc.pre(left.join(',') !== right.join(','));
    const first = mintToken('pat', bytesFrom(left));
    const second = mintToken('pat', bytesFrom(right));
    expect(first.tokenId === second.tokenId && first.secret === second.secret).toBe(false);
  });
});
