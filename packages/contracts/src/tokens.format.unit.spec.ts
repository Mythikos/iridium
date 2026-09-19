import { describe, expect, it } from 'vitest';

import {
  BASE62_ALPHABET,
  CREDENTIAL_LENGTH,
  CREDENTIAL_PREFIX,
  crc32,
  crc6,
  DISPLAY_PREFIX_LENGTH,
  displayPrefix,
  kindOf,
  mintToken,
  parseToken,
  parseTokenDetailed,
  redactToken,
  SCANNER_REGEX_SOURCE,
  scannerRegex,
  TOKEN_CRC_LENGTH,
  TOKEN_ID_LENGTH,
  TOKEN_KINDS,
  TOKEN_REGEX,
  TOKEN_SECRET_LENGTH,
  tokenParseFailure,
} from './tokens.ts';

/** Deterministic bytes, so a failure names a credential rather than a lottery ticket. */
function sequentialBytes(seed: number): (bytes: Uint8Array) => void {
  let next = seed;
  return (bytes) => {
    for (let index = 0; index < bytes.length; index += 1) {
      next = (next * 1_103_515_245 + 12_345) % 2_147_483_648;
      bytes[index] = next % 256;
    }
  };
}

describe('tokens.format.unit [area:tokens]', () => {
  describe('the shape', () => {
    it.each([...TOKEN_KINDS])('mints a 75-character %s credential', (kind) => {
      const minted = mintToken(kind, sequentialBytes(7));
      expect(minted.raw).toHaveLength(CREDENTIAL_LENGTH);
      expect(minted.raw).toMatch(TOKEN_REGEX);
      expect(minted.raw.startsWith(`${CREDENTIAL_PREFIX}${kind}_`)).toBe(true);
      expect(minted.tokenId).toHaveLength(TOKEN_ID_LENGTH);
      expect(minted.secret).toHaveLength(TOKEN_SECRET_LENGTH);
      expect(minted.displayPrefix).toHaveLength(DISPLAY_PREFIX_LENGTH);
      expect(minted.displayPrefix).toBe(displayPrefix(kind, minted.tokenId));
    });

    it('draws the id and the secret from the base62 alphabet only', () => {
      const minted = mintToken('pat', sequentialBytes(11));
      for (const character of minted.tokenId + minted.secret) {
        expect(BASE62_ALPHABET).toContain(character);
      }
    });

    it('is exactly 9 + 16 + 1 + 43 + 6 characters', () => {
      expect(CREDENTIAL_PREFIX.length + 3 + 1).toBe(9);
      expect(9 + TOKEN_ID_LENGTH + 1 + TOKEN_SECRET_LENGTH + TOKEN_CRC_LENGTH).toBe(
        CREDENTIAL_LENGTH,
      );
      expect(DISPLAY_PREFIX_LENGTH).toBe(9 + TOKEN_ID_LENGTH + 1);
    });

    it('never issues the same public id twice', () => {
      const ids = new Set(Array.from({ length: 200 }, () => mintToken('pat').tokenId));
      expect(ids.size).toBe(200);
    });

    it('refuses an entropy source that yields no unbiased byte, rather than spinning', () => {
      // Every byte at or above 248 is discarded by the rejection sampler, so a source of nothing
      // but 0xFF can never fill the id. That is a broken CSPRNG, and it fails loudly.
      expect(() => mintToken('pat', (bytes) => bytes.fill(0xff))).toThrow(/entropy source/);
    });
  });

  describe('parsing', () => {
    it.each([...TOKEN_KINDS])('round-trips a %s credential', (kind) => {
      const minted = mintToken(kind, sequentialBytes(13));
      const parsed = parseToken(minted.raw);
      expect(parsed).toStrictEqual({
        kind,
        tokenId: minted.tokenId,
        secret: minted.secret,
      });
    });

    it('is total: any string parses to a credential or to null', () => {
      for (const candidate of [
        '',
        'irid_',
        'irid_pat_',
        'irid_xyz_0123456789ABCDEF_0123456789012345678901234567890123456789012345678',
        'IRID_PAT_0123456789ABCDEF_0123456789012345678901234567890123456789012345678',
        `${mintToken('pat').raw} `,
        `x${mintToken('pat').raw}`,
      ]) {
        expect(parseToken(candidate)).toBeNull();
      }
    });

    it('rejects a corruption at every single position', () => {
      const raw = mintToken('ses', sequentialBytes(17)).raw;
      for (let index = 0; index < raw.length; index += 1) {
        const original = raw.charAt(index);
        const replacement = original === 'a' ? 'b' : 'a';
        const corrupted = raw.slice(0, index) + replacement + raw.slice(index + 1);
        expect(parseToken(corrupted)).toBeNull();
      }
    });

    it('names why a string is not a credential, in a closed vocabulary', () => {
      const raw = mintToken('oat', sequentialBytes(19)).raw;
      expect(tokenParseFailure(raw)).toBeNull();
      // The detailed form is the one answer both projections are read from.
      expect(parseTokenDetailed(raw)).toStrictEqual({ ok: true, token: parseToken(raw) });
      expect(parseTokenDetailed('sk-live-not-ours')).toStrictEqual({
        ok: false,
        reason: 'not_a_credential',
      });
      expect(tokenParseFailure('sk-live-not-ours')).toBe('not_a_credential');
      expect(tokenParseFailure('irid_zzz_0123456789ABCDEF_x')).toBe('unknown_kind');
      expect(tokenParseFailure('irid_pat_0123456789ABCDEF_short')).toBe('malformed');
      expect(tokenParseFailure(`${raw.slice(0, -1)}${raw.endsWith('a') ? 'b' : 'a'}`)).toBe(
        'crc_mismatch',
      );
    });

    it('never lets a secret into a redacted rendering', () => {
      const minted = mintToken('pat', sequentialBytes(23));
      const redacted = redactToken(minted.raw);
      expect(redacted).toBe(`${minted.displayPrefix}[redacted]`);
      expect(redacted).not.toContain(minted.secret);
      expect(redactToken('not a credential at all')).toBe('[redacted]');
    });

    it('dispatches on the prefix without verifying the CRC', () => {
      expect(kindOf('irid_pat_0123456789ABCDEF_whatever')).toBe('pat');
      expect(kindOf('irid_zzz_0123456789ABCDEF_whatever')).toBeNull();
      expect(kindOf('nothing')).toBeNull();
    });
  });

  describe('the CRC', () => {
    it('is CRC-32 IEEE', () => {
      // The check value every CRC-32/ISO-HDLC implementation publishes.
      expect(crc32('123456789')).toBe(0xcb_f4_39_26);
      expect(crc32('')).toBe(0);
    });

    it('is six base62 characters, zero-padded', () => {
      const digits = crc6('irid_pat_0123456789ABCDEF_x');
      expect(digits).toHaveLength(TOKEN_CRC_LENGTH);
      for (const character of digits) expect(BASE62_ALPHABET).toContain(character);
      expect(crc6('')).toBe('000000');
    });
  });

  describe('the published scanner regex', () => {
    it('is the string documented for a site scanning tool', () => {
      expect(SCANNER_REGEX_SOURCE).toBe(
        'irid_(pat|ses|tkt|spl|oat|ort|oac)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}',
      );
    });

    it('finds every live kind inside surrounding text', () => {
      for (const kind of TOKEN_KINDS) {
        const raw = mintToken(kind, sequentialBytes(29)).raw;
        const matches = `config: ${raw}\nnext line`.match(scannerRegex());
        expect(matches).toStrictEqual([raw]);
      }
    });

    it('does not match a near miss', () => {
      const raw = mintToken('pat', sequentialBytes(31)).raw;
      const nearMisses = [
        raw.replace('_pat_', '_xxx_'),
        raw.slice(0, CREDENTIAL_LENGTH - 1),
        raw.replace(/^irid_/, 'irid-'),
        raw.replace('_', '-'),
      ];
      for (const candidate of nearMisses) {
        expect(candidate.match(scannerRegex())).toBeNull();
      }
    });

    it('matches a credential the scanner regex finds only when the CRC also verifies', () => {
      const raw = mintToken('ort', sequentialBytes(37)).raw;
      const forged = `${raw.slice(0, CREDENTIAL_LENGTH - TOKEN_CRC_LENGTH)}000000`;
      expect(forged.match(scannerRegex())).toStrictEqual([forged]);
      expect(parseToken(forged)).toBeNull();
    });
  });
});
