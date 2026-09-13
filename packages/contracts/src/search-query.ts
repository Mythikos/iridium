/**
 * The parsed shape of a search query (09-api-reference.md section 2.10; skeleton A39).
 *
 * The grammar itself is parsed by `@iridium/markdown/search/parseQuery.ts`, which is where the
 * translation into an InnoDB boolean-mode string lives. This module owns only the *shape* that
 * crosses the wire: the search response echoes the parse so a client can show what it understood,
 * and both sides read that shape from here.
 */

import { z } from 'zod';

import type { EnumOf } from './schema.ts';

/** Operators that filter before the FULLTEXT match. */
export const SEARCH_OPERATORS = ['path', 'file'] as const;

/** An operator that filters before the FULLTEXT match. */
export type SearchOperator = (typeof SEARCH_OPERATORS)[number];

/** An operator that filters before the FULLTEXT match. */
export const SearchOperator: EnumOf<typeof SEARCH_OPERATORS> = z.enum(SEARCH_OPERATORS);

/**
 * Operators that parse and are reserved: a query using one is refused with
 * `422 validation_failed` and `errors[0].code = 'operator_reserved'`, so adding them later is
 * additive rather than a grammar change.
 */
export const RESERVED_SEARCH_OPERATORS = ['tag', 'line'] as const;

/** A reserved operator. */
export type ReservedSearchOperator = (typeof RESERVED_SEARCH_OPERATORS)[number];

/** A reserved operator. */
export const ReservedSearchOperator: EnumOf<typeof RESERVED_SEARCH_OPERATORS> =
  z.enum(RESERVED_SEARCH_OPERATORS);

/** The `errors[].code` a reserved operator is refused with. */
export const OPERATOR_RESERVED_CODE = 'operator_reserved';

/**
 * What a query parsed to, as echoed under `query` in the search response: bare tokens, quoted
 * phrases, `-negations`, and the `path:` / `file:` operators. Negations and operators are
 * excluded from snippet matching, which is why they are separate members rather than one list.
 */
export const ParsedSearchQuery: z.ZodObject<
  {
    raw: z.ZodString;
    terms: z.ZodArray<z.ZodString>;
    phrases: z.ZodArray<z.ZodString>;
    negations: z.ZodArray<z.ZodString>;
    operators: z.ZodRecord<z.ZodString, z.ZodString>;
  },
  z.core.$strict
> = z.strictObject({
  /** The query exactly as the caller sent it. */
  raw: z.string(),
  /** Bare tokens, which become `+tok*` in boolean mode. */
  terms: z.array(z.string()),
  /** `"quoted phrases"`, which stay phrases. */
  phrases: z.array(z.string()),
  /** `-token`, excluded from the match and from snippets. */
  negations: z.array(z.string()),
  /** `path:Projects/`, `file:Roadmap` — applied before the FULLTEXT match. */
  operators: z.record(z.string(), z.string()),
});

/** What a query parsed to. */
export type ParsedSearchQuery = z.infer<typeof ParsedSearchQuery>;
