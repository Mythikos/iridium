/**
 * The password policy (04-auth-and-access-control.md section 3.4; NIST SP 800-63B-4; D04-04).
 *
 * Applied identically by `POST /auth/set-password` and `POST /me/password`. Unicode NFC is applied
 * before every length check and before hashing, at set and at verify, so the same password typed on
 * different platforms produces the same hash. Length is counted in code points, never UTF-16 units.
 * There are no composition rules and no rotation rules.
 *
 * The rule ids are the wire vocabulary of `ProblemDetails.errors[].code` for `validation_failed`
 * (09-api-reference.md section 2.1 spells `too_short`, `too_long` and `breached`; `context_word` is
 * the fourth rule of 04 section 3.4).
 */
import { Password } from '@iridium/contracts';

import { blocklistKey } from './blocklist.ts';

/** Why a candidate was refused; the `errors[].code` values a client receives. */
export type PasswordRuleId = 'too_short' | 'too_long' | 'breached' | 'context_word';

/** The literal every deployment refuses inside a password (section 3.4, "Context words"). */
export const PRODUCT_CONTEXT_WORD = 'iridium';

/** Characters an email local part needs before it counts as a context word. */
export const CONTEXT_WORD_MIN_CHARS = 4;

/**
 * The bound the wire schema already states: `Password` is `z.string().min(15).max(128)` in
 * `@iridium/contracts` (09-api-reference.md section 2.1), and that is where `GET /meta.policies`
 * reads `passwordMaxLength` from. Reading it back from the schema keeps the number in one place.
 * The schema counts UTF-16 units and this policy counts code points after NFC (section 3.4), so
 * the schema's cut is the tighter of the two and the policy's is the documented rule.
 *
 * @internal exported for `auth.policy.unit`, which proves the refusal of a schema without a bound.
 */
export function schemaMaxLength(schema: object): number {
  // A `ZodType<string>` hides the string checks; the runtime object carries `maxLength` regardless.
  const bound: unknown = Reflect.get(schema, 'maxLength');
  if (typeof bound !== 'number') {
    throw new TypeError(
      'the Password schema of @iridium/contracts declares no maximum length; the password policy ' +
        'reads its upper bound from that schema (09-api-reference.md section 2.1)',
    );
  }
  return bound;
}

/**
 * The maximum length in code points (section 3.4): it bounds the argon2 input, and a longer
 * candidate is rejected, never truncated. `password_policy.maxLength` (03 section 13.1) is this
 * value until the settings store lands.
 */
export const PASSWORD_MAX_CODE_POINTS: number = schemaMaxLength(Password);

/** What the policy is configured with; `minLength` is the environment floor at M1. */
export interface PasswordPolicyOptions {
  /** `PASSWORD_MIN_LENGTH`, floor 15 (`password_policy.minLength` tightens it post-M1). */
  readonly minLength: number;
  /** Bounds the argon2 input; longer inputs are rejected, never truncated. */
  readonly maxLength: number;
  /** The bundled breached list, keyed by `blocklistKey`. */
  readonly blocklist: ReadonlySet<string>;
  /** `password_policy.checkBreachedList`; the list is consulted only when true. */
  readonly checkBreachedList: boolean;
}

/** The context a candidate is checked in: the account it will belong to. */
export interface PasswordContext {
  /** The account's email; the local part before `@` is a context word when long enough. */
  readonly email: string;
}

/** The outcome of a policy check: the normalised password, or the failing rule ids. */
export type PasswordCheck =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly violations: readonly PasswordRuleId[] };

/** NFC normalisation, the one transformation applied before length checks and hashing. */
export function normalizePassword(raw: string): string {
  return raw.normalize('NFC');
}

/** Code points, not UTF-16 units: an astral character is one character of a password. */
function codePointLength(value: string): number {
  return Array.from(value).length;
}

/** The lowercased email local part when it is long enough to be a context word, else `null`. */
export function emailLocalPart(email: string): string | null {
  const at = email.indexOf('@');
  const local = (at === -1 ? email : email.slice(0, at)).toLowerCase();
  return local.length >= CONTEXT_WORD_MIN_CHARS ? local : null;
}

/** The password policy. One instance per process, owned by the auth plugin. */
export class PasswordPolicy {
  readonly #options: PasswordPolicyOptions;

  constructor(options: PasswordPolicyOptions) {
    this.#options = options;
  }

  /** The configured minimum, published to clients through `GET /meta.policies`. */
  get minLength(): number {
    return this.#options.minLength;
  }

  /** The configured maximum. */
  get maxLength(): number {
    return this.#options.maxLength;
  }

  /**
   * Checks a candidate. Every failing rule is reported, in vocabulary order, so a client can show
   * all of them at once; the normalised form is returned only when every rule passed.
   */
  check(raw: string, context: PasswordContext): PasswordCheck {
    const normalized = normalizePassword(raw);
    const length = codePointLength(normalized);
    const violations: PasswordRuleId[] = [];

    if (length < this.#options.minLength) violations.push('too_short');
    if (length > this.#options.maxLength) violations.push('too_long');

    const lowered = blocklistKey(normalized);
    if (this.#options.checkBreachedList && this.#options.blocklist.has(lowered)) {
      violations.push('breached');
    }

    const local = emailLocalPart(context.email);
    if (lowered.includes(PRODUCT_CONTEXT_WORD) || (local !== null && lowered.includes(local))) {
      violations.push('context_word');
    }

    return violations.length === 0 ? { ok: true, normalized } : { ok: false, violations };
  }
}
