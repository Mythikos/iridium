/**
 * `scripts/check-env-lists.ts` — the check 02-system-architecture.md names `check-env-lists`
 * ("Runtime configuration model" principle 7: *"Turborepo runs with `envMode: strict`;
 * `apps/server/turbo.json` lists every key the server reads, and the CI job `check-env-lists` fails
 * when the Turbo list and the `EnvSchema` keys differ in either direction"*; invariant 4 of
 * "Architectural invariants and their guard tests"; 12-milestones.md §3, the "Format and hygiene"
 * row; 13-decision-log.md A1's M0 verification list).
 *
 * `envMode: strict` means Turborepo hands a task **only** the variables some list names. A schema key
 * that no list names is therefore not "an untracked cache input" — it is a variable the server never
 * sees when it is started through `turbo run`, and the failure is a boot that exits `2` on a key the
 * operator did set, or worse a default silently taking effect. That is why the diff runs in both
 * directions: a name in the schema and not in Turbo is a knob that stops working under `turbo run`,
 * and a name in Turbo and not in the schema is a name nothing reads.
 *
 * ## Which keys are Turbo inputs, and in which field
 *
 * The rule is derived, never curated. Three questions decide every name, and each is answered by
 * something the repository already states rather than by a list kept here.
 *
 * **1. Which task declares them?** The one whose command starts a process that calls `loadConfig()`.
 * For `@iridium/server` that is `dev` alone (`node --watch src/main.ts serve`). `build`, `lint`,
 * `check-types` and `clean` run tools over source; `test` runs the `unit` project, which never reads
 * `process.env` (invariant 3 restricts reads to `config/**`, and 02's principle 4 has tests build an
 * environment *record*); and `test:integration` synthesises the whole product environment in
 * `packages/testkit/src/server/env.ts` — `buildServerEnv()` writes `DATABASE_URL`, `PUBLIC_ORIGIN`
 * and the fixture secrets itself, so the ambient environment supplies it nothing. Declaring the keys
 * on a task that does not read them would be exactly the drift this check exists to prevent, so
 * `ENV_READING_TASKS` is checked in both directions too.
 *
 * **2. `env` or `passThroughEnv`?** Whether the task is cached. `env` is a **cache-key**
 * declaration — changing one of its values must invalidate the task's output — and `passThroughEnv`
 * is a visibility declaration that does not enter the hash. No cacheable `@iridium/server` task reads
 * `process.env`, so no schema key can change a cached artefact; putting one in `env` would be a false
 * claim about what the cache depends on, and it would put a database password into a task hash for
 * nothing. The check therefore derives the field from the resolved task rather than hard-coding it:
 * `cache: false` → `passThroughEnv`, `cache: true` → `env`. Flip `dev` to cacheable and this check
 * tells you to move the list, which is the only honest thing it could say.
 *
 * **3. Which names beyond the schema keys?** Four families, each derived from an export of
 * `apps/server/src/config/env.ts`, because each is a name `EnvSchema` itself acts on and therefore a
 * name that has to survive strict mode for the schema's own rules to hold:
 *
 * | Family | Derived from | Why strict mode must not filter it |
 * |---|---|---|
 * | `<SECRET>_FILE` | `SINGLE_SECRET_KEYS` | principle 3's twin: a file-mounted secret arrives under this name and no other, so filtering it turns a configured password into an unset one |
 * | `<KEYRING>_V*` | `KEYRING_NAMES`, `RESERVED_KEYRING_NAME` | a keyring member is not a schema key (a keyring is *collected*, not parsed); the wildcard also covers each member's `_FILE` twin, and `ATTACHMENT_KEY_V*` is included so its refusal (G4) can fire at all |
 * | the alias spellings | `KEY_ALIASES` | an accepted alias that strict mode hides is precisely the silent misconfiguration the alias exists to prevent |
 * | `IRIDIUM_*` | `RESERVED_HARNESS_PREFIXES`, `RESERVED_HARNESS_KEYS`, `REJECTED_KEYS` | ARCH-25 is *typo protection*: `IRIDIUM_MIGRATE_ON_BOT` must reach the process to be fatal. Filtered, the typo is silently ignored under `turbo run` and fatal everywhere else — the one divergence between the two ways of starting the same binary that an operator would never think to look for. The wildcard also carries the reserved harness namespaces the `child` mode inherits and the two names refused by name |
 *
 * The five `IRIDIUM_*` schema keys stay listed literally as well as being covered by the wildcard.
 * The redundancy is deliberate: the literal list is the artefact this check diffs and the thing a
 * reader of `apps/server/turbo.json` is entitled to see in full, while the wildcard is a rule about
 * *unknown* names and says nothing about which keys exist.
 *
 * ## Where the two sides are read from
 *
 * The schema side is `apps/server/src/config/env.ts` imported under Node's native TypeScript. The
 * module is side-effect free — every export is a frozen constant or a function, and `process.env` is
 * touched only through a default argument — so importing it neither reads an environment nor opens
 * anything. It does pull in `@iridium/contracts` for `LIMITS`, which resolves to that package's
 * `dist`, so an unbuilt workspace is an environment error (exit `2`) naming the build, never a pass.
 *
 * The Turbo side is `turbo run <tasks> --filter=@iridium/server --dry=json`, not the JSON file. A
 * package configuration inherits from the root through `extends`, and array fields *replace* rather
 * than merge unless the `$TURBO_EXTENDS$` microsyntax says otherwise; re-implementing that resolution
 * here would give this check its own opinion about what Turborepo does, which is the one thing a gate
 * over Turborepo's configuration must not have. The dry run reports the resolved definition Turborepo
 * will actually use.
 *
 * The one property the dry run cannot show is order: Turborepo normalises the list alphabetically
 * before reporting it. Order is worth keeping — 11-operations-and-deployment.md calls the Turbo lists
 * "generated from the schema keys", and a hundred names in the schema's own grouped order is a file a
 * reviewer can read while a hundred in arrival order is not — so that one property is checked against
 * `apps/server/turbo.json` itself, and only once the two sets already agree.
 *
 * ## Scope
 *
 * `@iridium/server` is the only workspace with an `EnvSchema` to diff against. Every other
 * `turbo.json` is still read, and the ones that declare an `env` or `passThroughEnv` list are named
 * in the summary: a list that appears somewhere else is not a failure — nothing here knows what
 * `apps/web`'s Vite build reads — but it is something this check must not pass over in silence.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isFile, walkFiles } from './lib/files.ts';
import { arrayMember, isRecord, parseJson, recordMember, stringMember } from './lib/json.ts';
import { REPO_ROOT, SERVER_ROOT } from './lib/paths.ts';
import {
  MissingToolError,
  resolveTool,
  runToolOrThrow,
  ToolFailedError,
  type ToolSpec,
} from './lib/process.ts';

/** The workspace whose `EnvSchema` is the source of truth. */
const SERVER_PACKAGE = '@iridium/server';

/** `apps/server/src/config/env.ts` — the module the expected list is derived from. */
const ENV_MODULE = join(SERVER_ROOT, 'src', 'config', 'env.ts');

/** `apps/server/turbo.json` — the file every finding names. */
const SERVER_TURBO_JSON = join(SERVER_ROOT, 'turbo.json');

/** `turbo.json` at the workspace root, read for the task table and for `envMode`. */
const ROOT_TURBO_JSON = join(REPO_ROOT, 'turbo.json');

/**
 * The `@iridium/server` tasks whose command starts a process that calls `loadConfig()`.
 *
 * See the header, question 1. Checked in both directions: a task here that declares nothing is a
 * finding, and so is a task not here that declares a schema key.
 */
const ENV_READING_TASKS: readonly string[] = ['dev'];

/** The catalog pin of `pnpm-workspace.yaml`, printed beside the installed version. */
const TURBO: ToolSpec = { pkg: 'turbo', from: REPO_ROOT, pinnedVersion: '2.10.12' };

/** Indentation of an entry inside `tasks.<task>.<field>` in `apps/server/turbo.json`. */
const ENTRY_INDENT = ' '.repeat(8);

// -----------------------------------------------------------------------------------------------
// Reading JSON with comments
// -----------------------------------------------------------------------------------------------

/**
 * `JSON.parse` for a `turbo.json`.
 *
 * Turborepo accepts comments, and `apps/server/turbo.json` carries the rule this check enforces as
 * one, so the comments are removed before parsing. Trailing commas are deliberately left alone:
 * Turborepo rejects those too, so a file needing them stripped is a file Turborepo would not read
 * either, and a parse error naming the file is the honest report.
 */
function parseTurboJson(text: string): unknown {
  let out = '';
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const character = text[index] ?? '';
    const next = text[index + 1];

    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    out += character;
    index += 1;
  }
  return parseJson(out);
}

/** A `turbo.json` read from disk, or an environment error naming the file that would not parse. */
function readTurboJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new EnvironmentError(
      `${repoPath(path)} could not be read.\n` +
        'Remedy: this check diffs the Turborepo configuration against `EnvSchema`; it cannot run ' +
        'without it.',
    );
  }
  try {
    return parseTurboJson(text);
  } catch (error) {
    throw new EnvironmentError(
      `${repoPath(path)} is not valid JSON once comments are removed: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        'Remedy: Turborepo would refuse the same file — fix the syntax there first.',
    );
  }
}

// -----------------------------------------------------------------------------------------------
// The schema side
// -----------------------------------------------------------------------------------------------

/** One name `apps/server/turbo.json` has to declare, and the reason it is on the list. */
interface Expected {
  /** The literal name or wildcard pattern, exactly as it must appear. */
  readonly name: string;
  /** One clause, printed beside the name when it is missing. */
  readonly reason: string;
}

function stringList(module: unknown, name: string): readonly string[] {
  const raw = arrayMember(module, name);
  if (raw === undefined) {
    throw new EnvironmentError(
      `${repoPath(ENV_MODULE)} exports no \`${name}\` array.\n` +
        'Remedy: this check derives the Turborepo list from that export; restore it, or update ' +
        `${repoPath(join(REPO_ROOT, 'scripts', 'check-env-lists.ts'))} to the name that replaced it.`,
    );
  }
  const values = raw.filter((entry) => typeof entry === 'string');
  if (values.length !== raw.length) {
    throw new EnvironmentError(
      `${repoPath(ENV_MODULE)} exports \`${name}\` with a non-string entry.\n` +
        'Remedy: the export is a list of environment variable names; nothing else can be one.',
    );
  }
  return values;
}

function recordKeys(module: unknown, name: string): readonly string[] {
  const record = recordMember(module, name);
  if (record === undefined) {
    throw new EnvironmentError(
      `${repoPath(ENV_MODULE)} exports no \`${name}\` object.\n` +
        'Remedy: this check derives the Turborepo list from that export; restore it, or update ' +
        `${repoPath(join(REPO_ROOT, 'scripts', 'check-env-lists.ts'))} to the name that replaced it.`,
    );
  }
  return Object.keys(record);
}

/** The exports of `config/env.ts` this check derives the expected list from. */
interface EnvSchemaFacts {
  readonly schemaKeys: readonly string[];
  readonly singleSecretKeys: readonly string[];
  readonly keyringNames: readonly string[];
  readonly reservedKeyringName: string;
  readonly aliases: readonly string[];
}

async function readEnvSchemaFacts(): Promise<EnvSchemaFacts> {
  let module: unknown;
  try {
    module = await import(pathToFileURL(ENV_MODULE).href);
  } catch (error) {
    throw new EnvironmentError(
      `${repoPath(ENV_MODULE)} could not be imported: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        "It reads `LIMITS` from @iridium/contracts, which resolves to that package's `dist`.\n" +
        'Remedy: run `pnpm turbo run build --filter=@iridium/contracts` and try again; this check ' +
        'never passes on an input it could not read.',
    );
  }
  if (!isRecord(module)) {
    throw new EnvironmentError(`${repoPath(ENV_MODULE)} did not import as a module namespace.`);
  }
  const reservedKeyringName = stringMember(module, 'RESERVED_KEYRING_NAME');
  if (reservedKeyringName === undefined) {
    throw new EnvironmentError(
      `${repoPath(ENV_MODULE)} exports no \`RESERVED_KEYRING_NAME\` string.\n` +
        'Remedy: this check derives the reserved keyring wildcard from that export.',
    );
  }
  return {
    schemaKeys: stringList(module, 'ENV_SCHEMA_KEYS'),
    singleSecretKeys: stringList(module, 'SINGLE_SECRET_KEYS'),
    keyringNames: stringList(module, 'KEYRING_NAMES'),
    reservedKeyringName,
    aliases: recordKeys(module, 'KEY_ALIASES'),
  };
}

/**
 * Every name `apps/server/turbo.json` must declare, in the order it must declare it: the schema key
 * table first, in its own order, then the derived families, then the typo-protection wildcard.
 *
 * The order is enforced because the file is a rendering of the schema rather than a list somebody
 * curates — 11-operations-and-deployment.md, "Configuration and secrets", calls the Turbo lists
 * "generated from the schema keys" — so the remedy for any drift can be a block to paste.
 */
function expectedDeclarations(facts: EnvSchemaFacts): readonly Expected[] {
  const expected: Expected[] = facts.schemaKeys.map((name) => ({
    name,
    reason: 'an `EnvSchema` key',
  }));

  for (const secret of facts.singleSecretKeys) {
    expected.push({
      name: `${secret}_FILE`,
      reason: `the \`_FILE\` twin of ${secret}, which is how a mounted secret arrives`,
    });
  }
  for (const keyring of [...facts.keyringNames, facts.reservedKeyringName]) {
    expected.push({
      name: `${keyring}_V*`,
      reason:
        keyring === facts.reservedKeyringName
          ? `the reserved ${keyring} keyring, which must be visible for its refusal to fire`
          : `the ${keyring} keyring family and its \`_FILE\` twins`,
    });
  }
  for (const alias of facts.aliases) {
    expected.push({
      name: alias,
      reason: 'an accepted `KEY_ALIASES` spelling, which is useless if it never reaches the parser',
    });
  }
  expected.push({
    name: 'IRIDIUM_*',
    reason:
      'ARCH-25 typo protection, the reserved harness namespaces and the names refused by name, ' +
      'none of which can act on a variable strict mode filtered out',
  });
  return expected;
}

// -----------------------------------------------------------------------------------------------
// The Turborepo side
// -----------------------------------------------------------------------------------------------

/** One resolved `@iridium/server` task as `--dry=json` reports it. */
interface ResolvedTask {
  readonly task: string;
  readonly cache: boolean;
  readonly env: readonly string[];
  readonly passThroughEnv: readonly string[];
  readonly envMode: string;
}

function namesOf(definition: unknown, field: string): readonly string[] {
  const raw = arrayMember(definition, field);
  if (raw === undefined) return [];
  return raw.filter((entry) => typeof entry === 'string');
}

/** The tasks the root `turbo.json` defines that `apps/server/package.json` has a script for. */
function serverTaskNames(rootConfig: unknown): readonly string[] {
  const tasks = recordMember(rootConfig, 'tasks');
  if (tasks === undefined) {
    throw new EnvironmentError(
      `${repoPath(ROOT_TURBO_JSON)} declares no \`tasks\` object.\n` +
        'Remedy: this check asks Turborepo to resolve those tasks for @iridium/server.',
    );
  }
  const manifestPath = join(SERVER_ROOT, 'package.json');
  if (!isFile(manifestPath)) {
    throw new EnvironmentError(`${repoPath(manifestPath)} is missing.`);
  }
  const scripts = recordMember(parseJson(readFileSync(manifestPath, 'utf8')), 'scripts') ?? {};
  const names = Object.keys(tasks).filter((task) => Object.hasOwn(scripts, task));
  if (names.length === 0) {
    throw new EnvironmentError(
      `${repoPath(manifestPath)} has no script matching any task in ${repoPath(ROOT_TURBO_JSON)}.\n` +
        'Remedy: this check has nothing to resolve; one of the two files is wrong.',
    );
  }
  return names.toSorted((a, b) => a.localeCompare(b));
}

/** `turbo run <tasks> --filter=@iridium/server --dry=json`, parsed. */
function resolveServerTasks(taskNames: readonly string[]): readonly ResolvedTask[] {
  let stdout: string;
  try {
    const tool = resolveTool(TURBO);
    stdout = runToolOrThrow(
      tool,
      ['run', ...taskNames, `--filter=${SERVER_PACKAGE}`, '--dry=json'],
      { cwd: REPO_ROOT },
    ).stdout;
  } catch (error) {
    if (error instanceof MissingToolError || error instanceof ToolFailedError) {
      throw new EnvironmentError(
        `turbo could not resolve the ${SERVER_PACKAGE} task definitions: ${error.message}\n` +
          'Remedy: this check reads the definitions Turborepo resolves rather than re-implementing ' +
          '`extends`; without them it has nothing to diff.',
      );
    }
    throw error;
  }

  const document = parseJson(stdout);
  const tasks = arrayMember(document, 'tasks');
  if (tasks === undefined) {
    throw new EnvironmentError(
      'turbo `--dry=json` produced no `tasks` array.\n' +
        `Remedy: check \`turbo run ${taskNames.join(' ')} --filter=${SERVER_PACKAGE} --dry=json\` by hand.`,
    );
  }

  const resolved: ResolvedTask[] = [];
  for (const entry of tasks) {
    if (stringMember(entry, 'package') !== SERVER_PACKAGE) continue;
    const definition = recordMember(entry, 'resolvedTaskDefinition');
    const task = stringMember(entry, 'task');
    if (definition === undefined || task === undefined) continue;
    resolved.push({
      task,
      cache: definition['cache'] !== false,
      env: namesOf(definition, 'env'),
      passThroughEnv: namesOf(definition, 'passThroughEnv'),
      envMode: stringMember(entry, 'envMode') ?? '',
    });
  }
  if (resolved.length === 0) {
    throw new EnvironmentError(
      `turbo \`--dry=json\` reported no ${SERVER_PACKAGE} task.\n` +
        `Remedy: check that the filter still matches — the tasks asked for were ${taskNames.join(', ')}.`,
    );
  }
  return resolved.toSorted((a, b) => a.task.localeCompare(b.task));
}

// -----------------------------------------------------------------------------------------------
// The other workspaces
// -----------------------------------------------------------------------------------------------

/** A workspace `turbo.json` other than the root's, and whether it declares an env list. */
interface WorkspaceConfig {
  readonly path: string;
  readonly fields: readonly string[];
}

/**
 * Every `turbo.json` under the repository except the root's, with the tasks that declare an `env` or
 * `passThroughEnv` list. `walkFiles` skips `node_modules`, `dist` and `.stryker-tmp` by name.
 */
function workspaceConfigs(): readonly WorkspaceConfig[] {
  const found: WorkspaceConfig[] = [];
  for (const file of walkFiles(REPO_ROOT)) {
    if (!file.path.endsWith('turbo.json')) continue;
    if (file.path === ROOT_TURBO_JSON) continue;
    const tasks = recordMember(readTurboJson(file.path), 'tasks') ?? {};
    const fields: string[] = [];
    for (const [task, definition] of Object.entries(tasks)) {
      for (const field of ['env', 'passThroughEnv']) {
        if (arrayMember(definition, field) !== undefined) fields.push(`${task}.${field}`);
      }
    }
    found.push({ path: file.path, fields: fields.toSorted((a, b) => a.localeCompare(b)) });
  }
  return found;
}

// -----------------------------------------------------------------------------------------------
// The check
// -----------------------------------------------------------------------------------------------

/** The paste-ready block a failure prints, so the remedy is mechanical rather than transcribed. */
function renderBlock(field: string, expected: readonly Expected[]): readonly string[] {
  return [
    `The ${field} list ${repoPath(SERVER_TURBO_JSON)} must carry, in this order:`,
    `      "${field}": [`,
    // No trailing comma on the last entry: Turborepo rejects one, so a block that cannot be pasted
    // verbatim would be a remedy that does not work.
    ...expected.map(
      (entry, index) => `${ENTRY_INDENT}"${entry.name}"${index === expected.length - 1 ? '' : ','}`,
    ),
    '      ]',
  ];
}

/**
 * The order finding, read from `apps/server/turbo.json` rather than from the resolved definition,
 * because Turborepo normalises the list alphabetically before reporting it.
 *
 * Called only once the two *sets* agree, so it can assume the file carries exactly the expected names
 * and report the first position where the rendering differs. A leading `$TURBO_EXTENDS$` marker is
 * skipped: it is a microsyntax element, not a name, and it has to stay first.
 */
function orderFinding(
  taskName: string,
  field: string,
  expected: readonly Expected[],
  findings: Finding[],
): void {
  const declaration = recordMember(readTurboJson(SERVER_TURBO_JSON), 'tasks');
  const written = (arrayMember(declaration?.[taskName], field) ?? [])
    .filter((entry) => typeof entry === 'string')
    .filter((entry) => entry !== '$TURBO_EXTENDS$');
  // The sets agree through the resolved definition; a different length here means inheritance is
  // supplying part of the list, and the file's order is then not a rendering of anything.
  if (written.length !== expected.length) return;

  const index = expected.findIndex((entry, position) => written[position] !== entry.name);
  if (index === -1) return;
  findings.push(
    finding(
      SERVER_TURBO_JSON,
      `\`${taskName}.${field}\` carries every expected name but in a different order; the first difference is ` +
        `at entry ${String(index + 1)} — \`${written[index] ?? ''}\` where \`${expected[index]?.name ?? ''}\` belongs.`,
      'reorder it to the `ENV_SCHEMA_KEYS` table followed by the derived families; the list is a ' +
        "rendering of `EnvSchema`, so its order is that module's.",
    ),
  );
}

function checkEnvMode(tasks: readonly ResolvedTask[], findings: Finding[]): void {
  const loose = tasks.filter((task) => task.envMode !== 'strict');
  if (loose.length === 0) return;
  findings.push(
    finding(
      ROOT_TURBO_JSON,
      `${loose.map((task) => task.task).join(', ')} resolve with envMode ` +
        `${loose[0]?.envMode === '' ? 'unset' : `\`${loose[0]?.envMode ?? ''}\``}, not \`strict\`.`,
      'restore `"envMode": "strict"` at the root; without it every variable reaches every task and ' +
        'the list this check diffs guarantees nothing (02-system-architecture.md, principle 7).',
    ),
  );
}

export const check: Check = {
  name: 'check-env-lists',
  workflow: 'ci.yml › static › `Env lists`',
  owns: '02-system-architecture.md, "Runtime configuration model" principle 7 and invariant 4',
  async run(argv: readonly string[]): Promise<CheckResult> {
    if (argv.length > 0) {
      throw new EnvironmentError(
        `check-env-lists takes no arguments; received ${argv.join(' ')}.\n` +
          'Remedy: run `node scripts/check-env-lists.ts`.',
      );
    }

    const facts = await readEnvSchemaFacts();
    const expected = expectedDeclarations(facts);
    const expectedNames = new Set(expected.map((entry) => entry.name));

    const rootConfig = readTurboJson(ROOT_TURBO_JSON);
    const tasks = resolveServerTasks(serverTaskNames(rootConfig));

    const findings: Finding[] = [];
    const details: string[] = [];
    checkEnvMode(tasks, findings);

    const declaring = tasks.filter((task) =>
      [...task.env, ...task.passThroughEnv].some((name) => expectedNames.has(name)),
    );

    for (const task of declaring) {
      if (ENV_READING_TASKS.includes(task.task)) continue;
      findings.push(
        finding(
          SERVER_TURBO_JSON,
          `the \`${task.task}\` task declares \`EnvSchema\` keys, but its command starts no process ` +
            'that calls `loadConfig()`.',
          `move them to \`${ENV_READING_TASKS.join('`/`')}\` — a key declared on a task that never ` +
            'reads it is the drift this check exists to catch.',
        ),
      );
    }

    for (const name of ENV_READING_TASKS) {
      const task = tasks.find((candidate) => candidate.task === name);
      if (task === undefined) {
        findings.push(
          finding(
            SERVER_TURBO_JSON,
            `\`${name}\` is named as the task that reads the environment, but Turborepo resolves no ` +
              `such task for ${SERVER_PACKAGE}.`,
            'either restore the task or update `ENV_READING_TASKS` in scripts/check-env-lists.ts to ' +
              'the task that now starts the server.',
          ),
        );
        continue;
      }

      // The header, question 2: the field is a property of the task, not a preference.
      const field = task.cache ? 'env' : 'passThroughEnv';
      const other = task.cache ? 'passThroughEnv' : 'env';
      const declared = field === 'env' ? task.env : task.passThroughEnv;
      const misplaced = (field === 'env' ? task.passThroughEnv : task.env).filter((declared_) =>
        expectedNames.has(declared_),
      );

      if (misplaced.length > 0) {
        findings.push(
          finding(
            SERVER_TURBO_JSON,
            `\`${task.task}\` is \`cache: ${String(task.cache)}\`, so its ${String(misplaced.length)} ` +
              `schema name(s) belong in \`${field}\`, not \`${other}\`.`,
            task.cache
              ? "a cached task's inputs must enter its hash, so move the list to `env` — or restore " +
                  '`cache: false`, which is what made `passThroughEnv` right.'
              : 'an uncached task has no hash for them to enter, so move the list to `passThroughEnv`; ' +
                  '`env` would also put a database password into a task hash for nothing.',
          ),
        );
      }

      const declaredSet = new Set(declared);
      const missingInTurbo = expected.filter((entry) => !declaredSet.has(entry.name));
      const missingInSchema = declared.filter((declared_) => !expectedNames.has(declared_));

      for (const entry of missingInTurbo) {
        findings.push(
          finding(
            SERVER_TURBO_JSON,
            `\`${entry.name}\` is ${entry.reason}, and \`${task.task}.${field}\` does not list it.`,
            `add it — under \`envMode: strict\` a name no list carries never reaches the server, so ` +
              'the knob silently stops working when the process is started through `turbo run`.',
          ),
        );
      }
      for (const unknownName of missingInSchema) {
        findings.push(
          finding(
            SERVER_TURBO_JSON,
            `\`${task.task}.${field}\` lists \`${unknownName}\`, which \`EnvSchema\` does not know and ` +
              'which no rule of `config/env.ts` derives.',
            `remove it, or add the key to \`ENV_SCHEMA_KEYS\` in ${repoPath(ENV_MODULE)} if the ` +
              'server is supposed to read it.',
          ),
        );
      }

      if (missingInTurbo.length === 0 && missingInSchema.length === 0) {
        orderFinding(task.task, field, expected, findings);
      }

      details.push(
        `${task.task}: cache ${String(task.cache)}, envMode ${task.envMode}, ` +
          `${String(declared.length)} name(s) in \`${field}\`.`,
      );
    }

    const counts =
      `${String(facts.schemaKeys.length)} EnvSchema key(s), ` +
      `${String(facts.singleSecretKeys.length)} \`_FILE\` twin(s), ` +
      `${String(facts.keyringNames.length + 1)} keyring wildcard(s), ` +
      `${String(facts.aliases.length)} accepted alias(es), 1 typo-protection wildcard.`;
    details.push(`Expected ${String(expected.length)} name(s): ${counts}`);
    details.push(
      `Tasks Turborepo resolves for ${SERVER_PACKAGE}: ` +
        tasks.map((task) => task.task).join(', ') +
        '.',
    );

    const others = workspaceConfigs().filter((config) => config.path !== SERVER_TURBO_JSON);
    const declaringOthers = others.filter((config) => config.fields.length > 0);
    details.push(
      declaringOthers.length === 0
        ? `${String(others.length)} other workspace turbo.json file(s) declare no env list; ` +
            `${SERVER_PACKAGE} is the only workspace with an \`EnvSchema\` to diff against.`
        : `${String(declaringOthers.length)} other workspace(s) declare an env list, and no schema ` +
            'names what they read, so they are reported rather than diffed: ' +
            declaringOthers
              .map((config) => `${repoPath(dirname(config.path))} (${config.fields.join(', ')})`)
              .join('; ') +
            '.',
    );

    if (findings.length > 0) {
      const target = tasks.find((task) => ENV_READING_TASKS.includes(task.task));
      details.push(...renderBlock(target?.cache === true ? 'env' : 'passThroughEnv', expected));
    }

    return {
      summary:
        findings.length === 0
          ? `the ${String(expected.length)} name(s) ${repoPath(SERVER_TURBO_JSON)} declares and the ` +
            `${String(facts.schemaKeys.length)} \`EnvSchema\` key(s) agree in both directions.`
          : `${repoPath(SERVER_TURBO_JSON)} and \`EnvSchema\` disagree.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
