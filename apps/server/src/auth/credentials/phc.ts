/**
 * PHC string parsing and the re-hash decision (04-auth-and-access-control.md section 3.5).
 *
 * `@node-rs/argon2` 2.2.1 exports no `needsRehash()` (spike S13), and the decision must not depend on
 * a library helper in any case: it is Iridium's own comparison of the parameters a stored hash was
 * made with against the parameters the deployment runs now, so it behaves identically if the binding
 * is ever swapped for `argon2` 0.45.1.
 *
 * The parser is total. An unparseable string, an unknown variant or a malformed parameter list is a
 * typed failure the caller treats as a mismatch, never a silent accept.
 */

/** The argon2 parameters Iridium fixes or configures (section 3.5). */
export interface Argon2Params {
  /** `m=` in KiB (`ARGON2_MEMORY_KIB`). */
  readonly memoryKib: number;
  /** `t=` (`ARGON2_TIME_COST`). */
  readonly timeCost: number;
  /** `p=`; always 1 in Iridium so each hash costs one thread-pool slot. */
  readonly parallelism: number;
}

/** The only variant Iridium hashes with. */
export const ARGON2_VARIANT = 'argon2id';

/** The only argon2 version Iridium hashes with (`0x13`). */
export const ARGON2_VERSION = 19;

/** `p=`, fixed at 1 (section 3.5: predictable calibration, one thread-pool slot per hash). */
export const ARGON2_PARALLELISM = 1;

/** A parsed `$argon2id$v=19$m=…,t=…,p=…$<salt>$<hash>` string. */
export interface ParsedPhc {
  readonly variant: typeof ARGON2_VARIANT;
  readonly version: number;
  readonly params: Argon2Params;
  /** Base64 (unpadded) salt as written. */
  readonly salt: string;
  /** Base64 (unpadded) hash as written. */
  readonly hash: string;
}

/** Why a stored string is not a usable PHC hash. Never carries the string itself. */
export type PhcParseFailure =
  | 'not_phc'
  | 'unknown_variant'
  | 'unsupported_version'
  | 'malformed_params'
  | 'malformed_body';

const PHC_SHAPE = /^\$([a-z0-9-]+)\$v=(\d+)\$([^$]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Parses a PHC string. Returns a failure reason rather than throwing. */
export function parsePhc(stored: string): ParsedPhc | { readonly failure: PhcParseFailure } {
  const match = PHC_SHAPE.exec(stored);
  // The five groups are all non-optional in the pattern, so a match carries all five; the guard is
  // one statement because `RegExpExecArray` types each as possibly absent.
  const [, variant, version, paramList, salt, hash] = match ?? [];
  if (
    match === null ||
    variant === undefined ||
    version === undefined ||
    paramList === undefined ||
    salt === undefined ||
    hash === undefined
  ) {
    return { failure: stored.startsWith('$') ? 'malformed_body' : 'not_phc' };
  }
  if (variant !== ARGON2_VARIANT) return { failure: 'unknown_variant' };
  if (Number(version) !== ARGON2_VERSION) return { failure: 'unsupported_version' };

  const params = new Map<string, number>();
  for (const pair of paramList.split(',')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined || !/^\d+$/.test(value)) {
      return { failure: 'malformed_params' };
    }
    params.set(key, Number(value));
  }
  const memoryKib = params.get('m');
  const timeCost = params.get('t');
  const parallelism = params.get('p');
  if (memoryKib === undefined || timeCost === undefined || parallelism === undefined) {
    return { failure: 'malformed_params' };
  }
  return {
    variant: ARGON2_VARIANT,
    version: ARGON2_VERSION,
    params: { memoryKib, timeCost, parallelism },
    salt,
    hash,
  };
}

/** Whether a parse result is a failure. */
export function isPhcFailure(
  parsed: ParsedPhc | { readonly failure: PhcParseFailure },
): parsed is { readonly failure: PhcParseFailure } {
  return 'failure' in parsed;
}

/** What a stored credential is compared against to decide on a transparent re-hash. */
export interface RehashPolicy {
  readonly params: Argon2Params;
  /** `schema_meta.pepper_version`, the version every new hash uses. */
  readonly pepperVersion: number;
}

/**
 * The re-hash decision of section 3.5: any difference between the stored parameters and the
 * current ones, or between the row's pepper version and the current one, triggers a transparent
 * re-hash on the next successful login. An unparseable stored hash also answers `true`: a login
 * that verified against it (which cannot happen, since verification fails on malformed input) would
 * still want it rewritten.
 */
export function needsRehash(
  stored: string,
  storedPepperVersion: number,
  policy: RehashPolicy,
): boolean {
  const parsed = parsePhc(stored);
  if (isPhcFailure(parsed)) return true;
  return (
    parsed.params.memoryKib !== policy.params.memoryKib ||
    parsed.params.timeCost !== policy.params.timeCost ||
    parsed.params.parallelism !== policy.params.parallelism ||
    storedPepperVersion !== policy.pepperVersion
  );
}
