// The Yjs single-instance guard must be the first import of this process: the interception happens at
// module evaluation, and it has to be in place before the copy of yjs that announces itself is
// evaluated -- which, under ESM, is before the body of any module that imported it. It is written as a
// bare side-effect import, and it is the first statement in the file, because `sortImports` reorders
// named imports alphabetically but leaves a side-effect import where it stands. An import of
// `./cli/dispatch.ts` above this line would reach `@iridium/crdt` first and the guard would observe
// nothing and pass on a broken process (A14) -- which is the exact shape of bug it exists to catch.
// eslint-disable-next-line import/no-unassigned-import -- the guard installs its interception at module evaluation and must be evaluated before any import that can reach yjs (A14)
import './ops/yjs-single-instance.ts';
/**
 * `iridium` -- the CLI entry, and the same binary as the server (`dist/main.mjs`).
 *
 * This file is the **process**: it reads the environment, hands argv to the dispatcher, and turns a
 * returned code or a thrown error into `process.exitCode`. Every command body lives in
 * `apps/server/src/cli/<command>.ts`, the inventory lives in `cli/commands.ts` and the resolution
 * lives in `cli/dispatch.ts`, so that `cli.dispatch.unit` can drive every refusal path without
 * spawning a process -- which is what M0's header promised by keeping `run` separate from `main` and
 * could not deliver while both lived beside the `void main()` at the bottom of this file.
 *
 * Every command loads the same configuration through `loadConfig()` and, where it needs the database,
 * boots the same `buildApp` the server boots -- so a CLI command can never see a different schema, a
 * different validation or a different set of secrets than the running server.
 *
 * Exit codes are the seven-code contract of OPS-16, restated as ARCH-22, and they live in
 * `cli/exit.ts`; every wrapper script, systemd unit and CI drill branches on those numbers.
 *
 * This file and `config/**` are the only places `process.env` may be read (oxlint
 * `node/no-process-env`), which is why the dispatcher takes the environment as an argument.
 */
import { runCli } from './cli/dispatch.ts';
import { EXIT } from './cli/exit.ts';
import { PROCESS_IO } from './cli/output.ts';
import { processEnv } from './config/process-env.ts';

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

/** The process entry. Kept separate from `runCli` so a test asserts exit codes without exiting. */
async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      io: PROCESS_IO,
      env: processEnv(),
    });
  } catch (error) {
    // The only place this binary writes outside pino and the command output, and deliberately so: a
    // configuration failure happens before a logger exists, and an operator reading `docker compose
    // up` needs the reason rather than a silent exit.
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = declaredExitCode(error) ?? EXIT.internal;
  }
}

// `serve` never resolves until shutdown, so nothing here awaits the process exiting.
void main();
