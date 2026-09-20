/**
 * The vault reads and the one vault write M1 has (09-api-reference.md §2.5; 03-data-model.md §5).
 *
 * **Creation is one transaction, and the order inside it is the data model's.** `vaults` is inserted
 * with `root_node_id` null because the root row it will point at does not exist yet; the root `nodes`
 * row is then inserted with `parent_id = id` (§6.2, valid under InnoDB's immediate foreign-key check
 * because the row satisfies its own reference); `vaults.root_node_id` is set; the requested
 * memberships follow, each bumping that member's `users.authz_version`; and every audit row is
 * written last, because `AuditWriter.record` locks `audit_chain_heads` and that lock is always the
 * last one taken (A46).
 *
 * **The creator gets no membership row when they are a server admin**, which on this route they
 * always are: an administrator is an implied manager everywhere for user principals (§5), and a row
 * written here would make "an admin without a membership" a state no fixture reaches and no test
 * exercises. 12-milestones.md §5.2 says "the creator as manager"; §5 of the data model is the
 * narrower statement and the one `authorize()` and the seeded kernel already assume.
 *
 * **`withVaultLock` is not used and cannot be**: it opens by locking a vault row that does not exist
 * until the second statement of this transaction. The protocol it enforces is for changes *to* a
 * tree; creating the tree is the one write that precedes it.
 */
import {
  LIMITS,
  newId,
  VaultId,
  type Role,
  type SessionId,
  type UserId,
  type Vault,
  type VaultSettingsPatch,
  type VaultSummary,
} from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { AuthzEvent } from '../authz/bus.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Database } from '../db/index.ts';
import type { ExternalImagePolicy, MarkdownFlavor } from '../db/schema.ts';
import { BOUNDED_LIST_ROWS } from '../rest/pagination.ts';
import { ProblemError } from '../security/problem.ts';
import { storedVaultName } from '../tree/names.ts';
import {
  toVaultDto,
  toVaultSummaryDto,
  VAULT_COLUMNS,
  type CreatorRow,
  type VaultCountRow,
} from './dto.ts';
import { slugCollisionPattern, uniqueSlug } from './slug.ts';

/** The statuses a listing may show. `importing` and `deleting` are invisible to everyone (§2.5). */
const LISTABLE_STATUSES = ['active', 'archived'] as const;

/** The name of the root category row of every vault (§6.2). */
const ROOT_NODE_NAME = '';

/** The `version` a `vault_members` row is inserted with (`DEFAULT 1`), carried by the event. */
const FIRST_MEMBER_VERSION = 1;

/** The settings columns a `POST /vaults` body may set; every absent member keeps its column default. */
interface SettingsColumns {
  markdown_flavor?: MarkdownFlavor;
  soft_breaks?: boolean;
  attachment_folder?: string;
  load_external_images?: ExternalImagePolicy;
  mcp_enabled?: boolean;
  ai_guidance?: string | null;
  trash_retention_days?: number;
  auto_checkpoint_interval_min?: number;
}

/** What a vault creation takes. */
export interface CreateVaultInput {
  readonly name: string;
  readonly description?: string | undefined;
  readonly settings?: VaultSettingsPatch | undefined;
  readonly members?: readonly { readonly userId: UserId; readonly role: Role }[] | undefined;
  /** The administrator making the request. */
  readonly actor: {
    readonly userId: UserId;
    readonly sessionId: SessionId;
    readonly displayName: string;
  };
  readonly context: AuditEventContext;
  readonly now: Date;
}

/** What a vault creation answers: the `201` body, and the events to publish after COMMIT. */
export interface CreatedVault {
  readonly vault: Vault;
  readonly events: readonly AuthzEvent[];
}

/**
 * The body's settings patch as column values.
 *
 * Written out member by member rather than folded through a name map: the column names are the data
 * model's and the member names are the wire's, and a loop over a mapping object would type every
 * value as `unknown` and hand Kysely a row it cannot check.
 */
function settingsColumns(patch: VaultSettingsPatch | undefined): SettingsColumns {
  if (patch === undefined) return {};
  return {
    ...(patch.markdownFlavor === undefined ? {} : { markdown_flavor: patch.markdownFlavor }),
    ...(patch.softBreaks === undefined ? {} : { soft_breaks: patch.softBreaks }),
    ...(patch.attachmentFolder === undefined ? {} : { attachment_folder: patch.attachmentFolder }),
    ...(patch.loadExternalImages === undefined
      ? {}
      : { load_external_images: patch.loadExternalImages }),
    ...(patch.mcpEnabled === undefined ? {} : { mcp_enabled: patch.mcpEnabled }),
    ...(patch.aiGuidance === undefined ? {} : { ai_guidance: patch.aiGuidance }),
    ...(patch.trashRetentionDays === undefined
      ? {}
      : { trash_retention_days: patch.trashRetentionDays }),
    ...(patch.autoCheckpointIntervalMin === undefined
      ? {}
      : { auto_checkpoint_interval_min: patch.autoCheckpointIntervalMin }),
  };
}

/** The slugs already taken that a new name could collide with. */
async function takenSlugs(trx: Transaction<Database>, name: string): Promise<ReadonlySet<string>> {
  const rows = await trx
    .selectFrom('vaults')
    .select('slug')
    .where('slug', 'like', slugCollisionPattern(name))
    .execute();
  return new Set(rows.map((row) => row.slug));
}

/** What the counting statement returns before the driver's numeric shapes are normalised. */
interface RawCounts {
  readonly notes: string | number | bigint;
  readonly categories: string | number | bigint;
  readonly members: string | number | bigint;
  readonly attachments: string | number | bigint;
}

/** The four live counts of `Vault.counts`, in one round trip (§2.5: computed per request). */
async function countsOf(db: Kysely<Database>, vaultId: Buffer): Promise<VaultCountRow> {
  const result = await sql<RawCounts>`
    SELECT
      (SELECT COUNT(*) FROM nodes WHERE vault_id = ${vaultId} AND kind = 'note' AND deleted_at IS NULL) AS notes,
      (SELECT COUNT(*) FROM nodes WHERE vault_id = ${vaultId} AND kind = 'category' AND deleted_at IS NULL AND id <> parent_id) AS categories,
      (SELECT COUNT(*) FROM vault_members WHERE vault_id = ${vaultId}) AS members,
      (SELECT COUNT(*) FROM attachments WHERE vault_id = ${vaultId}) AS attachments
  `.execute(db);
  const counts = result.rows[0];
  return counts === undefined
    ? { notes: 0, categories: 0, members: 0, attachments: 0 }
    : {
        notes: Number(counts.notes),
        categories: Number(counts.categories),
        members: Number(counts.members),
        attachments: Number(counts.attachments),
      };
}

/**
 * The creator's `UserRef` row.
 *
 * `vaults.created_by` is a foreign key into `users`, so an absent row is a restore from a partial
 * dump rather than an ordinary state. The vault still renders — the creator is the one field a
 * missing row can make unknown — and `iridium doctor` is what reports the dangling reference.
 */
async function creatorOf(db: Kysely<Database>, userId: Buffer): Promise<CreatorRow> {
  const row = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'color_hue'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row ?? { id: userId, display_name: 'unknown', color_hue: 0 };
}

/** One vault in full, or `null` when no such row exists. */
export async function readVault(
  db: Kysely<Database>,
  vaultId: VaultId,
  viewer: { readonly role: Role | null; readonly isServerAdmin: boolean },
): Promise<Vault | null> {
  const id = idBytes(vaultId);
  const row = await db
    .selectFrom('vaults')
    .select(VAULT_COLUMNS)
    .where('vaults.id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return null;

  const [counts, creator] = await Promise.all([countsOf(db, id), creatorOf(db, row.created_by)]);
  return toVaultDto(row, {
    counts,
    creator,
    role: viewer.role,
    isServerAdmin: viewer.isServerAdmin,
  });
}

/**
 * `GET /vaults` (§2.5): the accessible set, with the caller's membership and each vault's live note
 * count read in the same statement.
 *
 * The accessible set arrives as ids from `accessibleVaultIds()` rather than being recomputed here:
 * §5.7 and D04-11 make that helper the one place a principal's readable vaults are decided, and a
 * second predicate written here is how the two would come to disagree.
 */
export async function listVaults(
  db: Kysely<Database>,
  options: {
    readonly vaultIds: readonly VaultId[];
    readonly userId: UserId;
    readonly isServerAdmin: boolean;
    readonly includeArchived: boolean;
  },
): Promise<readonly VaultSummary[]> {
  if (options.vaultIds.length === 0) return [];
  const statuses = options.includeArchived ? LISTABLE_STATUSES : (['active'] as const);

  const rows = await db
    .selectFrom('vaults')
    .leftJoin('vault_members as vm', (join) =>
      join.onRef('vm.vault_id', '=', 'vaults.id').on('vm.user_id', '=', idBytes(options.userId)),
    )
    .select(VAULT_COLUMNS)
    .select((eb) => [
      eb.ref('vm.role').as('caller_role'),
      eb
        .selectFrom('nodes')
        .whereRef('nodes.vault_id', '=', 'vaults.id')
        .where('nodes.kind', '=', 'note')
        .where('nodes.deleted_at', 'is', null)
        .select((inner) => inner.fn.countAll().as('count'))
        .as('note_count'),
    ])
    .where(
      'vaults.id',
      'in',
      options.vaultIds.map((vaultId) => idBytes(vaultId)),
    )
    .where('vaults.status', 'in', [...statuses])
    .orderBy('vaults.name', 'asc')
    .limit(BOUNDED_LIST_ROWS)
    .execute();

  return rows.map((row) =>
    toVaultSummaryDto(row, {
      noteCount: Number(row.note_count ?? 0),
      role: row.caller_role ?? null,
      isServerAdmin: options.isServerAdmin,
    }),
  );
}

/**
 * Creates a vault, its root category row and any initial memberships in one transaction (§2.5, §5).
 *
 * @throws ProblemError `409 name_conflict` through `db/failure.ts` when `uq_vaults_name` refuses the
 * name, `422 validation_failed` when the name breaks a node-name rule of §6.5, and
 * `404 not_found` when an initial membership names a user that does not exist.
 */
export async function createVault(
  deps: {
    readonly db: Kysely<Database>;
    readonly audit: AuditRecorder;
    readonly ownerFence: OwnerFence;
  },
  input: CreateVaultInput,
): Promise<CreatedVault> {
  const name = storedVaultName(input.name);
  const vaultId = VaultId.parse(newId());
  const rootNodeId = newId();
  const vaultBytes = idBytes(vaultId);
  const rootBytes = idBytes(rootNodeId);
  const actorBytes = idBytes(input.actor.userId);
  const grants = [...(input.members ?? [])].toSorted((left, right) =>
    left.userId.localeCompare(right.userId),
  );
  const events: AuthzEvent[] = [];
  const actor = {
    actorType: 'user',
    actorId: input.actor.userId,
    actorDisplay: input.actor.displayName,
    credentialType: 'session',
    credentialId: input.actor.sessionId,
    outcome: 'success',
    context: input.context,
  } as const;

  await deps.db.transaction().execute(async (trx) => {
    await deps.ownerFence.assertCurrent(trx);
    const slug = uniqueSlug(name, await takenSlugs(trx, name));

    await trx
      .insertInto('vaults')
      .values({
        id: vaultBytes,
        name,
        slug,
        description: input.description ?? null,
        root_node_id: null,
        ai_guidance: null,
        created_by: actorBytes,
        created_at: input.now,
        updated_at: input.now,
        auto_checkpoint_interval_min: LIMITS.CHECKPOINT_MIN_INTERVAL_MIN,
        ...settingsColumns(input.settings),
      })
      .execute();

    await trx
      .insertInto('nodes')
      .values({
        id: rootBytes,
        vault_id: vaultBytes,
        parent_id: rootBytes,
        kind: 'category',
        name: ROOT_NODE_NAME,
        deleted_at: null,
        created_by: actorBytes,
        updated_by: actorBytes,
        created_at: input.now,
        updated_at: input.now,
      })
      .execute();

    await trx
      .updateTable('vaults')
      .set({ root_node_id: rootBytes })
      .where('id', '=', vaultBytes)
      .execute();

    const bumped: number[] = [];
    for (const grant of grants) {
      // Sequential by design: each grant writes a membership row and then bumps that member's
      // `users.authz_version`, and the event carries the number the bump left behind.
      // eslint-disable-next-line no-await-in-loop -- one member's two rows are one ordered unit
      bumped.push(await grantMembershipRow(trx, vaultBytes, grant, actorBytes, input.now));
    }

    // Every audit row is written after every data row: `record` locks `audit_chain_heads`, which is
    // always the last lock taken (A46).
    await deps.audit.record(trx, {
      ...actor,
      action: 'vault.created',
      vaultId,
      targetType: 'vault',
      targetId: vaultId,
      metadata: { name, slug, memberCount: grants.length },
    });
    for (const [index, grant] of grants.entries()) {
      // eslint-disable-next-line no-await-in-loop -- the chain is a sequence; rows enter it in order
      await deps.audit.record(trx, {
        ...actor,
        action: 'vault.member.added',
        vaultId,
        targetType: 'user',
        targetId: grant.userId,
        metadata: { role: grant.role },
      });
      events.push({
        type: 'membership.role_changed',
        userId: grant.userId,
        vaultId,
        role: grant.role,
        userAuthzVersion: bumped[index] ?? 0,
        memberVersion: FIRST_MEMBER_VERSION,
      });
    }
  });

  const created = await readVault(deps.db, vaultId, { role: null, isServerAdmin: true });
  if (created === null) throw new Error(`vault ${vaultId} vanished between COMMIT and its read`);
  return { vault: created, events };
}

/** One membership row plus the member's `users.authz_version` bump; answers the bumped value. */
async function grantMembershipRow(
  trx: Transaction<Database>,
  vaultId: Buffer,
  grant: { readonly userId: UserId; readonly role: Role },
  actor: Buffer,
  now: Date,
): Promise<number> {
  const memberBytes = idBytes(grant.userId);
  const member = await trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', memberBytes)
    .forUpdate()
    .executeTakeFirst();
  if (member === undefined) throw new ProblemError('not_found', { detail: 'No such user.' });
  await trx
    .insertInto('vault_members')
    .values({
      vault_id: vaultId,
      user_id: memberBytes,
      role: grant.role,
      granted_by: actor,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return bumpAuthzVersion(trx, memberBytes, now);
}

/**
 * `users.authz_version = authz_version + 1` for one user, answering the new value.
 *
 * Every membership insert, update and delete bumps it (§2.6), and the post-COMMIT `AuthzBus` event
 * carries the bumped number — read back rather than computed, so a concurrent bump cannot make the
 * event name a version the row never held.
 */
export async function bumpAuthzVersion(
  trx: Transaction<Database>,
  userId: Buffer,
  now: Date,
): Promise<number> {
  await trx
    .updateTable('users')
    .set({ authz_version: sql<number>`authz_version + 1`, updated_at: now })
    .where('id', '=', userId)
    .execute();
  const row = await trx
    .selectFrom('users')
    .select('authz_version')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.authz_version ?? 0;
}
