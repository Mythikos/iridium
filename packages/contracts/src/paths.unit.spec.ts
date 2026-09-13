import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits.ts';
import {
  checkNodeName,
  isSafeNodeName,
  isSafePath,
  joinPath,
  nameKey,
  namesCollide,
  nodeNameFromFileName,
  NOTE_EXTENSION,
  noteFileName,
  pathDepth,
  RESERVED_DEVICE_NAMES,
  safePath,
  utf8ByteLength,
  type NameRejection,
} from './paths.ts';

const NUL = String.fromCodePoint(0x00);
const TAB = String.fromCodePoint(0x09);
const CR = String.fromCodePoint(0x0d);
const UNIT_SEPARATOR = String.fromCodePoint(0x1f);
const DELETE = String.fromCodePoint(0x7f);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);
const COMBINING_ACUTE = String.fromCodePoint(0x03_01);
/** A three-byte character in UTF-8 but a single UTF-16 unit. */
const CJK = String.fromCodePoint(0x4e_2d);

function rejection(name: string): NameRejection | 'accepted' {
  const check = checkNodeName(name);
  return check.ok ? 'accepted' : check.reason;
}

describe('contracts.paths.unit [spec:structural-concurrency]', () => {
  describe('the empty and whitespace-only cases', () => {
    it('reserves the empty string for the root row', () => {
      expect(rejection('')).toBe('empty');
    });

    it.each([' ', '  ', TAB, NO_BREAK_SPACE, `${TAB} `])('refuses %j', (name) => {
      expect(isSafeNodeName(name)).toBe(false);
    });
  });

  describe('dot segments, separators and control characters', () => {
    it.each(['.', '..'])('refuses %j', (name) => {
      expect(rejection(name)).toBe('dot_segment');
    });

    it.each(['a/b', '/a', 'a/', 'a\\b', '\\\\server\\share', 'C:\\Notes'])(
      'refuses the separator in %j',
      (name) => {
        expect(rejection(name)).toBe('separator');
      },
    );

    it.each([`a${NUL}b`, NUL, `a${TAB}b`, `a${CR}b`, `a${UNIT_SEPARATOR}b`, `a${DELETE}b`])(
      'refuses the control character in %j',
      (name) => {
        expect(rejection(name)).toBe('control_character');
      },
    );

    it('refuses a lone surrogate, which utf8mb4 cannot store', () => {
      const high = String.fromCharCode(0xd8_3d);
      const low = String.fromCharCode(0xde_00);
      expect(rejection(`a${high}b`)).toBe('lone_surrogate');
      expect(rejection(`a${low}b`)).toBe('lone_surrogate');
      // A high surrogate as the very last unit has no partner to inspect at all.
      expect(rejection(`a${high}`)).toBe('lone_surrogate');
      expect(isSafeNodeName(`a${high}${low}b`)).toBe(true);
    });
  });

  describe('leading and trailing dots and spaces (the Windows rules)', () => {
    it.each(['.hidden', ' Report', `${NO_BREAK_SPACE}Report`])(
      'refuses the leading character in %j',
      (name) => {
        expect(rejection(name)).toBe('leading_space_or_dot');
      },
    );

    it.each(['Report.', 'Report ', `Report${NO_BREAK_SPACE}`, 'Report..'])(
      'refuses the trailing character in %j',
      (name) => {
        expect(rejection(name)).toBe('trailing_space_or_dot');
      },
    );

    it('still accepts a dot inside a name', () => {
      expect(isSafeNodeName('v1.2 notes')).toBe(true);
      expect(isSafeNodeName('Roadmap.md')).toBe(true);
    });
  });

  describe('the reserved Windows device names', () => {
    it('lists exactly CON, PRN, AUX, NUL, COM1-COM9 and LPT1-LPT9', () => {
      expect(RESERVED_DEVICE_NAMES).toHaveLength(4 + 9 + 9);
      expect(RESERVED_DEVICE_NAMES).toContain('CON');
      expect(RESERVED_DEVICE_NAMES).toContain('COM9');
      expect(RESERVED_DEVICE_NAMES).toContain('LPT9');
    });

    it.each(['CON', 'con', 'Con', 'CON.md', 'con.txt', 'COM9', 'com9', 'COM9.md', 'NUL', 'lpt1'])(
      'refuses %j with or without an extension, in any case',
      (name) => {
        expect(rejection(name)).toBe('reserved_device_name');
      },
    );

    it.each(['CONSOLE', 'COM10', 'COM0', 'CONTACTS.md', 'NULL'])(
      'accepts %j, which is not a device name',
      (name) => {
        expect(isSafeNodeName(name)).toBe(true);
      },
    );
  });

  describe('length in UTF-16 units versus bytes', () => {
    it('bounds the name at 255 UTF-8 bytes, not 255 characters', () => {
      expect(LIMITS.NODE_NAME_MAX_BYTES).toBe(255);
      expect(utf8ByteLength('a')).toBe(1);
      expect(utf8ByteLength(CJK)).toBe(3);
      expect(utf8ByteLength('\u{1F600}')).toBe(4);
      expect(utf8ByteLength(`e${COMBINING_ACUTE}`)).toBe(3);

      expect(isSafeNodeName('a'.repeat(255))).toBe(true);
      expect(rejection('a'.repeat(256))).toBe('too_long');

      // 85 three-byte characters are 255 bytes and 85 UTF-16 units: accepted.
      expect(isSafeNodeName(CJK.repeat(85))).toBe(true);
      // 86 are 258 bytes and still only 86 UTF-16 units: refused on bytes, not on length.
      const tooLong = CJK.repeat(86);
      expect(tooLong).toHaveLength(86);
      expect(rejection(tooLong)).toBe('too_long');

      // An astral character is one code point, two UTF-16 units and four bytes.
      expect(isSafeNodeName('\u{1F600}'.repeat(63))).toBe(true);
      expect(rejection('\u{1F600}'.repeat(64))).toBe('too_long');
    });
  });

  describe('Unicode normalisation', () => {
    it('refuses a name that is not NFC', () => {
      const nfd = `cafe${COMBINING_ACUTE}`;
      expect(nfd.normalize('NFC')).toBe('café');
      expect(rejection(nfd)).toBe('not_nfc');
      expect(isSafeNodeName('café')).toBe(true);
    });

    it('keys the NFD and NFC spellings of one name together', () => {
      expect(nameKey(`cafe${COMBINING_ACUTE}`)).toBe(nameKey('café'));
      expect(namesCollide(`cafe${COMBINING_ACUTE}`, 'café')).toBe(true);
    });
  });

  describe('sibling collision under utf8mb4_0900_as_ci', () => {
    it('is case-insensitive', () => {
      expect(namesCollide('Note', 'note')).toBe(true);
      expect(namesCollide('README', 'readme')).toBe(true);
    });

    it('is accent-sensitive', () => {
      expect(namesCollide('Note', 'Noté')).toBe(false);
      expect(namesCollide('resume', 'résumé')).toBe(false);
    });

    it('distinguishes different names', () => {
      expect(namesCollide('Roadmap', 'Roadmaps')).toBe(false);
    });
  });

  describe('percent-encoding cannot smuggle a refused name through', () => {
    it.each(['a%2Fb', 'a%2fb', `a%00b`, 'a%2E%2E', '%43%4F%4E', '%2e', '%20Report'])(
      'refuses %j',
      (name) => {
        expect(rejection(name)).toBe('percent_encoded');
      },
    );

    it('leaves a percent sign that decodes to a storable name alone', () => {
      expect(isSafeNodeName('100% done')).toBe(true);
      expect(isSafeNodeName('100%20done')).toBe(true);
      expect(isSafeNodeName('%41')).toBe(true);
    });

    it('decodes an escape that is not valid UTF-8 rather than trusting it', () => {
      // `%FF` is not a UTF-8 sequence, so `decodeURIComponent` throws; the byte-wise fallback
      // still shows what the name would become, which is all the check needs.
      expect(isSafeNodeName('a%FFb')).toBe(true);
      expect(rejection('a%FF%2Fb')).toBe('percent_encoded');
    });
  });

  describe('vault-relative paths', () => {
    it('accepts a joined path of storable names', () => {
      const check = safePath('Projects/Iridium/Roadmap');
      expect(check).toStrictEqual({ ok: true, segments: ['Projects', 'Iridium', 'Roadmap'] });
      expect(isSafePath('Roadmap')).toBe(true);
      expect(joinPath(['Projects', 'Iridium'])).toBe('Projects/Iridium');
      expect(pathDepth('Projects/Iridium/Roadmap')).toBe(3);
      expect(pathDepth('')).toBe(0);
    });

    it('refuses an empty, absolute or doubled-separator path', () => {
      expect(safePath('')).toStrictEqual({ ok: false, reason: 'empty_path', index: null });
      expect(safePath('/Projects')).toStrictEqual({
        ok: false,
        reason: 'absolute_path',
        index: null,
      });
      expect(safePath('\\Projects')).toStrictEqual({
        ok: false,
        reason: 'absolute_path',
        index: null,
      });
      expect(safePath('Projects//Roadmap')).toStrictEqual({
        ok: false,
        reason: 'empty_segment',
        index: 1,
      });
    });

    it('reports which segment failed and why', () => {
      expect(safePath('Projects/CON/Roadmap')).toStrictEqual({
        ok: false,
        reason: 'reserved_device_name',
        index: 1,
      });
      expect(safePath(`Projects/Road${NUL}map`)).toStrictEqual({
        ok: false,
        reason: 'control_character',
        index: 1,
      });
    });

    it('bounds the depth at TREE_MAX_DEPTH', () => {
      expect(LIMITS.TREE_MAX_DEPTH).toBe(64);
      const atLimit = Array.from(
        { length: LIMITS.TREE_MAX_DEPTH },
        (_unused, i) => `n${String(i)}`,
      );
      expect(safePath(joinPath(atLimit)).ok).toBe(true);
      expect(safePath(joinPath([...atLimit, 'one-too-deep']))).toStrictEqual({
        ok: false,
        reason: 'too_deep',
        index: null,
      });
    });
  });

  describe('the note extension', () => {
    it('adds and removes .md without touching the stored name', () => {
      expect(NOTE_EXTENSION).toBe('.md');
      expect(noteFileName('Roadmap')).toBe('Roadmap.md');
      expect(nodeNameFromFileName('Roadmap.md')).toBe('Roadmap');
      expect(nodeNameFromFileName('Roadmap.MD')).toBe('Roadmap');
      expect(nodeNameFromFileName('Roadmap')).toBe('Roadmap');
      expect(nodeNameFromFileName('notes.md.md')).toBe('notes.md');
    });
  });
});
