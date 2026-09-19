/**
 * Flag parsing for the operator CLI.
 *
 * One parser for every command, declared per command as a table of flag names, because the
 * alternative — each command reading `argv.includes('--json')` — is how `iridium audit verify-chain
 * --chian vault:…` silently verifies every chain instead of refusing. Every deviation is a usage
 * error (exit `2`, "nothing was started") carrying the accepted flags, so the remedy is in the
 * refusal rather than in a manual.
 *
 * The accepted spellings are `--flag`, `--flag value` and `--flag=value`. There is no single-dash
 * form and no flag clustering: the command inventory of 11-operations-and-deployment.md spells every
 * flag long, and a `-c` that four commands each read differently is exactly the ambiguity an
 * operations tool should not have. `-h` and `-v` are handled by the dispatcher before any command's
 * flags are parsed, because they are questions about the binary rather than about a command.
 */

/** Whether a flag stands alone (`--server-admin`) or takes the next word (`--email <address>`). */
export type FlagKind = 'switch' | 'value';

/** The flags one command accepts, by name without the leading dashes. */
export type FlagSpec = Readonly<Record<string, FlagKind>>;

/** The parsed argv of one command. */
export class CliArgs {
  readonly #values: ReadonlyMap<string, string>;
  readonly #switches: ReadonlySet<string>;
  readonly #positionals: readonly string[];

  constructor(options: {
    readonly values: ReadonlyMap<string, string>;
    readonly switches: ReadonlySet<string>;
    readonly positionals: readonly string[];
  }) {
    this.#values = options.values;
    this.#switches = options.switches;
    this.#positionals = options.positionals;
  }

  /** The value of a `value` flag, or `undefined` when it was not given. */
  value(name: string): string | undefined {
    return this.#values.get(name);
  }

  /** Whether a `switch` flag was given. */
  has(name: string): boolean {
    return this.#switches.has(name);
  }

  /** The words that carried no flag, in order — `migrate to <name>`'s argument, for example. */
  get positionals(): readonly string[] {
    return this.#positionals;
  }
}

/** What `parseArgs` answers: the parsed flags, or the sentence the operator needs. */
export type ParseResult =
  | { readonly ok: true; readonly args: CliArgs }
  | { readonly ok: false; readonly message: string };

/** The accepted flags, rendered for a refusal so the remedy never has to be looked up. */
function accepted(spec: FlagSpec): string {
  const names = Object.entries(spec).map(([name, kind]) =>
    kind === 'switch' ? `--${name}` : `--${name} <value>`,
  );
  return names.length === 0 ? 'this command takes no flags' : `accepted flags: ${names.join(', ')}`;
}

/**
 * Parses one command's argv against its flag table.
 *
 * A repeated flag is refused rather than resolved last-wins: two values for one flag is a mistake in
 * the command line, and choosing one of them silently is how an operator revokes the wrong user's
 * sessions.
 */
export function parseArgs(argv: readonly string[], spec: FlagSpec): ParseResult {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }

    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    const inline = separator === -1 ? undefined : argument.slice(separator + 1);
    const kind = spec[name];

    if (kind === undefined) {
      return {
        ok: false,
        message: `unknown flag ${JSON.stringify(argument)}; ${accepted(spec)}`,
      };
    }
    if (values.has(name) || switches.has(name)) {
      return {
        ok: false,
        message: `--${name} was given more than once; two values for one flag is a mistake in the command line, not a choice to resolve`,
      };
    }
    if (kind === 'switch') {
      if (inline !== undefined) {
        return { ok: false, message: `--${name} takes no value; write it as --${name}` };
      }
      switches.add(name);
      continue;
    }

    // `--flag=value` first, then `--flag value`. A following word that itself starts with `--` is a
    // flag, not this one's value: `--chain --json` is a missing argument, and silently consuming the
    // next flag would verify the wrong thing and report success.
    const next = argv[index + 1];
    const value = inline ?? (next !== undefined && !next.startsWith('--') ? next : undefined);
    if (value === undefined || value === '') {
      return {
        ok: false,
        message: `--${name} needs a value, for example --${name} <value>`,
      };
    }
    if (inline === undefined) index += 1;
    values.set(name, value);
  }

  return { ok: true, args: new CliArgs({ values, switches, positionals }) };
}

/**
 * `audit_events.context.argv_shape` (OPS-19): the command path with every value elided.
 *
 * `path` is the command words the dispatcher resolved (`['admin', 'create-user']`) and `rest` is
 * what followed them, so everything in `rest` is either a flag name or a value — which is what makes
 * the elision total rather than best-effort. An email address, a note id, a chain id and a migration
 * name are all values an auditor does not need and a forensic reader should not be shown, and
 * `iridium admin create-user --email <value> --display-name <value> --server-admin` still answers
 * "what was run" exactly.
 */
export function argvShape(
  path: readonly string[],
  rest: readonly string[],
  spec: FlagSpec,
): string {
  const shape: string[] = [...path];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index] ?? '';
    if (!argument.startsWith('--')) {
      shape.push('<value>');
      continue;
    }
    const separator = argument.indexOf('=');
    const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
    shape.push(`--${name}`);
    if (spec[name] !== 'value') continue;
    shape.push('<value>');
    if (separator !== -1) continue;
    const next = rest[index + 1];
    if (next !== undefined && !next.startsWith('--')) index += 1;
  }
  return shape.join(' ');
}
