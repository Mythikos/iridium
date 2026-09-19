/**
 * `GET /admin/users` (09-api-reference.md §2.15.1): the cursor listing the admin console pages.
 *
 * The keyset is `(emailKey, id)` — §1.6's `users` keyset — so the page boundary is a row's own
 * values and never an offset: an account created while an administrator pages does not shift the
 * rows behind it into a second appearance or out of sight. `email_key` is the stored generated
 * column, which is what makes the order stable under any collation choice for `email` itself.
 *
 * The filter object the cursor is bound to is the **whole** query minus the cursor and the limit:
 * changing `q` or `status` mid-listing produces a different sequence, and resuming the old cursor
 * against it would silently skip rows. `mcp/cursor.ts` hashes it and refuses the mismatch.
 */
import type { AdminUserPage, AdminUserSummary, UserStatus } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import { userIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/index.ts';
import type { CursorCodec, CursorKeyPart } from '../mcp/cursor.ts';
import { fetchOnePage } from '../rest/pagination.ts';

/** The filters a listing is bound to; the cursor carries their hash. */
export interface AdminUserFilter {
  readonly q: string | null;
  readonly status: readonly UserStatus[] | null;
  readonly isServerAdmin: boolean | null;
}

/** What the listing takes. */
export interface AdminUserQuery extends AdminUserFilter {
  readonly cursor: string | null;
  readonly limit: number;
  /** `request.principalKey`; a cursor is bound to the principal that minted it. */
  readonly principalKey: string;
}

/** One listed row, before it becomes a DTO. */
interface AdminUserRow {
  readonly id: Buffer;
  readonly email: string;
  readonly email_key: string;
  readonly display_name: string;
  readonly is_server_admin: boolean;
  readonly status: UserStatus;
  readonly color_hue: number;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_login_at: Date | null;
  /**
   * `COUNT(*)` comes back as a driver-dependent numeric, and a correlated subquery is typed
   * nullable; every read goes through `Number(… ?? 0)`.
   */
  readonly has_credentials: string | number | bigint | null;
  readonly vault_count: string | number | bigint | null;
  readonly session_count: string | number | bigint | null;
  readonly token_count: string | number | bigint | null;
}

/** The after-key a cursor carries for this keyset: `(email_key, id)`. */
function afterKeyOf(row: AdminUserRow): readonly CursorKeyPart[] {
  return [row.email_key, row.id.toString('hex')];
}

function toSummary(row: AdminUserRow): AdminUserSummary {
  return {
    id: userIdFromBytes(row.id),
    email: row.email,
    displayName: row.display_name,
    isServerAdmin: row.is_server_admin,
    status: row.status,
    colorHue: row.color_hue,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastLoginAt: row.last_login_at === null ? null : row.last_login_at.toISOString(),
    hasCredentials: Number(row.has_credentials ?? 0) > 0,
    version: row.version,
    vaultCount: Number(row.vault_count ?? 0),
    sessionCount: Number(row.session_count ?? 0),
    tokenCount: Number(row.token_count ?? 0),
  };
}

/**
 * The filter object the cursor is hashed over. Spelled out rather than passed through so that adding
 * a filter to the query without adding it here is a compile error rather than a cursor that survives
 * a filter change it should have refused.
 */
function filterOf(query: AdminUserQuery): AdminUserFilter {
  return { q: query.q, status: query.status, isServerAdmin: query.isServerAdmin };
}

/**
 * One page of `GET /admin/users`.
 *
 * The three counts are correlated subqueries rather than joins: a join to `sessions` and
 * `access_tokens` would multiply the rows before the page boundary is applied, and `GROUP BY` over
 * three one-to-many relations is the classic way to page 50 users into 4 000 rows.
 */
export async function listAdminUsers(
  db: Kysely<Database>,
  codec: CursorCodec,
  query: AdminUserQuery,
): Promise<AdminUserPage> {
  const filter = filterOf(query);
  const after =
    query.cursor === null
      ? null
      : codec.parse(query.cursor, {
          kind: 'users',
          filter: { ...filter, status: filter.status === null ? null : [...filter.status] },
          principalKey: query.principalKey,
        }).a;

  const page = await fetchOnePage(query.limit, async (rows) => {
    let statement = db
      .selectFrom('users')
      .select([
        'users.id',
        'users.email',
        'users.email_key',
        'users.display_name',
        'users.is_server_admin',
        'users.status',
        'users.color_hue',
        'users.version',
        'users.created_at',
        'users.updated_at',
        'users.last_login_at',
      ])
      .select((eb) => [
        eb
          .selectFrom('user_credentials')
          .whereRef('user_credentials.user_id', '=', 'users.id')
          .select((inner) => inner.fn.countAll().as('count'))
          .as('has_credentials'),
        eb
          .selectFrom('vault_members')
          .whereRef('vault_members.user_id', '=', 'users.id')
          .select((inner) => inner.fn.countAll().as('count'))
          .as('vault_count'),
        eb
          .selectFrom('sessions')
          .whereRef('sessions.user_id', '=', 'users.id')
          .where('sessions.revoked_at', 'is', null)
          .select((inner) => inner.fn.countAll().as('count'))
          .as('session_count'),
        eb
          .selectFrom('access_tokens')
          .whereRef('access_tokens.user_id', '=', 'users.id')
          .where('access_tokens.revoked_at', 'is', null)
          .select((inner) => inner.fn.countAll().as('count'))
          .as('token_count'),
      ])
      .orderBy('users.email_key', 'asc')
      .orderBy('users.id', 'asc')
      .limit(rows);

    if (filter.q !== null && filter.q !== '') {
      const prefix = `${filter.q.toLowerCase().replaceAll(/([%_\\])/gu, String.raw`\$1`)}%`;
      statement = statement.where((eb) =>
        eb.or([eb('users.email_key', 'like', prefix), eb('users.display_name', 'like', prefix)]),
      );
    }
    if (filter.status !== null && filter.status.length > 0) {
      statement = statement.where('users.status', 'in', [...filter.status]);
    }
    if (filter.isServerAdmin !== null) {
      statement = statement.where('users.is_server_admin', '=', filter.isServerAdmin);
    }
    if (after !== null) {
      const [emailKey, idHex] = after;
      // The keyset predicate, written as the two-branch form rather than a row comparison: MySQL's
      // optimiser uses `ix_users_email_key` for the first branch and the primary key for the tie.
      statement = statement.where((eb) =>
        eb.or([
          eb('users.email_key', '>', String(emailKey)),
          eb.and([
            eb('users.email_key', '=', String(emailKey)),
            eb('users.id', '>', Buffer.from(String(idHex), 'hex')),
          ]),
        ]),
      );
    }
    return statement.execute();
  });

  const items = page.items.map((row: AdminUserRow) => toSummary(row));
  const last = page.items.at(-1);
  return {
    items,
    ...(page.hasMore && last !== undefined
      ? {
          nextCursor: codec.issue({
            kind: 'users',
            after: afterKeyOf(last),
            filter: { ...filter, status: filter.status === null ? null : [...filter.status] },
            principalKey: query.principalKey,
          }),
        }
      : {}),
  };
}
