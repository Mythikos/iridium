/** Typed REST search driver shared by acceptance and contract suites. */
import type { SearchPage } from '@iridium/contracts';

import type { RestClient, RestResponse } from './rest-client.ts';

/** Only query input is encoded here; ranking and authorization stay in the product. */
export interface SearchClient {
  query(
    q: string,
    options?: {
      readonly vaultId?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
      readonly pathPrefix?: string | undefined;
      readonly snippetChars?: number | undefined;
    },
  ): Promise<RestResponse<SearchPage>>;
}

/** Bind to a real authenticated transport, including its cookie jar or token. */
export function searchClient(client: RestClient): SearchClient {
  return {
    query(q, options = {}) {
      const params = new URLSearchParams({ q });
      if (options.cursor !== undefined) params.set('cursor', options.cursor);
      if (options.limit !== undefined) params.set('limit', String(options.limit));
      if (options.pathPrefix !== undefined) params.set('pathPrefix', options.pathPrefix);
      if (options.snippetChars !== undefined)
        params.set('snippetChars', String(options.snippetChars));
      return client.get<SearchPage>(
        `${options.vaultId === undefined ? '' : `/vaults/${options.vaultId}`}/search?${params.toString()}`,
      );
    },
  };
}
