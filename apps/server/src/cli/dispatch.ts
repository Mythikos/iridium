/**
 * The dispatcher: argv in, exit code out.
 *
 * It resolves a command and a subcommand against `CLI_COMMANDS`, parses that subcommand's declared
 * flags, builds the OPS-19 audit context once, boots the application if the subcommand asked for one,
 * resolves `--actor`, and runs the body. Nothing here knows what any command *does* — that is what
 * keeps `main.ts` a process entry and the command modules independently testable.
 *
 * It is a module rather than a function inside `main.ts` for one reason M0's header already stated
 * and could not deliver: *"kept separate from `main` so a test asserts exit codes without exiting"*.
 * `main.ts` calls `void main()` at module scope, so importing it to test `run()` would start a server.
 * With the dispatcher here, `cli.dispatch.unit` drives every refusal path with a buffered `CliIo` and
 * a synthetic environment, and no process is spawned.
 *
 * **The order of refusals is deliberate.** A reserved name is refused before an unknown one, a
 * declared flag is parsed before anything connects, and the configuration is parsed before any
 * command that needs it runs — so `2` really does mean "nothing was started" and `3` really does mean
 * "the command understood you and refused".
 */
import { ConfigError, loadConfigDetailed, type LoadedConfig, type RawEnv } from '../config/env.ts';
import { assertSingleYjsInstance } from '../ops/yjs-single-instance.ts';
import { withCliApp, requireDatabase } from './app.ts';
import { argvShape, parseArgs, type CliArgs } from './args.ts';
import {
  cliAuditContext,
  newRequestId,
  resolveCliActor,
  SYSTEM_ACTOR,
  type CliActor,
} from './attribution.ts';
import {
  commandByName,
  RESERVED_COMMANDS,
  subcommandByName,
  USAGE,
  type CliCommand,
  type CliSubcommand,
} from './commands.ts';
import { EXIT } from './exit.ts';
import type { CliIo } from './output.ts';

/** What the dispatcher needs from the process. */
export interface DispatchOptions {
  readonly io: CliIo;
  /** `processEnv()` in the binary; a literal object in a test. `main.ts` is the only reader of it. */
  readonly env: RawEnv;
}

/**
 * Parses argv and runs one command.
 *
 * Every path answers with an exit code; only an unexpected internal failure throws, and `main.ts`
 * maps that to `1` with the stack on stderr.
 */
export async function runCli(argv: readonly string[], options: DispatchOptions): Promise<number> {
  assertSingleYjsInstance();
  const { io } = options;
  const [word = '', ...rest] = argv;

  // `help` is a command word, so it counts only in first position: `--display-name help` is a name.
  if (word === '' || isHelp(word) || rest.some((argument) => isHelpFlag(argument))) {
    io.out(USAGE);
    return word === '' ? EXIT.usage : EXIT.success;
  }

  if (RESERVED_COMMANDS.includes(word)) {
    io.err(
      `iridium ${word}: not_implemented in this build. The command is reserved by ` +
        '11-operations-and-deployment.md, "Command inventory", and arrives with the milestone that ' +
        'gives it something to do.',
    );
    return EXIT.refused;
  }

  const command = commandByName(word === '--version' || word === '-v' ? 'version' : word);
  if (command === undefined) {
    io.err(`iridium: unknown command ${JSON.stringify(word)}\n\n${USAGE}`);
    return EXIT.usage;
  }

  const resolved = resolveSubcommand(command, rest);
  if (!resolved.ok) {
    io.err(resolved.message);
    return resolved.exitCode;
  }

  const parsed = parseArgs(resolved.rest, resolved.subcommand.flags);
  if (!parsed.ok) {
    io.err(`iridium ${resolved.path}: ${parsed.message}${misplacedHint(command, resolved)}`);
    return EXIT.usage;
  }
  const extra = unexpectedPositionals(resolved.subcommand, parsed.args);
  if (extra !== null) {
    io.err(`iridium ${resolved.path}: ${extra}${misplacedHint(command, resolved)}`);
    return EXIT.usage;
  }

  // Every command that reads the environment fails the same way when it is wrong: the prettified
  // parse error to stderr and exit 2, with nothing started. `version` declares `needsConfig: false`
  // and is answered without a parse, so it still works inside a deployment that cannot boot.
  let loaded: LoadedConfig | null = null;
  if (resolved.subcommand.needsConfig) {
    try {
      loaded = loadConfigDetailed(options.env);
    } catch (error) {
      if (error instanceof ConfigError) {
        io.err(`configuration error (${error.code}):\n${error.message}`);
        return error.exitCode;
      }
      throw error;
    }
  }

  const requestId = newRequestId();
  const auditContext = cliAuditContext({
    requestId,
    argvShape: argvShape(resolved.path.split(' '), resolved.rest, resolved.subcommand.flags),
  });

  const base = {
    io,
    loaded,
    args: parsed.args,
    path: resolved.path,
    auditContext,
    requestId,
  };

  if (loaded === null || !resolved.subcommand.needsApp(parsed.args)) {
    return resolved.subcommand.run({ ...base, actor: SYSTEM_ACTOR, app: null });
  }

  return withCliApp(loaded.config, async (app) => {
    const actorEmail = parsed.args.value('actor');
    let actor: CliActor = SYSTEM_ACTOR;
    if (actorEmail !== undefined) {
      const result = await resolveCliActor(requireDatabase(app, resolved.path), actorEmail);
      if (!result.ok) {
        io.err(`iridium ${resolved.path}: ${result.message}`);
        return EXIT.refused;
      }
      actor = result.actor;
    }
    return resolved.subcommand.run({ ...base, actor, app });
  });
}

/** `--help`, `-h` and the bare word `help`, which M0 all answered with the usage text. */
function isHelp(argument: string): boolean {
  return isHelpFlag(argument) || argument === 'help';
}

/** The flag spellings only, which are unambiguous anywhere in the argument list. */
function isHelpFlag(argument: string): boolean {
  return argument === '--help' || argument === '-h';
}

/** What resolving a subcommand answers. */
type SubcommandResult =
  | {
      readonly ok: true;
      readonly subcommand: CliSubcommand;
      /** `admin create-user`, for messages, `argv_shape` and `SystemPrincipal.job`. */
      readonly path: string;
      /** Everything after the command and subcommand words. */
      readonly rest: readonly string[];
    }
  | { readonly ok: false; readonly message: string; readonly exitCode: number };

/**
 * Resolves the subcommand word.
 *
 * Only the **first** word after the command is considered, and only when it is not a flag. Searching
 * the whole argument list — which M0's `config` did, harmlessly, because `--json` was its only flag —
 * would read the value of `--actor ops@example.com` as a subcommand the moment a value flag existed.
 */
function resolveSubcommand(command: CliCommand, rest: readonly string[]): SubcommandResult {
  const bare = subcommandByName(command, null);
  if (bare !== undefined) return { ok: true, subcommand: bare, path: command.name, rest };

  const head = rest[0];
  const word = head !== undefined && !head.startsWith('--') ? head : undefined;
  const name = word ?? command.defaultSubcommand;
  const spellings = command.subcommands
    .map((subcommand) => subcommand.name)
    .filter((subcommand): subcommand is string => subcommand !== null);

  if (name === null || name === undefined) {
    return {
      ok: false,
      exitCode: EXIT.usage,
      message: `iridium ${command.name}: expected a subcommand (${spellings.join(', ')})`,
    };
  }
  if (command.reserved.includes(name)) {
    return {
      ok: false,
      exitCode: EXIT.refused,
      message:
        `iridium ${command.name} ${name}: not_implemented in this build. The subcommand is ` +
        'reserved by 11-operations-and-deployment.md, "Command inventory", and arrives with the ' +
        'milestone that gives it something to do.',
    };
  }

  const subcommand = subcommandByName(command, name);
  if (subcommand === undefined) {
    return {
      ok: false,
      exitCode: EXIT.usage,
      message:
        `iridium ${command.name}: unknown subcommand ${JSON.stringify(name)}. This build answers ` +
        `${spellings.join(', ')}.`,
    };
  }
  return {
    ok: true,
    subcommand,
    path: `${command.name} ${name}`,
    rest: word === undefined ? rest : rest.slice(1),
  };
}

/**
 * The extra sentence for the mistake a default subcommand makes possible.
 *
 * `iridium migrate --actor a@example.test up` resolves to `migrate status`, because only the first
 * word is read as a subcommand and this one is a flag — which is correct (otherwise `--actor`'s value
 * would be read as a subcommand) but leaves a refusal that talks about the wrong subcommand. When one
 * of the remaining words names a real subcommand, the refusal says where it belongs.
 */
function misplacedHint(
  command: CliCommand,
  resolved: { readonly rest: readonly string[] },
): string {
  const named = resolved.rest.find(
    (argument) =>
      !argument.startsWith('--') &&
      (command.subcommands.some((subcommand) => subcommand.name === argument) ||
        command.reserved.includes(argument)),
  );
  return named === undefined
    ? ''
    : ` Did you mean \`iridium ${command.name} ${named} …\`? The subcommand comes before the flags.`;
}

/** The refusal for a word a subcommand does not take, or `null` when the positionals are legal. */
function unexpectedPositionals(subcommand: CliSubcommand, args: CliArgs): string | null {
  const allowed = subcommand.positional === null ? 0 : 1;
  if (args.positionals.length <= allowed) return null;
  const surplus = args.positionals.slice(allowed);
  return (
    `unexpected argument ${JSON.stringify(surplus[0] ?? '')}. This command takes ` +
    (subcommand.positional === null
      ? 'no positional arguments; every value belongs to a flag.'
      : `one positional argument, ${subcommand.positional}.`)
  );
}
