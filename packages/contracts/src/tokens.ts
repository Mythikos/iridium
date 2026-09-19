/**
 * The shared credential format (04-auth-and-access-control.md section 2.2;
 * 06-mcp-and-agent-access.md, "Integration token model"; A31).
 *
 * ```
 * irid_<kind>_<id16>_<secret43><crc6>
 * ```
 *
 * Every kind is three letters, so every credential is exactly 75 characters. Underscores are not
 * base62 characters, so a double-click selects the whole token in a terminal or an editor. The
 * CRC lets the server and offline scanners reject malformed strings before any lookup, which is
 * the first line of the login and verification pipelines and is what bounds the cost of a
 * credential flood.
 *
 * Only `SHA-256(secret43)` is ever stored, and the hash is taken over the base62 string rather
 * than the decoded bytes so that every store and verifier computes the same value. The hashing
 * itself belongs to the server (`node:crypto`); this package owns the format, the CRC, the
 * published scanner regex, the kind dispatch and the scope vocabulary.
 */

import { z } from 'zod';

import { READ_BUNDLE, type Permission } from './authz.ts';
import { fillRandom as defaultFillRandom, type FillRandom } from './random.ts';
import type { EnumOf } from './schema.ts';

// ---------------------------------------------------------------------------------------------
// Alphabet and shape
// ---------------------------------------------------------------------------------------------

/** Big-endian base62, left-padded with `0`. */
export const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The literal prefix every credential carries; a secret-scanner anchor. */
export const CREDENTIAL_PREFIX = 'irid_';

/** The seven kinds that are issued. `scim` is reserved and never issued (`RESERVED_TOKEN_KINDS`). */
export const TOKEN_KINDS = ['pat', 'ses', 'tkt', 'spl', 'oat', 'ort', 'oac'] as const;

/** An issued credential kind. */
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** An issued credential kind. */
export const TokenKind: EnumOf<typeof TOKEN_KINDS> = z.enum(TOKEN_KINDS);

/** Kinds that are schema-valid and never issued, so a later migration changes no column. */
export const RESERVED_TOKEN_KINDS = ['scim'] as const;

/** A reserved credential kind. */
export type ReservedTokenKind = (typeof RESERVED_TOKEN_KINDS)[number];

/** `access_tokens.kind`: `pat` and `oauth` are live, `scim` is reserved and never issued. */
export const ACCESS_TOKEN_KINDS = ['pat', 'oauth', 'scim'] as const;

/** A value of `access_tokens.kind`. */
export type AccessTokenKind = (typeof ACCESS_TOKEN_KINDS)[number];

/** A value of `access_tokens.kind`. */
export const AccessTokenKind: EnumOf<typeof ACCESS_TOKEN_KINDS> = z.enum(ACCESS_TOKEN_KINDS);

/** Characters of the public lookup id (`access_tokens.token_id CHAR(16) ascii_bin`). */
export const TOKEN_ID_LENGTH = 16;
/** Characters of the secret: 32 CSPRNG bytes as a base62 big integer. */
export const TOKEN_SECRET_LENGTH = 43;
/** Characters of the CRC-32 check digits. */
export const TOKEN_CRC_LENGTH = 6;
/** Characters of a whole credential: `irid_xxx_` (9) + 16 + `_` (1) + 43 + 6. */
export const CREDENTIAL_LENGTH = 75;
/** Characters of `access_tokens.display_prefix`: `irid_<kind>_<id16>_`. */
export const DISPLAY_PREFIX_LENGTH = 26;

/**
 * The published secret-scanning regex, as documented in `SECURITY.md` for a site's scanning
 * tooling (11-operations-and-deployment.md C17). It is deliberately unanchored: a scanner looks
 * for the pattern inside arbitrary text. The authorization-code kind is included on purpose — a
 * code in a redirect URL or in browser history is a finding, not noise.
 */
export const SCANNER_REGEX_SOURCE =
  'irid_(pat|ses|tkt|spl|oat|ort|oac)_[0-9A-Za-z]{16}_[0-9A-Za-z]{49}';

/** The anchored form the server matches a whole credential against, before the CRC check. */
export const TOKEN_REGEX: RegExp = new RegExp(`^${SCANNER_REGEX_SOURCE}$`);

/** A fresh unanchored scanner, because a global regex carries `lastIndex` state. */
export function scannerRegex(): RegExp {
  return new RegExp(SCANNER_REGEX_SOURCE, 'g');
}

// ---------------------------------------------------------------------------------------------
// CRC-32 and base62
// ---------------------------------------------------------------------------------------------

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE, the `node:zlib` `crc32` polynomial) over the ASCII bytes of `input`. The input is
 * always ASCII here, so the bytes are the code units.
 */
export function crc32(input: string): number {
  let crc = 0xff_ff_ff_ff;
  for (let index = 0; index < input.length; index += 1) {
    const byte = input.charCodeAt(index) & 0xff;
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** A non-negative integer in base62, left-padded to `length` characters. */
function base62FromInteger(value: bigint, length: number): string {
  let remaining = value;
  let out = '';
  while (remaining > 0n) {
    out = BASE62_ALPHABET[Number(remaining % 62n)]! + out;
    remaining /= 62n;
  }
  return out.padStart(length, '0');
}

/** The six base62 check digits: CRC-32 over everything before them (62^6 > 2^32). */
export function crc6(input: string): string {
  return base62FromInteger(BigInt(crc32(input)), TOKEN_CRC_LENGTH);
}

// ---------------------------------------------------------------------------------------------
// Minting, parsing and redaction
// ---------------------------------------------------------------------------------------------

/** `access_tokens.display_prefix` — the only part of a credential ever shown after creation. */
export function displayPrefix(kind: TokenKind, tokenId: string): string {
  return `${CREDENTIAL_PREFIX}${kind}_${tokenId}_`;
}

/** What `parseToken` returns for a well-formed credential whose CRC verifies. */
export interface ParsedToken {
  readonly kind: TokenKind;
  /** The public lookup id, safe to display, log and index. */
  readonly tokenId: string;
  /** The 43-character base62 secret. Never stored, never logged. */
  readonly secret: string;
}

/** A freshly minted credential. The full string is shown to a human exactly once. */
export interface MintedToken extends ParsedToken {
  /** The whole 75-character credential. */
  readonly raw: string;
  /** `irid_<kind>_<id16>_`, stored in `display_prefix`. */
  readonly displayPrefix: string;
}

/** Passes over the entropy source before minting gives up: 32 x 32 bytes is never reached. */
const MINT_MAX_PASSES = 32;

/**
 * Sixteen base62 characters drawn uniformly by rejection sampling over random bytes. The pass
 * count is bounded so an entropy source that never yields an accepted byte fails loudly instead of
 * spinning; with a real CSPRNG the first pass succeeds with probability 1 - 2^-80.
 */
function mintTokenId(fillRandom: FillRandom): string {
  const out: string[] = [];
  const buffer = new Uint8Array(TOKEN_ID_LENGTH * 2);
  for (let pass = 0; pass < MINT_MAX_PASSES && out.length < TOKEN_ID_LENGTH; pass += 1) {
    fillRandom(buffer);
    for (const byte of buffer) {
      // 248 = 4 x 62: bytes at or above it would bias the distribution, so they are discarded.
      if (byte < 248 && out.length < TOKEN_ID_LENGTH) out.push(BASE62_ALPHABET[byte % 62]!);
    }
  }
  if (out.length < TOKEN_ID_LENGTH) {
    throw new TypeError('the entropy source did not yield enough unbiased bytes');
  }
  return out.join('');
}

/**
 * Mints a credential of the given kind: a 16-character public id and a 43-character secret
 * encoding 32 CSPRNG bytes, followed by the CRC of everything before it.
 */
export function mintToken(
  kind: TokenKind,
  fillRandom: FillRandom = defaultFillRandom,
): MintedToken {
  const tokenId = mintTokenId(fillRandom);
  const secretBytes = new Uint8Array(32);
  fillRandom(secretBytes);
  let value = 0n;
  for (const byte of secretBytes) value = (value << 8n) | BigInt(byte);
  const secret = base62FromInteger(value, TOKEN_SECRET_LENGTH);
  const body = `${displayPrefix(kind, tokenId)}${secret}`;
  return {
    kind,
    tokenId,
    secret,
    raw: `${body}${crc6(body)}`,
    displayPrefix: displayPrefix(kind, tokenId),
  };
}

/** What `parseTokenDetailed` answers: the parsed credential, or why the string is not one. */
export type TokenParseResult =
  | { readonly ok: true; readonly token: ParsedToken }
  | { readonly ok: false; readonly reason: TokenParseFailure };

/**
 * Parses a credential, naming the failure when it is not one. Total: it never throws, and a
 * credential flood costs one regex and one CRC and never a database read. `parseToken` and
 * `tokenParseFailure` are the two projections of this one answer, so a caller that needs both the
 * token and the reason never reconciles two functions.
 */
export function parseTokenDetailed(raw: string): TokenParseResult {
  if (!raw.startsWith(CREDENTIAL_PREFIX)) return { ok: false, reason: 'not_a_credential' };
  const kind = kindOf(raw);
  if (kind === null) return { ok: false, reason: 'unknown_kind' };
  if (!TOKEN_REGEX.test(raw)) return { ok: false, reason: 'malformed' };
  const body = raw.slice(0, raw.length - TOKEN_CRC_LENGTH);
  if (crc6(body) !== raw.slice(raw.length - TOKEN_CRC_LENGTH)) {
    return { ok: false, reason: 'crc_mismatch' };
  }
  const tokenId = raw.slice(DISPLAY_PREFIX_LENGTH - TOKEN_ID_LENGTH - 1, DISPLAY_PREFIX_LENGTH - 1);
  const secret = body.slice(DISPLAY_PREFIX_LENGTH);
  return { ok: true, token: { kind, tokenId, secret } };
}

/**
 * Parses a credential. Total: it returns `null` for anything that is not a well-formed credential
 * of a live kind whose CRC verifies, and never throws.
 */
export function parseToken(raw: string): ParsedToken | null {
  const result = parseTokenDetailed(raw);
  return result.ok ? result.token : null;
}

/**
 * The kind a string claims to be, from its prefix alone and without verifying the CRC. It is what
 * the verifier dispatches on before deciding whether a mount accepts that kind.
 */
export function kindOf(raw: string): TokenKind | null {
  if (!raw.startsWith(CREDENTIAL_PREFIX)) return null;
  const candidate = raw.slice(CREDENTIAL_PREFIX.length, CREDENTIAL_PREFIX.length + 3);
  const kind = TOKEN_KINDS.find((known) => known === candidate);
  return kind ?? null;
}

/** Why a string is not a usable credential. Never carries any part of the secret. */
export type TokenParseFailure = 'not_a_credential' | 'unknown_kind' | 'malformed' | 'crc_mismatch';

/**
 * The reason a string failed to parse, or `null` when it parsed. The server reports this as the
 * `reason` label of `iridium_token_auth_failures_total`, which is why it is a closed vocabulary
 * and why no variant can contain input.
 */
export function tokenParseFailure(raw: string): TokenParseFailure | null {
  const result = parseTokenDetailed(raw);
  return result.ok ? null : result.reason;
}

/**
 * A credential reduced to what may be logged: the display prefix of a well-formed credential, and
 * nothing at all otherwise. Every log line, error message and audit row that mentions a
 * credential goes through this.
 */
export function redactToken(raw: string): string {
  const kind = kindOf(raw);
  if (kind === null || raw.length !== CREDENTIAL_LENGTH) return '[redacted]';
  return `${raw.slice(0, DISPLAY_PREFIX_LENGTH)}[redacted]`;
}

// ---------------------------------------------------------------------------------------------
// Kind dispatch
// ---------------------------------------------------------------------------------------------

/** Where the row for a credential kind lives, and whether the kind is issued in MVP. */
export interface TokenKindSpec {
  /** The table or in-process store holding the row. */
  readonly store: string;
  /** `access_tokens.kind` when the row lives in `access_tokens`, else `null`. */
  readonly accessTokenKind: AccessTokenKind | null;
  /** `false` for a reserved kind, which is schema-valid and never issued. */
  readonly issued: boolean;
}

/** The store and liveness of every credential kind, reserved ones included. */
export const TOKEN_KIND_SPECS: Readonly<Record<TokenKind | ReservedTokenKind, TokenKindSpec>> = {
  pat: { store: 'access_tokens', accessTokenKind: 'pat', issued: true },
  ses: { store: 'sessions', accessTokenKind: null, issued: true },
  tkt: { store: 'TicketStore', accessTokenKind: null, issued: true },
  spl: { store: 'password_setup_tokens', accessTokenKind: null, issued: true },
  oat: { store: 'access_tokens', accessTokenKind: 'oauth', issued: true },
  ort: { store: 'oauth_refresh_tokens', accessTokenKind: null, issued: true },
  oac: { store: 'oauth_authorization_codes', accessTokenKind: null, issued: true },
  scim: { store: 'access_tokens', accessTokenKind: 'scim', issued: false },
};

/** The bearer surfaces a credential can be presented on. */
export const BEARER_MOUNTS = ['mcp', 'mcp-connect', 'rest'] as const;

/** A bearer surface: `POST /mcp`, `POST /mcp/connect`, or the starred read-only REST routes. */
export type BearerMount = (typeof BEARER_MOUNTS)[number];

/**
 * Exactly one credential kind per mount (04-auth-and-access-control.md section 9.1 step 5): a PAT
 * on `/mcp` and on the starred REST reads, an OAuth access token on `/mcp/connect`. Presenting
 * the other kind is `401 invalid_token` whose description names the other endpoint.
 */
export const MOUNT_ACCEPTED_KIND: Readonly<Record<BearerMount, TokenKind>> = {
  mcp: 'pat',
  'mcp-connect': 'oat',
  rest: 'pat',
};

/** Whether a mount accepts a kind. Deny by default: an unlisted pairing is refused. */
export function isKindAcceptedOn(kind: TokenKind, mount: BearerMount): boolean {
  return MOUNT_ACCEPTED_KIND[mount] === kind;
}

/**
 * The verification contract the server's `auth/tokens/verify.ts` implements and
 * `tokens.verify.unit` reads. It is declared rather than implemented here because the comparison
 * itself is `crypto.timingSafeEqual` over two digests, which belongs to the Node side of the
 * boundary — but the properties it must have are part of the contract, not of the implementation.
 */
export interface SecretVerificationContract {
  /** SHA-256, no pepper: a 256-bit CSPRNG secret is not brute-forceable (A31). */
  readonly hashAlgorithm: 'sha256';
  /** The digest is taken over the 43-character ASCII secret exactly as presented. */
  readonly hashedInput: 'ascii(secret43)';
  /** Bytes of the stored digest (`secret_hash BINARY(32)`). */
  readonly hashBytes: 32;
  /** The comparison examines every byte and is independent of where the first difference is. */
  readonly comparisonIsConstantTime: true;
  /**
   * When no row exists the verifier still compares against `ABSENT_SECRET_HASH`, so a response
   * time cannot distinguish "unknown id" from "wrong secret".
   */
  readonly comparesOnAbsentRow: true;
  /** Lookup is by the indexed `token_id`, never by the hash. */
  readonly lookupBy: 'token_id';
}

/** The verification contract, as data, so a test can assert it and the server can read it. */
export const SECRET_VERIFICATION: SecretVerificationContract = {
  hashAlgorithm: 'sha256',
  hashedInput: 'ascii(secret43)',
  hashBytes: 32,
  comparisonIsConstantTime: true,
  comparesOnAbsentRow: true,
  lookupBy: 'token_id',
};

/** The fixed buffer an absent row is compared against, so the timing carries no information. */
export const ABSENT_SECRET_HASH: Uint8Array = new Uint8Array(SECRET_VERIFICATION.hashBytes);

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

/**
 * The six read permissions a token may carry. The same six strings are the OAuth scope
 * vocabulary, and `READ_BUNDLE.join(' ')` is the `scope` value of the `/mcp/connect` challenge.
 */
export const READ_SCOPES: typeof READ_BUNDLE = READ_BUNDLE;

/**
 * Write scopes that are schema-valid so a future migration does not change the column contract.
 * No code path grants one, `POST /me/tokens` accepts only the bundle name `read`, and
 * `toEffectivePermissions` drops them, which is what makes them inert by construction rather than
 * by a check someone can forget (`token.reserved-scopes-inert.unit`).
 */
export const RESERVED_WRITE_SCOPES = [
  'note:propose',
  'note:write',
  'node:create',
  'node:rename',
  'node:move',
  'node:trash',
  'node:restore',
  'attachment:write',
  'revision:name',
] as const;

/** Every string `access_tokens.scopes` may contain. */
export const SCOPES: readonly [...typeof READ_SCOPES, ...typeof RESERVED_WRITE_SCOPES] = [
  ...READ_SCOPES,
  ...RESERVED_WRITE_SCOPES,
];

/** A string `access_tokens.scopes` may contain. */
export type Scope = (typeof SCOPES)[number];

/** A string `access_tokens.scopes` may contain, reserved values included. */
export const ScopeSchema: EnumOf<typeof SCOPES> = z.enum(SCOPES);

/** The only bundle `POST /me/tokens` accepts, and the only one the consent screen offers. */
export const GrantableBundleSchema: z.ZodEnum<{ read: 'read' }> = z.enum(['read']);

/** A grantable scope bundle. */
export type GrantableBundle = z.infer<typeof GrantableBundleSchema>;

/** What each bundle expands to, server-side. */
export const SCOPE_BUNDLES: Readonly<Record<GrantableBundle, typeof READ_SCOPES>> = {
  read: READ_SCOPES,
};

/**
 * The permissions a stored scope list actually grants: the intersection with the grantable
 * vocabulary, in vocabulary order and without duplicates. A reserved scope on a row therefore
 * grants nothing, and `note:propose` — which is a scope string but not a permission — cannot
 * reach `authorize()` at all.
 */
export function toEffectivePermissions(scopes: readonly string[]): readonly Permission[] {
  return READ_SCOPES.filter((scope) => scopes.includes(scope));
}

// ---------------------------------------------------------------------------------------------
// Per-kind wire schemas
// ---------------------------------------------------------------------------------------------

/**
 * The anchored pattern a credential of one kind matches. The REST DTOs that carry a credential on
 * the wire — the set-password link of `POST /auth/set-password`, the batch of
 * `POST /auth/collab-tickets`, the desktop session of `POST /auth/sessions` — validate against
 * this rather than against a regex written at the call site, so the format lives in exactly one
 * module (09-api-reference.md sections 2.1, 2.3).
 */
export function credentialRegex(kind: TokenKind): RegExp {
  return new RegExp(
    `^${CREDENTIAL_PREFIX}${kind}_[0-9A-Za-z]{${String(TOKEN_ID_LENGTH)}}_[0-9A-Za-z]{${String(TOKEN_SECRET_LENGTH + TOKEN_CRC_LENGTH)}}$`,
  );
}

/** A credential of one kind as a wire schema, with the CRC checked as well as the shape. */
export function credentialSchema(kind: TokenKind): z.ZodString {
  return z
    .string()
    .length(CREDENTIAL_LENGTH)
    .regex(credentialRegex(kind))
    .refine((raw) => parseToken(raw)?.kind === kind, {
      error: 'credential check digits do not verify',
      params: { code: 'crc_mismatch' },
    });
}
