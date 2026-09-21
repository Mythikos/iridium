/** Committed full-text search request and response (09 section 2.10). */
import { z } from 'zod';

import { NoteId, VaultId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { ParsedSearchQuery } from '../search-query.ts';
import { Timestamp } from '../time.ts';

/** A source-located excerpt; Markdown source lines are one-based. */
export interface SearchSnippet {
  readonly line: number;
  readonly text: string;
  readonly ranges?: readonly { readonly start: number; readonly end: number }[] | undefined;
}
/** A source-located excerpt. */
export const SearchSnippet: z.ZodType<SearchSnippet> = z
  .strictObject({
    line: z.int().positive(),
    text: z.string(),
    ranges: z
      .array(z.strictObject({ start: z.int().nonnegative(), end: z.int().nonnegative() }))
      .optional(),
  })
  .meta({ id: 'SearchSnippet' });
/** Search input on both routes. */
export interface SearchQuery {
  readonly q: string;
  readonly pathPrefix?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly snippetChars: number;
  readonly vaultIds?: readonly string[] | undefined;
}
/** Search input on both routes. */
export const SearchQuery: z.ZodType<SearchQuery> = z
  .strictObject({
    q: z.string().min(1).max(LIMITS.SEARCH_QUERY_MAX_CHARS),
    pathPrefix: z.string().max(LIMITS.NODE_PATH_MAX_CHARS).optional(),
    cursor: z.string().max(4096).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.SEARCH_LIMIT_MAX)
      .default(LIMITS.SEARCH_LIMIT_DEFAULT),
    snippetChars: z.coerce
      .number()
      .int()
      .min(LIMITS.SNIPPET_CHARS_MIN)
      .max(LIMITS.SNIPPET_CHARS_MAX)
      .default(LIMITS.SNIPPET_MAX_CHARS),
    vaultIds: z
      .codec(z.union([VaultId, z.array(VaultId)]), z.array(VaultId), {
        decode: (value) => (typeof value === 'string' ? [value] : value),
        encode: (value) => value.map((id) => VaultId.parse(id)),
      })
      .refine((value) => value.length <= LIMITS.SEARCH_VAULTS_MAX)
      .optional(),
  })
  .meta({ id: 'SearchQuery' });
/** The indexed identity and its current committed-head staleness hint. */
export interface SearchHit {
  readonly noteId: string;
  readonly vaultId: string;
  readonly vaultName: string;
  readonly path: string;
  readonly title: string;
  readonly revision: number;
  readonly score: number;
  readonly updatedAt: string;
  readonly snippets: readonly SearchSnippet[];
  readonly stale: boolean;
}
/** One ranked result. */
export const SearchHit: z.ZodType<SearchHit> = z
  .strictObject({
    noteId: NoteId,
    vaultId: VaultId,
    vaultName: z.string(),
    path: z.string(),
    title: z.string(),
    revision: z.int().nonnegative(),
    score: z.number(),
    updatedAt: Timestamp,
    snippets: z.array(SearchSnippet).max(LIMITS.SNIPPET_MAX_LINES),
    stale: z.boolean(),
  })
  .meta({ id: 'SearchHit' });
/** A keyset page ranked by score descending and note id ascending. */
export interface SearchPage {
  readonly results: readonly SearchHit[];
  readonly nextCursor?: string | undefined;
  readonly query: ParsedSearchQuery;
  readonly totalEstimate?: number | undefined;
}
/** A search page. */
export const SearchPage: z.ZodType<SearchPage> = z
  .strictObject({
    results: z.array(SearchHit),
    nextCursor: z.string().optional(),
    query: ParsedSearchQuery,
    totalEstimate: z.int().nonnegative().optional(),
  })
  .meta({ id: 'SearchPage' });
