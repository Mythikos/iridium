/**
 * The command table: what `iridium` answers, what each answer takes, and which of them write an audit
 * row (11-operations-and-deployment.md, "Command inventory"; 12-milestones.md §5.2, the
 * `apps/server/src/cli` row).
 *
 * It is **data**, and that is the point. The dispatcher walks it, `--help` renders it, and
 * `cli.audit-coverage.integration` enumerates it to fail on a mutating command nobody proved writes
 * an audit row — the alternative, a `switch` whose cases are the inventory, is a list only a human can
 * check. From M8 `cli.contract` compares the same table with the generated
 * `docs/ops/runbooks/cli.md`, so a new command cannot ship undocumented and a removed flag cannot
 * linger in a runbook.
 *
 * Three rules keep the table honest:
 *
 *  - **`mutations` is the audit contract.** Every action a successful run may write is listed. An
 *    empty list means the command writes nothing, and `cli.audit-coverage.integration` holds both
 *    directions: a listed action must be observed, and a command that writes an unlisted one fails.
 *  - **Reserved names are refused, not unknown.** A command or subcommand the plan names but this
 *    build does not carry exits `3` `not_implemented`; only a name the plan does not name at all is a
 *    usage error. A runbook naming `iridium backup` deserves "not in this build", not "unknown".
 *  - **Flags are declared, never sniffed.** Each subcommand carries its `FlagSpec`, so an unknown or
 *    valueless flag is refused with the accepted list before anything connects.
 */
import type { AuditAction } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import type { AuditEventContext } from '../audit/chain.ts';
import type { LoadedConfig } from '../config/env.ts';
import { systemClock } from '../ops/clock.ts';
import { runCreateUser } from './admin.ts';
import type { CliArgs, FlagSpec } from './args.ts';
import { cliPrincipal, type CliActor } from './attribution.ts';
import { runVerifyChain } from './audit.ts';
import { runConfigCheck } from './config.ts';
import { DOCTOR_RESERVED_CHECKS, reportChecks, runAllChecks, runRepairContent } from './doctor.ts';
import { EXIT } from './exit.ts';
import { runMigrate, type MigrateSubcommand } from './migrate.ts';
import type { CliIo } from './output.ts';
import { runServe } from './serve.ts';
import { runSessionsRevokeAll } from './sessions.ts';
import { runTokensRevokeAll } from './tokens.ts';
import { runVersion } from './version.ts';

/** Everything a subcommand body is given. */
export interface CommandInput {
  readonly io: CliIo;
  /** The parsed configuration when `needsConfig` asked for it, `null` otherwise. */
  readonly loaded: LoadedConfig | null;
  readonly args: CliArgs;
  /** The resolved command path, `admin create-user`, for messages and `SystemPrincipal.job`. */
  readonly path: string;
  /** `{os_user, host, request_id, argv_shape}` (OPS-19), built once per invocation. */
  readonly auditContext: AuditEventContext;
  /** The invocation's correlation id, which is also `auditContext.request_id`. */
  readonly requestId: string;
  /** `SYSTEM_ACTOR`, or the administrator `--actor` resolved. */
  readonly actor: CliActor;
  /** The booted application when `needsApp` asked for one, `null` otherwise. */
  readonly app: FastifyInstance | null;
}

/** One answerable command spelling. */
export interface CliSubcommand {
  /** The word after the command, or `null` for a command that takes none (`serve`, `version`). */
  readonly name: string | null;
  /** The left column of `--help`; M0's four entries are preserved verbatim. */
  readonly usage: string;
  /** The right column of `--help`. A multi-line summary carries its own continuation indent. */
  readonly summary: string;
  readonly flags: FlagSpec;
  /**
   * The one positional argument this subcommand takes, named for the refusal message, or `null` when
   * it takes none. A subcommand that takes none refuses a stray word rather than ignoring it: a
   * silently dropped argument is how `iridium migrate --actor a@b up` runs `status`.
   */
  readonly positional: string | null;
  /** Every audit action a successful run may write; empty for a read-only command. */
  readonly mutations: readonly AuditAction[];
  /**
   * Whether the environment must parse before this subcommand runs.
   *
   * `version` is the one that says `false`, and it matters: it is a pure function of the build, and
   * an operator debugging a deployment whose `EnvSchema` parse fails must still be able to ask which
   * binary is installed. Everything else refuses with exit `2` and nothing started.
   */
  readonly needsConfig: boolean;
  /** Whether this invocation needs `buildApp`; a function because `doctor` decides per flag. */
  needsApp(args: CliArgs): boolean;
  run(input: CommandInput): Promise<number>;
}

/** One command word and everything under it. */
export interface CliCommand {
  readonly name: string;
  readonly subcommands: readonly CliSubcommand[];
  /** Used when no subcommand word is given; `null` when one is required. */
  readonly defaultSubcommand: string | null;
  /** Subcommands 11's inventory names that this build does not carry: exit `3` `not_implemented`. */
  readonly reserved: readonly string[];
}

/** The `--actor <email>` flag of OPS-19, on every command that writes an audit row. */
const ACTOR_FLAG: FlagSpec = { actor: 'value' };

/** `--json` where 11 states it. */
const JSON_FLAG: FlagSpec = { json: 'switch' };

/** The application a subcommand asked for. A `null` here is a table mistake, never an operator's. */
function requireApp(input: CommandInput): FastifyInstance {
  if (input.app === null) {
    throw new Error(
      `the \`${input.path}\` row of CLI_COMMANDS returns false from needsApp() but its body reads ` +
        'the application; correct the table in apps/server/src/cli/commands.ts',
    );
  }
  return input.app;
}

/** The configuration a subcommand asked for. A `null` here is a table mistake, never an operator's. */
function requireLoaded(input: CommandInput): LoadedConfig {
  if (input.loaded === null) {
    throw new Error(
      `the \`${input.path}\` row of CLI_COMMANDS declares needsConfig: false but its body reads the ` +
        'configuration; correct the table in apps/server/src/cli/commands.ts',
    );
  }
  return input.loaded;
}

/** The reserved `doctor` checks as a flag spec: `--verify-note` takes a value, the rest do not. */
function doctorReservedFlags(): FlagSpec {
  return Object.fromEntries(
    DOCTOR_RESERVED_CHECKS.map((check) => [check, check === 'verify-note' ? 'value' : 'switch']),
  );
}

/** The first reserved check flag an invocation carried, or `undefined`. */
function reservedDoctorCheck(args: CliArgs): string | undefined {
  return DOCTOR_RESERVED_CHECKS.find((check) => args.has(check) || args.value(check) !== undefined);
}

const SERVE: CliSubcommand = {
  name: null,
  usage: 'serve',
  summary: 'Run the server (the container CMD and the systemd ExecStart).',
  flags: { child: 'switch' },
  positional: null,
  mutations: [],
  needsConfig: true,
  needsApp: () => false,
  run: (input) => runServe(input.args.has('child') ? 'child' : 'container'),
};

function migrateSubcommand(name: MigrateSubcommand, usage: string, summary: string): CliSubcommand {
  const mutates = name !== 'status';
  return {
    name,
    usage,
    summary,
    // `status` reads; `up` and `to` write, so they carry `--actor` like every other mutation.
    flags: mutates ? ACTOR_FLAG : {},
    positional: name === 'to' ? '<name>' : null,
    mutations: mutates ? ['system.migration.applied'] : [],
    needsConfig: true,
    needsApp: () => false,
    run: (input) =>
      runMigrate({
        io: input.io,
        loaded: requireLoaded(input),
        subcommand: name,
        args: input.args,
        actorEmail: input.args.value('actor'),
        auditContext: input.auditContext,
        batch: input.requestId,
        clock: systemClock,
      }),
  };
}

const CONFIG_CHECK: CliSubcommand = {
  name: 'check',
  usage: 'config check [--json]',
  summary: 'Parse EnvSchema exactly as serve would and print the redacted summary.',
  flags: JSON_FLAG,
  positional: null,
  mutations: [],
  needsConfig: true,
  needsApp: () => false,
  run: (input) =>
    Promise.resolve(runConfigCheck(input.io, requireLoaded(input), input.args.has('json'))),
};

const VERSION: CliSubcommand = {
  name: null,
  usage: 'version [--json]',
  summary: 'Print the product version, commit, Node version and migration head.',
  flags: JSON_FLAG,
  positional: null,
  mutations: [],
  // The one command that answers inside a deployment whose environment does not parse.
  needsConfig: false,
  needsApp: () => false,
  run: (input) => Promise.resolve(runVersion(input.io, input.args.has('json'))),
};

const DOCTOR: CliSubcommand = {
  name: null,
  usage: 'doctor [checks…]',
  summary:
    'Run every non-mutating check this build carries; exit 6 with the findings table.\n' +
    '                            --argon2 measures the configured pair, --yjs-instances reports the\n' +
    '                            startup guard, --repair-content <note> --yes repairs one note.',
  flags: {
    ...JSON_FLAG,
    ...ACTOR_FLAG,
    argon2: 'switch',
    'yjs-instances': 'switch',
    'repair-content': 'value',
    'dry-run': 'switch',
    yes: 'switch',
    ...doctorReservedFlags(),
  },
  positional: null,
  mutations: ['note.content.repaired'],
  needsConfig: true,
  // Only an invocation that will actually reach the note service needs one: a `--repair-content`
  // without `--yes` is refused by 11's "Repair" rule, and booting an application to answer that
  // would open two connection pools to say no.
  needsApp: (args) =>
    args.value('repair-content') !== undefined && (args.has('yes') || args.has('dry-run')),
  run: async (input) => {
    const reserved = reservedDoctorCheck(input.args);
    if (reserved !== undefined) {
      input.io.err(
        `iridium doctor --${reserved}: not_implemented in this build. The check is specified by ` +
          '11-operations-and-deployment.md\'s "doctor checks" table and arrives with the milestone ' +
          'that gives it something to read.',
      );
      return EXIT.refused;
    }

    const note = input.args.value('repair-content');
    if (note !== undefined) {
      return runRepairContent({
        io: input.io,
        app: input.app,
        noteId: note,
        principal: cliPrincipal('doctor --repair-content', input.actor),
        dryRun: input.args.has('dry-run'),
        confirmed: input.args.has('yes'),
        json: input.args.has('json'),
      });
    }

    const wantsArgon2 = input.args.has('argon2');
    const wantsYjs = input.args.has('yjs-instances');
    const all = await runAllChecks(requireLoaded(input).config, systemClock);
    const selected =
      wantsArgon2 || wantsYjs
        ? all.filter(
            (check) =>
              (wantsArgon2 && check.name === 'argon2') ||
              (wantsYjs && check.name === 'yjs_instances'),
          )
        : all;
    return reportChecks(input.io, selected, input.args.has('json'));
  },
};

const ADMIN_CREATE_USER: CliSubcommand = {
  name: 'create-user',
  usage: 'admin create-user',
  summary:
    'Create a user without credentials and print its one-time set-password link.\n' +
    '                            --email <e> --display-name <n> [--server-admin] [--json]',
  flags: {
    ...ACTOR_FLAG,
    ...JSON_FLAG,
    email: 'value',
    'display-name': 'value',
    'server-admin': 'switch',
  },
  positional: null,
  mutations: ['admin.user.created'],
  needsConfig: true,
  needsApp: () => true,
  run: (input) =>
    runCreateUser({
      io: input.io,
      app: requireApp(input),
      email: input.args.value('email'),
      displayName: input.args.value('display-name'),
      serverAdmin: input.args.has('server-admin'),
      actor: input.actor,
      context: input.auditContext,
      json: input.args.has('json'),
    }),
};

const AUDIT_VERIFY_CHAIN: CliSubcommand = {
  name: 'verify-chain',
  usage: 'audit verify-chain',
  summary:
    'Recompute every audit chain; exit 5 naming the first divergent row.\n' +
    '                            [--chain <id>] [--json]',
  flags: { ...JSON_FLAG, chain: 'value' },
  positional: null,
  mutations: [],
  needsConfig: true,
  needsApp: () => true,
  run: (input) =>
    runVerifyChain({
      io: input.io,
      app: requireApp(input),
      chain: input.args.value('chain'),
      json: input.args.has('json'),
    }),
};

const SESSIONS_REVOKE_ALL: CliSubcommand = {
  name: 'revoke-all',
  usage: 'sessions revoke-all',
  summary: 'Revoke every live session, or one user’s with --user <email>.',
  flags: { ...ACTOR_FLAG, user: 'value' },
  positional: null,
  mutations: ['session.revoked_all'],
  needsConfig: true,
  needsApp: () => true,
  run: (input) =>
    runSessionsRevokeAll({
      io: input.io,
      app: requireApp(input),
      userEmail: input.args.value('user'),
      actor: input.actor,
      context: input.auditContext,
    }),
};

const TOKENS_REVOKE_ALL: CliSubcommand = {
  name: 'revoke-all',
  usage: 'tokens revoke-all',
  summary: 'Revoke every live access token, or one user’s with --user <email>.',
  flags: { ...ACTOR_FLAG, user: 'value' },
  positional: null,
  mutations: ['token.revoked_all'],
  needsConfig: true,
  needsApp: () => true,
  run: (input) =>
    runTokensRevokeAll({
      io: input.io,
      app: requireApp(input),
      userEmail: input.args.value('user'),
      actor: input.actor,
      context: input.auditContext,
    }),
};

/** Every command this build answers, in the order `--help` lists them. */
export const CLI_COMMANDS: readonly CliCommand[] = Object.freeze([
  { name: 'serve', subcommands: [SERVE], defaultSubcommand: null, reserved: [] },
  {
    name: 'migrate',
    subcommands: [
      migrateSubcommand(
        'status',
        'migrate status',
        'Print applied, pending and unknown-newer migrations.',
      ),
      migrateSubcommand(
        'up',
        'migrate up',
        "Apply every pending migration under GET_LOCK('iridium_migrate', 60).",
      ),
      migrateSubcommand(
        'to',
        'migrate to <name>',
        'Migrate to a named migration; a target behind the current head is\n' +
          '                            refused with exit 3 when NODE_ENV=production.',
      ),
    ],
    defaultSubcommand: 'status',
    reserved: ['down', 'ensure-guards', 'grants'],
  },
  {
    name: 'config',
    subcommands: [CONFIG_CHECK],
    defaultSubcommand: 'check',
    reserved: [],
  },
  { name: 'version', subcommands: [VERSION], defaultSubcommand: null, reserved: [] },
  { name: 'doctor', subcommands: [DOCTOR], defaultSubcommand: null, reserved: [] },
  {
    name: 'admin',
    subcommands: [ADMIN_CREATE_USER],
    defaultSubcommand: null,
    reserved: [
      'list-users',
      'reset-password',
      'disable-user',
      'enable-user',
      'delete-user',
      'grant',
      'revoke',
      'create-vault',
      'list-vaults',
      'archive-vault',
      'unarchive-vault',
    ],
  },
  {
    name: 'audit',
    subcommands: [AUDIT_VERIFY_CHAIN],
    defaultSubcommand: null,
    reserved: ['export', 'archive', 'chain-status'],
  },
  {
    name: 'sessions',
    subcommands: [SESSIONS_REVOKE_ALL],
    defaultSubcommand: null,
    reserved: ['list', 'revoke'],
  },
  {
    name: 'tokens',
    subcommands: [TOKENS_REVOKE_ALL],
    defaultSubcommand: null,
    reserved: ['list', 'revoke'],
  },
]);

/**
 * The commands 11's inventory reserves that this build does not carry. M0 listed thirteen; `doctor`,
 * `admin`, `audit`, `tokens` and `sessions` land in M1, so eight remain and each still exits `3`.
 */
export const RESERVED_COMMANDS: readonly string[] = Object.freeze([
  'backup',
  'restore',
  'reindex',
  'keys',
  'jobs',
  'trash',
  'desktop-updates',
  'mirror',
]);

/** Where the summary column starts, so `--help` is one aligned block. */
const SUMMARY_COLUMN = 26;

/** `iridium --help`, rendered from the table so it can never describe a command that is not there. */
export const USAGE: string = `iridium <command> [args]

Commands available in this build:
${CLI_COMMANDS.flatMap((command) => command.subcommands)
  .map((subcommand) => `  ${subcommand.usage.padEnd(SUMMARY_COLUMN)}${subcommand.summary}`)
  .join('\n')}

Reserved for later milestones (each exits 3 with not_implemented):
  ${RESERVED_COMMANDS.join(', ')}

Exit codes: 0 success · 1 internal · 2 configuration or usage · 3 refused precondition
            4 pre-flight integrity · 5 verification · 6 diagnostic findings
`;

/** The command a word names, or `undefined`. */
export function commandByName(name: string): CliCommand | undefined {
  return CLI_COMMANDS.find((command) => command.name === name);
}

/** The subcommand a word names within a command, or `undefined`. */
export function subcommandByName(
  command: CliCommand,
  name: string | null,
): CliSubcommand | undefined {
  return command.subcommands.find((subcommand) => subcommand.name === name);
}

/**
 * Every `<command> <subcommand>` path in the table.
 *
 * `cli.commands.unit` reads it to hold the spellings unique, and `cli.audit-coverage.integration`
 * reads it to enumerate the mutating paths; from M8 `cli.contract` compares it with the generated
 * runbook. No product code calls it.
 *
 * @internal
 */
export function commandPaths(): readonly string[] {
  return CLI_COMMANDS.flatMap((command) =>
    command.subcommands.map((subcommand) =>
      subcommand.name === null ? command.name : `${command.name} ${subcommand.name}`,
    ),
  );
}
