/**
 * `vaults` rows as the wire renders them (09-api-reference.md §2.0 `Vault` and `VaultSummary`).
 *
 * Two shapes, deliberately: `Vault` is one vault in full, with the live counts a vault page shows,
 * and `VaultSummary` is the vault-picker projection — the same identity plus the four fields a
 * picker sorts, badges and routes on. A listing that returned the full shape would run four counting
 * queries per row.
 *
 * `role` is the caller's **explicit** membership and `effectiveRole` is the role authorization
 * actually decided with, which is `manager` for a server admin with no row (04-auth-and-access-control.md
 * §5.4). Keeping both on the wire is what lets a client say "you can manage this because you are an
 * administrator" instead of inventing a membership that does not exist.
 */
import { maxRole, type Role, type Vault, type VaultSummary } from '@iridium/contracts';

import { userIdFromBytes, vaultIdFromBytes } from '../auth/ids.ts';
import type { ExternalImagePolicy, MarkdownFlavor, VaultStatus } from '../db/schema.ts';
import { nodeIdFromBytes } from '../tree/ids.ts';

/** Every `vaults` column the two shapes read, plus the creator's user row. */
export interface VaultRow {
  readonly id: Buffer;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly root_node_id: Buffer | null;
  readonly status: VaultStatus;
  readonly archived_at: Date | null;
  readonly markdown_flavor: MarkdownFlavor;
  readonly soft_breaks: boolean;
  readonly attachment_folder: string;
  readonly load_external_images: ExternalImagePolicy;
  readonly mcp_enabled: boolean;
  readonly ai_guidance: string | null;
  readonly trash_retention_days: number;
  readonly auto_checkpoint_interval_min: number;
  readonly tree_version: number;
  readonly version: number;
  readonly created_by: Buffer;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** The creator, as `UserRef` renders an actor. */
export interface CreatorRow {
  readonly id: Buffer;
  readonly display_name: string;
  readonly color_hue: number;
}

/** The four live counts of `Vault.counts`, computed per request rather than cached (§2.5). */
export interface VaultCountRow {
  readonly notes: number;
  readonly categories: number;
  readonly members: number;
  readonly attachments: number;
}

/** The columns every `vaults` read selects, so the two shapes cannot diverge on one. */
export const VAULT_COLUMNS = [
  'vaults.id',
  'vaults.name',
  'vaults.slug',
  'vaults.description',
  'vaults.root_node_id',
  'vaults.status',
  'vaults.archived_at',
  'vaults.markdown_flavor',
  'vaults.soft_breaks',
  'vaults.attachment_folder',
  'vaults.load_external_images',
  'vaults.mcp_enabled',
  'vaults.ai_guidance',
  'vaults.trash_retention_days',
  'vaults.auto_checkpoint_interval_min',
  'vaults.tree_version',
  'vaults.version',
  'vaults.created_by',
  'vaults.created_at',
  'vaults.updated_at',
] as const;

/** The role authorization decided with: the explicit membership, or `manager` for a server admin. */
export function effectiveRoleOf(explicit: Role | null, isServerAdmin: boolean): Role {
  const decided = isServerAdmin ? maxRole(explicit, 'manager') : explicit;
  // A caller with neither a membership nor the admin flag never reaches a vault read: `authorize()`
  // answers `not_found` first (04 §5.4), so `viewer` here is the narrowest honest fallback rather
  // than a widening.
  return decided ?? 'viewer';
}

/** The per-vault settings block, one place so `GET` and a later `PATCH` render it identically. */
function settingsOf(row: VaultRow): Vault['settings'] {
  return {
    markdownFlavor: row.markdown_flavor,
    softBreaks: row.soft_breaks,
    attachmentFolder: row.attachment_folder,
    loadExternalImages: row.load_external_images,
    mcpEnabled: row.mcp_enabled,
    aiGuidance: row.ai_guidance,
    trashRetentionDays: row.trash_retention_days,
    autoCheckpointIntervalMin: row.auto_checkpoint_interval_min,
  };
}

/** Thrown when a vault row has no `root_node_id`; invariant I-01, repaired by `iridium doctor`. */
export class VaultRootMissingError extends Error {
  readonly code = 'db.vault_root_missing';

  constructor(vaultId: string) {
    super(
      `vault ${vaultId} has no root_node_id. Every vault gets one in the transaction that creates ` +
        'it (03-data-model.md §5), so this row was written by something other than POST /vaults or ' +
        'the import commit. Run `iridium doctor` — it quarantines a vault that has lost its root ' +
        'row — and check the dump the schema was restored from.',
    );
    this.name = 'VaultRootMissingError';
  }
}

/** One vault in full. */
export function toVaultDto(
  row: VaultRow,
  parts: {
    readonly creator: CreatorRow;
    readonly counts: VaultCountRow;
    readonly role: Role | null;
    readonly isServerAdmin: boolean;
  },
): Vault {
  const id = vaultIdFromBytes(row.id);
  if (row.root_node_id === null) throw new VaultRootMissingError(id);
  return {
    id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
    rootNodeId: nodeIdFromBytes(row.root_node_id),
    treeVersion: row.tree_version,
    settings: settingsOf(row),
    role: parts.role,
    effectiveRole: effectiveRoleOf(parts.role, parts.isServerAdmin),
    counts: parts.counts,
    createdBy: {
      id: userIdFromBytes(parts.creator.id),
      displayName: parts.creator.display_name,
      colorHue: parts.creator.color_hue,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

/** One row of the vault picker. */
export function toVaultSummaryDto(
  row: VaultRow,
  parts: {
    readonly noteCount: number;
    readonly role: Role | null;
    readonly isServerAdmin: boolean;
  },
): VaultSummary {
  return {
    id: vaultIdFromBytes(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    role: parts.role,
    effectiveRole: effectiveRoleOf(parts.role, parts.isServerAdmin),
    treeVersion: row.tree_version,
    updatedAt: row.updated_at.toISOString(),
    noteCount: parts.noteCount,
    markdownFlavor: row.markdown_flavor,
    mcpEnabled: row.mcp_enabled,
  };
}
