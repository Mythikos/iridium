/**
 * `vaults.slug` (03-data-model.md §5).
 *
 * The slug is derived once from the name at creation and is **immutable** afterwards, so export
 * archive names and manifest paths stay stable across a rename. It is ASCII by column
 * (`VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin`) because it is used as a directory name in a
 * ZIP, and a ZIP entry whose name depends on the reader's locale is a support ticket.
 *
 * Derivation is 03 §5's: lowercase, every run of non-alphanumerics to a single `-`, trimmed, with a
 * `-2`, `-3`, … suffix on collision. Nothing here queries; `uniqueSlug` takes the already-taken set,
 * so the rule is a pure function and the transaction owns the read.
 */

/**
 * The width of `vaults.slug`. It is the column, not a product cap: nothing is refused for exceeding
 * it — a long name is truncated and then made unique — and no client pre-validates against it.
 */
const SLUG_COLUMN_CHARS = 64;

/** The suffix a collision starts at: the second vault with a slug takes `-2` (§5). */
const FIRST_COLLISION_SUFFIX = 2;

/** What a name with no ASCII alphanumerics derives to, so the column is never empty. */
export const FALLBACK_SLUG = 'vault';

/**
 * The base slug of a name, before collisions are resolved.
 *
 * `NFKD` then dropping the combining marks is the whole of the transliteration: `é` becomes `e`
 * because the decomposition separates the letter from its accent, and nothing else is guessed. A
 * transliteration *table* would be a locale guess, and the slug's job is to be a stable ASCII
 * directory name rather than a readable rendering of the name — so every remaining non-alphanumeric
 * run collapses to one hyphen, and a name with nothing left falls back to `vault`, which then
 * collides and is suffixed.
 */
export function baseSlug(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replaceAll(/\p{M}+/gu, '')
    .replaceAll(/[^\da-z]+/giu, '-')
    .toLowerCase()
    .replaceAll(/^-+|-+$/gu, '');
  const trimmed = ascii.slice(0, SLUG_COLUMN_CHARS).replaceAll(/-+$/gu, '');
  return trimmed === '' ? FALLBACK_SLUG : trimmed;
}

/**
 * The first free slug for a name, given the slugs already taken.
 *
 * The suffix is appended after truncating the stem so the result always fits the column: a 64-character
 * stem with a `-12` suffix would otherwise be a silent `ER_DATA_TOO_LONG` on the insert.
 */
export function uniqueSlug(name: string, taken: ReadonlySet<string>): string {
  const base = baseSlug(name);
  if (!taken.has(base)) return base;
  for (let suffix = FIRST_COLLISION_SUFFIX; ; suffix += 1) {
    const tail = `-${String(suffix)}`;
    const stem = base.slice(0, SLUG_COLUMN_CHARS - tail.length).replaceAll(/-+$/gu, '');
    const candidate = `${stem}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The `LIKE` pattern that selects every slug a name could collide with: the base and its suffixed
 * forms. `\` escapes are applied to the stem because a derived slug never contains `%` or `_`, but
 * the pattern is built from it and a future change to `baseSlug` must not turn it into a wildcard.
 */
export function slugCollisionPattern(name: string): string {
  const base = baseSlug(name).replaceAll(/([%_\\])/gu, String.raw`\$1`);
  return `${base}%`;
}
