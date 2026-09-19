/**
 * The two page shapes `/api/v1` serves (09-api-reference.md §1.6).
 *
 * A listing is either **bounded** — `{ items }` with no cursor, capped at a number small enough that
 * the whole list is one response (`/me/sessions`, `/vaults`, `/vaults/:vaultId/members`) — or
 * **cursored**, `{ items, nextCursor? }` over an opaque keyset token from `mcp/cursor.ts`. There is
 * no third shape, and `nextCursor` is absent at the end of a list rather than `null` or `''`.
 *
 * `fetchOnePage` is the one place the "read `limit + 1` rows, return `limit`, the extra row is the
 * proof there is a next page" trick lives. Doing it per route is how one listing ends up returning a
 * `nextCursor` on its last page and another dropping a row at the boundary.
 */

/**
 * The cap on a bounded list: the plan's "capped at 1 000 rows".
 *
 * It is a numeric limit and belongs in `@iridium/contracts/limits.ts`, where the response schemas'
 * own `.max(1000)` could then read it too; it is declared here until that package carries the member,
 * and the M1 report asks for it.
 */
export const BOUNDED_LIST_ROWS = 1_000;

/** One page of a cursored listing, before the cursor is minted. */
export interface PageWindow<T> {
  /** At most `limit` rows, in keyset order. */
  readonly items: readonly T[];
  /** Whether a further page exists — the extra row that was read and dropped. */
  readonly hasMore: boolean;
}

/**
 * Runs a keyset query for `limit + 1` rows and splits the answer.
 *
 * @param limit the caller's validated page size; the query is asked for one row more.
 * @param read the query, which must apply the caller's after-key and its own deterministic order.
 */
export async function fetchOnePage<T>(
  limit: number,
  read: (rows: number) => Promise<readonly T[]>,
): Promise<PageWindow<T>> {
  const rows = await read(limit + 1);
  return rows.length > limit
    ? { items: rows.slice(0, limit), hasMore: true }
    : { items: rows, hasMore: false };
}
