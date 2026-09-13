/**
 * The configuration failure type. Every one of these exits `2` — "configuration or usage error" in
 * the seven-code CLI contract (11-operations-and-deployment.md OPS-16, restated as ARCH-22) — and
 * carries a stable `code` so a runbook can name the failure rather than quote a sentence.
 *
 * Nothing here ever includes a secret value: the message may name a *key*, a *file path* and a
 * fingerprint, which is what an operator needs to fix a mount, and never material.
 */

/** The stable configuration failure codes the plan names. */
export const CONFIG_ERROR_CODES = [
  'config.unknown_key',
  'config.rejected_key',
  'config.invalid',
  'config.secret_both_forms',
  'config.secret_unreadable',
  'config.secret_missing',
  'config.not_implemented',
  'config.test_knob_in_production',
  'config.pretty_logs_in_production',
  'config.pressure_above_heap_limit',
] as const;

/** A member of the closed configuration failure vocabulary. */
export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number];

/** A configuration or usage failure. `main.ts` maps `exitCode` straight to `process.exit`. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly exitCode = 2;
  /** The environment variable names the failure is about, for the printed report. */
  readonly keys: readonly string[];

  constructor(code: ConfigErrorCode, message: string, keys: readonly string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.keys = keys;
  }
}
