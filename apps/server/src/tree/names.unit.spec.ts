/**
 * `tree.names.unit` — the server's enforcement of the name rules (03-data-model.md §6.5).
 *
 * The *rules* are `contracts.paths.unit`'s; what is proven here is the server's three additions:
 * a note's `.md` suffix is stripped before storage, the result is re-checked rather than assumed,
 * and the depth ceiling is a property of the parent rather than of the name.
 */
import { LIMITS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { assertChildDepth, storedNodeName, storedVaultName } from './names.ts';

/**
 * The value a call threw, or `undefined` when it returned.
 *
 * A `try`/`catch` around an `expect` is a conditional assertion: a refusal that stopped happening
 * would make the `catch` unreachable and the case would pass having asserted nothing. Capturing the
 * value first and asserting on it unconditionally is the shape that cannot do that.
 */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('tree.names.unit [area:tree]', () => {
  it.each([
    ['Onboarding.md', 'Onboarding'],
    ['Onboarding.MD', 'Onboarding'],
    ['Onboarding', 'Onboarding'],
    ['Release .md notes.md', 'Release .md notes'],
  ])('stores the note %j as %j', (given: string, stored: string) => {
    expect(storedNodeName(given, 'note')).toBe(stored);
  });

  it('leaves a category name alone', () => {
    expect(storedNodeName('Guides.md', 'category')).toBe('Guides.md');
  });

  it('normalises to NFC before storing, so one name is one row', () => {
    const decomposed = 'Café';
    const stored = storedNodeName(decomposed, 'note');
    expect(stored).toBe('Café');
    expect(stored.normalize('NFC')).toBe(stored);
  });

  it('re-checks after stripping the suffix', () => {
    // `.md` alone strips to the empty name, which the schema never saw.
    expect(() => storedNodeName('.md', 'note')).toThrow(/node-name rule/i);
  });

  it.each(['a/b', 'a\\b', '.hidden', 'trailing ', 'CON', 'nul.md', '..'])(
    'refuses %j with the policy code',
    (name: string) => {
      expect(thrownBy(() => storedNodeName(name, 'note'))).toMatchObject({
        code: 'validation_failed',
        status: 422,
        extensions: { errors: [{ path: 'body.name', code: 'invalid_name' }] },
      });
    },
  );

  it('bounds a vault name in characters, not in bytes', () => {
    const atCap = 'é'.repeat(LIMITS.VAULT_NAME_MAX_CHARS);
    expect(storedVaultName(atCap)).toBe(atCap.normalize('NFC'));
    expect(() => storedVaultName('é'.repeat(LIMITS.VAULT_NAME_MAX_CHARS + 1))).toThrow(
      /node-name rule/i,
    );
  });

  it('admits a child at the ceiling and refuses the one past it', () => {
    expect(
      thrownBy(() => {
        assertChildDepth(LIMITS.TREE_MAX_DEPTH - 1);
      }),
    ).toBeUndefined();
    expect(
      thrownBy(() => {
        assertChildDepth(LIMITS.TREE_MAX_DEPTH);
      }),
    ).toMatchObject({
      code: 'invalid_move',
      status: 409,
      extensions: { errors: [{ code: 'depth' }] },
    });
  });
});
