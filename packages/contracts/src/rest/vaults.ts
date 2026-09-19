/**
 * `/vaults` (09-api-reference.md section 2.5), M1's three routes: the listing every principal kind
 * sees differently, the administrator-only create, and the full read.
 *
 * `PATCH /vaults/:vaultId`, `archive` and `unarchive` are M2 (12-milestones.md section 6.2), so their
 * bodies are not declared here: a DTO with no route is dead code, and `M1_ROUTES` is what says which
 * routes exist.
 */

import { z } from 'zod';

import { Role } from '../authz.ts';
import { UserId } from '../ids.ts';
import { QueryBoolean, VaultName, VaultSettingsPatch, VaultSummary } from './common.ts';

/** `GET /vaults` — archived vaults are included by default; `importing` and `deleting` never are. */
export interface ListVaultsQuery {
  readonly includeArchived: boolean;
}

/** `GET /vaults` — the query. */
export const ListVaultsQuery: z.ZodType<ListVaultsQuery> = z
  .strictObject({ includeArchived: QueryBoolean.default(true) })
  .meta({ id: 'ListVaultsQuery' });

/** `GET /vaults` — ordered by name under `utf8mb4_0900_as_ci`, capped at 1 000 rows, no cursor. */
export interface VaultSummaryList {
  readonly items: readonly VaultSummary[];
}

/** `GET /vaults`. */
export const VaultSummaryList: z.ZodType<VaultSummaryList> = z
  .strictObject({ items: z.array(VaultSummary).max(1000) })
  .meta({ id: 'VaultSummaryList' });

/** One membership granted in the same transaction that creates the vault. */
export interface VaultMemberGrant {
  readonly userId: string;
  readonly role: Role;
}

/** One membership granted with the vault. */
export const VaultMemberGrant: z.ZodType<VaultMemberGrant> = z
  .strictObject({ userId: UserId, role: Role })
  .meta({ id: 'VaultMemberGrant' });

/**
 * `POST /vaults` — one transaction creates the vault, its root `nodes` row (`parent_id = id`) and
 * every listed membership, each of which bumps that member's `users.authz_version`.
 */
export interface CreateVaultBody {
  readonly name: string;
  readonly description?: string | undefined;
  /** Every setting is optional; an absent one takes the documented default. */
  readonly settings?: VaultSettingsPatch | undefined;
  readonly members?: readonly VaultMemberGrant[] | undefined;
}

/** `POST /vaults`. */
export const CreateVaultBody: z.ZodType<CreateVaultBody> = z
  .strictObject({
    name: VaultName,
    description: z.string().max(500).optional(),
    settings: VaultSettingsPatch.optional(),
    members: z.array(VaultMemberGrant).max(500).optional(),
  })
  .meta({ id: 'CreateVaultBody' });
