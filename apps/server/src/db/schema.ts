/**
 * The hand-written `Database` interface: the type source for every Kysely query in the server.
 *
 * 03-data-model.md section 1.3 fixes the mapping this file implements:
 *   BINARY(16) / BINARY(32) / VARBINARY / *BLOB  -> Buffer
 *   DATETIME(6)                                  -> Date
 *   BIGINT UNSIGNED                              -> number  (every sequence counter stays far below
 *                                                  2^53; the boot assertion `supportBigNumbers &&
 *                                                  !bigNumberStrings` guarantees numbers, never
 *                                                  strings, so Kysely's own `numUpdatedRows` is the
 *                                                  only bigint anywhere in the persistence path)
 *   JSON                                         -> the typed shape declared per column below
 *   TINYINT(1)                                   -> boolean (mysql2 `typeCast`, db/pool.ts)
 *   ENUM                                         -> a string-literal union
 *
 * `pnpm gen` runs kysely-codegen 0.20.0 against the freshly migrated schema and CI fails on any
 * difference (A3), so a migration that forgets its type change cannot merge and a type change with
 * no migration cannot merge either. The structural half of that comparison -- every table and column
 * of the migrated database appears here and nothing else does -- is asserted by
 * `migrations.integration`.
 *
 * The ENUM unions below are declared here rather than imported from `@iridium/contracts` only
 * because that package is still the M0 placeholder; each one is mirrored by a zod enum there
 * (03-data-model.md section 1.2) and becomes a re-export as soon as the contracts modules land.
 * `Generated<T>` marks a column with a DEFAULT or AUTO_INCREMENT (optional on insert);
 * `GeneratedAlways<T>` marks a generated column (never insertable, never updatable).
 */
import type { ObsidianFindings } from '@iridium/markdown';
import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

/** A JSON column: parsed on the way out (mysql2 `jsonStrings:false`), a JSON string on the way in. */
type Json<T> = ColumnType<T, string, string>;
/** A nullable JSON column. */
type NullableJson<T> = ColumnType<T | null, string | null, string | null>;

// ---------------------------------------------------------------------------------------------
// Enumerations (each mirrored by a zod enum in @iridium/contracts; additive at the end only)
// ---------------------------------------------------------------------------------------------

export type UserStatus = 'active' | 'disabled' | 'deleted';
export type PasswordSetupPurpose = 'initial' | 'reset';
export type SessionKind = 'web' | 'desktop';
export type SessionRevokedReason =
  | 'logout'
  | 'admin'
  | 'password_change'
  | 'user_disabled'
  | 'expired'
  | 'replaced';
export type AccessTokenKind = 'pat' | 'oauth' | 'scim';
export type OauthRegistrationKind = 'cimd' | 'dynamic' | 'manual';
export type OauthApplicationType = 'native' | 'web';
export type OauthTokenEndpointAuthMethod = 'none' | 'client_secret_basic';
export type OauthClientStatus = 'active' | 'disabled';
export type OauthCodeChallengeMethod = 'S256';
export type VaultStatus = 'importing' | 'active' | 'archived' | 'deleting';
export type MarkdownFlavor = 'gfm' | 'obsidian-compat';
export type ExternalImagePolicy = 'never' | 'click' | 'always';
export type VaultRole = 'viewer' | 'editor' | 'manager';
export type NodeKind = 'category' | 'note';
export type NoteEol = 'lf' | 'crlf' | 'cr' | 'mixed';
export type UpdateActorType = 'user' | 'system';
export type UpdateOrigin = 'connection' | 'create' | 'import' | 'restore' | 'repair';
export type RevisionKind =
  | 'create'
  | 'import'
  | 'checkpoint'
  | 'unload'
  | 'named'
  | 'pre_restore'
  | 'restore'
  | 'trash';
export type RevisionActorType = 'user' | 'token' | 'system';
export type ProjectionStatus =
  | 'ok'
  | 'pending'
  | 'too_large'
  | 'too_complex'
  | 'timeout'
  | 'error'
  | 'invalid_content';
export type LinkKind = 'markdown' | 'image' | 'wikilink' | 'embed' | 'definition';
export type LinkStatus = 'resolved' | 'ambiguous' | 'broken' | 'external';
export type AttachmentEncryption = 'none' | 'aes256gcm';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ImportSourceKind = 'zip' | 'files';
export type ImportPhase =
  | 'uploading'
  | 'scanning'
  | 'reported'
  | 'committing'
  | 'done'
  | 'failed'
  | 'aborted';
export type ExportFormat = 'zip';
export type AuditActorType = 'user' | 'token' | 'system';
export type AuditCredentialType =
  | 'session'
  | 'pat'
  | 'oauth'
  | 'ticket'
  | 'setpw'
  | 'cli'
  | 'system'
  | 'none';
export type AuditOutcome = 'success' | 'failure';
export type AccessLogSurface = 'mcp' | 'rest' | 'export' | 'oauth';
export type AccessLogStatus = 'ok' | 'denied' | 'not_found' | 'error' | 'rate_limited';
export type ReleaseChannel = 'stable' | 'beta';

// ---------------------------------------------------------------------------------------------
// JSON column shapes
// ---------------------------------------------------------------------------------------------

/** `note_projections.headings` (08-markdown-pipeline-import-export.md section 5.3). */
export interface ProjectedHeading {
  depth: number;
  text: string;
  slug: string;
  line: number;
  offset: number;
}

/** `note_projections.tasks`: GFM task list items. */
export interface ProjectedTask {
  line: number;
  offset: number;
  checked: boolean;
}

/** Complete detector counts plus the first bounded document-order findings (08 section 6). */
export interface ProjectedObsidianFindings {
  counts: ObsidianFindings['counts'];
  sample: ObsidianFindings['findings'];
}

/** `audit_events.context`. */
export interface AuditContext {
  ip?: string;
  user_agent?: string;
  request_id?: string;
  client?: string;
  mcp_client?: string;
  os_user?: string;
}

/** `audit_events.targets`: element for element the shape `AuditEvent.targets` publishes. */
export interface AuditTarget {
  type: string;
  id: string;
  path?: string;
}

/** `jobs.progress`: a typed object per job type, written at most once per second. */
export interface JobProgress {
  phase: string;
  done: number;
  total: number;
  cursor?: string;
}

/** `import_jobs.stats` (03-data-model.md section 11.3, D03-20). */
export interface ImportStats {
  upload: { files: number; bytes: number; sha256: string | null };
  replaced?: boolean;
  notes?: number;
  categories?: number;
  attachments?: number;
  bytes?: number;
  skipped?: number;
  collisionsResolved?: number;
  renamed?: number;
}

/** `export_jobs.manifest`: the `manifest.json` the archive contains. */
export interface ExportManifest {
  format: 'iridium-export/1';
  vault: { id: string; name: string; flavor: MarkdownFlavor };
  exported_at: string;
  notes: Array<{
    note_id: string;
    path: string;
    revision: number;
    content_hash: string;
    updated_at: string;
  }>;
  attachments: Array<{ attachment_id: string; path: string; sha256: string; size: number }>;
  warnings: string[];
}

/** `desktop_releases.files`; the platform vocabulary is `process.platform`'s. */
export interface DesktopReleaseFile {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  name: string;
  sha256: string;
  sha512: string;
  size: number;
  blockmap?: string;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

export interface UsersTable {
  id: Buffer;
  email: string;
  email_key: GeneratedAlways<string>;
  display_name: string;
  is_server_admin: Generated<boolean>;
  status: Generated<UserStatus>;
  color_hue: number;
  authz_version: Generated<number>;
  version: Generated<number>;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export interface UserCredentialsTable {
  user_id: Buffer;
  password_hash: string;
  pepper_version: number;
  password_changed_at: Date;
}

export interface PasswordSetupTokensTable {
  id: Buffer;
  token_id: string;
  secret_hash: Buffer;
  user_id: Buffer;
  purpose: PasswordSetupPurpose;
  issued_by: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export interface SessionsTable {
  id: Buffer;
  token_id: string;
  secret_hash: Buffer;
  user_id: Buffer;
  kind: SessionKind;
  created_at: Date;
  last_seen_at: Date;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  last_authenticated_at: Date;
  mfa_verified_at: Date | null;
  ip: Buffer | null;
  user_agent: string | null;
  client_name: string | null;
  device_name: string | null;
  client_version: string | null;
  revoked_at: Date | null;
  revoked_reason: SessionRevokedReason | null;
}

/** The `rate-limiter-flexible` RateLimiterMySQL store, pre-created because the app role has no DDL. */
export interface LoginThrottleTable {
  key: string;
  points: number;
  expire: number | null;
}

export interface AccessTokensTable {
  id: Buffer;
  token_id: string;
  secret_hash: Buffer;
  user_id: Buffer;
  kind: Generated<AccessTokenKind>;
  name: string;
  display_prefix: string;
  scopes: Json<string[]>;
  all_vaults: Generated<boolean>;
  admin_owned: Generated<boolean>;
  expires_at: Date;
  last_used_at: Date | null;
  last_used_ip: Buffer | null;
  last_client: string | null;
  rate_limit_per_hour: number | null;
  created_at: Date;
  created_from_session_id: Buffer | null;
  created_ip: Buffer | null;
  created_user_agent: string | null;
  rotated_from_id: Buffer | null;
  rotation_overlap_until: Date | null;
  client_id: Buffer | null;
  consent_id: Buffer | null;
  refresh_id: Buffer | null;
  resource: string | null;
  revoked_at: Date | null;
  revoked_by: Buffer | null;
  revoke_reason: string | null;
  version: Generated<number>;
}

export interface AccessTokenVaultsTable {
  token_id: Buffer;
  vault_id: Buffer;
}

export interface OauthClientsTable {
  id: Buffer;
  client_id: string;
  registration_kind: OauthRegistrationKind;
  client_name: string;
  client_uri: string | null;
  logo_uri: string | null;
  application_type: OauthApplicationType;
  token_endpoint_auth_method: Generated<OauthTokenEndpointAuthMethod>;
  client_secret_hash: Buffer | null;
  client_secret_prefix: string | null;
  redirect_uris: Json<string[]>;
  grant_types: Json<string[]>;
  scopes: NullableJson<string[]>;
  cimd_document: NullableJson<Record<string, unknown>>;
  cimd_fetched_at: Date | null;
  cimd_etag: string | null;
  status: Generated<OauthClientStatus>;
  created_at: Date;
  created_by_user_id: Buffer | null;
  last_authorized_at: Date | null;
  disabled_at: Date | null;
  disabled_by: Buffer | null;
  version: Generated<number>;
}

export interface OauthConsentsTable {
  id: Buffer;
  user_id: Buffer;
  client_id: Buffer;
  scopes: Json<string[]>;
  all_vaults: Generated<boolean>;
  admin_owned: Generated<boolean>;
  granted_at: Date;
  granted_session_id: Buffer | null;
  updated_at: Date;
  last_authorized_at: Date | null;
  revoked_at: Date | null;
  revoked_by: Buffer | null;
  revoke_reason: string | null;
  version: Generated<number>;
  live_consent_key: GeneratedAlways<Buffer | null>;
}

export interface OauthConsentVaultsTable {
  consent_id: Buffer;
  vault_id: Buffer;
}

export interface OauthAuthorizationCodesTable {
  id: Buffer;
  code_id: string;
  secret_hash: Buffer;
  client_id: Buffer;
  user_id: Buffer;
  consent_id: Buffer;
  session_id: Buffer;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: OauthCodeChallengeMethod;
  resource: string;
  scopes: Json<string[]>;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface OauthRefreshTokensTable {
  id: Buffer;
  token_id: string;
  secret_hash: Buffer;
  family_id: Buffer;
  rotated_from_id: Buffer | null;
  client_id: Buffer;
  user_id: Buffer;
  consent_id: Buffer;
  resource: string;
  scopes: Json<string[]>;
  issued_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
  last_used_at: Date | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

export interface VaultsTable {
  id: Buffer;
  name: string;
  slug: string;
  description: string | null;
  root_node_id: Buffer | null;
  status: Generated<VaultStatus>;
  archived_at: Date | null;
  markdown_flavor: Generated<MarkdownFlavor>;
  soft_breaks: Generated<boolean>;
  attachment_folder: Generated<string>;
  load_external_images: Generated<ExternalImagePolicy>;
  mcp_enabled: Generated<boolean>;
  ai_guidance: string | null;
  trash_retention_days: Generated<number>;
  auto_checkpoint_interval_min: Generated<number>;
  tree_version: Generated<number>;
  version: Generated<number>;
  created_by: Buffer;
  created_at: Date;
  updated_at: Date;
}

export interface VaultMembersTable {
  vault_id: Buffer;
  user_id: Buffer;
  role: VaultRole;
  version: Generated<number>;
  granted_by: Buffer;
  created_at: Date;
  updated_at: Date;
}

export interface NodesTable {
  id: Buffer;
  vault_id: Buffer;
  parent_id: Buffer;
  kind: NodeKind;
  name: string;
  deleted_at: Date | null;
  live: GeneratedAlways<number | null>;
  version: Generated<number>;
  created_by: Buffer;
  updated_by: Buffer;
  created_at: Date;
  updated_at: Date;
}

export interface TrashEntriesTable {
  node_id: Buffer;
  vault_id: Buffer;
  cascade_root_id: Buffer;
  deleted_by: Buffer;
  deleted_at: Date;
  original_parent_id: Buffer;
  original_path: string;
  expires_at: Date;
}

export interface NotesTable {
  node_id: Buffer;
  vault_id: Buffer;
  initialized_at: Date | null;
  original_eol: Generated<NoteEol>;
  had_bom: Generated<boolean>;
  size_chars: Generated<number>;
  oversize: Generated<boolean>;
  content_invalid: Generated<boolean>;
  last_edited_by: Buffer | null;
  last_edited_at: Date | null;
  last_checkpoint_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface NoteDocsTable {
  note_id: Buffer;
  head_seq: Generated<number>;
  snapshot_format: Generated<number>;
  yjs_major: Generated<number>;
  snapshot: Buffer | null;
  snapshot_sv: Buffer | null;
  snapshot_through_seq: Generated<number>;
  snapshot_size: Generated<number>;
  snapshot_at: Date | null;
  projected_seq: Generated<number>;
  updated_at: Date;
}

export interface NoteUpdatesTable {
  note_id: Buffer;
  seq: number;
  update_v1: Buffer;
  yjs_major: Generated<number>;
  sv_after: Buffer;
  actor_type: UpdateActorType;
  actor_id: Buffer | null;
  session_id: Buffer | null;
  origin: UpdateOrigin;
  created_at: Date;
}

export interface NoteRevisionsTable {
  id: Generated<number>;
  note_id: Buffer;
  seq: number;
  kind: RevisionKind;
  label: string | null;
  markdown: string;
  content_hash: Buffer;
  size_chars: number;
  snapshot: Buffer | null;
  snapshot_format: number | null;
  yjs_major: number | null;
  snapshot_sv: Buffer | null;
  actor_type: RevisionActorType;
  actor_id: Buffer | null;
  restored_from_revision_id: number | null;
  created_at: Date;
}

export interface NoteProjectionsTable {
  note_id: Buffer;
  revision: number;
  markdown: string;
  content_hash: Buffer;
  heading_title: string | null;
  frontmatter_raw: string | null;
  frontmatter: NullableJson<unknown>;
  frontmatter_error: string | null;
  fm_tags: NullableJson<string[]>;
  fm_aliases: NullableJson<string[]>;
  headings: NullableJson<ProjectedHeading[]>;
  tasks: NullableJson<ProjectedTask[]>;
  code_langs: NullableJson<string[]>;
  obsidian_findings: NullableJson<ProjectedObsidianFindings>;
  word_count: number | null;
  line_count: number | null;
  status: ProjectionStatus;
  pipeline_version: number;
  projected_at: Date;
}

/** Bounded, normalized frontmatter lookup terms, replaced atomically with their projection. */
export interface NoteProjectionTermsTable {
  note_id: Buffer;
  vault_id: Buffer;
  kind: 'tag' | 'alias';
  term_hash: Buffer;
}

export interface NoteSearchTable {
  note_id: Buffer;
  vault_id: Buffer;
  title: string;
  body_text: string;
  revision: number;
  updated_at: Date;
}

export interface NoteLinksTable {
  id: Generated<number>;
  from_note_id: Buffer;
  vault_id: Buffer;
  revision: number;
  ordinal: number;
  kind: LinkKind;
  raw_target: string;
  resolved_node_id: Buffer | null;
  resolved_attachment_id: Buffer | null;
  fragment: string | null;
  status: LinkStatus;
  start_offset: number;
  end_offset: number;
  line: number;
}

export interface AttachmentsTable {
  id: Buffer;
  vault_id: Buffer;
  sha256: Buffer;
  size_bytes: number;
  mime: string;
  original_name: string;
  path_hint: string | null;
  storage_key: string;
  encryption: Generated<AttachmentEncryption>;
  key_version: number | null;
  iv: Buffer | null;
  auth_tag: Buffer | null;
  uploaded_by: Buffer;
  created_at: Date;
  deleted_at: Date | null;
  live: GeneratedAlways<number | null>;
  version: Generated<number>;
}

export interface JobsTable {
  id: Buffer;
  type: string;
  status: JobStatus;
  vault_id: Buffer | null;
  requested_by: Buffer | null;
  payload: Json<Record<string, unknown>>;
  progress: NullableJson<JobProgress>;
  result: NullableJson<Record<string, unknown>>;
  error: string | null;
  attempts: Generated<number>;
  locked_by: string | null;
  locked_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface ImportJobsTable {
  job_id: Buffer;
  target_vault_id: Buffer | null;
  target_parent_id: Buffer | null;
  source_kind: ImportSourceKind;
  source_sha256: Buffer | null;
  staging_key: string;
  phase: ImportPhase;
  report: NullableJson<Record<string, unknown>>;
  options: NullableJson<Record<string, unknown>>;
  stats: NullableJson<ImportStats>;
  committed_at: Date | null;
  expires_at: Date;
}

export interface ExportJobsTable {
  job_id: Buffer;
  vault_id: Buffer;
  scope_node_id: Buffer | null;
  format: ExportFormat;
  restore_eol: Generated<boolean>;
  include_attachments: Generated<boolean>;
  include_trashed: Generated<boolean>;
  manifest: NullableJson<ExportManifest>;
  artifact_key: string | null;
  artifact_sha256: Buffer | null;
  size_bytes: number | null;
  expires_at: Date;
}

export interface AuditEventsTable {
  id: Generated<number>;
  occurred_at: Date;
  schema_version: Generated<number>;
  chain_id: string;
  action: string;
  actor_type: AuditActorType;
  actor_id: Buffer | null;
  actor_display: string | null;
  on_behalf_of_user_id: Buffer | null;
  credential_type: AuditCredentialType;
  credential_id: Buffer | null;
  vault_id: Buffer | null;
  target_type: string | null;
  target_id: Buffer | null;
  targets: NullableJson<AuditTarget[]>;
  outcome: AuditOutcome;
  reason: string | null;
  context: Json<AuditContext>;
  metadata: NullableJson<Record<string, unknown>>;
  prev_hash: Buffer;
  hash: Buffer;
  key_version: number;
}

export interface AuditChainHeadsTable {
  chain_id: string;
  last_id: number;
  last_hash: Buffer;
}

export interface AccessLogTable {
  id: Generated<number>;
  occurred_at: Date;
  token_id: Buffer | null;
  user_id: Buffer;
  surface: AccessLogSurface;
  action: string;
  vault_id: Buffer | null;
  note_ids: NullableJson<string[]>;
  note_ids_truncated: Generated<boolean>;
  revision: number | null;
  status: AccessLogStatus;
  latency_ms: number;
  bytes_out: number | null;
  client_name: string | null;
  client_version: string | null;
  oauth_client_id: Buffer | null;
  ip: Buffer | null;
  request_id: Buffer | null;
}

export interface ServerSettingsTable {
  key: string;
  value: Json<Record<string, unknown>>;
  updated_by: Buffer | null;
  updated_at: Date;
  version: Generated<number>;
}

/** At-least-once session invalidations; deliberately independent of session-row retention. */
/** A successful result and its exact session events commit together with the revocation. */
export type SessionRevocationCommandResult =
  | {
      readonly ok: true;
      readonly users: number;
      readonly sessions: readonly { readonly userId: string; readonly sessionId: string }[];
    }
  | { readonly ok: false };

export interface SessionRevocationCommandsTable {
  id: Buffer;
  /** Null selects every user with a live session when the owner executes the command. */
  user_id: Buffer | null;
  actor_type: AuditActorType;
  actor_id: Buffer | null;
  actor_display: string | null;
  context: Json<AuditContext>;
  created_at: Date;
  result: NullableJson<SessionRevocationCommandResult>;
  delivered_at: Date | null;
}

/** The singleton generation changed only by an exclusive collaboration lease claimant. */
export interface CollabOwnerFenceTable {
  id: number;
  generation: Buffer;
}

export interface SchemaMetaTable {
  key: string;
  value: string;
}

export interface DesktopReleasesTable {
  version: string;
  channel: ReleaseChannel;
  published_at: Date;
  published_by: Buffer | null;
  notes: string | null;
  files: Json<DesktopReleaseFile[]>;
  withdrawn_at: Date | null;
  withdrawn_by: Buffer | null;
}

/** Created and owned by kysely-ctl; `iridium_app` holds SELECT only, for the /readyz comparison. */
export interface KyselyMigrationTable {
  name: string;
  timestamp: string;
}

/** Created and owned by kysely-ctl. */
export interface KyselyMigrationLockTable {
  id: string;
  is_locked: Generated<number>;
}

/**
 * The database. Keys are the MySQL table names verbatim: column names are snake_case end to end and
 * neither `CamelCasePlugin` nor `ParseJSONResultsPlugin` is installed (03-data-model.md section 1.3).
 */
export interface Database {
  access_log: AccessLogTable;
  access_token_vaults: AccessTokenVaultsTable;
  access_tokens: AccessTokensTable;
  attachments: AttachmentsTable;
  audit_chain_heads: AuditChainHeadsTable;
  audit_events: AuditEventsTable;
  audit_events_archive: AuditEventsTable;
  collab_owner_fence: CollabOwnerFenceTable;
  desktop_releases: DesktopReleasesTable;
  export_jobs: ExportJobsTable;
  import_jobs: ImportJobsTable;
  jobs: JobsTable;
  kysely_migration: KyselyMigrationTable;
  kysely_migration_lock: KyselyMigrationLockTable;
  login_throttle: LoginThrottleTable;
  nodes: NodesTable;
  note_docs: NoteDocsTable;
  note_links: NoteLinksTable;
  note_projections: NoteProjectionsTable;
  note_projection_terms: NoteProjectionTermsTable;
  note_revisions: NoteRevisionsTable;
  note_search: NoteSearchTable;
  note_updates: NoteUpdatesTable;
  notes: NotesTable;
  oauth_authorization_codes: OauthAuthorizationCodesTable;
  oauth_clients: OauthClientsTable;
  oauth_consent_vaults: OauthConsentVaultsTable;
  oauth_consents: OauthConsentsTable;
  oauth_refresh_tokens: OauthRefreshTokensTable;
  password_setup_tokens: PasswordSetupTokensTable;
  schema_meta: SchemaMetaTable;
  server_settings: ServerSettingsTable;
  sessions: SessionsTable;
  session_revocation_commands: SessionRevocationCommandsTable;
  trash_entries: TrashEntriesTable;
  user_credentials: UserCredentialsTable;
  users: UsersTable;
  vault_members: VaultMembersTable;
  vaults: VaultsTable;
}
