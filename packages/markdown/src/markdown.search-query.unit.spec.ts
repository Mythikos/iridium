/**
 * The query parser ships in `@iridium/markdown` but belongs to the search area, so the test name is
 * `search.query-parser.unit` while the basename states this package's own subject. That is one of the
 * two exceptions 10-testing-and-quality.md admits to "a test's name is its file basename", and the
 * Inventory-completeness row for the name is what states this path (D10-21).
 */
import { describe, expect, it } from 'vitest';

import { parseQuery, queryTitleTerms, toBooleanQuery } from './search/parse-query.ts';

describe('search.query-parser.unit [area:search]', () => {
  it('parses phrases, escaped quotes, negation and filtering operators once', () => {
    const raw = 'alpha "two words" -beta path:"Projects/Plan" file:Roadmap a';
    const result = parseQuery(raw);
    expect(result).toEqual({
      ok: true,
      query: {
        raw,
        terms: ['alpha', 'a'],
        phrases: ['two words'],
        negations: ['beta'],
        operators: { path: 'Projects/Plan', file: 'Roadmap' },
      },
      booleanQuery: '+alpha* +"two words" -beta*',
      titleTerms: ['a'],
    });
    expect(parseQuery('"a \\"quoted\\" phrase" -"not this"')).toMatchObject({ ok: true });
  });
  it.each([
    ['tag:draft', 'operator_reserved'],
    ['line:2', 'operator_reserved'],
    ['"unclosed', 'unterminated_quote'],
    ['path:', 'missing_operator_value'],
    ['file:a file:b', 'duplicate_operator'],
    ['', 'empty_query'],
    ['+><()~*', 'empty_query'],
  ])('returns a named error for %s', (raw, code) => {
    expect(parseQuery(raw ?? '')).toMatchObject({
      ok: false,
      error: { code, offset: expect.any(Number), message: expect.any(String) },
    });
  });
  it('never passes user boolean operators into InnoDB and keeps single characters out of FULLTEXT', () => {
    const result = parseQuery('+hello* foo) (>bar ~baz -(omit) x');
    expect(result).toMatchObject({
      ok: true,
      booleanQuery: '+hello* +foo* +bar* +baz* -omit*',
      titleTerms: ['x'],
    });
    expect(
      toBooleanQuery({
        raw: '',
        terms: ['x', '🎉', 'valid'],
        phrases: ['"phrase" <bad>'],
        negations: ['two words'],
        operators: {},
      }),
    ).toBe('+valid* +"phrase bad" -"two words"');
    expect(
      queryTitleTerms({
        raw: '',
        terms: ['é', '日', 'ab'],
        phrases: [],
        negations: ['x'],
        operators: {},
      }),
    ).toEqual(['é', '日']);
  });
  it('supports filter-only searches and treats unrecognized operator names as ordinary searchable text', () => {
    expect(parseQuery('path:Projects/')).toMatchObject({
      ok: true,
      booleanQuery: '',
      titleTerms: [],
    });
    expect(parseQuery('unknown:word')).toMatchObject({
      ok: true,
      booleanQuery: '+unknown* +word*',
    });
  });
});
