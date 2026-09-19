/**
 * `cli.audit-coverage.integration` (10-testing-and-quality.md, "Inventory completeness — Audit,
 * access log, jobs and admin"; 12-milestones.md §5.2's cli row, "every CLI mutation audits with
 * `credential_type='cli'`"; OPS-19).
 *
 * The inventory row states the shape of this suite exactly: *every CLI mutation writes an audit event
 * with `credential_type='cli'`; the test enumerates the command table and fails on an unaudited
 * mutation.* So the table in `apps/server/src/cli/commands.ts` is the input, not a list written here:
 * each subcommand declares the audit actions a successful run may write, and each of those is
 * **observed** — by running the real binary as a child process against this worker's schema and then
 * reading `audit_events`.
 *
 * **Every case seeds itself.** The harness truncates the worker schema after each test
 * (`worker-schema.setup.ts`: "every test is handed it empty"), so a flow built once in `beforeAll`
 * would be wiped before the first assertion; and `vitest.config.ts` shuffles, so cases that depended
 * on each other's order would fail on a seed rather than on a defect. Each case therefore runs the
 * commands it asserts about, which costs a second or two per case and buys isolation.
 *
 * Two rules keep the enumeration from going quietly vacuous:
 *
 *  - **Every mutating path has a case.** A new mutating command with no case fails the first test
 *    below, naming the path. That is the "fails on an unaudited mutation" half.
 *  - **A declared action no case can observe is recorded, not ignored.** `UNOBSERVED` carries the
 *    reason, the way `limits.single-source.allowlist.json` carries the numbers that legitimately live
 *    outside the limits policy. An entry that stops being true fails the suite, so it cannot rot.
 */
import { AUDIT_ACTIONS, type AuditAction, type UserId } from '@iridium/contracts';
import { createCookieJar, waitFor, type CliResult } from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes, userIdFromBytes } from '../../src/auth/ids.ts';
import { SESSION_REVOCATION_POLL_MS } from '../../src/authz/session-revocations.ts';
import { CLI_COMMANDS } from '../../src/cli/commands.ts';
import {
  desktopClient,
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { insertToken, SEED_PASSWORD } from '../support/seed.ts';

/** The address every case's administrator carries; the schema is empty when each case starts. */
const ADMIN_EMAIL = 'cli-audit-admin@iridium.test';

/** A note id nothing owns, for the repair command's refusal. */
const ABSENT_NOTE = '018f2b1e-0000-7000-8000-0000000000aa';

/** A vault chain nothing has written, for `verify-chain`'s refusal. */
const ABSENT_CHAIN = 'vault:00000000000000000000000000000000';

/** A year out, so the seeded token is live when `tokens revoke-all` reaches it. */
const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** The argv `createAdmin` runs, and the `argv_shape` OPS-19 requires it to record. */
const CREATE_ARGV: readonly string[] = [
  'admin',
  'create-user',
  '--email',
  ADMIN_EMAIL,
  '--display-name',
  'CLI Audit Admin',
  '--server-admin',
];
const CREATE_ARGV_SHAPE = 'admin create-user --email <value> --display-name <value> --server-admin';

/**
 * Declared mutations no case can observe, with the reason.
 *
 * It is data so that admitting one is a reviewed one-line change, and the suite fails on an entry
 * that is no longer true — a register of gaps that used to exist is worse than no register.
 */
const UNOBSERVED: readonly {
  readonly path: string;
  readonly action: AuditAction;
  readonly reason: string;
}[] = Object.freeze([
  {
    path: 'doctor',
    action: 'note.content.repaired',
    reason:
      'the row is written only when a note is actually repaired, and a content-invalid note can ' +
      'only be produced through a live CRDT connection (a CR or an attributed span in the Y.Text). ' +
      'The case below drives the command end to end and asserts its refusal for a note that does ' +
      'not exist; the repairing case belongs with collab-server’s content-invalid fixture.',
  },
]);

/** The mutating command paths this suite covers, and the actions each case observes. */
const COVERED: readonly { readonly path: string; readonly observes: readonly AuditAction[] }[] = [
  { path: 'migrate up', observes: ['system.migration.applied'] },
  { path: 'migrate to', observes: ['system.migration.applied'] },
  { path: 'admin create-user', observes: ['admin.user.created'] },
  { path: 'sessions revoke-all', observes: ['session.revoked_all'] },
  { path: 'tokens revoke-all', observes: ['token.revoked_all'] },
  { path: 'doctor', observes: [] },
];

let context: AuthTestServer;

/** `iridium <args…>` against this worker's schema and secrets. */
function cli(args: readonly string[]): Promise<CliResult> {
  return context.server.cli(args);
}

/**
 * Runs a command and asserts its exit code, showing everything it printed when the code is wrong.
 *
 * The message is carried by the asserted value rather than by `expect`'s second argument, which
 * `vitest/valid-expect` refuses; the diff Vitest prints is then the command and its two streams.
 */
async function expectExit(
  args: readonly string[],
  code: number,
  executing: Promise<CliResult> = cli(args),
): Promise<CliResult> {
  const result = await executing;
  const detail =
    result.code === code
      ? ''
      : `iridium ${args.join(' ')} exited ${String(result.code ?? result.signal)}, expected ` +
        `${String(code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  expect(detail).toBe('');
  return result;
}

/** Every `audit_events` row of one action, with the columns OPS-19 constrains. */
async function rowsOf(action: AuditAction): Promise<
  readonly {
    readonly actor_type: string;
    readonly credential_type: string;
    readonly context: unknown;
    readonly metadata: unknown;
  }[]
> {
  return context.db
    .selectFrom('audit_events')
    .select(['actor_type', 'credential_type', 'context', 'metadata'])
    .where('action', '=', action)
    .orderBy('id', 'asc')
    .execute();
}

/** The distinct `credential_type`s one action's rows carry — `['cli']` for every CLI mutation. */
async function credentialsOf(action: AuditAction): Promise<readonly string[]> {
  const rows = await rowsOf(action);
  return [...new Set(rows.map((row) => row.credential_type))].toSorted();
}

/** A JSON column as an object, whichever way the driver hands it back. */
function jsonOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
  }
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

/** What one case's administrator is: the row the CLI created and the link it printed once. */
interface SeededAdmin {
  readonly result: CliResult;
  readonly userId: UserId;
  readonly setPasswordLink: string;
}

/** `iridium admin create-user --server-admin`, the deployment's first human (04 §3.2). */
async function createAdmin(): Promise<SeededAdmin> {
  const result = await expectExit(CREATE_ARGV, 0);
  const setPasswordLink = /https?:\/\/\S*#irid_spl_[A-Za-z0-9_-]+/.exec(result.stdout)?.[0] ?? '';
  expect(setPasswordLink).toContain('#irid_spl_');
  const row = await context.db
    .selectFrom('users')
    .select('id')
    .where('email_key', '=', ADMIN_EMAIL)
    .executeTakeFirstOrThrow();
  return { result, userId: userIdFromBytes(row.id), setPasswordLink };
}

/** The printed link consumed through the product's own route; no plaintext password ever transits. */
async function setPassword(link: string): Promise<void> {
  const response = await desktopClient(context).post('/auth/set-password', {
    json: { token: link.slice(link.indexOf('#') + 1), password: SEED_PASSWORD },
  });
  expect({ status: response.status, body: response.body }).toMatchObject({ status: 204 });
}

beforeAll(async () => {
  context = await startAuthServer();
}, 120_000);

afterAll(async () => {
  await context?.stop();
});

describe('cli.audit-coverage.integration [area:audit]', () => {
  describe('the command table is the input', () => {
    it('covers every mutating command path', () => {
      const mutating = CLI_COMMANDS.flatMap((command) =>
        command.subcommands
          .filter((subcommand) => subcommand.mutations.length > 0)
          .map((subcommand) =>
            subcommand.name === null ? command.name : `${command.name} ${subcommand.name}`,
          ),
      );
      expect([...mutating].toSorted()).toEqual(COVERED.map((entry) => entry.path).toSorted());
    });

    it('observes every declared mutation, or records why it cannot', () => {
      const declared = CLI_COMMANDS.flatMap((command) =>
        command.subcommands.flatMap((subcommand) => {
          const path =
            subcommand.name === null ? command.name : `${command.name} ${subcommand.name}`;
          return subcommand.mutations.map((action) => `${path} → ${action}`);
        }),
      );
      const observed = COVERED.flatMap((entry) =>
        entry.observes.map((action) => `${entry.path} → ${action}`),
      );
      const registered = UNOBSERVED.map((entry) => `${entry.path} → ${entry.action}`);
      expect([...declared].toSorted()).toEqual([...observed, ...registered].toSorted());
    });

    it('names only actions of the closed vocabulary', () => {
      for (const entry of COVERED) {
        for (const action of entry.observes) expect(AUDIT_ACTIONS).toContain(action);
      }
      for (const entry of UNOBSERVED) expect(AUDIT_ACTIONS).toContain(entry.action);
    });
  });

  describe('migrate reconciles the chain', () => {
    it('writes one system.migration.applied per applied migration, as the CLI', async () => {
      // The schema is at head and this run applies nothing; the events are still written, because the
      // per-test truncation removed them and 11 specifies that the next run backfills what
      // `kysely_migration` has and the chain does not. That is the reconciliation, observed directly.
      await expectExit(['migrate', 'up'], 0);

      const applied = await context.db.selectFrom('kysely_migration').select('name').execute();
      const rows = await rowsOf('system.migration.applied');
      const recorded = new Set(
        rows.map((row) => {
          const metadata = jsonOf(row.metadata);
          return typeof metadata['name'] === 'string' ? metadata['name'] : '';
        }),
      );
      expect(applied.length).toBeGreaterThan(0);
      expect(applied.filter((migration) => !recorded.has(migration.name))).toEqual([]);
      expect(await credentialsOf('system.migration.applied')).toEqual(['cli']);
    }, 60_000);

    it('reconciles through `migrate to` as well, and writes nothing twice', async () => {
      const head = await context.db
        .selectFrom('kysely_migration')
        .select('name')
        .orderBy('name', 'desc')
        .executeTakeFirstOrThrow();
      await expectExit(['migrate', 'to', head.name], 0);
      const first = (await rowsOf('system.migration.applied')).length;
      expect(first).toBeGreaterThan(0);

      // Idempotent by construction: the set it writes is the ledger minus what the chain has.
      await expectExit(['migrate', 'to', head.name], 0);
      expect((await rowsOf('system.migration.applied')).length).toBe(first);
      expect(await credentialsOf('system.migration.applied')).toEqual(['cli']);
    }, 60_000);
  });

  describe('admin create-user is the deployment’s first human', () => {
    it('creates the row, prints the one-time link and never a password', async () => {
      const admin = await createAdmin();
      expect(admin.result.stdout).not.toContain(SEED_PASSWORD);

      const row = await context.db
        .selectFrom('users')
        .select(['is_server_admin', 'status'])
        .where('id', '=', idBytes(admin.userId))
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ is_server_admin: true, status: 'active' });

      // The account cannot log in until the link is consumed (A28): no credential row exists yet.
      const credential = await context.db
        .selectFrom('user_credentials')
        .select('user_id')
        .where('user_id', '=', idBytes(admin.userId))
        .executeTakeFirst();
      expect(credential).toBeUndefined();
    }, 60_000);

    it('writes one admin.user.created row as the CLI, attributable to no human', async () => {
      await createAdmin();
      const rows = await rowsOf('admin.user.created');
      expect(rows).toHaveLength(1);
      expect({ actor: rows[0]?.actor_type, credential: rows[0]?.credential_type }).toEqual({
        actor: 'system',
        credential: 'cli',
      });
    }, 60_000);

    it('records OPS-19’s context: os_user, host, request_id, argv_shape, and no value', async () => {
      await createAdmin();
      const recorded = jsonOf((await rowsOf('admin.user.created'))[0]?.context);
      expect(recorded).toHaveProperty('host');
      expect(recorded).toHaveProperty('request_id');
      expect(recorded['argv_shape']).toBe(CREATE_ARGV_SHAPE);
      expect(JSON.stringify(recorded)).not.toContain(ADMIN_EMAIL);
    }, 60_000);

    it('answers --json with the body POST /admin/users answers', async () => {
      const result = await expectExit([...CREATE_ARGV, '--json'], 0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({
        user: { email: ADMIN_EMAIL, isServerAdmin: true, hasCredentials: false },
        setPasswordLink: expect.stringContaining('#irid_spl_'),
        expiresAt: expect.any(String),
      });
    }, 60_000);
  });

  describe('sessions revoke-all cuts the session off immediately', () => {
    it('revokes the live session, audits it as the CLI, and the cookie stops working', async () => {
      const admin = await createAdmin();
      await setPassword(admin.setPasswordLink);

      const jar = createCookieJar();
      const signIn = await webClient(context, jar).post('/auth/sessions', {
        json: { email: ADMIN_EMAIL, password: SEED_PASSWORD, client: 'web' },
        headers: webHeaders(context.origin),
      });
      expect({ status: signIn.status, body: signIn.body }).toMatchObject({ status: 201 });
      expect((await webClient(context, jar).get('/auth/me')).status).toBe(200);

      const args = ['sessions', 'revoke-all', '--user', ADMIN_EMAIL];
      const executing = cli(args);
      // This fixture owns a ManualClock. Observe the real child command's durable submission
      // before advancing the serving relay's timer; queuing an intent alone revokes nothing.
      const pending = await waitFor(
        async () => (await context.app.authz.sessionCommands.store.pending()) ?? undefined,
        { timeoutMs: 15_000, description: 'the CLI to submit its durable session command' },
      );
      expect(pending).toMatchObject({ userId: admin.userId, result: null, delivered: false });
      expect((await webClient(context, jar).get('/auth/me')).status).toBe(200);
      await context.clock.advance(SESSION_REVOCATION_POLL_MS);
      const result = await expectExit(args, 0, executing);
      expect(result.stdout).toContain(`command  ${pending.id}`);
      expect(result.stdout).toContain('sessions revoked  1');
      expect(await context.app.authz.sessionCommands.store.find(pending.id)).toMatchObject({
        id: pending.id,
        delivered: true,
        result: { ok: true, users: 1, sessions: [{ userId: admin.userId }] },
      });
      expect((await webClient(context, jar).get('/auth/me')).status).toBe(401);

      const rows = await rowsOf('session.revoked_all');
      expect(rows).toHaveLength(1);
      expect(jsonOf(rows[0]?.metadata)).toMatchObject({ scope: 'user', revoked: 1 });
      expect(await credentialsOf('session.revoked_all')).toEqual(['cli']);
    }, 60_000);
  });

  describe('tokens revoke-all revokes without deleting', () => {
    it('sets revoked_at on the live token, keeps the row, and audits it as the CLI', async () => {
      const admin = await createAdmin();
      // The token lifecycle REST arrives in M3 (12 §5.2), so the row enters through the schema — the
      // one seam the fixture policy allows where no product path exists yet.
      const seeded = await insertToken(
        context.db,
        { ownerId: admin.userId, expiresAt: new Date(context.clock.now() + TOKEN_LIFETIME_MS) },
        context.clock.now(),
      );

      const result = await expectExit(['tokens', 'revoke-all', '--user', ADMIN_EMAIL], 0);
      expect(result.stdout).toContain('tokens revoked  1');

      const row = await context.db
        .selectFrom('access_tokens')
        .select(['revoked_at', 'revoke_reason'])
        .where('id', '=', idBytes(seeded.id))
        .executeTakeFirstOrThrow();
      expect({ revoked: row.revoked_at !== null, reason: row.revoke_reason }).toEqual({
        revoked: true,
        reason: 'admin',
      });

      const rows = await rowsOf('token.revoked_all');
      expect(rows).toHaveLength(1);
      expect(jsonOf(rows[0]?.metadata)).toMatchObject({ scope: 'user', revoked: 1 });
      expect(await credentialsOf('token.revoked_all')).toEqual(['cli']);
    }, 60_000);
  });

  describe('doctor --repair-content', () => {
    it('refuses a note that does not exist rather than failing inside the service', async () => {
      const result = await expectExit(['doctor', '--repair-content', ABSENT_NOTE, '--yes'], 3);
      expect(result.stderr).toContain('no note');
    }, 60_000);

    it('refuses without --yes, which every repair subcommand requires', async () => {
      const result = await expectExit(['doctor', '--repair-content', ABSENT_NOTE], 3);
      expect(result.stderr).toContain('add --yes to confirm');
    }, 60_000);
  });

  describe('audit verify-chain reads what the flow wrote', () => {
    it('exits 0 and reports every chain intact after a CLI mutation', async () => {
      await createAdmin();
      const result = await expectExit(['audit', 'verify-chain', '--json'], 0);
      const parsed: unknown = JSON.parse(result.stdout);
      expect(parsed).toMatchObject({ ok: true });

      const server = await expectExit(['audit', 'verify-chain', '--chain', 'server'], 0);
      expect(server.stdout).toContain('intact');
    }, 60_000);

    it('refuses a chain id nothing has written, rather than reporting it intact', async () => {
      await createAdmin();
      const result = await expectExit(['audit', 'verify-chain', '--chain', ABSENT_CHAIN], 3);
      expect(result.stderr).toContain('no chain');
    }, 60_000);
  });

  describe('--actor attributes the mutation to a named administrator (OPS-19)', () => {
    it('refuses an address that names no administrator', async () => {
      await createAdmin();
      const result = await expectExit(
        ['tokens', 'revoke-all', '--actor', 'nobody@iridium.test'],
        3,
      );
      expect(result.stderr).toContain('no user carries that address');
    }, 60_000);

    it('records the administrator on the row, still as a CLI credential', async () => {
      await createAdmin();
      await expectExit(['tokens', 'revoke-all', '--actor', ADMIN_EMAIL], 0);
      const rows = await rowsOf('token.revoked_all');
      expect(rows).toHaveLength(1);
      expect({ actor: rows[0]?.actor_type, credential: rows[0]?.credential_type }).toEqual({
        actor: 'user',
        credential: 'cli',
      });
    }, 60_000);
  });
});
