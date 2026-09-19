/**
 * The shared REST DTOs (09-api-reference.md section 2.0) and the header contract of section 1.2.
 *
 * Every schema here is a `z.strictObject`, because section 1.1 rejects unknown members on request
 * bodies and `openapi.contract` asserts `additionalProperties: false` on every request and response
 * object in the generated document. Every schema that appears in `components.schemas` carries its
 * name through `.meta({ id })`, which is the `z.globalRegistry` entry `fastify-type-provider-zod`
 * reads; an anonymous inline object is a lint failure in the generated document (section 6).
 *
 * **Why each DTO is an interface plus a schema.** Compiled packages build with
 * `isolatedDeclarations`, so an exported value needs an explicit type annotation, and spelling a
 * `z.ZodObject<…>` for a twenty-five-field body is both unreadable and unmaintainable. The
 * annotation is therefore the DTO's own interface, which TypeScript checks the schema's inferred
 * output against — a field the schema forgets is a compile error — and which is the named type
 * `@iridium/api-client` and `@iridium/ui` consume. `rest.dtos.unit` closes the other direction by
 * asserting each schema's JSON Schema key set, so a field the schema gains without the interface is
 * a red test rather than a silent widening. Optional members are written `?: T | undefined` because
 * `exactOptionalPropertyTypes` is on and `.optional()` infers exactly that.
 *
 * Role and Permission are **not** redeclared here: 09-api-reference.md section 2.0 shows them in
 * this module, but they already have one owning module in `authz.ts`, where the matrix that gives
 * them meaning lives. A second declaration would be a second source of truth.
 */

import { z } from 'zod';

import { Permission, Role, VaultStatus } from '../authz.ts';
import { NodeId, NoteId, SessionId, TokenId, UserId, VaultId } from '../ids.ts';
import { LIMITS } from '../limits.ts';
import { isSafeNodeName, RESERVED_DEVICE_NAMES } from '../paths.ts';
import { Timestamp } from '../time.ts';

// ---- headers, validators and the client contract (section 1.2) -------------------------------

/** The closed value set of `X-Iridium-Client`. */
export const CLIENT_KINDS = ['web', 'desktop'] as const;

/** A value of `X-Iridium-Client`, of `sessions.kind` and of `POST /auth/sessions`' `client`. */
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** A value of `X-Iridium-Client`. Exactly these two; anything else is `403 csrf_rejected`. */
export const ClientKind: z.ZodType<ClientKind> = z.enum(CLIENT_KINDS).meta({ id: 'ClientKind' });

/** The request headers of section 1.2, lower-cased as every HTTP/2 and Fastify surface carries them. */
export const REQUEST_HEADERS = {
  /** Required on every state-changing request that is not bearer-authenticated (A27). */
  client: 'x-iridium-client',
  /** Compared with `Meta.minClientVersion` (section 7.1). */
  clientVersion: 'x-iridium-client-version',
  /** Honoured from the reverse proxy inside `TRUST_PROXY`, else generated. */
  requestId: 'x-request-id',
  ifMatch: 'if-match',
  ifNoneMatch: 'if-none-match',
} as const;

/** The response headers this milestone's routes set beyond the framework's own. */
export const RESPONSE_HEADERS = {
  requestId: 'x-request-id',
  /** The integer `apiVersion` the response was produced under. */
  apiVersion: 'x-iridium-api-version',
  /** `GET /notes/:noteId/markdown` (section 2.8). */
  revision: 'x-iridium-revision',
  headRevision: 'x-iridium-head-revision',
  contentHash: 'x-iridium-content-hash',
  lineCount: 'x-iridium-line-count',
  returnedLines: 'x-iridium-returned-lines',
  projectionStatus: 'x-iridium-projection-status',
} as const;

/**
 * The headers a mutating, cookie-capable route requires. Loose rather than strict: a request carries
 * dozens of headers Iridium neither reads nor rejects, so strictness here would refuse every real
 * browser. The CSRF guard, not this schema, is what turns an absent value into `403 csrf_rejected`;
 * the schema is what puts the header in the OpenAPI document.
 */
export const ClientHeaders: z.ZodType<{
  readonly 'x-iridium-client': ClientKind;
  readonly 'x-iridium-client-version'?: string | undefined;
}> = z
  .looseObject({
    'x-iridium-client': ClientKind,
    'x-iridium-client-version': z.string().max(64).optional(),
  })
  .meta({ id: 'ClientHeaders' });

/**
 * Query flags accept exactly `true` or `false` (section 1.1). The codec keeps that wire enum visible
 * to JSON Schema while handlers receive booleans; `stringbool` exposes only an unconstrained
 * string to input-schema conversion. Each query composes its own boolean default.
 */
export const QueryBoolean: z.ZodType<boolean, 'true' | 'false'> = z.codec(
  z.enum(['true', 'false']),
  z.boolean(),
  { decode: (value) => value === 'true', encode: (value) => (value ? 'true' : 'false') },
);

/** A strong entity tag over a row version: `"<version>"` (section 1.2). */
export const STRONG_ETAG_PATTERN: RegExp = /^"(\d+)"$/;

/** The `ETag` a versioned read emits, and the value `If-Match` compares against. */
export function strongEtag(version: number): string {
  return `"${String(version)}"`;
}

/**
 * The version a strong `If-Match` names, or `null` for anything else — a weak validator (`W/…`),
 * `*`, a list, or a malformed value, all of which section 1.2 refuses with
 * `428 precondition_required` rather than treating as a match.
 */
export function parseStrongEtag(value: string): number | null {
  const match = STRONG_ETAG_PATTERN.exec(value.trim());
  if (match === null) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version > 0 ? version : null;
}

/**
 * The headers a route marked **If-Match** requires. The handler parses the same rule after reading
 * the row, so an absent or malformed value remains `428 precondition_required`, never a validator
 * error. The custom format also describes the positive safe-integer bound.
 */
export const IfMatchHeaders: z.ZodType<{ readonly 'if-match': string }> = z
  .looseObject({
    'if-match': z
      .string()
      .refine((value) => parseStrongEtag(value) !== null)
      .meta({ format: 'iridium-strong-etag', pattern: '^\\s*"0*[1-9][0-9]*"\\s*$' }),
  })
  .meta({ id: 'IfMatchHeaders' });

// ---- field primitives ------------------------------------------------------------------------

/** `users.email`, the login identity. */
export const Email: z.ZodType<string> = z.email().max(320).meta({ id: 'Email' });

/** `users.display_name`. */
export const DisplayName: z.ZodType<string> = z.string().min(1).max(120).meta({
  id: 'DisplayName',
});

/**
 * A password: any Unicode, 15 to 128 code points (04-auth-and-access-control.md section 3.4). The
 * breached-list check is server-side, so a refusal there is `422 validation_failed` with
 * `errors[].code = 'breached'` rather than a pattern in this schema.
 */
export const Password: z.ZodType<string> = z.string().min(15).max(128).meta({ id: 'Password' });

/**
 * The representable character rules of A12, shared by node and vault names. NFC, the UTF-8 byte
 * bound, lone-surrogate refusal and recursive percent-decoding remain the custom format's rules;
 * runtime validation always delegates to paths.ts. Device names come from that same vocabulary.
 */
const SAFE_NAME_PATTERN =
  '^(?![.\\s])(?!(?:' +
  RESERVED_DEVICE_NAMES.map((name) =>
    Array.from(name, (character) =>
      /[A-Z]/.test(character) ? '[' + character + character.toLowerCase() + ']' : character,
    ).join(''),
  ).join('|') +
  ')(?:\\.|$))[^\\x00-\\x1f\\x7f-\\x9f/\\\\]*[^.\\s\\x00-\\x1f\\x7f-\\x9f/\\\\]$';

/**
 * A node name: the A12 rules, the reserved Windows device names and the 255-byte cap, all through
 * `checkNodeName` so the rules live in `paths.ts` alone. The character cap in front of it can never
 * refuse a name the byte cap would accept, and it stops a megabyte of text reaching the rule set.
 */
export const NodeName: z.ZodType<string> = z
  .string()
  .min(1)
  .max(LIMITS.NODE_NAME_MAX_BYTES)
  .refine(isSafeNodeName, {
    error: 'the name breaks a node-name rule (03-data-model.md section 6.5)',
    params: { code: 'invalid_name' },
  })
  .meta({ id: 'NodeName', format: 'iridium-node-name', pattern: SAFE_NAME_PATTERN });

/** A vault name: `VAULT_NAME_MAX_CHARS` characters under the same character rules as a node name. */
export const VaultName: z.ZodType<string> = z
  .string()
  .min(1)
  .max(LIMITS.VAULT_NAME_MAX_CHARS)
  .refine(isSafeNodeName, {
    error: 'the name breaks a node-name rule (03-data-model.md section 6.5)',
    params: { code: 'invalid_name' },
  })
  .meta({ id: 'VaultName', format: 'iridium-node-name', pattern: SAFE_NAME_PATTERN });

/** A lowercase hex SHA-256 digest (section 1.1). */
export const Sha256Hex: z.ZodType<string> = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/)
  .meta({ id: 'Sha256Hex' });

/** A row version, the validator every `If-Match` route compares (section 1.7). */
export const Version: z.ZodType<number> = z.int().positive().meta({ id: 'Version' });

/** A hue on the colour wheel; the client derives the presence colour from it. */
export const ColorHue: z.ZodType<number> = z.int().min(0).max(359).meta({ id: 'ColorHue' });

// ---- users -----------------------------------------------------------------------------------

/** `users.status`. `deleted` exists for a later erasure flow; disabling is the supported removal. */
export const USER_STATUSES = ['active', 'disabled', 'deleted'] as const;

/** `users.status`. */
export type UserStatus = (typeof USER_STATUSES)[number];

/** `users.status`. */
export const UserStatus: z.ZodType<UserStatus> = z.enum(USER_STATUSES).meta({ id: 'UserStatus' });

/** An embedded author or actor: everything a client needs to render a name and a colour. */
export interface UserRef {
  readonly id: string;
  readonly displayName: string;
  readonly colorHue: number;
}

/** An embedded author or actor. */
export const UserRef: z.ZodType<UserRef> = z
  .strictObject({ id: UserId, displayName: z.string(), colorHue: z.int() })
  .meta({ id: 'UserRef' });

/** A user row as every surface renders it. */
export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly isServerAdmin: boolean;
  readonly status: UserStatus;
  readonly colorHue: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastLoginAt: string | null;
  /** `false` until a set-password link has been consumed (A28). */
  readonly hasCredentials: boolean;
  readonly version: number;
}

/** Each field of a user row, declared once so the admin listing row below cannot drift from it. */
const USER_FIELDS = {
  id: UserId,
  email: Email,
  displayName: DisplayName,
  isServerAdmin: z.boolean(),
  status: UserStatus,
  colorHue: ColorHue,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastLoginAt: Timestamp.nullable(),
  hasCredentials: z.boolean(),
  version: Version,
} as const;

/** A user row. */
export const User: z.ZodType<User> = z.strictObject(USER_FIELDS).meta({ id: 'User' });

/**
 * One row of `GET /admin/users` (section 2.15.1): the user plus the three counts the console lists.
 * It lives beside `User` rather than in `rest/admin-users.ts` because it is the same field set plus
 * three members, and that field set is private to this module.
 */
export interface AdminUserSummary extends User {
  readonly vaultCount: number;
  readonly sessionCount: number;
  readonly tokenCount: number;
}

/** One row of `GET /admin/users`. */
export const AdminUserSummary: z.ZodType<AdminUserSummary> = z
  .strictObject({
    ...USER_FIELDS,
    vaultCount: z.int().nonnegative(),
    sessionCount: z.int().nonnegative(),
    tokenCount: z.int().nonnegative(),
  })
  .meta({ id: 'AdminUserSummary' });

/** The token a `Me` was resolved from, so an agent can discover its own rights without probing. */
export interface MeToken {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly Permission[];
  readonly allVaults: boolean;
  readonly vaultIds: readonly string[];
  readonly expiresAt: string;
}

/** The token a `Me` was resolved from. */
export const MeToken: z.ZodType<MeToken> = z
  .strictObject({
    id: TokenId,
    name: z.string(),
    scopes: z.array(Permission),
    allVaults: z.boolean(),
    vaultIds: z.array(VaultId),
    expiresAt: Timestamp,
  })
  .meta({ id: 'MeToken' });

/** The current principal (`GET /auth/me`). */
export interface Me {
  readonly user: User;
  /** Always `false` for a token principal, even when its owner is an administrator. */
  readonly isServerAdmin: boolean;
  readonly principalKind: 'user' | 'token';
  readonly sessionKind?: ClientKind | undefined;
  readonly sessionId?: string | undefined;
  /** The step-up window's start, for user principals. */
  readonly lastAuthenticatedAt?: string | undefined;
  readonly token?: MeToken | undefined;
}

/** The current principal. */
export const Me: z.ZodType<Me> = z
  .strictObject({
    user: User,
    isServerAdmin: z.boolean(),
    principalKind: z.enum(['user', 'token']),
    sessionKind: ClientKind.optional(),
    sessionId: SessionId.optional(),
    lastAuthenticatedAt: Timestamp.optional(),
    token: MeToken.optional(),
  })
  .meta({ id: 'Me' });

// ---- sessions --------------------------------------------------------------------------------

/** Why a session row was revoked (`sessions.revoked_reason`). */
export const SESSION_REVOKED_REASONS = [
  'logout',
  'admin',
  'password_change',
  'user_disabled',
  'expired',
  'replaced',
] as const;

/** Why a session row was revoked. */
export type SessionRevokedReason = (typeof SESSION_REVOKED_REASONS)[number];

/** Why a session row was revoked. */
export const SessionRevokedReason: z.ZodType<SessionRevokedReason> = z
  .enum(SESSION_REVOKED_REASONS)
  .meta({ id: 'SessionRevokedReason' });

/** A session row as `GET /me/sessions` and the admin listing render it. */
export interface Session {
  readonly id: string;
  readonly kind: ClientKind;
  /** Whether this row is the session the request was authenticated with. */
  readonly current: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly lastAuthenticatedAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly clientName: string | null;
  readonly deviceName: string | null;
  readonly clientVersion: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: SessionRevokedReason | null;
  /** Admin listings only. */
  readonly user?: UserRef | undefined;
}

/** A session row. */
export const Session: z.ZodType<Session> = z
  .strictObject({
    id: SessionId,
    kind: ClientKind,
    current: z.boolean(),
    createdAt: Timestamp,
    lastSeenAt: Timestamp,
    idleExpiresAt: Timestamp,
    absoluteExpiresAt: Timestamp,
    lastAuthenticatedAt: Timestamp,
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    clientName: z.string().nullable(),
    deviceName: z.string().nullable(),
    clientVersion: z.string().nullable(),
    revokedAt: Timestamp.nullable(),
    revokedReason: SessionRevokedReason.nullable(),
    user: UserRef.optional(),
  })
  .meta({ id: 'Session' });

// ---- vaults ----------------------------------------------------------------------------------

/** `vaults.markdown_flavor`. `obsidian-compat` is a reserved value no 1.0 renderer honours (G2). */
export const MARKDOWN_FLAVORS = ['gfm', 'obsidian-compat'] as const;

/** `vaults.markdown_flavor`. */
export type MarkdownFlavor = (typeof MARKDOWN_FLAVORS)[number];

/** `vaults.markdown_flavor`. */
export const MarkdownFlavor: z.ZodType<MarkdownFlavor> = z
  .enum(MARKDOWN_FLAVORS)
  .meta({ id: 'MarkdownFlavor' });

/** `vaults.load_external_images`. */
export const LOAD_EXTERNAL_IMAGES = ['never', 'click', 'always'] as const;

/** `vaults.load_external_images`. */
export type LoadExternalImages = (typeof LOAD_EXTERNAL_IMAGES)[number];

/** `vaults.load_external_images`. */
export const LoadExternalImages: z.ZodType<LoadExternalImages> = z
  .enum(LOAD_EXTERNAL_IMAGES)
  .meta({ id: 'LoadExternalImages' });

/** Every per-vault setting a manager can change. */
export interface VaultSettings {
  readonly markdownFlavor: MarkdownFlavor;
  readonly softBreaks: boolean;
  readonly attachmentFolder: string;
  readonly loadExternalImages: LoadExternalImages;
  readonly mcpEnabled: boolean;
  readonly aiGuidance: string | null;
  readonly trashRetentionDays: number;
  readonly autoCheckpointIntervalMin: number;
}

/**
 * Each setting's own field schema, declared once so the complete object and the partial one below
 * carry identical bounds. Vault-relative, no leading `/` and no `..` on the attachment folder is
 * checked server-side, where the vault's tree is available.
 */
const SETTING_FIELDS = {
  markdownFlavor: MarkdownFlavor,
  softBreaks: z.boolean(),
  attachmentFolder: z.string().min(1).max(255),
  loadExternalImages: LoadExternalImages,
  mcpEnabled: z.boolean(),
  aiGuidance: z.string().max(LIMITS.AI_GUIDANCE_MAX_CHARS).nullable(),
  trashRetentionDays: z.int().min(1).max(3650),
  autoCheckpointIntervalMin: z.int().min(1).max(1440),
} as const;

/** Every per-vault setting a manager can change. */
export const VaultSettings: z.ZodType<VaultSettings> = z
  .strictObject(SETTING_FIELDS)
  .meta({ id: 'VaultSettings' });

/**
 * The settings a body may set a subset of: `POST /vaults`' optional `settings`, and from M2 the whole
 * of `PATCH /vaults/:vaultId`. An absent member means "leave the documented default", which is why it
 * is optional rather than nullable — `aiGuidance` is the one member where `null` is itself a value.
 */
export interface VaultSettingsPatch {
  readonly markdownFlavor?: MarkdownFlavor | undefined;
  readonly softBreaks?: boolean | undefined;
  readonly attachmentFolder?: string | undefined;
  readonly loadExternalImages?: LoadExternalImages | undefined;
  readonly mcpEnabled?: boolean | undefined;
  readonly aiGuidance?: string | null | undefined;
  readonly trashRetentionDays?: number | undefined;
  readonly autoCheckpointIntervalMin?: number | undefined;
}

/** The settings a body may set a subset of. */
export const VaultSettingsPatch: z.ZodType<VaultSettingsPatch> = z
  .strictObject({
    markdownFlavor: SETTING_FIELDS.markdownFlavor.optional(),
    softBreaks: SETTING_FIELDS.softBreaks.optional(),
    attachmentFolder: SETTING_FIELDS.attachmentFolder.optional(),
    loadExternalImages: SETTING_FIELDS.loadExternalImages.optional(),
    mcpEnabled: SETTING_FIELDS.mcpEnabled.optional(),
    aiGuidance: SETTING_FIELDS.aiGuidance.optional(),
    trashRetentionDays: SETTING_FIELDS.trashRetentionDays.optional(),
    autoCheckpointIntervalMin: SETTING_FIELDS.autoCheckpointIntervalMin.optional(),
  })
  .meta({ id: 'VaultSettingsPatch' });

/** Live row counts, computed per request rather than cached. */
export interface VaultCounts {
  readonly notes: number;
  readonly categories: number;
  readonly members: number;
  readonly attachments: number;
}

/** Live row counts. */
export const VaultCounts: z.ZodType<VaultCounts> = z
  .strictObject({
    notes: z.int(),
    categories: z.int(),
    members: z.int(),
    attachments: z.int(),
  })
  .meta({ id: 'VaultCounts' });

/** A vault as `GET /vaults/:vaultId` renders it. */
export interface Vault {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: VaultStatus;
  readonly archivedAt: string | null;
  readonly rootNodeId: string;
  readonly treeVersion: number;
  readonly settings: VaultSettings;
  /** The caller's explicit membership; `null` for a server admin without one. */
  readonly role: Role | null;
  /** The role authorization used: `manager` for a server admin. */
  readonly effectiveRole: Role;
  readonly counts: VaultCounts;
  readonly createdBy: UserRef;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** A vault. */
export const Vault: z.ZodType<Vault> = z
  .strictObject({
    id: VaultId,
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: VaultStatus,
    archivedAt: Timestamp.nullable(),
    rootNodeId: NodeId,
    treeVersion: z.int().nonnegative(),
    settings: VaultSettings,
    role: Role.nullable(),
    effectiveRole: Role,
    counts: VaultCounts,
    createdBy: UserRef,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    version: Version,
  })
  .meta({ id: 'Vault' });

/** One row of `GET /vaults`: the vault-picker projection of `Vault`. */
export interface VaultSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: VaultStatus;
  readonly role: Role | null;
  readonly effectiveRole: Role;
  readonly treeVersion: number;
  readonly updatedAt: string;
  readonly noteCount: number;
  readonly markdownFlavor: MarkdownFlavor;
  /** Reported even for a token principal: the flag gates `/mcp`, so an agent can explain itself. */
  readonly mcpEnabled: boolean;
}

/** One row of `GET /vaults`. */
export const VaultSummary: z.ZodType<VaultSummary> = z
  .strictObject({
    id: VaultId,
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    status: VaultStatus,
    role: Role.nullable(),
    effectiveRole: Role,
    treeVersion: z.int().nonnegative(),
    updatedAt: Timestamp,
    noteCount: z.int(),
    markdownFlavor: MarkdownFlavor,
    mcpEnabled: z.boolean(),
  })
  .meta({ id: 'VaultSummary' });

// ---- membership ------------------------------------------------------------------------------

/** The member's own row, with the e-mail and status a members list shows. */
export interface MemberUser {
  readonly id: string;
  readonly displayName: string;
  readonly colorHue: number;
  readonly email: string;
  readonly status: UserStatus;
}

/** The member's own row. */
export const MemberUser: z.ZodType<MemberUser> = z
  .strictObject({
    id: UserId,
    displayName: z.string(),
    colorHue: z.int(),
    email: Email,
    status: UserStatus,
  })
  .meta({ id: 'MemberUser' });

/** One `vault_members` row. Its `version` is the `If-Match` validator for the two writes. */
export interface Member {
  readonly user: MemberUser;
  readonly role: Role;
  readonly grantedBy: UserRef;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** One `vault_members` row. */
export const Member: z.ZodType<Member> = z
  .strictObject({
    user: MemberUser,
    role: Role,
    grantedBy: UserRef,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    version: Version,
  })
  .meta({ id: 'Member' });

// ---- nodes and notes -------------------------------------------------------------------------

/** `nodes.kind`. */
export const NODE_KINDS = ['category', 'note'] as const;

/** `nodes.kind`. A `NoteId` is the `NodeId` of a node with `kind='note'`. */
export type NodeKind = (typeof NODE_KINDS)[number];

/** `nodes.kind`. */
export const NodeKind: z.ZodType<NodeKind> = z.enum(NODE_KINDS).meta({ id: 'NodeKind' });

/** `note_projections.status`: why derived fields may be absent. */
export const PROJECTION_STATUSES = [
  'ok',
  'pending',
  'too_large',
  'too_complex',
  'timeout',
  'error',
  'invalid_content',
] as const;

/** `note_projections.status`. */
export type ProjectionStatus = (typeof PROJECTION_STATUSES)[number];

/** `note_projections.status`. */
export const ProjectionStatus: z.ZodType<ProjectionStatus> = z
  .enum(PROJECTION_STATUSES)
  .meta({ id: 'ProjectionStatus' });

/**
 * The note facts a listing carries, so a tree can show the title, the staleness dot
 * (`revision < headRevision`) and the oversize and invalid badges without a second request.
 */
export interface NoteSummary {
  /** `COALESCE(heading_title, name)`. */
  readonly title: string;
  /** The projected `note_updates.seq`. */
  readonly revision: number;
  /** `note_docs.head_seq`. */
  readonly headRevision: number;
  readonly contentHash: string | null;
  readonly sizeChars: number;
  readonly oversize: boolean;
  readonly contentInvalid: boolean;
  readonly projectionStatus: ProjectionStatus;
  /** `[]` for a note whose first projection has not committed. */
  readonly fmTags: readonly string[];
  readonly fmAliases: readonly string[];
  readonly lastEditedBy: UserRef | null;
  readonly lastEditedAt: string | null;
}

/** The note facts a listing carries. */
export const NoteSummary: z.ZodType<NoteSummary> = z
  .strictObject({
    title: z.string(),
    revision: z.int().nonnegative(),
    headRevision: z.int().nonnegative(),
    contentHash: Sha256Hex.nullable(),
    sizeChars: z.int(),
    oversize: z.boolean(),
    contentInvalid: z.boolean(),
    projectionStatus: ProjectionStatus,
    fmTags: z.array(z.string().max(LIMITS.FM_TAG_MAX_LEN)).max(LIMITS.FM_TAGS_MAX),
    fmAliases: z.array(z.string().max(LIMITS.FM_ALIAS_MAX_LEN)).max(LIMITS.FM_ALIASES_MAX),
    lastEditedBy: UserRef.nullable(),
    lastEditedAt: Timestamp.nullable(),
  })
  .meta({ id: 'NoteSummary' });

/** Live child counts, present on a category on tree pages. */
export interface NodeChildCounts {
  readonly categories: number;
  readonly notes: number;
}

/** Live child counts. */
export const NodeChildCounts: z.ZodType<NodeChildCounts> = z
  .strictObject({ categories: z.int(), notes: z.int() })
  .meta({ id: 'NodeChildCounts' });

/** One `nodes` row with its derived path. Ids are stable; paths are derived per request (A12). */
export interface Node {
  readonly id: string;
  readonly vaultId: string;
  readonly parentId: string;
  readonly kind: NodeKind;
  readonly name: string;
  /** Derived, `''` for the root row. */
  readonly path: string;
  readonly deletedAt: string | null;
  readonly version: number;
  readonly createdBy: UserRef;
  readonly updatedBy: UserRef;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Present when `kind === 'note'`. */
  readonly note?: NoteSummary | undefined;
  /** Present when `kind === 'category'` on tree pages. */
  readonly childCounts?: NodeChildCounts | undefined;
}

/** One `nodes` row. */
export const Node: z.ZodType<Node> = z
  .strictObject({
    id: NodeId,
    vaultId: VaultId,
    parentId: NodeId,
    kind: NodeKind,
    name: z.string(),
    path: z.string().max(4096),
    deletedAt: Timestamp.nullable(),
    version: Version,
    createdBy: UserRef,
    updatedBy: UserRef,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    note: NoteSummary.optional(),
    childCounts: NodeChildCounts.optional(),
  })
  .meta({ id: 'Node' });

/** `notes.original_eol`, recorded at import and restored on export. */
export const ORIGINAL_EOLS = ['lf', 'crlf', 'cr', 'mixed'] as const;

/** `notes.original_eol`. */
export type OriginalEol = (typeof ORIGINAL_EOLS)[number];

/** `notes.original_eol`. */
export const OriginalEol: z.ZodType<OriginalEol> = z
  .enum(ORIGINAL_EOLS)
  .meta({ id: 'OriginalEol' });

/** One heading of the committed projection. */
export interface NoteHeading {
  readonly depth: number;
  readonly text: string;
  readonly slug: string;
  readonly line: number;
  readonly offset: number;
}

/** One heading of the committed projection. */
export const NoteHeading: z.ZodType<NoteHeading> = z
  .strictObject({
    depth: z.int().min(1).max(6),
    text: z.string(),
    slug: z.string(),
    line: z.int(),
    offset: z.int(),
  })
  .meta({ id: 'NoteHeading' });

/** One task list item of the committed projection. */
export interface NoteTask {
  readonly line: number;
  readonly offset: number;
  readonly checked: boolean;
}

/** One task list item of the committed projection. */
export const NoteTask: z.ZodType<NoteTask> = z
  .strictObject({ line: z.int(), offset: z.int(), checked: z.boolean() })
  .meta({ id: 'NoteTask' });

/**
 * A note's full metadata (`GET /notes/:noteId`). Every derived member is nullable or empty, because
 * `projectionStatus` is what tells a client why: `pending` before the first projection, and
 * `too_large`, `too_complex`, `timeout` or `error` when the pre-scan or the worker refused — the
 * Markdown is still served in every one of those cases.
 *
 * `obsidianFindings` of 09-api-reference.md section 2.0 is deliberately **absent at M1**: its code
 * vocabulary is `@iridium/contracts/import-report.ts`, which 12-milestones.md section 6.2 adds with
 * the detector at M2. Adding a response member is additive (section 7.2), so it arrives with the
 * enum that gives it meaning rather than as a field typed loosely now.
 */
export interface NoteMeta extends NoteSummary {
  readonly id: string;
  readonly vaultId: string;
  readonly parentId: string;
  readonly name: string;
  readonly path: string;
  readonly version: number;
  readonly lineCount: number | null;
  readonly wordCount: number | null;
  readonly originalEol: OriginalEol;
  readonly hadBom: boolean;
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly frontmatterError: string | null;
  readonly headings: readonly NoteHeading[];
  readonly tasks: readonly NoteTask[];
  readonly codeLangs: readonly string[];
  readonly linksCount: number;
  readonly backlinksCount: number;
  readonly pipelineVersion: number;
  readonly projectedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A note's full metadata. */
export const NoteMeta: z.ZodType<NoteMeta> = z
  .strictObject({
    title: z.string(),
    revision: z.int().nonnegative(),
    headRevision: z.int().nonnegative(),
    contentHash: Sha256Hex.nullable(),
    sizeChars: z.int(),
    oversize: z.boolean(),
    contentInvalid: z.boolean(),
    projectionStatus: ProjectionStatus,
    fmTags: z.array(z.string().max(LIMITS.FM_TAG_MAX_LEN)).max(LIMITS.FM_TAGS_MAX),
    fmAliases: z.array(z.string().max(LIMITS.FM_ALIAS_MAX_LEN)).max(LIMITS.FM_ALIASES_MAX),
    lastEditedBy: UserRef.nullable(),
    lastEditedAt: Timestamp.nullable(),
    id: NoteId,
    vaultId: VaultId,
    parentId: NodeId,
    name: z.string(),
    path: z.string().max(4096),
    version: Version,
    lineCount: z.int().nullable(),
    wordCount: z.int().nullable(),
    originalEol: OriginalEol,
    hadBom: z.boolean(),
    frontmatter: z.record(z.string(), z.unknown()).nullable(),
    frontmatterError: z.string().nullable(),
    headings: z.array(NoteHeading),
    tasks: z.array(NoteTask),
    codeLangs: z.array(z.string()),
    linksCount: z.int(),
    backlinksCount: z.int(),
    pipelineVersion: z.int(),
    projectedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'NoteMeta' });
