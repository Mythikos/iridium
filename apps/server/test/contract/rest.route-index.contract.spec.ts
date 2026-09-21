/**
 * `rest.route-index.contract` — the route index of 09-api-reference.md §2.18 is the same table as the
 * committed document and the boot-time route policy (10-testing-and-quality.md, "Inventory
 * completeness — Ops, restore, release and the seam contract suites").
 *
 * Three artefacts claim to describe one route set: a markdown table a human maintains, an
 * `openapi.json` a script generates, and the `config.auth` a running server enforces. Any two of them
 * can agree while the third drifts, so this file parses the table out of the plan and compares all
 * three — the operation ids, the policy legend, the `If-Match` column and the `★` PAT column.
 *
 * **The comparison is scoped by milestone, in the honest direction.** §2.18 lists the whole 1.0
 * surface; `API_ROUTES` lists what this milestone registers. So every M1 row must appear in the table
 * and agree with it, and every *documented* operation must be a table row — but a table row this
 * milestone does not register is not a failure, it is M2 through M8.
 *
 * §2.18 has **two** tables: the `/api/v1` operations, seven columns wide, and the operations whose
 * URLs are published outside it (`/healthz`, `/collab`, `/mcp`, the `/.well-known/*` documents),
 * which are five columns and say nothing about `★` or `If-Match`. Both are parsed, because the plan
 * says in so many words that this test asserts the second one too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  API_ROUTES,
  routePrincipalKinds,
  type RouteAuth,
  type RouteSpec,
} from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

const PLAN_PATH = fileURLToPath(
  new URL('../../../../docs/plan/09-api-reference.md', import.meta.url),
);

const DOCUMENT_PATH = fileURLToPath(
  new URL('../../../../packages/contracts/openapi/openapi.json', import.meta.url),
);

/**
 * One row of either table.
 *
 * `pat` and `ifMatch` are `undefined` for a row of the narrow table rather than defaulted, because
 * "this table does not say" and "this table says no" are different claims and only the first is true.
 */
interface IndexRow {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
  readonly auth: string;
  readonly pat: boolean | undefined;
  readonly ifMatch: string | undefined;
}

/** The em dash the wide table uses for "not applicable". */
const NOT_APPLICABLE = '\u2014';

/** The number of columns that makes a table the `/api/v1` one. */
const WIDE_TABLE_COLUMNS = 7;

/** The placeholder an escaped pipe wears while a row is split on its unescaped ones. */
const ESCAPED_PIPE = '\u0001';

/** A table cell, with the backticks removed and any escaped pipe restored. */
function cell(raw: string): string {
  return raw.trim().replaceAll('`', '').replaceAll(ESCAPED_PIPE, '|').trim();
}

/**
 * Every row of §2.18's two tables.
 *
 * A table is recognised by its header rather than by a line range: a section that moved would
 * otherwise parse to zero rows and every comparison below would pass by finding nothing, which is
 * what the first case guards against.
 */
function parseIndex(markdown: string): readonly IndexRow[] {
  const rows: IndexRow[] = [];
  let columns = 0;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.replaceAll('\\|', ESCAPED_PIPE);
    if (line.startsWith('| Method | Path | operationId |')) {
      columns = line.split('|').slice(1, -1).length;
      continue;
    }
    if (columns === 0) continue;
    if (!line.startsWith('|')) {
      columns = 0;
      continue;
    }
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== columns) continue;
    const method = cell(cells[0] ?? '');
    if (method === '' || method.startsWith('-')) continue;
    const wide = columns >= WIDE_TABLE_COLUMNS;
    rows.push({
      method,
      path: cell(cells[1] ?? ''),
      operationId: cell(cells[2] ?? ''),
      auth: cell(cells[3] ?? ''),
      pat: wide ? cell(cells[4] ?? '') === '\u2605' : undefined,
      ifMatch: wide ? cell(cells[5] ?? '') : undefined,
    });
  }
  return rows;
}

const INDEX = parseIndex(readFileSync(PLAN_PATH, 'utf8'));
const document: unknown = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8'));
const BY_OPERATION = new Map(INDEX.map((row) => [row.operationId, row]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every `operationId` the committed document names. */
function documentedOperationIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  const paths = isRecord(document) ? document['paths'] : undefined;
  if (!isRecord(paths)) return ids;
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue;
    for (const operation of Object.values(item)) {
      const id = isRecord(operation) ? operation['operationId'] : undefined;
      if (typeof id === 'string') ids.add(id);
    }
  }
  return ids;
}

/** The legend spelling of §1.3 that a `RouteAuth` corresponds to. */
function legendFor(auth: RouteAuth): string {
  if (auth === 'test-only') return 'test-only';
  if ('public' in auth) return 'public';
  if ('self' in auth) return 'self';
  if ('serverAdmin' in auth) return 'admin';
  if ('session' in auth) {
    return routePrincipalKinds(auth).includes('token') ? 'session/PAT' : 'session';
  }
  return `perm:${auth.permission}`;
}

/** Whether the table's `Auth` cell means the same as a row's policy. */
function authAgrees(cellValue: string, auth: RouteAuth): boolean {
  // `admin | dev` is §2.17's relaxation of an `admin` route under `NODE_ENV=development`.
  return cellValue.replaceAll('| dev', '').trim() === legendFor(auth);
}

/** The `If-Match` cell a row's `ifMatch` member corresponds to. */
function ifMatchFor(row: RouteSpec): string {
  return row.ifMatch ?? NOT_APPLICABLE;
}

/**
 * The one row whose `Auth` cell is not a legend value.
 *
 * `/metrics` states its own credential (`METRICS_TOKEN or internal CIDR`) because the token is
 * checked inside the handler: it is not a principal the route policy knows, and the route declares
 * `public` so that the boot assertion sees a policy at all (D09-11).
 */
const HANDLER_CHECKED_CREDENTIAL: ReadonlySet<string> = new Set(['ops.metrics']);

function problemList(problems: readonly string[]): string {
  return problems.filter((problem) => problem !== '').join('\n');
}

describe('rest.route-index.contract [area:contracts]', () => {
  it('parses both route-index tables out of the plan', () => {
    // A parse that found nothing would make every comparison below pass vacuously.
    expect(INDEX.length).toBeGreaterThan(80);
    expect(BY_OPERATION.get('vaults.create')?.path).toBe('/vaults');
    expect(BY_OPERATION.get('ops.healthz')?.path).toBe('/healthz');
    expect(BY_OPERATION.get('ops.healthz')?.pat).toBeUndefined();
  });

  it('lists every M1 route, at the same method and path', () => {
    const problems = API_ROUTES.flatMap((row) => {
      const indexed = BY_OPERATION.get(row.operationId);
      if (indexed === undefined) return [`${row.operationId} is in no §2.18 table row`];
      if (indexed.method !== row.method) {
        return [`${row.operationId} is ${indexed.method} in §2.18 and ${row.method} in API_ROUTES`];
      }
      return indexed.path === row.path
        ? []
        : [`${row.operationId} is ${indexed.path} in §2.18 and ${row.path} in API_ROUTES`];
    });
    expect(problemList(problems)).toBe('');
  });

  it('agrees with the plan about the policy of every M1 route', () => {
    const problems = API_ROUTES.flatMap((row) => {
      const indexed = BY_OPERATION.get(row.operationId);
      if (indexed === undefined || HANDLER_CHECKED_CREDENTIAL.has(row.operationId)) return [];
      return authAgrees(indexed.auth, row.auth)
        ? []
        : [
            `${row.operationId}: §2.18 says "${indexed.auth}", the route declares ` +
              `"${legendFor(row.auth)}"`,
          ];
    });
    expect(problemList(problems)).toBe('');
  });

  it('agrees with the plan about which M1 routes accept an integration token', () => {
    const problems = API_ROUTES.flatMap((row) => {
      const indexed = BY_OPERATION.get(row.operationId);
      if (indexed?.pat === undefined) return [];
      const accepts = routePrincipalKinds(row.auth).includes('token');
      return accepts === indexed.pat
        ? []
        : [
            `${row.operationId}: §2.18 marks it ${indexed.pat ? 'PAT-enabled' : 'not PAT-enabled'} ` +
              `and the route ${accepts ? 'accepts' : 'refuses'} a token principal`,
          ];
    });
    expect(problemList(problems)).toBe('');
  });

  it('agrees with the plan about every M1 route that requires a validator', () => {
    const problems = API_ROUTES.flatMap((row) => {
      const indexed = BY_OPERATION.get(row.operationId);
      if (indexed?.ifMatch === undefined) return [];
      return indexed.ifMatch === ifMatchFor(row)
        ? []
        : [
            `${row.operationId}: §2.18 says If-Match "${indexed.ifMatch}", the row says ` +
              `"${ifMatchFor(row)}"`,
          ];
    });
    expect(problemList(problems)).toBe('');
  });

  it('documents nothing the plan does not list', () => {
    const undocumented = [...documentedOperationIds()].filter((id) => !BY_OPERATION.has(id));
    expect(undocumented).toStrictEqual([]);
  });

  it('documents every `rest` row this milestone registers', () => {
    const documented = documentedOperationIds();
    const missing = API_ROUTES.filter(
      (row) => row.plugin === 'rest' && !documented.has(row.operationId),
    ).map((row) => row.operationId);
    expect(missing).toStrictEqual([]);
  });

  it('carries every M1 operation in one of its two tables', () => {
    const missing = API_ROUTES.filter((row) => !BY_OPERATION.has(row.operationId)).map(
      (row) => row.operationId,
    );
    expect(missing).toStrictEqual([]);
  });
});
