/**
 * The seven-code CLI contract (11-operations-and-deployment.md, "Exit codes (uniform across every
 * command)"; OPS-16, which supersedes ARCH-22's four codes).
 *
 * Every wrapper script, systemd unit, cron line and CI drill branches on these numbers, so they are
 * one frozen table rather than seven literals spread across the command modules. "Non-zero" is not a
 * contract: a runbook that says "exit `5` means the chain is broken" is only true if exactly one
 * module decides what `5` means.
 *
 * The distinction that is easiest to get wrong, and therefore stated here: `2` is "nothing was
 * started" — a bad flag or a bad environment — while `3` is "the command understood you and refused",
 * which is what a reserved command, a held lock and a missing `--yes` all are.
 */

/** The seven codes of OPS-16. */
export const EXIT = Object.freeze({
  /** Success, or a verified no-op. */
  success: 0,
  /** An unexpected internal error; a stack trace is written to stderr. */
  internal: 1,
  /** A configuration or usage error. Nothing was started. */
  usage: 2,
  /** A refused precondition: a reserved command, a held lock, a missing confirmation. */
  refused: 3,
  /** A pre-flight integrity failure: a hash mismatch, a missing key, an unclean target. */
  integrity: 4,
  /** A verification failure: a broken audit chain, a broken restore invariant. */
  verification: 5,
  /** The command ran correctly and found problems (`doctor`). */
  findings: 6,
} as const);
