import { Password } from '@iridium/contracts';
/**
 * `auth.policy.unit` (04-auth-and-access-control.md section 3.4; D04-04): the NIST-style policy —
 * 15 to 128 code points, any Unicode, no composition rules, no rotation rules — plus the breached
 * list and the two context words, with every failing rule reported at once.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { blocklistKey } from './blocklist.ts';
import {
  CONTEXT_WORD_MIN_CHARS,
  emailLocalPart,
  normalizePassword,
  PASSWORD_MAX_CODE_POINTS,
  PasswordPolicy,
  PRODUCT_CONTEXT_WORD,
  schemaMaxLength,
} from './policy.ts';

const MIN = 15;
const CONTEXT = { email: 'Ada.Lovelace@example.test' };

function policy(overrides: { blocklist?: readonly string[]; checkBreachedList?: boolean } = {}) {
  return new PasswordPolicy({
    minLength: MIN,
    maxLength: PASSWORD_MAX_CODE_POINTS,
    blocklist: new Set((overrides.blocklist ?? ['correct horse battery staple']).map(blocklistKey)),
    checkBreachedList: overrides.checkBreachedList ?? true,
  });
}

describe('auth.policy.unit [area:auth]', () => {
  it('accepts any Unicode of 15 to 128 code points, spaces included, and answers the NFC form', () => {
    const result = policy().check('a whole sentence with spaces 42', CONTEXT);
    expect(result).toStrictEqual({ ok: true, normalized: 'a whole sentence with spaces 42' });
    const astral = '🔑'.repeat(MIN);
    expect(policy().check(astral, CONTEXT)).toStrictEqual({ ok: true, normalized: astral });
  });

  it('counts code points, not UTF-16 units', () => {
    // Fourteen astral characters are 28 UTF-16 units and still one short.
    const result = policy().check('🔑'.repeat(MIN - 1), CONTEXT);
    expect(result).toStrictEqual({ ok: false, violations: ['too_short'] });
  });

  it('applies NFC before the length check, so decomposed input is measured after composition', () => {
    // "é" as e + combining acute is two code points before NFC and one after.
    const decomposed = 'é'.repeat(MIN - 1);
    expect(normalizePassword(decomposed)).toBe('é'.repeat(MIN - 1));
    expect(policy().check(decomposed, CONTEXT)).toStrictEqual({
      ok: false,
      violations: ['too_short'],
    });
  });

  it('rejects, never truncates, above 128 code points', () => {
    const result = policy().check('x'.repeat(PASSWORD_MAX_CODE_POINTS + 1), CONTEXT);
    expect(result).toStrictEqual({ ok: false, violations: ['too_long'] });
    expect(policy().check('x'.repeat(PASSWORD_MAX_CODE_POINTS), CONTEXT).ok).toBe(true);
  });

  it('rejects a breached entry by its NFC-lowercased form, and only when the list is consulted', () => {
    expect(policy().check('Correct Horse Battery Staple', CONTEXT)).toStrictEqual({
      ok: false,
      violations: ['breached'],
    });
    expect(
      policy({ checkBreachedList: false }).check('Correct Horse Battery Staple', CONTEXT).ok,
    ).toBe(true);
  });

  it('rejects the product name and the email local part as context words, case-insensitively', () => {
    expect(policy().check('my IRIDIUM password here', CONTEXT)).toStrictEqual({
      ok: false,
      violations: ['context_word'],
    });
    expect(policy().check('ada.lovelace loves numbers', CONTEXT)).toStrictEqual({
      ok: false,
      violations: ['context_word'],
    });
    expect(PRODUCT_CONTEXT_WORD).toBe('iridium');
  });

  it('ignores a local part shorter than four characters', () => {
    expect(emailLocalPart('bob@example.test')).toBeNull();
    expect(emailLocalPart('abcd@example.test')).toBe('abcd');
    expect(emailLocalPart('no-at-sign')).toBe('no-at-sign');
    expect(CONTEXT_WORD_MIN_CHARS).toBe(4);
    expect(policy().check('bob is a fine short name!', { email: 'bob@example.test' }).ok).toBe(
      true,
    );
  });

  it('reports every failing rule at once, in vocabulary order', () => {
    const list = ['iridium'];
    expect(policy({ blocklist: list }).check('iridium', CONTEXT)).toStrictEqual({
      ok: false,
      violations: ['too_short', 'breached', 'context_word'],
    });
  });

  it('has no composition or rotation rule: digits, cases and symbols are never required', () => {
    expect(policy().check('lowercase letters only here', CONTEXT).ok).toBe(true);
    expect(policy().check('123456789012345', CONTEXT).ok).toBe(true);
  });

  it('publishes its bounds', () => {
    const configured = policy();
    expect(configured.minLength).toBe(MIN);
    expect(configured.maxLength).toBe(PASSWORD_MAX_CODE_POINTS);
  });

  it('reads the maximum from the wire schema, and refuses a schema that declares none', () => {
    expect(schemaMaxLength(Password)).toBe(128);
    expect(PASSWORD_MAX_CODE_POINTS).toBe(128);
    expect(() => schemaMaxLength(z.string())).toThrow(/declares no maximum length/);
  });
});
