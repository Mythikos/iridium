/**
 * Opaque keyset cursors, shared by REST and MCP (09-api-reference.md §1.6 and §4.7; skeleton A35).
 *
 * One module, because a cursor is a *capability*: it names a position in a listing, the filter that
 * listing was built from and the principal it was issued to, and every one of those has to be
 * re-checked on the way back in. A page token that only carried the after-key would let a caller
 * page a filter they never ran, or resume another principal's listing by pasting their token.
 *
 * ```
 * cursor := base64url(JSON{ v, k, a, f, t, tv?, exp }) + "." + base64url(HMAC-SHA256(key, <JSON bytes>))
 * ```
 *
 * The payload carries no key version, and that is deliberate (§4.7): the signature is verified with
 * the promoted `MCP_CURSOR_KEY` alone, so `iridium keys rotate cursor` invalidates every outstanding
 * cursor — which is the behaviour an operator rotating a key wants. A cursor presented by a different
 * principal, with a different filter hash, with a bad signature, or after `exp` is one answer:
 * `422 validation_failed` with `errors[0].code = 'cursor_invalid'` on REST, and the same refusal
 * rendered as an `isError` result on MCP (§4.6).
 *
 * The module lives at the path §1.6 names (`apps/server/src/mcp/cursor.ts`) even though its first
 * consumer is `GET /admin/users` rather than a tool: there is one cursor format, and a second
 * implementation under `rest/` is how the two surfaces would come to disagree about what a page token
 * means.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson, type CanonicalValue } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import type { Keyring } from '../config/env.ts';
import type { Database } from '../db/index.ts';
import { ProblemError } from '../security/problem.ts';

/** The keyset kinds of §4.7. One per listing shape, not one per route. */
export const CURSOR_KINDS = [
  'notes',
  'tree',
  'search',
  'revisions',
  'attachments',
  'trash',
  'links',
  'audit',
  'access',
  'sessions',
  'tokens',
  'jobs',
  'users',
  'vaults',
  'oauthClients',
  'oauthConsents',
] as const;

/** A keyset kind. */
export type CursorKind = (typeof CURSOR_KINDS)[number];

/** The cursor schema version the payload declares. */
export const CURSOR_VERSION = 1;

/**
 * How long an issued cursor stays valid: issue + 3 600 s (§4.7).
 *
 * It is a numeric limit and belongs in `@iridium/contracts/limits.ts` beside `TICKET_TTL_S` and
 * `OAUTH_CODE_TTL_SECONDS`; it is declared here until that package carries it, and the M1 report
 * asks for the member so this constant can become an import.
 */
export const CURSOR_TTL_SECONDS = 3_600;

const MS_PER_SECOND = 1000;

/** One element of an after-key tuple: the columns a keyset orders by (§1.6). */
export type CursorKeyPart = string | number;

/** The decoded payload. Members are §4.7's, spelled as the wire spells them. */
export interface CursorPayload {
  /** Cursor schema version. */
  readonly v: number;
  readonly k: CursorKind;
  /** The after-key tuple for that keyset. */
  readonly a: readonly CursorKeyPart[];
  /** SHA-256 of the canonicalised filter object. */
  readonly f: string;
  /** The principal key: `ses:<id>`, `pat:<id>` or `oat:<id>`. */
  readonly t: string;
  /** `vaults.tree_version` at page 1; notes and tree listings only. */
  readonly tv?: number;
  /** Unix seconds. */
  readonly exp: number;
}

/** What issuing a cursor takes; `exp` is computed, never supplied. */
export interface IssueCursorInput {
  readonly kind: CursorKind;
  readonly after: readonly CursorKeyPart[];
  /** The canonical filter object this page was produced from. */
  readonly filter: CanonicalValue;
  /** `request.principalKey`. */
  readonly principalKey: string;
  readonly treeVersion?: number;
}

/** What presenting a cursor must match. Every member is compared; none is advisory. */
export interface ParseCursorInput {
  readonly kind: CursorKind;
  readonly filter: CanonicalValue;
  readonly principalKey: string;
}

/** What the codec needs: the keyring, the promoted version and the clock. */
export interface CursorCodecOptions {
  /** `MCP_CURSOR_KEY`, the whole configured family. */
  readonly keyring: Keyring;
  /** `schema_meta.cursor_key_version` — the version cursors are signed and verified with. */
  readonly signingVersion: number;
  readonly now: () => number;
}

/** Thrown at boot when the promoted cursor key version is not in the configured keyring. */
export class CursorKeyMissingError extends Error {
  readonly code = 'config.key_version_downgrade';
  readonly exitCode = 2;

  constructor(promoted: number, configured: readonly number[]) {
    super(
      `schema_meta.cursor_key_version is ${String(promoted)} and the configured MCP_CURSOR_KEY ` +
        `keyring carries ${configured.length === 0 ? 'no version' : `v${configured.join(', v')}`}. ` +
        'Cursors are signed and verified with the promoted version alone (09-api-reference.md §4.7), ' +
        'so a process without it would refuse every page token it had just issued. Add ' +
        `MCP_CURSOR_KEY_V${String(promoted)}_FILE from the encrypted secrets bundle, or ` +
        '`iridium keys promote cursor --to <n>` to a version this host has.',
    );
    this.name = 'CursorKeyMissingError';
  }
}

/** The one refusal every unusable cursor produces (§1.6, §4.7). */
export function cursorInvalid(detail: string): ProblemError {
  return new ProblemError('validation_failed', {
    detail,
    errors: [{ path: 'query.cursor', message: detail, code: 'cursor_invalid' }],
  });
}

/** SHA-256 of the canonicalised filter object, lowercase hex — the `f` member. */
export function filterHash(filter: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(filter), 'utf8').digest('hex');
}

function encodePart(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function isKeyPart(value: unknown): value is CursorKeyPart {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The decoded JSON as a `CursorPayload`, or `null` when it is not one. Every member is checked
 * rather than asserted: the bytes came from a client, and a valid signature proves only that *this*
 * server minted them, not that the process that minted them wrote the shape this one expects.
 */
function asPayload(value: unknown): CursorPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record: Record<string, unknown> = { ...value };
  const { v, k, a, f, t, tv, exp } = record;
  if (typeof v !== 'number' || typeof f !== 'string' || typeof t !== 'string') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (typeof k !== 'string' || !CURSOR_KINDS.some((kind) => kind === k)) return null;
  if (!Array.isArray(a) || !a.every((part: unknown) => isKeyPart(part))) return null;
  if (tv !== undefined && (typeof tv !== 'number' || !Number.isFinite(tv))) return null;
  const kind = CURSOR_KINDS.find((candidate) => candidate === k);
  if (kind === undefined) return null;
  return { v, k: kind, a, f, t, exp, ...(tv === undefined ? {} : { tv }) };
}

/**
 * Issues and verifies cursors for one process.
 *
 * A class rather than two functions because the key and the clock are state with a lifetime: the
 * promoted version is read once at boot and the keyring is the configuration's, and threading both
 * through every call site is how one listing ends up signing with a different key than the next.
 */
export class CursorCodec {
  readonly #key: Uint8Array;
  readonly #now: () => number;

  constructor(options: CursorCodecOptions) {
    const key = options.keyring.versions.get(options.signingVersion);
    if (key === undefined) {
      throw new CursorKeyMissingError(options.signingVersion, [...options.keyring.versions.keys()]);
    }
    this.#key = key;
    this.#now = options.now;
  }

  /** The opaque token for one page boundary. */
  issue(input: IssueCursorInput): string {
    const payload: CursorPayload = {
      v: CURSOR_VERSION,
      k: input.kind,
      a: [...input.after],
      f: filterHash(input.filter),
      t: input.principalKey,
      ...(input.treeVersion === undefined ? {} : { tv: input.treeVersion }),
      exp: Math.floor(this.#now() / MS_PER_SECOND) + CURSOR_TTL_SECONDS,
    };
    const json = Buffer.from(JSON.stringify(payload), 'utf8');
    return `${encodePart(json)}.${encodePart(this.#sign(json))}`;
  }

  /**
   * The payload a presented cursor carries, after every check of §4.7.
   *
   * @throws ProblemError `422 validation_failed` with `errors[0].code = 'cursor_invalid'` for a
   * malformed token, a bad signature, a foreign principal, a changed filter, or an expired cursor.
   */
  parse(raw: string, expectation: ParseCursorInput): CursorPayload {
    const separator = raw.indexOf('.');
    if (separator <= 0 || separator === raw.length - 1) {
      throw cursorInvalid('The cursor is not a valid page token.');
    }
    const json = Buffer.from(raw.slice(0, separator), 'base64url');
    const signature = Buffer.from(raw.slice(separator + 1), 'base64url');
    const expected = this.#sign(json);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw cursorInvalid(
        'The cursor was not issued by this server, or its signing key has rotated.',
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(json.toString('utf8'));
    } catch {
      throw cursorInvalid('The cursor is not a valid page token.');
    }
    const payload = asPayload(decoded);
    if (payload === null || payload.v !== CURSOR_VERSION) {
      throw cursorInvalid('The cursor is not a valid page token.');
    }
    if (payload.k !== expectation.kind) {
      throw cursorInvalid('The cursor belongs to a different listing.');
    }
    if (payload.t !== expectation.principalKey) {
      throw cursorInvalid('The cursor was issued to a different principal.');
    }
    if (payload.f !== filterHash(expectation.filter)) {
      throw cursorInvalid('The filters changed since this cursor was issued; start from page one.');
    }
    if (payload.exp * MS_PER_SECOND <= this.#now()) {
      throw cursorInvalid('The cursor has expired; start from page one.');
    }
    return payload;
  }

  #sign(json: Buffer): Buffer {
    return createHmac('sha256', this.#key).update(json).digest();
  }
}

/** The `schema_meta` key naming the promoted cursor version (03-data-model.md §13.2). */
export const CURSOR_KEY_VERSION_META_KEY = 'cursor_key_version';

/** The version a schema that predates migration `0032` is treated as carrying. */
const FIRST_KEY_VERSION = 1;

/**
 * The promoted cursor key version, read from `schema_meta` — the same rule `audit/keys.ts` applies to
 * its own family: the environment says which versions this process *has*, the database says which one
 * is in use, and a missing row means a schema older than migration `0032`, which the readiness
 * `migrations` check already reports.
 */
export async function readPromotedCursorKeyVersion(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('schema_meta')
    .select('value')
    .where('key', '=', CURSOR_KEY_VERSION_META_KEY)
    .executeTakeFirst();
  const parsed = row === undefined ? Number.NaN : Number(row.value);
  return Number.isSafeInteger(parsed) && parsed >= FIRST_KEY_VERSION ? parsed : FIRST_KEY_VERSION;
}
