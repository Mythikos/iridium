/** Password-flow units retain real auth services and Kysely; only SQL and audit I/O are scripted. */
import { LIMITS, mintToken, newId, SessionId, UserId, type MintedToken } from '@iridium/contracts';
import { onTestFinished } from 'vitest';

import { DetachedAuditSink, FailureAuditGate, type AuditEventInput } from '../../src/auth/audit.ts';
import { PasswordHasher } from '../../src/auth/credentials/hasher.ts';
import { PepperVersionSource } from '../../src/auth/credentials/pepper-version.ts';
import { PasswordPolicy } from '../../src/auth/credentials/policy.ts';
import { createMemoryLimiters, LoginThrottle } from '../../src/auth/credentials/throttle.ts';
import { idBytes } from '../../src/auth/ids.ts';
import type { LoginInput, PasswordFlowDeps, SessionActor } from '../../src/auth/login.ts';
import { secretHash } from '../../src/auth/secret-hash.ts';
import { issueSession, type IssuedSession } from '../../src/auth/sessions/issuer.ts';
import { KyselySessionRepository } from '../../src/auth/sessions/repository.ts';
import { SetPasswordLinks, type IssuedLink } from '../../src/auth/setpw/service.ts';
import type { AuthzEvent } from '../../src/authz/bus.ts';
import { AuthzMutations } from '../../src/authz/mutations.ts';
import { SessionCommandFence } from '../../src/authz/session-command-fence.ts';
import { createLogger } from '../../src/ops/logging.ts';
import type { ExecutedQuery, ScriptedAnswer } from './fake-driver.ts';
import { ManualClock } from './manual-clock.ts';
import { ownedFakeDatabase } from './owned-fake-database.ts';

export const FLOW_USER = UserId.parse('019948c4-0000-7000-8000-000000000101');
export const FLOW_SESSION = SessionId.parse('019948c4-0000-7000-8000-000000000102');
export const FLOW_PASSWORD = 'violet orbit reliable lantern';
export const FLOW_NEW_PASSWORD = 'marble sunset another passphrase';
export const FLOW_NOW = Date.parse('2026-09-17T18:00:00.000Z');
export const FLOW_PEPPER = new Uint8Array(32).fill(7);
export const FLOW_ACTOR: SessionActor = {
  userId: FLOW_USER,
  sessionId: FLOW_SESSION,
  ip: '198.51.100.12',
  context: { request_id: 'flow-request', client: 'desktop' },
};
export const FLOW_LOGIN: LoginInput = {
  email: 'Person@Example.Test',
  password: FLOW_PASSWORD,
  client: 'desktop',
  deviceName: 'workstation',
  ip: FLOW_ACTOR.ip,
  userAgent: 'auth-flow-unit',
  clientVersion: '1.2.3',
  context: FLOW_ACTOR.context,
};

type Row = Record<string, unknown>;
type Tables = Record<
  | 'users'
  | 'user_credentials'
  | 'sessions'
  | 'password_setup_tokens'
  | 'access_tokens'
  | 'access_token_vaults',
  Row[]
>;

function equal(left: unknown, right: unknown): boolean {
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function scalar(value: unknown): string | number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return value;
  throw new Error('The scripted SQL comparison requires a date, string or number.');
}

/** Evaluate only the scalar predicates these adapters emit; unsupported SQL fails the fixture. */
function selected(row: Row, query: ExecutedQuery, parameterOffset = 0): boolean {
  const where = query.sql
    .split(' where ')[1]
    ?.split(/ order by | limit | for update| for share/)[0];
  if (where === undefined) return true;
  let parameter = parameterOffset;
  return where.split(' and ').every((clause) => {
    const match = /^(?:`\w+`\.)?`(\w+)` (is not|is|=|!=|>|<|in) (null|\?|\([^)]*\))$/.exec(clause);
    if (match === null) throw new Error(`Unsupported scripted SQL predicate: ${clause}`);
    const column = match[1];
    const operator = match[2];
    const value = match[3];
    if (column === undefined || operator === undefined || value === undefined)
      throw new Error('Invalid predicate parse.');
    const actual = row[column];
    if (operator === 'is') return actual === null;
    if (operator === 'is not') return actual !== null;
    if (operator === 'in') {
      const expected = query.parameters.slice(
        parameter,
        parameter + (value.match(/\?/g)?.length ?? 0),
      );
      parameter += expected.length;
      return expected.some((candidate) => equal(actual, candidate));
    }
    const expected = query.parameters[parameter++];
    if (operator === '=') return equal(actual, expected);
    if (operator === '!=') return !equal(actual, expected);
    return operator === '>' ? scalar(actual) > scalar(expected) : scalar(actual) < scalar(expected);
  });
}

function insertRow(query: ExecutedQuery): Row {
  const columns = /^insert into `\w+` \(([^)]+)\) values/.exec(query.sql)?.[1];
  if (columns === undefined) throw new Error(`Unsupported scripted insert: ${query.sql}`);
  return Object.fromEntries(
    columns
      .split(', ')
      .map((column, index) => [column.replaceAll('`', ''), query.parameters[index]]),
  );
}

function updateRows(rows: readonly Row[], query: ExecutedQuery): bigint {
  const sets = query.sql.split(' set ')[1]?.split(' where ')[0]?.split(', ');
  if (sets === undefined) throw new Error(`Unsupported scripted update: ${query.sql}`);
  const boundValues = sets.filter((set) => set.endsWith(' = ?')).length;
  let changed = 0n;
  for (const row of rows.filter((candidate) => selected(candidate, query, boundValues))) {
    let parameter = 0;
    for (const set of sets) {
      const match = /^`(\w+)` = (.+)$/.exec(set);
      const column = match?.[1];
      const expression = match?.[2];
      if (column === undefined || expression === undefined)
        throw new Error(`Unsupported scripted assignment: ${set}`);
      if (expression === '?') row[column] = query.parameters[parameter++];
      else if (expression === `${column} + 1`) row[column] = Number(row[column]) + 1;
      else throw new Error(`Unsupported scripted assignment: ${set}`);
    }
    changed += 1n;
  }
  return changed;
}

function copy(rows: readonly Row[]) {
  return rows.map((row) => ({ ...row }));
}

function cloneTables(tables: Tables): Tables {
  return {
    users: copy(tables.users),
    user_credentials: copy(tables.user_credentials),
    sessions: copy(tables.sessions),
    password_setup_tokens: copy(tables.password_setup_tokens),
    access_tokens: copy(tables.access_tokens),
    access_token_vaults: copy(tables.access_token_vaults),
  };
}

/** Configurable failure budgets and clock seed for the auth I/O fixture. @internal */
export interface AuthFlowFixtureOptions {
  readonly maxFailures?: number;
  readonly sourcePerDay?: number;
  readonly now?: number;
}

/** Mutable SQL fixture controls; tests change these to exercise committed and rolled-back work. */
interface AuthFlowState {
  promotedPepper: number;
  auditFailure: boolean;
  profileConflict: boolean;
  rehashConflict: boolean;
  retireLinkAtLock: boolean;
  retireSessionsAtLock: boolean;
  tables: Tables;
}

/** Real auth services and their observable SQL/audit I/O fixture (04 sections 3 and 4). @internal */
export interface AuthFlowFixture {
  readonly deps: PasswordFlowDeps;
  readonly fake: Awaited<ReturnType<typeof ownedFakeDatabase>>;
  readonly state: AuthFlowState;
  readonly fence: SessionCommandFence;
  readonly trace: string[];
  readonly audits: AuditEventInput[];
  readonly events: AuthzEvent[];
  readonly metrics: string[];
  readonly logs: Record<string, unknown>[];
  readonly clock: ManualClock;
  readonly seedSession: (
    kind?: 'web' | 'desktop',
    sessionId?: SessionId,
    deviceName?: string | null,
  ) => Promise<IssuedSession>;
  readonly seedLink: () => Promise<{ readonly issued: IssuedLink; readonly token: string }>;
  readonly seedToken: (allVaults?: boolean) => MintedToken;
  readonly resetObservations: () => void;
}

/**
 * Retains the real password, session and mutation services behind scripted SQL/audit I/O so unit
 * assertions exercise the transaction and revocation contract (04 sections 3.7 and 4.7).
 * Registers resource cleanup with the owning test's completion hook.
 * @internal
 */
export async function authFlowFixture(
  options: AuthFlowFixtureOptions = {},
): Promise<AuthFlowFixture> {
  const clock = new ManualClock(options.now ?? FLOW_NOW);
  const trace: string[] = [];
  const audits: AuditEventInput[] = [];
  const events: AuthzEvent[] = [];
  const metrics: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const state = {
    promotedPepper: 1,
    auditFailure: false,
    profileConflict: false,
    rehashConflict: false,
    retireLinkAtLock: false,
    retireSessionsAtLock: false,
    tables: {
      users: [
        {
          id: idBytes(FLOW_USER),
          email: 'person@example.test',
          email_key: 'person@example.test',
          display_name: 'Person',
          is_server_admin: false,
          status: 'active',
          color_hue: 20,
          authz_version: 1,
          version: 1,
          created_at: clock.date(),
          updated_at: clock.date(),
          last_login_at: null,
        },
      ],
      user_credentials: [],
      sessions: [],
      password_setup_tokens: [],
      access_tokens: [],
      access_token_vaults: [],
    } as Tables,
  };
  const peppers = new Map([
    [1, FLOW_PEPPER],
    [2, new Uint8Array(32).fill(8)],
  ]);
  // The initial credential is seeded before the transport exists. All tested operations use the
  // real DB-backed version source installed below, including its unavailable-key validation.
  let readPepperVersion = async () => state.promotedPepper;
  const hasher = new PasswordHasher({
    memoryKib: 8192,
    timeCost: 1,
    concurrency: 1,
    peppers,
    currentPepperVersion: () => readPepperVersion(),
    fillRandom: (bytes) => bytes.fill(7),
  });
  const hashed = await hasher.hash(FLOW_PASSWORD);
  await hasher.prime();
  state.tables.user_credentials.push({
    user_id: idBytes(FLOW_USER),
    password_hash: hashed.phc,
    pepper_version: hashed.pepperVersion,
    password_changed_at: clock.date(),
  });
  let snapshot: Tables | undefined = undefined;
  const fake = await ownedFakeDatabase({
    transaction: (phase) => {
      trace.push(`tx:${phase}`);
      if (phase === 'begin') snapshot = cloneTables(state.tables);
      if (phase === 'rollback' && snapshot !== undefined) state.tables = snapshot;
    },
    script: (query): ScriptedAnswer => {
      trace.push(query.sql);
      if (query.sql.includes('from `schema_meta`'))
        return { rows: [{ value: String(state.promotedPepper) }] };
      if (query.sql.includes('left join `user_credentials`')) {
        const rows = state.tables.users
          .filter((row) => selected(row, query))
          .map((row) => {
            const credential = state.tables.user_credentials.find((entry) =>
              equal(entry['user_id'], row['id']),
            );
            return Object.assign({}, row, {
              password_hash: credential?.['password_hash'] ?? null,
              pepper_version: credential?.['pepper_version'] ?? null,
            });
          });
        return { rows };
      }
      const table =
        /(?:from|into|update) `(users|user_credentials|sessions|password_setup_tokens|access_tokens|access_token_vaults)`/.exec(
          query.sql,
        )?.[1];
      if (table === undefined) throw new Error(`Unexpected auth SQL: ${query.sql}`);
      // The regexp is the closed storage-table vocabulary above, not a claim about query results.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- closed regexp capture
      const tableName = table as keyof Tables;
      const rows = state.tables[tableName];
      if (query.sql.startsWith('select')) {
        if (
          tableName === 'users' &&
          query.sql.endsWith('for update') &&
          state.retireSessionsAtLock
        ) {
          for (const session of state.tables.sessions) {
            session['revoked_at'] = clock.date();
            session['revoked_reason'] = 'admin';
          }
        }
        if (
          tableName === 'password_setup_tokens' &&
          query.sql.endsWith('for update') &&
          state.retireLinkAtLock
        ) {
          rows.length = 0;
        }
        const matched = rows.filter((row) => selected(row, query));
        if (tableName === 'sessions' && query.sql.includes('inner join `users`')) {
          return {
            rows: matched.map((row) => {
              const user = state.tables.users.find((entry) => equal(entry['id'], row['user_id']));
              return {
                ...row,
                status: user?.['status'],
                is_server_admin: user?.['is_server_admin'],
                authz_version: user?.['authz_version'],
              };
            }),
          };
        }
        if (tableName === 'access_tokens' && query.sql.includes('inner join')) {
          return {
            rows: matched.map((row) =>
              Object.assign({}, row, {
                user_status: state.tables.users.find((user) => equal(user['id'], row['user_id']))?.[
                  'status'
                ],
                consent_revoked_at: null,
                client_public_id: null,
                client_status: null,
              }),
            ),
          };
        }
        return { rows: matched };
      }
      if (query.sql.startsWith('insert')) {
        const row = insertRow(query);
        if (tableName === 'user_credentials') {
          const existing = rows.find((entry) => equal(entry['user_id'], row['user_id']));
          if (existing === undefined) rows.push(row);
          else Object.assign(existing, row);
        } else rows.push(row);
        return { numAffectedRows: 1n };
      }
      if (query.sql.startsWith('update')) {
        if (tableName === 'users' && query.sql.includes('`display_name`') && state.profileConflict)
          return { numAffectedRows: 0n };
        if (tableName === 'user_credentials' && state.rehashConflict)
          return { numAffectedRows: 0n };
        return { numAffectedRows: updateRows(rows, query) };
      }
      throw new Error(`Unexpected auth SQL: ${query.sql}`);
    },
  });
  const pepperSource = new PepperVersionSource(() => fake.db, peppers);
  readPepperVersion = () => pepperSource.current();
  const fence = new SessionCommandFence();
  const mutations = new AuthzMutations({
    database: () => fake.db,
    owner: () => fake.owner,
    fence,
    clock,
    settleWrites: async () => {
      trace.push('writers:drained');
    },
    deliver: async (event) => {
      trace.push(`published:${event.type}`);
      events.push(event);
      return true;
    },
    revalidate: async () => undefined,
    uncertain: () => {
      trace.push('uncertain');
    },
  });
  const policy = new PasswordPolicy({
    minLength: 15,
    maxLength: 128,
    blocklist: new Set(),
    checkBreachedList: true,
  });
  const throttlePolicy = {
    maxFailures: options.maxFailures ?? LIMITS.LOGIN_FAILURES_PER_ACCOUNT_SOURCE,
    blockBaseSeconds: LIMITS.LOGIN_BLOCK_BASE_SECONDS,
    blockMaxSeconds: LIMITS.LOGIN_BLOCK_MAX_SECONDS,
    sourcePerDay: options.sourcePerDay ?? 100,
  };
  const throttle = new LoginThrottle(
    createMemoryLimiters(throttlePolicy),
    throttlePolicy,
    () => null,
  );
  const audit = {
    record: async (_trx: unknown, event: AuditEventInput) => {
      trace.push(`audit:${event.action}`);
      if (state.auditFailure) throw new Error('audit storage unavailable');
      audits.push(event);
      return audits.length;
    },
  };
  const sink = new DetachedAuditSink(() => fake.db);
  sink.bind(audit);
  const log = createLogger({
    level: 'trace',
    format: 'json',
    instanceId: 'auth-flow-unit',
    destination: {
      write: (line) => {
        logs.push(JSON.parse(line));
      },
    },
  });
  const deps: PasswordFlowDeps = {
    db: fake.db,
    mutations,
    ownerFence: fake.owner.captureFence(),
    hasher,
    policy,
    throttle,
    ttls: {
      webIdleMs: 86_400_000,
      webAbsoluteMs: 1_209_600_000,
      desktopIdleMs: 2_592_000_000,
      desktopAbsoluteMs: 7_776_000_000,
      stepUpWindowMs: 600_000,
    },
    setpw: new SetPasswordLinks({
      publicOrigin: new URL('http://127.0.0.1:4000'),
      hasher,
      policy,
      now: () => clock.now(),
      newId,
    }),
    audit,
    sink,
    loginFailureGate: new FailureAuditGate(60_000, () => clock.now()),
    now: () => clock.now(),
    newId,
    log,
    countLoginFailure: (reason) => {
      metrics.push(reason);
    },
    currentPepper: () => pepperSource.currentPepper(),
  };
  async function seedSession(
    kind: 'web' | 'desktop' = 'desktop',
    sessionId: SessionId = FLOW_SESSION,
    deviceName: string | null = null,
  ) {
    return issueSession(
      new KyselySessionRepository(fake.db),
      deps.ttls,
      clock.now(),
      () => sessionId,
      {
        userId: FLOW_USER,
        kind,
        deviceName,
        ip: FLOW_ACTOR.ip,
        userAgent: 'fixture-client',
        clientVersion: null,
        method: 'password',
      },
    );
  }
  async function seedLink() {
    const issued = await deps.setpw.issue(fake.db, {
      userId: FLOW_USER,
      purpose: 'reset',
      issuedBy: FLOW_USER,
    });
    const token = new URL(issued.link).hash.slice(1);
    return { issued, token };
  }
  function seedToken(allVaults = true) {
    const minted = mintToken('pat');
    state.tables.access_tokens.push({
      id: idBytes(newId()),
      token_id: minted.tokenId,
      secret_hash: secretHash(minted.secret),
      name: 'Automation',
      user_id: idBytes(FLOW_USER),
      kind: 'pat',
      scopes: ['vault:read', 'note:read'],
      all_vaults: allVaults,
      admin_owned: true,
      expires_at: new Date(clock.now() + 86_400_000),
      rate_limit_per_hour: null,
      rotation_overlap_until: null,
      resource: null,
      revoked_at: null,
      consent_id: null,
      client_id: null,
    });
    return minted;
  }
  function resetObservations() {
    trace.length = 0;
    audits.length = 0;
    events.length = 0;
    metrics.length = 0;
    logs.length = 0;
  }
  onTestFinished(async () => {
    await mutations.stop();
    await fake.close();
  });
  resetObservations();
  return {
    deps,
    fake,
    state,
    fence,
    trace,
    audits,
    events,
    metrics,
    logs,
    clock,
    seedSession,
    seedLink,
    seedToken,
    resetObservations,
  };
}
