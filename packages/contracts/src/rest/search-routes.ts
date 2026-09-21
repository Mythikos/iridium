/** Both REST search mounts delegate to the shared authorized read core. */
import { VaultIdParams } from './params.ts';
import { REST_ROUTE_POLICIES } from './route-policies.ts';
import type { RouteSpec } from './routes.ts';
import { SearchPage, SearchQuery } from './search.ts';
/** Search is available to session and read-token principals. */
export const M2_SEARCH_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'search.vault',
    method: 'GET',
    path: '/vaults/:vaultId/search',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'search',
    auth: REST_ROUTE_POLICIES['search.vault'],
    request: { params: VaultIdParams, query: SearchQuery },
    responses: [{ status: 200, body: { kind: 'json', schema: SearchPage } }],
    errors: ['unauthenticated', 'token_expired', 'not_found', 'validation_failed', 'rate_limited'],
    rateLimit: 'pat',
    summary: 'Search the committed index of one accessible vault.',
  },
  {
    operationId: 'search.all',
    method: 'GET',
    path: '/search',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'search',
    auth: REST_ROUTE_POLICIES['search.all'],
    request: { query: SearchQuery },
    responses: [{ status: 200, body: { kind: 'json', schema: SearchPage } }],
    errors: ['unauthenticated', 'token_expired', 'validation_failed', 'rate_limited'],
    rateLimit: 'pat',
    summary: "Search committed notes across the principal's accessible vaults.",
  },
];
