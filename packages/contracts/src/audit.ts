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

import type { EnumOf } from './schema.ts';

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
