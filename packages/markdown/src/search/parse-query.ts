/** User grammar, never raw MySQL boolean syntax (A39; 09 §2.10). */
import type { ParsedSearchQuery, SearchQueryErrorCode } from '@iridium/contracts';

/** A named, positioned query error that REST translates to validation_failed. */
export interface SearchQueryError {
  code: SearchQueryErrorCode;
  message: string;
  offset: number;
}

/** A parsed query with its safe SQL-bound operands, or an expected grammar refusal. */
export type SearchQueryResult =
  | { ok: true; query: ParsedSearchQuery; booleanQuery: string; titleTerms: string[] }
  | { ok: false; error: SearchQueryError };

function words(value: string): string[] {
  return value.match(/[\p{L}\p{N}\p{M}_’']+/gu) ?? [];
}

/** Builds a boolean-mode value bound as one SQL parameter, without accepting boolean operators. */
export function toBooleanQuery(query: ParsedSearchQuery): string {
  const positive = query.terms
    .flatMap(words)
    .filter((term) => Array.from(term).length > 1)
    .map((term) => `+${term}*`);
  const phrases = query.phrases
    .map((phrase) => words(phrase).join(' '))
    .filter(Boolean)
    .map((phrase) => `+"${phrase}"`);
  const negatives = query.negations.flatMap((value) => {
    const tokens = words(value);
    if (tokens.length > 1) return [`-"${tokens.join(' ')}"`];
    return tokens.map((term) => `-${term}*`);
  });
  return [...positive, ...phrases, ...negatives].join(' ');
}

/** Single-character positive tokens take the title LIKE union because FULLTEXT omits them. */
export function queryTitleTerms(query: ParsedSearchQuery): string[] {
  return query.terms.flatMap(words).filter((term) => Array.from(term).length === 1);
}

/** Parses phrases, negations and path/file operators in a single bounded scan. */
export function parseQuery(raw: string): SearchQueryResult {
  const query: ParsedSearchQuery = { raw, terms: [], phrases: [], negations: [], operators: {} };
  let cursor = 0;
  while (cursor < raw.length) {
    if (/\s/u.test(raw[cursor] ?? '')) {
      cursor += 1;
      continue;
    }
    const offset = cursor;
    const negative = raw[cursor] === '-';
    if (negative) cursor += 1;
    const operatorMatch = /^([a-z]+):/i.exec(raw.slice(cursor));
    const operatorName = operatorMatch?.[1]?.toLowerCase();
    const operator =
      !negative &&
      operatorName !== undefined &&
      ['path', 'file', 'tag', 'line'].includes(operatorName)
        ? operatorName
        : undefined;
    if (operator === 'tag' || operator === 'line') {
      return {
        ok: false,
        error: {
          code: 'operator_reserved',
          message: `${operator}: is reserved and is not supported yet.`,
          offset,
        },
      };
    }
    if (operator !== undefined) cursor += operator.length + 1;
    const quoted = raw[cursor] === '"';
    let value = '';
    if (quoted) {
      cursor += 1;
      let closed = false;
      while (cursor < raw.length) {
        const char = raw[cursor] ?? '';
        if (char === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        if (char === '\\' && ['"', '\\'].includes(raw[cursor + 1] ?? '')) cursor += 1;
        value += raw[cursor] ?? '';
        cursor += 1;
      }
      if (!closed)
        return {
          ok: false,
          error: { code: 'unterminated_quote', message: 'Close the quoted phrase.', offset },
        };
    } else {
      const start = cursor;
      while (cursor < raw.length && !/\s/u.test(raw[cursor] ?? '')) cursor += 1;
      value = raw.slice(start, cursor);
    }
    if (operator !== undefined) {
      if (value.trim() === '')
        return {
          ok: false,
          error: {
            code: 'missing_operator_value',
            message: `Provide a value for ${operator}:`,
            offset,
          },
        };
      if (query.operators[operator] !== undefined)
        return {
          ok: false,
          error: { code: 'duplicate_operator', message: `Use ${operator}: only once.`, offset },
        };
      query.operators[operator] = value;
    } else if (value !== '') {
      if (negative) query.negations.push(value);
      else if (quoted) query.phrases.push(value);
      else query.terms.push(value);
    }
  }
  const booleanQuery = toBooleanQuery(query);
  const titleTerms = queryTitleTerms(query);
  if (booleanQuery === '' && titleTerms.length === 0 && Object.keys(query.operators).length === 0) {
    return {
      ok: false,
      error: {
        code: 'empty_query',
        message: 'Enter a search term or a path/file filter.',
        offset: 0,
      },
    };
  }
  return { ok: true, query, booleanQuery, titleTerms };
}
