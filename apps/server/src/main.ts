import { startServer } from './app.ts';
/**
 * `iridium` — the CLI entry, and the same binary as the server (`dist/main.mjs`).
 *
 * At M0 the inventory is `serve` and `migrate` (12-milestones.md section 4.3); `doctor`, `config`,
 * `backup`, `restore`, `audit`, `reindex`, `admin`, `tokens`, `sessions`, `keys`, `jobs`, `trash`,
 * `desktop-updates` and `mirror` arrive with the milestones that give them something to do. Every
 * command loads the same configuration through `loadConfig()` and, where it needs the database, the
 * same Kysely factory the server uses — so a CLI command can never see a different schema, a
 * different validation or a different set of secrets than the running server.
 *
 * `version` and `config check` are here too, not as scope creep but because both are pure functions
 * of the configuration this file already parses, and both are the first step of every runbook: the
 * systemd unit's first `ExecStartPre` is `iridium config check`.
 *
 * Exit codes are the seven-code contract of OPS-16, restated as ARCH-22 — `0` success or a verified
 * no-op, `1` unexpected internal error, `2` configuration or usage error, `3` refused precondition,
 * `4` pre-flight integrity failure, `5` verification failure, `6` diagnostic findings — and every
 * wrapper script, systemd unit and CI drill branches on these numbers.
 *
 * This file and `config/**` are the only places `process.env` may be read (oxlint
 * `node/no-process-env`).
 */
import { ConfigError, loadConfigDetailed, type LoadedConfig } from './config/env.ts';
import { processEnv } from './config/process-env.ts';
import {
  createMaintDb,
  migrateTo,
  migrateToLatest,
  migrationStatus,
  MigrationDirectionRefusedError,
  MigrationLockedError,
} from './db/migrator.ts';
import { BUILD_INFO } from './ops/build-info.ts';
// The Yjs single-instance guard must be the first import of this process: the interception happens at
// module evaluation, and it has to be in place before the copy of yjs that announces itself is
// evaluated -- which, under ESM, is before the body of any module that imported it. Moving this import
// below one that reaches @iridium/crdt would make the guard observe nothing and pass on a broken
// process (A14). `assertSingleYjsInstance` is then called by every command, not only `serve`: a
// process with two Yjs copies has no business migrating a schema either.
import { assertSingleYjsInstance } from './ops/yjs-single-instance.ts';

/** The seven-code CLI contract of OPS-16 / ARCH-22. */
export const EXIT = Object.freeze({
  success: 0,
  internal: 1,
  usage: 2,
  refused: 3,
  integrity: 4,
  verification: 5,
  findings: 6,
});

/** Commands this binary answers at M0. */
export const M0_COMMANDS: readonly string[] = Object.freeze([
  'serve',
  'migrate',
  'config',
  'version',
]);

/** Commands the plan reserves; naming them makes an unimplemented one a clear refusal, not a typo. */
export const RESERVED_COMMANDS: readonly string[] = Object.freeze([
  'doctor',
  'backup',
  'restore',
  'audit',
  'reindex',
  'admin',
  'tokens',
  'sessions',
  'keys',
  'jobs',
  'trash',
  'desktop-updates',
  'mirror',
]);

const USAGE = `iridium <command> [args]

Commands available in this build:
  serve                     Run the server (the container CMD and the systemd ExecStart).
  migrate status            Print applied, pending and unknown-newer migrations.
  migrate up                Apply every pending migration under GET_LOCK('iridium_migrate', 60).
  migrate to <name>         Migrate to a named migration; a target behind the current head is
                            refused with exit 3 when NODE_ENV=production.
  config check [--json]     Parse EnvSchema exactly as serve would and print the redacted summary.
  version [--json]          Print the product version, commit, Node version and migration head.

Reserved for later milestones (each exits 3 with not_implemented):
  ${RESERVED_COMMANDS.join(', ')}

Exit codes: 0 success · 1 internal · 2 configuration or usage · 3 refused precondition
            4 pre-flight integrity · 5 verification · 6 diagnostic findings
`;

/** Writes one line to stderr. The only place this binary writes outside pino, and deliberately so:
 * a configuration failure happens before a logger exists, and an operator reading `docker compose up`
 * needs the reason rather than a silent exit. */
function fail(message: string): void {
  process.stderr.write(`${message}\n`);
}

function has(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

/** `iridium version`. */
function printVersion(json: boolean): number {
  const payload = {
    version: BUILD_INFO.version,
    commit: BUILD_INFO.commit,
    node: BUILD_INFO.node,
  };
  process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : renderVersion(payload));
  return EXIT.success;
}

function renderVersion(payload: Readonly<Record<string, string>>): string {
  return `${Object.entries(payload)
    .map(([key, value]) => `${key.padEnd(8)} ${value}`)
    .join('\n')}\n`;
}

/** `iridium config check`: the same parse `serve` performs, and the first step of every runbook. */
function configCheck(loaded: LoadedConfig, json: boolean): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          config: loaded.redacted,
          ignoredHarnessKeys: loaded.diagnostics.ignoredHarnessKeys,
          warnings: loaded.diagnostics.warnings,
          cpu: loaded.diagnostics.cpuCeiling,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.success;
  }

  const lines: string[] = ['configuration'];
  const width = Math.max(...Object.keys(loaded.redacted).map((key) => key.length));
  for (const [key, value] of Object.entries(loaded.redacted)) {
    lines.push(`  ${key.padEnd(width)}  ${value}`);
  }
  const cpu = loaded.diagnostics.cpuCeiling;
  lines.push(
    '',
    'cpu',
    `  host parallelism  ${String(cpu.hostParallelism)}`,
    `  cgroup quota      ${Number.isFinite(cpu.cgroupCpus) ? String(cpu.cgroupCpus) : 'none'}`,
    `  resolved ceiling  ${String(cpu.cpus)} (${cpu.bound} bound won)`,
  );
  if (loaded.diagnostics.ignoredHarnessKeys.length > 0) {
    lines.push('', 'ignored harness keys (recognised, deliberately not used)');
    for (const key of loaded.diagnostics.ignoredHarnessKeys) lines.push(`  ${key}`);
  }
  if (loaded.diagnostics.warnings.length > 0) {
    lines.push('', 'warnings');
    for (const warning of loaded.diagnostics.warnings) lines.push(`  ${warning}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT.success;
}

/**
 * `iridium migrate <status|up|to>` (A7; 11-operations-and-deployment.md, "Command inventory") —
 * delegated to the database stream's migrator wrapper at `apps/server/src/db/migrator.ts`, which owns
 * `GET_LOCK('iridium_migrate', 60)`, the per-migration transaction mode, the forward-only refusal and
 * the audit event per applied migration. The CLI adds only the role check and the exit code, because
 * two code paths that apply migrations would eventually differ.
 */
async function migrate(loaded: LoadedConfig, argv: readonly string[]): Promise<number> {
  const subcommand = argv[0] ?? 'status';
  if (subcommand !== 'status' && subcommand !== 'up' && subcommand !== 'to') {
    fail(
      `iridium migrate: unknown subcommand ${JSON.stringify(subcommand)}. ` +
        'This build answers `status`, `up` and `to`; `down`, `ensure-guards` and `grants --print` ' +
        'arrive with the milestone that needs them.',
    );
    return EXIT.usage;
  }

  // `to` is the one subcommand that takes an argument. Resolving it before anything connects keeps a
  // missing name a usage error rather than a failure that has already opened a migrator connection.
  const name = argv[1] ?? '';
  if (subcommand === 'to' && (name === '' || name.startsWith('-'))) {
    fail(
      'iridium migrate to: expected a migration name, for example `iridium migrate to 0034_grants`. ' +
        '`iridium migrate status` lists the names this build carries.',
    );
    return EXIT.usage;
  }

  const { config } = loaded;
  if (config.db.migrateUrl === null) {
    fail(
      'iridium migrate requires DATABASE_MIGRATE_URL (the iridium_migrator role). The serving ' +
        'process deliberately does not hold the DDL credential (A7, A8, ARCH-20).',
    );
    return EXIT.usage;
  }

  const maint = createMaintDb(config.db.migrateUrl, config.db.connectTimeoutMs);
  try {
    if (subcommand === 'status') {
      const status = await migrationStatus(maint.db);
      process.stdout.write(
        `${JSON.stringify(
          {
            status: status.status,
            applied: status.applied.length,
            pending: status.pending,
            unknown: status.unknown,
          },
          null,
          2,
        )}\n`,
      );
      return EXIT.success;
    }

    const outcome =
      subcommand === 'to'
        ? await migrateTo({ db: maint.db, target: maint.target }, name, config.env)
        : await migrateToLatest({ db: maint.db, target: maint.target });
    const applied = outcome.results.filter((result) => result.status === 'Success');
    process.stdout.write(
      `${JSON.stringify({ applied: applied.map((result) => result.migrationName) }, null, 2)}\n`,
    );
    return EXIT.success;
  } catch (error) {
    if (error instanceof MigrationLockedError || error instanceof MigrationDirectionRefusedError) {
      fail(error.message);
      return EXIT.refused;
    }
    fail(error instanceof Error ? error.message : String(error));
    return EXIT.internal;
  } finally {
    await maint.db.destroy();
  }
}

/** `iridium serve`. Resolves only when the process is shutting down. */
async function serve(): Promise<number> {
  await startServer({ mode: 'container' });
  return EXIT.success;
}

/** Parses argv and runs one command. Exported so a test can drive it without spawning a process. */
export async function run(argv: readonly string[]): Promise<number> {
  assertSingleYjsInstance();
  const [command = '', ...rest] = argv;
  const json = has(rest, '--json');

  if (command === '' || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command === '' ? EXIT.usage : EXIT.success;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    return printVersion(json);
  }
  if (RESERVED_COMMANDS.includes(command)) {
    fail(
      `iridium ${command}: not_implemented in this build. The command is reserved by ` +
        '11-operations-and-deployment.md, "Command inventory", and arrives with the milestone that ' +
        'gives it something to do.',
    );
    return EXIT.refused;
  }
  if (!M0_COMMANDS.includes(command)) {
    fail(`iridium: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    return EXIT.usage;
  }

  // Every command below needs the configuration, and every one of them fails the same way when it is
  // wrong: `z.prettifyError` to stderr and exit 2, with nothing started.
  let loaded: LoadedConfig;
  try {
    loaded = loadConfigDetailed(processEnv());
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(`configuration error (${error.code}):\n${error.message}`);
      return error.exitCode;
    }
    throw error;
  }

  switch (command) {
    case 'config': {
      const subcommand = rest.find((argument) => !argument.startsWith('-')) ?? 'check';
      if (subcommand !== 'check') {
        fail(
          `iridium config: unknown subcommand ${JSON.stringify(subcommand)} (expected \`check\`)`,
        );
        return EXIT.usage;
      }
      return configCheck(loaded, json);
    }
    case 'migrate':
      return migrate(loaded, rest);
    case 'serve':
      return serve();
    default:
      fail(`iridium: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return EXIT.usage;
  }
}

/**
 * The exit code an error declares, when it declares one. Every failure type in the boot path carries
 * `exitCode`, so the seven-code contract is a property of the thrown value rather than of a `catch`
 * block that has to recognise each type.
 */
function declaredExitCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('exitCode' in error)) return undefined;
  const value = error.exitCode;
  return typeof value === 'number' ? value : undefined;
}

/** The process entry. Kept separate from `run` so a test asserts exit codes without exiting. */
async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = declaredExitCode(error) ?? EXIT.internal;
  }
}

// `serve` never resolves until shutdown, so nothing here awaits the process exiting.
void main();
