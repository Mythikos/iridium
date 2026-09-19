/**
 * `auth.routes.manifest.unit` (09-api-reference.md section 2.18; 12-milestones.md section 5.2): the
 * operation ids `applyAuthRoutes` registers are exactly the ten M1 auth/me operations of the shared
 * manifest, each has a row, and `routeSpec` resolves it — so a route can never be registered with a
 * path or policy the document does not describe, and a drift between the module and the manifest is a
 * boot-time failure rather than a silent divergence.
 */
import { M1_ROUTES, routeByOperationId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { RouteSpecMissingError } from '../rest/handler-context.ts';
import { AUTH_OPERATION_IDS, routeSpec } from './routes.ts';

/** The M1 operations this stream owns, as the manifest tags them (auth/me, minus the meta/docs ops). */
const OWNED_PREFIXES = ['auth.', 'me.'];
const NON_AUTH_META = new Set(['meta.get', 'meta.openapi', 'meta.docs']);

describe('auth.routes.manifest.unit [area:auth]', () => {
  it('registers exactly the ten M1 auth/me operations, and no meta/docs operation', () => {
    expect(AUTH_OPERATION_IDS).toHaveLength(10);
    expect(new Set(AUTH_OPERATION_IDS).size).toBe(10);
    for (const id of AUTH_OPERATION_IDS) {
      expect(OWNED_PREFIXES.some((prefix) => id.startsWith(prefix))).toBe(true);
      expect(NON_AUTH_META.has(id)).toBe(false);
    }
  });

  it('is the whole of the manifest auth/me operations, so none is forgotten', () => {
    const manifestOwned = M1_ROUTES.filter(
      (route) =>
        OWNED_PREFIXES.some((prefix) => route.operationId.startsWith(prefix)) &&
        !NON_AUTH_META.has(route.operationId),
    ).map((route) => route.operationId);
    expect([...AUTH_OPERATION_IDS].toSorted()).toStrictEqual(manifestOwned.toSorted());
  });

  it('resolves every registered operation to its manifest row', () => {
    for (const id of AUTH_OPERATION_IDS) {
      const spec = routeSpec(id);
      expect(spec).toBe(routeByOperationId(id));
      expect(spec.operationId).toBe(id);
      expect(typeof spec.path).toBe('string');
      expect(spec.auth).toBeDefined();
    }
  });

  it('throws a typed boot error for an operation the manifest does not carry', () => {
    // The cast reaches the boot-error branch a manifest drift would hit; the function never trusts its input.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately an id the manifest lacks
    const unknown = 'auth.doesNotExist' as (typeof AUTH_OPERATION_IDS)[number];
    expect(() => routeSpec(unknown)).toThrow(RouteSpecMissingError);
  });
});
