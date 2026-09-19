/**
 * The audit vocabulary (03-data-model.md section 12.6).
 *
 * `audit_events.action` values come from this closed list; a zod enum validates every write, and
 * `audit.vocabulary.unit` asserts both directions — every value the server can emit is in the
 * list, and every listed value is emitted by at least one test, so a dead action cannot linger.
 *
 * `access_log.action` has its own, separate vocabulary: the same closed-list discipline for a
 * different question. The audit chain records decisions; the access log records per-call traffic.
 */

import { z } from 'zod';

import { hasLoneSurrogate } from './paths.ts';
import type { EnumOf } from './schema.ts';
import { AUDIT_TIMESTAMP_PATTERN } from './time.ts';

/** The closed `audit_events.action` vocabulary, grouped as 03-data-model.md groups it. */
export const AUDIT_ACTIONS = [
  // authentication
  'user.login.succeeded',
  'user.login.failed',
  'user.logout',
  'user.reauth.succeeded',
  'user.password.set',
  'user.password.changed',
  'session.revoked',
  'session.revoked_all',
  // tokens
  'token.created',
  'token.rotated',
  'token.revoked',
  'token.revoked_all',
  'token.denied',
  // oauth
  'oauth.client.registered',
  'oauth.client.disabled',
  'oauth.client.deleted',
  'oauth.client.expired',
  'oauth.consent.granted',
  'oauth.consent.updated',
  'oauth.consent.revoked',
  'oauth.refresh.reuse_detected',
  'oauth.code.replayed',
  'oauth.authorize.denied',
  // vaults
  'vault.created',
  'vault.updated',
  'vault.archived',
  'vault.restored',
  'vault.settings.changed',
  'vault.member.added',
  'vault.member.role_changed',
  'vault.member.removed',
  // structure
  'node.created',
  'node.renamed',
  'node.moved',
  'node.trashed',
  'node.restored',
  'node.purged',
  // content
  'note.revision.named',
  'note.revision.restored',
  'note.content.invalid',
  'note.content.repaired',
  // attachments
  'attachment.uploaded',
  'attachment.deleted',
  // transfer
  'export.created',
  'import.scanned',
  'import.committed',
  'import.aborted',
  // administration
  'admin.user.created',
  'admin.user.updated',
  'admin.user.disabled',
  'admin.user.enabled',
  'admin.user.deleted',
  'admin.user.password_reset',
  'admin.settings.changed',
  'admin.job.triggered',
  'admin.backup.verified',
  'admin.release.published',
  'admin.release.withdrawn',
  // agents and collaboration
  'mcp.access.denied',
  'collab.connection.rejected',
  'collab.write.rejected',
  // system
  'system.migration.applied',
  'system.key.rotated',
  'system.audit.archived',
] as const;

/** An `audit_events.action`. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** An `audit_events.action`. */
export const AuditAction: EnumOf<typeof AUDIT_ACTIONS> = z.enum(AUDIT_ACTIONS);

/**
 * Which chain an action is written to. Every action carrying a vault id goes to
 * `vault:<32 hex>`; everything else goes to `server`. A vault manager may read their vault's
 * chain, including the administrative actions that touched it (A46), which is why membership and
 * settings events are vault-scoped. Every `oauth.*` action is server-scoped: a grant is made
 * against an account and a client, not inside a vault.
 */
export type AuditChainScope = 'vault' | 'server';

/** The literal name of the server-wide audit chain. */
export const SERVER_CHAIN_ID = 'server';

/** The `vault:` prefix of a per-vault chain id. */
export const VAULT_CHAIN_PREFIX = 'vault:';

const VAULT_CHAIN_PATTERN = /^vault:[0-9a-f]{32}$/;

/**
 * `'vault:'` plus the vault UUID **without hyphens** and in lowercase — 38 characters, which is
 * what fits the declared `VARCHAR(40)`; the canonical hyphenated form would be 42 and would not
 * (D03-05). An id schema accepts an uppercase id on input, so the case is normalised here too:
 * two spellings of one chain would fork the chain.
 */
export function chainIdForVault(vaultId: string): string {
  return `${VAULT_CHAIN_PREFIX}${vaultId.replaceAll('-', '').toLowerCase()}`;
}

/**
 * The canonical vault id a chain id addresses, or `null` for the server chain and for any other
 * shape. No call site parses this by hand.
 */
export function vaultIdFromChainId(chainId: string): string | null {
  if (!VAULT_CHAIN_PATTERN.test(chainId)) return null;
  const hex = chainId.slice(VAULT_CHAIN_PREFIX.length);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** `audit_events.chain_id`: the server chain, or one vault chain. Any other shape is rejected. */
export const ChainId: z.ZodString = z
  .string()
  .max(40)
  .refine(
    (value) => value === SERVER_CHAIN_ID || VAULT_CHAIN_PATTERN.test(value),
    "expected 'server' or 'vault:<32 lowercase hex>'",
  );

/** The chain each action is written to. */
export const AUDIT_ACTION_CHAIN: Readonly<Record<AuditAction, AuditChainScope>> = {
  'user.login.succeeded': 'server',
  'user.login.failed': 'server',
  'user.logout': 'server',
  'user.reauth.succeeded': 'server',
  'user.password.set': 'server',
  'user.password.changed': 'server',
  'session.revoked': 'server',
  'session.revoked_all': 'server',
  'token.created': 'server',
  'token.rotated': 'server',
  'token.revoked': 'server',
  'token.revoked_all': 'server',
  'token.denied': 'server',
  'oauth.client.registered': 'server',
  'oauth.client.disabled': 'server',
  'oauth.client.deleted': 'server',
  'oauth.client.expired': 'server',
  'oauth.consent.granted': 'server',
  'oauth.consent.updated': 'server',
  'oauth.consent.revoked': 'server',
  'oauth.refresh.reuse_detected': 'server',
  'oauth.code.replayed': 'server',
  'oauth.authorize.denied': 'server',
  'vault.created': 'vault',
  'vault.updated': 'vault',
  'vault.archived': 'vault',
  'vault.restored': 'vault',
  'vault.settings.changed': 'vault',
  'vault.member.added': 'vault',
  'vault.member.role_changed': 'vault',
  'vault.member.removed': 'vault',
  'node.created': 'vault',
  'node.renamed': 'vault',
  'node.moved': 'vault',
  'node.trashed': 'vault',
  'node.restored': 'vault',
  'node.purged': 'vault',
  'note.revision.named': 'vault',
  'note.revision.restored': 'vault',
  'note.content.invalid': 'vault',
  'note.content.repaired': 'vault',
  'attachment.uploaded': 'vault',
  'attachment.deleted': 'vault',
  'export.created': 'vault',
  'import.scanned': 'vault',
  'import.committed': 'vault',
  'import.aborted': 'vault',
  'admin.user.created': 'server',
  'admin.user.updated': 'server',
  'admin.user.disabled': 'server',
  'admin.user.enabled': 'server',
  'admin.user.deleted': 'server',
  'admin.user.password_reset': 'server',
  'admin.settings.changed': 'server',
  'admin.job.triggered': 'server',
  'admin.backup.verified': 'server',
  'admin.release.published': 'server',
  'admin.release.withdrawn': 'server',
  'mcp.access.denied': 'vault',
  'collab.connection.rejected': 'vault',
  'collab.write.rejected': 'vault',
  'system.migration.applied': 'server',
  'system.key.rotated': 'server',
  'system.audit.archived': 'server',
};

/** Who performed an audited action (`audit_events.actor_type`). */
export const AUDIT_ACTOR_TYPES = ['user', 'token', 'system'] as const;

/** Who performed an audited action. */
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/** Who performed an audited action. */
export const AuditActorType: EnumOf<typeof AUDIT_ACTOR_TYPES> = z.enum(AUDIT_ACTOR_TYPES);

/** Which credential the actor presented (`audit_events.credential_type`, 03-data-model.md 12.1). */
export const AUDIT_CREDENTIAL_TYPES = [
  'session',
  'pat',
  'oauth',
  'ticket',
  'setpw',
  'cli',
  'system',
  'none',
] as const;

/** Which credential the actor presented. */
export type AuditCredentialType = (typeof AUDIT_CREDENTIAL_TYPES)[number];

/** Which credential the actor presented. */
export const AuditCredentialType: EnumOf<typeof AUDIT_CREDENTIAL_TYPES> =
  z.enum(AUDIT_CREDENTIAL_TYPES);

/** Whether the audited action succeeded (`audit_events.outcome`). */
export const AUDIT_OUTCOMES = ['success', 'failure'] as const;

/** Whether the audited action succeeded. */
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Whether the audited action succeeded. */
export const AuditOutcome: EnumOf<typeof AUDIT_OUTCOMES> = z.enum(AUDIT_OUTCOMES);

/**
 * One entry of `audit_events.targets`, used when one action affects many rows (a recursive trash,
 * a purge, `token.revoked_all`). `path` carries the derived path for tree targets and is absent
 * for targets that have none, so a stored row needs no translation when it is read back.
 */
export const AuditTarget: z.ZodObject<
  { type: z.ZodString; id: z.ZodString; path: z.ZodOptional<z.ZodString> },
  z.core.$strict
> = z.strictObject({ type: z.string().max(32), id: z.string(), path: z.string().optional() });

/** One entry of `audit_events.targets`. */
export type AuditTarget = z.infer<typeof AuditTarget>;

/** Entries in `audit_events.targets` before the `truncated` marker is set instead. */
export const AUDIT_TARGETS_MAX = 1_000;

/**
 * `access_log.action` — a separate vocabulary, shaped `<surface>.<operation>`: `mcp.<tool>` for
 * MCP calls, `rest.<resource>.<operation>` for token-authenticated REST reads, `export.<op>` for
 * export streaming, and the four the authorization server writes.
 */
export const ACCESS_LOG_SURFACES = ['mcp', 'rest', 'export', 'oauth'] as const;

/** The surface an `access_log` row belongs to. */
export type AccessLogSurface = (typeof ACCESS_LOG_SURFACES)[number];

/** The surface an `access_log` row belongs to. */
export const AccessLogSurface: EnumOf<typeof ACCESS_LOG_SURFACES> = z.enum(ACCESS_LOG_SURFACES);

/** The four fixed `access_log.action` values of the authorization server. */
export const OAUTH_ACCESS_LOG_ACTIONS = [
  'oauth.authorize',
  'oauth.consent',
  'oauth.token.issue',
  'oauth.token.refresh',
] as const;

/** An authorization-server `access_log.action`. */
export type OAuthAccessLogAction = (typeof OAUTH_ACCESS_LOG_ACTIONS)[number];

// ---------------------------------------------------------------------------------------------
// The hashed row shape and its canonicalisation
// ---------------------------------------------------------------------------------------------

/** `audit_events.schema_version` for rows this version writes. */
export const AUDIT_SCHEMA_VERSION = 1;

/** The `prev_hash` of a chain's first row: 32 zero bytes (03-data-model.md section 12.2). */
export const GENESIS_CHAIN_HASH: Uint8Array = new Uint8Array(32);

/**
 * Exactly what the chain hashes (03-data-model.md section 12.2). Field names are the column names,
 * because the pre-image is taken over the row rather than over a wire body, and `prev_id` is inside
 * the payload while `id` is not: `id` is assigned by `AUTO_INCREMENT` after the pre-image is
 * computed, so including the predecessor's id instead is what binds a row to a position in its
 * chain and makes a deletion or a re-ordering detectable.
 *
 * Binary ids are canonical lowercase UUID strings and timestamps carry six fractional digits, so a
 * row read back from MySQL canonicalises to the same bytes the writer hashed. A field that is
 * absent is omitted from the JSON rather than serialised as `null` — which is why every optional
 * member here is `?` and not `| null`.
 */
export interface AuditChainPayload {
  /** `audit_chain_heads.last_id` under the row lock; `0` for a chain's first row. */
  readonly prev_id: number;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ` (`AUDIT_TIMESTAMP_PATTERN`). */
  readonly occurred_at: string;
  readonly schema_version: number;
  readonly chain_id: string;
  readonly action: AuditAction;
  readonly actor_type: AuditActorType;
  readonly actor_id?: string;
  readonly actor_display?: string;
  readonly on_behalf_of_user_id?: string;
  readonly credential_type: AuditCredentialType;
  readonly credential_id?: string;
  readonly vault_id?: string;
  readonly target_type?: string;
  readonly target_id?: string;
  readonly targets?: readonly AuditTarget[];
  readonly outcome: AuditOutcome;
  readonly reason?: string;
  /** `{ip, user_agent, request_id, client, mcp_client}`; always present, never `null`. */
  readonly context: CanonicalObject;
  /** Before/after values of non-content fields only; never a note body. */
  readonly metadata?: CanonicalObject;
}

/** A value `canonicalJson` can serialise. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | CanonicalObject;

/** An object `canonicalJson` can serialise. An `undefined` member is omitted, never emitted. */
export interface CanonicalObject {
  readonly [key: string]: CanonicalValue | undefined;
}

/**
 * Thrown when a value cannot be canonicalised. It names the path and states the remedy, because the
 * only way to hit it is a payload the caller built wrongly — and a silently coerced value would
 * produce a hash that a later verification cannot reproduce.
 */
export class AuditCanonicalError extends Error {
  /** The dotted path of the offending value, `''` for the root. */
  readonly path: string;

  constructor(path: string, problem: string, remedy: string) {
    super(`cannot canonicalise ${path === '' ? 'the payload' : path}: ${problem}. ${remedy}`);
    this.name = 'AuditCanonicalError';
    this.path = path;
  }
}

const CONTROL_ESCAPES: Readonly<Record<number, string>> = {
  0x08: String.raw`\b`,
  0x09: String.raw`\t`,
  0x0a: String.raw`\n`,
  0x0c: String.raw`\f`,
  0x0d: String.raw`\r`,
};

const HEX_ESCAPE_WIDTH = 4;
/** One reverse solidus, named so the escaping below reads as the two characters it emits. */
const BACKSLASH = '\\';
const FIRST_PRINTABLE = 0x20;

/** RFC 8785 section 3.2.2.2 string serialisation: the two mandatory escapes, then the short forms. */
function canonicalString(value: string, path: string): string {
  if (hasLoneSurrogate(value)) {
    throw new AuditCanonicalError(
      path,
      'the string contains an unpaired surrogate, so it has no UTF-8 encoding',
      'Replace it with U+FFFD before the row is written; the hash is taken over UTF-8 bytes.',
    );
  }
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') out += String.raw`\"`;
    else if (character === BACKSLASH) out += `${BACKSLASH}${BACKSLASH}`;
    else if (code < FIRST_PRINTABLE) {
      out +=
        CONTROL_ESCAPES[code] ??
        `${BACKSLASH}u${code.toString(16).padStart(HEX_ESCAPE_WIDTH, '0')}`;
    } else out += character;
  }
  return `${out}"`;
}

/** RFC 8785 section 3.2.2.3: the ECMAScript shortest round-trip form, which `JSON.stringify` emits. */
function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new AuditCanonicalError(
      path,
      `${String(value)} is not a finite number and RFC 8785 has no serialisation for it`,
      'Record the quantity as a string, or omit it.',
    );
  }
  return JSON.stringify(value);
}

/** `Array.isArray` alone does not narrow a readonly array out of the union, so the guard is named. */
function isCanonicalArray(value: CanonicalValue): value is readonly CanonicalValue[] {
  return Array.isArray(value);
}

function canonicalise(value: CanonicalValue, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return canonicalNumber(value, path);
  if (typeof value === 'string') return canonicalString(value, path);
  if (isCanonicalArray(value)) {
    const items = value.map((item, index) => canonicalise(item, `${path}[${String(index)}]`));
    return `[${items.join(',')}]`;
  }
  // An object: sorted by key over UTF-16 code units, which is what `sort()` compares strings by.
  const keys = Object.keys(value).filter((key) => value[key] !== undefined);
  keys.sort();
  const members = keys.map((key) => {
    // The filter above dropped every absent member, so `?? null` is unreachable and is here only
    // because index access yields `T | undefined` under `noUncheckedIndexedAccess`.
    const member = value[key] ?? null;
    const serialised = canonicalise(member, path === '' ? key : `${path}.${key}`);
    return `${canonicalString(key, path)}:${serialised}`;
  });
  return `{${members.join(',')}}`;
}

/**
 * RFC 8785 (JSON Canonicalization Scheme): keys sorted by UTF-16 code unit, no insignificant
 * whitespace, shortest round-trip numbers, absent members omitted. The audit chain and
 * `iridium audit verify-chain` both hash the output of this function, and the audit export re-emits
 * it byte for byte, so it lives here rather than in either of them.
 */
export function canonicalJson(value: CanonicalValue): string {
  return canonicalise(value, '');
}

/**
 * The bytes `HMAC-SHA256(key, prev_hash ‖ …)` covers for one row. The HMAC itself belongs to the
 * server, which has `node:crypto`; the pre-image is a pure function of the row and is shared by the
 * writer, the verifier and the export.
 */
export function auditChainPreimage(payload: AuditChainPayload): string {
  if (!AUDIT_TIMESTAMP_PATTERN.test(payload.occurred_at)) {
    throw new AuditCanonicalError(
      'occurred_at',
      `'${payload.occurred_at}' is not YYYY-MM-DDTHH:MM:SS.ffffffZ`,
      'Format it with toTimestamp(); a second spelling of one instant is a second hash.',
    );
  }
  if (!ChainId.safeParse(payload.chain_id).success) {
    throw new AuditCanonicalError(
      'chain_id',
      `'${payload.chain_id}' is neither 'server' nor 'vault:<32 lowercase hex>'`,
      'Build it with chainIdForVault(); a second spelling of one chain forks it.',
    );
  }
  return canonicalJson({ ...payload });
}
