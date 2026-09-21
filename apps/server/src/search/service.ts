/** Parse the user grammar once, then dispatch through the injected search boundary. */
import type { SearchPage, SearchQuery, VaultId } from '@iridium/contracts';
import { parseQuery } from '@iridium/markdown/search';

import type { CursorCodec } from '../mcp/cursor.ts';
import { ProblemError } from '../security/problem.ts';
import type { SearchIndex } from './index.ts';

/** ContentReadCore supplies a freshly authorized vault set and a principal-bound cursor codec. */
export class SearchService {
  readonly #index: SearchIndex;
  constructor(index: SearchIndex) {
    this.#index = index;
  }
  async search(
    vaultIds: readonly VaultId[],
    query: SearchQuery,
    codec: CursorCodec,
    principalKey: string,
  ): Promise<SearchPage> {
    const parsed = parseQuery(query.q);
    if (!parsed.ok)
      throw new ProblemError('validation_failed', {
        errors: [
          {
            path: 'query.q',
            message: parsed.error.message,
            code:
              parsed.error.code === 'empty_query' ? 'query_empty_after_parse' : parsed.error.code,
          },
        ],
      });
    return this.#index.query(
      parsed.query,
      { vaultIds, pathPrefix: query.pathPrefix },
      {
        cursor: query.cursor,
        limit: query.limit,
        snippetChars: query.snippetChars,
        cursors: codec,
        principalKey,
      },
    );
  }
}
