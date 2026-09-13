/**
 * The one place `process.env` is read (02-system-architecture.md, "Runtime configuration model",
 * principle 4; oxlint `node/no-process-env` exempts `config/**` and `main.ts` and nothing else).
 *
 * Every other module — `loadConfig`, the healthcheck probe, the CLI — takes an environment
 * *record* as a parameter, which is what lets a test build an environment without mutating the
 * process and what makes "configuration is parsed exactly once" a property of the code rather than
 * a convention.
 */

/** A raw environment as the schema sees it: names to values, absent keys undefined. */
export type RawEnv = Readonly<Record<string, string | undefined>>;

/** Reads the live process environment. Callers never mutate the returned object. */
export function processEnv(): RawEnv {
  return process.env;
}
