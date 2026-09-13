/**
 * Identifiers (02-system-architecture.md, "Identifiers"; ARCH-13, skeleton A11).
 *
 * Every entity on a wire surface is a UUIDv7 (RFC 9562) generated in the application, stored as
 * `BINARY(16)` and rendered as the canonical lowercase 36-character string on REST, WebSocket,
 * MCP, IPC and in `iridium://` URIs. The generator has no dependency: a 48-bit Unix millisecond
 * timestamp, `ver = 7`, the 12-bit `rand_a` field used as a per-process monotonic counter that is
 * re-seeded randomly on every new millisecond, `var = 10`, and 62 random bits from
 * `globalThis.crypto.getRandomValues` — available in Node 24 and in every supported browser, so
 * this `core` package needs no `node:*` import.
 */

import { z } from 'zod';

import { fillRandom as defaultFillRandom, type FillRandom } from './random.ts';

// ---------------------------------------------------------------------------------------------
// Branded types
// ---------------------------------------------------------------------------------------------

/** A canonical lowercase UUIDv7 string carrying the brand `B`. */
export type Id<B extends string> = string & z.core.$brand<B>;

/** The schema type `idSchema()` produces: a UUIDv7 normalised to lowercase and branded. */
export type IdSchema<B extends string> = z.core.$ZodBranded<z.ZodUUID, B>;

/**
 * Every id schema accepts the canonical form case-insensitively — agents and humans paste
 * uppercase ids, and rejecting them would be hostile — and normalises to lowercase, which is the
 * only form Iridium ever emits. The brand is a compile-time marker: it adds no runtime check, so
 * the emitted JSON Schema is still a plain `format: uuid` with the version-7 pattern.
 */

/** `users.id`. */
export type UserId = Id<'UserId'>;
/** `users.id`. */
export const UserId: IdSchema<'UserId'> = z.uuidv7().toLowerCase().brand<'UserId'>('UserId');

/** `sessions.id`. */
export type SessionId = Id<'SessionId'>;
/** `sessions.id`. */
export const SessionId: IdSchema<'SessionId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'SessionId'>('SessionId');

/** `access_tokens.id`. The 16-character base62 lookup key is `TokenLookupId`. */
export type TokenId = Id<'TokenId'>;
/** `access_tokens.id`. */
export const TokenId: IdSchema<'TokenId'> = z.uuidv7().toLowerCase().brand<'TokenId'>('TokenId');

/** `vaults.id`. */
export type VaultId = Id<'VaultId'>;
/** `vaults.id`. */
export const VaultId: IdSchema<'VaultId'> = z.uuidv7().toLowerCase().brand<'VaultId'>('VaultId');

/** `nodes.id` — a category or a note. */
export type NodeId = Id<'NodeId'>;
/** `nodes.id`. */
export const NodeId: IdSchema<'NodeId'> = z.uuidv7().toLowerCase().brand<'NodeId'>('NodeId');

/** A `NodeId` whose node is a note, so every `NoteId` is usable where a `NodeId` is expected. */
export type NoteId = NodeId & z.core.$brand<'NoteId'>;
/** A `NodeId` whose node is a note. */
export const NoteId: z.core.$ZodBranded<IdSchema<'NodeId'>, 'NoteId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'NodeId'>('NodeId')
  .brand<'NoteId'>('NoteId');

/** `attachments.id`. */
export type AttachmentId = Id<'AttachmentId'>;
/** `attachments.id`. */
export const AttachmentId: IdSchema<'AttachmentId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'AttachmentId'>('AttachmentId');

/** `jobs.id`. */
export type JobId = Id<'JobId'>;
/** `jobs.id`. */
export const JobId: IdSchema<'JobId'> = z.uuidv7().toLowerCase().brand<'JobId'>('JobId');

/** The per-request id echoed in `X-Request-Id` and `ProblemDetails.requestId`. */
export type RequestId = Id<'RequestId'>;
/** The per-request id echoed in `X-Request-Id`. */
export const RequestId: IdSchema<'RequestId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'RequestId'>('RequestId');

/** The id a server process takes at boot. */
export type InstanceId = Id<'InstanceId'>;
/** The id a server process takes at boot. */
export const InstanceId: IdSchema<'InstanceId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'InstanceId'>('InstanceId');

/** `oauth_clients.id` — the row id, never the public `client_id` string. */
export type OAuthClientId = Id<'OAuthClientId'>;
/** `oauth_clients.id`. */
export const OAuthClientId: IdSchema<'OAuthClientId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'OAuthClientId'>('OAuthClientId');

/** `oauth_consents.id`. */
export type OAuthConsentId = Id<'OAuthConsentId'>;
/** `oauth_consents.id`. */
export const OAuthConsentId: IdSchema<'OAuthConsentId'> = z
  .uuidv7()
  .toLowerCase()
  .brand<'OAuthConsentId'>('OAuthConsentId');

/**
 * The id schema of each entity that owns a UUIDv7 identity. `idSchema('vault')` is the documented
 * spelling; the map is what makes it a lookup rather than a factory, so the brand survives into
 * the caller's type without a cast.
 */
export const ID_SCHEMAS: {
  readonly user: typeof UserId;
  readonly session: typeof SessionId;
  readonly token: typeof TokenId;
  readonly vault: typeof VaultId;
  readonly node: typeof NodeId;
  readonly note: typeof NoteId;
  readonly attachment: typeof AttachmentId;
  readonly job: typeof JobId;
  readonly request: typeof RequestId;
  readonly instance: typeof InstanceId;
  readonly oauthClient: typeof OAuthClientId;
  readonly oauthConsent: typeof OAuthConsentId;
} = {
  user: UserId,
  session: SessionId,
  token: TokenId,
  vault: VaultId,
  node: NodeId,
  note: NoteId,
  attachment: AttachmentId,
  job: JobId,
  request: RequestId,
  instance: InstanceId,
  oauthClient: OAuthClientId,
  oauthConsent: OAuthConsentId,
};

/** An entity that owns a UUIDv7 identity. */
export type IdEntity = keyof typeof ID_SCHEMAS;

/** The id schema for one entity, with its brand. */
export function idSchema<E extends IdEntity>(entity: E): (typeof ID_SCHEMAS)[E] {
  return ID_SCHEMAS[entity];
}

/** The 16-character base62 credential lookup key (`access_tokens.token_id CHAR(16) ascii_bin`). */
export type TokenLookupId = string & z.core.$brand<'TokenLookupId'>;
/** The 16-character base62 credential lookup key. */
export const TokenLookupId: z.core.$ZodBranded<z.ZodString, 'TokenLookupId'> = z
  .string()
  .regex(/^[0-9A-Za-z]{16}$/, 'expected 16 base62 characters')
  .brand<'TokenLookupId'>('TokenLookupId');

// ---------------------------------------------------------------------------------------------
// Canonical string codec and the BINARY(16) round trip
// ---------------------------------------------------------------------------------------------

/** The canonical lowercase rendering, which is the only form Iridium emits. */
export const CANONICAL_ID_PATTERN: RegExp =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The 16 bytes of a `BINARY(16)` id column. */
export const ID_BYTE_LENGTH = 16;

/** `true` when `value` is a canonical lowercase UUIDv7 string. */
export function isCanonicalId(value: string): boolean {
  return CANONICAL_ID_PATTERN.test(value);
}

/**
 * The canonical lowercase string for 16 bytes read from a `BINARY(16)` column. The bytes are not
 * inspected beyond their length: a row written before a bug fix still round-trips to the string
 * that produced it.
 */
export function idFromBytes(bytes: Uint8Array): string {
  if (bytes.length !== ID_BYTE_LENGTH) {
    throw new TypeError(
      `expected ${String(ID_BYTE_LENGTH)} bytes, received ${String(bytes.length)}`,
    );
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The 16 bytes to write into a `BINARY(16)` column. Accepts the canonical form case-insensitively
 * for the same reason `idSchema()` does; anything else throws, because a malformed id must never
 * reach SQL.
 */
export function idToBytes(id: string): Uint8Array {
  const canonical = id.toLowerCase();
  if (!isCanonicalId(canonical)) throw new TypeError(`not a canonical UUIDv7: ${redactId(id)}`);
  const hex = canonical.replaceAll('-', '');
  const bytes = new Uint8Array(ID_BYTE_LENGTH);
  for (let index = 0; index < ID_BYTE_LENGTH; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** The id in the form every surface emits, or `null` when `value` is not one. */
export function toCanonicalId(value: string): string | null {
  const canonical = value.toLowerCase();
  return isCanonicalId(canonical) ? canonical : null;
}

/** The Unix millisecond timestamp encoded in a UUIDv7's first 48 bits. */
export function idTimestamp(id: string): number {
  const bytes = idToBytes(id);
  let ms = 0;
  for (let index = 0; index < 6; index += 1) ms = ms * 256 + bytes[index]!;
  return ms;
}

/** An id shortened for an error message, so a malformed credential is never echoed in full. */
function redactId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------

/** Seams the generator takes so a test can drive the clock and the randomness (10, "Mocks"). */
export interface IdGeneratorOptions {
  /** Unix milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Fills `bytes` with cryptographically strong random values. Defaults to Web Crypto. */
  readonly fillRandom?: FillRandom;
}

const RAND_A_MASK = 0x0f_ff;

/**
 * A UUIDv7 generator with its own monotonic state. `newId` is the process-wide instance; a test
 * builds its own so it can pin the clock and the randomness.
 *
 * Within one millisecond the 12-bit `rand_a` counter increments (RFC 9562 section 6.2 method 1),
 * so ids created in one transaction sort in creation order. When the counter would overflow the
 * generator waits for the next millisecond rather than reordering (ARCH-13). A clock that moves
 * backwards is treated as the last observed millisecond for the same reason.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): () => string {
  const now = options.now ?? Date.now;
  const fillRandom = options.fillRandom ?? defaultFillRandom;
  const random = new Uint8Array(10);
  const bytes = new Uint8Array(ID_BYTE_LENGTH);
  let lastMs = -1;
  let counter = 0;

  const seedCounter = (): number => {
    fillRandom(random);
    return ((random[0]! << 8) | random[1]!) & RAND_A_MASK;
  };

  return (): string => {
    let ms = now();
    if (ms > lastMs) {
      lastMs = ms;
      counter = seedCounter();
    } else {
      counter += 1;
      if (counter > RAND_A_MASK) {
        do {
          ms = now();
        } while (ms <= lastMs);
        lastMs = ms;
        counter = seedCounter();
      }
    }

    fillRandom(random);
    let remaining = lastMs;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    bytes[6] = 0x70 | (counter >>> 8);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | (random[2]! & 0x3f);
    for (let index = 9; index < ID_BYTE_LENGTH; index += 1) {
      bytes[index] = random[index - 6]!;
    }
    return idFromBytes(bytes);
  };
}

const generate = createIdGenerator();

/**
 * A new UUIDv7 in canonical lowercase form. It is deliberately unbranded: a caller that needs a
 * branded id parses it with that entity's schema (`VaultId.parse(newId())`), which is one regex
 * and also the assertion that the generator emitted the canonical form. A phantom type parameter
 * would have moved that assertion into a cast, where nothing checks it.
 */
export function newId(): string {
  return generate();
}

// ---------------------------------------------------------------------------------------------
// Non-UUID identifiers that cross the wire as JSON numbers
// ---------------------------------------------------------------------------------------------

/**
 * The largest integer a JSON number carries losslessly. `note_revisions.id` and `revision`
 * (= `note_updates.seq`) are `BIGINT UNSIGNED` columns serialised as JSON numbers on REST, so
 * every conversion from the database is checked against this bound (09-api-reference.md 1.1).
 */
export const JSON_SAFE_INT_MAX = 9_007_199_254_740_991;

/** `note_updates.seq`, called `revision` on the wire. */
export const Revision: z.ZodInt = z.int().min(0).max(JSON_SAFE_INT_MAX);

/** `note_revisions.id`, called `revisionId` on REST and `revision_id` (decimal string) on MCP. */
export const RevisionId: z.ZodInt = z.int().min(1).max(JSON_SAFE_INT_MAX);

/** `true` when the value survives a JSON round trip as a number. */
export function isJsonSafeInteger(value: number | bigint): boolean {
  return typeof value === 'bigint'
    ? value >= 0n && value <= BigInt(JSON_SAFE_INT_MAX)
    : Number.isInteger(value) && value >= 0 && value <= JSON_SAFE_INT_MAX;
}

/**
 * The number a `BIGINT UNSIGNED` column becomes on the wire. Throws above 2^53 - 1 rather than
 * silently losing precision, which is the failure this bound exists to make impossible.
 */
export function toJsonSafeInteger(value: number | bigint): number {
  if (!isJsonSafeInteger(value)) {
    throw new RangeError(`value is not safe as a JSON number: ${String(value)}`);
  }
  return Number(value);
}
