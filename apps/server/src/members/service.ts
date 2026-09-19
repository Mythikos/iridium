/**
 * Membership reads and writes (09-api-reference.md §2.6; 03-data-model.md §5).
 *
 * **Why this is not `withVaultLock`.** That helper is the *structural* transaction protocol: it
 * requires `vaults.tree_version` to be bumped and refuses to commit a callback that does not
 * (03-data-model.md §6.4 step 5). A membership change moves no node, and §2.6's effect list names
 * `member-changed` on the vault channel, never `tree-changed` — bumping the tree version would tell
 * every open client its tree is stale because somebody's role changed. So the transaction here takes
 * the same first lock for the same reason (serialise per vault, establish the snapshot after the
 * lock) and then follows §2.6's own list.
 *
 * **The two refusals that are not authorization.** A manager may not change or remove their own
 * membership, and the last manager of a vault may not be downgraded or removed. Both are
 * `422 validation_failed` with a policy code (`self_role_change`, `last_manager`) rather than a
 * `403`: the caller has the permission, and the request is refused for what it would leave behind.
 * A server admin is exempt from the first, because administrative access does not depend on a row.
 *
 * Every write bumps the member's `users.authz_version`, writes its audit row last, and passes the
 * `AuthzEvent` to the admission barrier for publication **after** COMMIT (04-auth-and-access-control.md §8.3, D04-14).
 */
import type { Member, Role, SessionId, UserId, VaultId } from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { AuthzEvent } from '../authz/bus.ts';
import type { AuthzMutationRunner } from '../authz/mutations.ts';
import { assertVersionedUpdate } from '../db/cas.ts';
import type { Database } from '../db/index.ts';
import type { VaultStatus } from '../db/schema.ts';
import { BOUNDED_LIST_ROWS } from '../rest/pagination.ts';
import { ProblemError } from '../security/problem.ts';
import { bumpAuthzVersion } from '../vaults/service.ts';
import { toMemberDto, type MemberRow } from './dto.ts';

/** The statuses a membership write is accepted in; every other one is a read-only vault (§5). */
const MUTABLE_STATUSES: readonly VaultStatus[] = Object.freeze(['active']);

/** The policy code a refused self-modification carries (§2.6). */
export const SELF_ROLE_CHANGE_CODE = 'self_role_change';
/** The policy code a refused last-manager change carries (§2.6). */
export const LAST_MANAGER_CODE = 'last_manager';

/** Who is making the change, for the audit row and the self-modification rule. */
export interface MemberActor {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly displayName: string;
  readonly isServerAdmin: boolean;
}

/** What a membership write takes. */
export interface MemberWriteInput {
  readonly vaultId: VaultId;
  readonly userId: UserId;
  readonly ifMatch: number | undefined;
  readonly actor: MemberActor;
  readonly context: AuditEventContext;
  readonly now: Date;
}

/** What `PUT` answers: the row, whether it was created, and its already-delivered committed event. */
export interface MemberWriteResult {
  readonly member: Member;
  readonly created: boolean;
  readonly event: AuthzEvent | null;
}

/** What `DELETE` answers. */
export interface MemberRemoveResult {
  readonly event: AuthzEvent;
}

const MEMBER_COLUMNS = [
  'vault_members.user_id',
  'vault_members.role',
  'vault_members.version',
  'vault_members.created_at',
  'vault_members.updated_at',
] as const;

function selectMembers(db: Kysely<Database> | Transaction<Database>) {
  return db
    .selectFrom('vault_members')
    .innerJoin('users', 'users.id', 'vault_members.user_id')
    .leftJoin('users as granter', 'granter.id', 'vault_members.granted_by')
    .select(MEMBER_COLUMNS)
    .select((eb) => [
      eb.ref('users.display_name').as('display_name'),
      eb.ref('users.color_hue').as('color_hue'),
      eb.ref('users.email').as('email'),
      eb.ref('users.status').as('status'),
      eb.ref('granter.id').as('granted_by_id'),
      eb.ref('granter.display_name').as('granted_by_name'),
      eb.ref('granter.color_hue').as('granted_by_hue'),
    ]);
}

/** `GET /vaults/:vaultId/members` — ordered by display name, capped like every bounded list. */
export async function listMembers(
  db: Kysely<Database>,
  vaultId: VaultId,
): Promise<readonly Member[]> {
  const rows = await selectMembers(db)
    .where('vault_members.vault_id', '=', idBytes(vaultId))
    .orderBy('users.display_name', 'asc')
    .limit(BOUNDED_LIST_ROWS)
    .execute();
  return rows.map((row: MemberRow) => toMemberDto(row));
}

/** One member row inside a transaction, or `undefined` when the user holds no membership. */
async function readMember(
  trx: Transaction<Database>,
  vaultId: Buffer,
  userId: Buffer,
): Promise<MemberRow | undefined> {
  return selectMembers(trx)
    .where('vault_members.vault_id', '=', vaultId)
    .where('vault_members.user_id', '=', userId)
    .executeTakeFirst();
}

/**
 * The `409 stale_version` of §1.7 for a comparison that is not a statement's result.
 *
 * `db/cas.ts`'s `assertVersionedUpdate` answers the same refusal for an `UPDATE` that matched no
 * row; this is the one case where nothing is written at all — a `PUT` that asks for the role the row
 * already holds — and fabricating a zero-row result to reuse that helper would make the code say
 * something happened that did not.
 */
function assertVersionMatches(current: number, expected: number, currentDto: Member): void {
  if (current === expected) return;
  throw new ProblemError('stale_version', {
    detail:
      'The row changed since the version you sent; re-read it and retry with the new version.',
    current: currentDto,
  });
}

/** The refusal a policy rule produces. */
function policyRefusal(code: string, detail: string): ProblemError {
  return new ProblemError('validation_failed', {
    detail,
    errors: [{ path: 'params.userId', message: code, code }],
  });
}

/**
 * Locks the vault row and refuses a vault that is not mutable.
 *
 * It is the same first statement `withVaultLock` makes, for the same reason: the lock is taken before
 * the transaction's first consistent read, so the snapshot is established after it. The route policy
 * has already answered `409 vault_archived` for an archived vault; this closes the window between
 * that decision and this transaction.
 */
async function lockVault(trx: Transaction<Database>, vaultId: Buffer): Promise<void> {
  const locked = await trx
    .selectFrom('vaults')
    .select('status')
    .where('id', '=', vaultId)
    .where('status', 'in', [...MUTABLE_STATUSES])
    .forUpdate()
    .executeTakeFirst();
  if (locked !== undefined) return;

  const existing = await trx
    .selectFrom('vaults')
    .select('status')
    .where('id', '=', vaultId)
    .executeTakeFirst();
  if (existing === undefined) throw new ProblemError('not_found', { detail: 'No such vault.' });
  throw new ProblemError('vault_archived', {
    detail: `This vault is ${existing.status} and accepts no membership changes.`,
  });
}

/** Whether the vault would still have a manager after this row stopped being one. */
async function managerRemains(
  trx: Transaction<Database>,
  vaultId: Buffer,
  excluding: Buffer,
): Promise<boolean> {
  const other = await trx
    .selectFrom('vault_members')
    .select('user_id')
    .where('vault_id', '=', vaultId)
    .where('role', '=', 'manager')
    .where('user_id', '!=', excluding)
    .limit(1)
    .executeTakeFirst();
  return other !== undefined;
}

/** Refuses a manager changing their own row; a server admin is exempt (§2.6). */
function assertNotSelf(actor: MemberActor, targetUserId: UserId): void {
  if (actor.isServerAdmin || actor.userId !== targetUserId) return;
  throw policyRefusal(
    SELF_ROLE_CHANGE_CODE,
    'A manager cannot change or remove their own membership; ask another manager or a server administrator.',
  );
}

/** Refuses a change that would leave the vault with no manager (§2.6). */
async function assertManagerRemains(
  trx: Transaction<Database>,
  vaultId: Buffer,
  target: Buffer,
  currentRole: Role,
): Promise<void> {
  if (currentRole !== 'manager') return;
  if (await managerRemains(trx, vaultId, target)) return;
  throw policyRefusal(
    LAST_MANAGER_CODE,
    'This is the vault’s last manager; promote another member first. A server administrator can still administer the vault.',
  );
}

/** The `users` row a membership names, or the `404` an unknown id answers. */
async function requireTargetUser(
  trx: Transaction<Database>,
  userId: Buffer,
): Promise<{ readonly display_name: string }> {
  const row = await trx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (row === undefined) throw new ProblemError('not_found', { detail: 'No such user.' });
  return row;
}

/**
 * `PUT /vaults/:vaultId/members/:userId` — add a membership (`201`) or change its role (`200`).
 *
 * `If-Match` is required only when a row already exists, which is why the route is `conditional` in
 * the manifest: a first add has no version to compare, and demanding one would make adding a member
 * a two-request operation.
 *
 * @throws ProblemError `404 not_found`, `409 stale_version`, `409 vault_archived`,
 * `422 validation_failed` (`self_role_change`, `last_manager`), `428 precondition_required`.
 */
export async function putMember(
  deps: { readonly mutations: AuthzMutationRunner; readonly audit: AuditRecorder },
  input: MemberWriteInput,
  role: Role,
): Promise<MemberWriteResult> {
  const vaultBytes = idBytes(input.vaultId);
  const targetBytes = idBytes(input.userId);
  const actorBytes = idBytes(input.actor.userId);

  return deps.mutations.run(
    { userId: input.userId, isolation: 'repeatable read' },
    async (trx) => {
      await lockVault(trx, vaultBytes);
      const target = await requireTargetUser(trx, targetBytes);
      const existing = await readMember(trx, vaultBytes, targetBytes);

      if (existing === undefined) {
        await trx
          .insertInto('vault_members')
          .values({
            vault_id: vaultBytes,
            user_id: targetBytes,
            role,
            granted_by: actorBytes,
            created_at: input.now,
            updated_at: input.now,
          })
          .execute();
        const bumped = await bumpAuthzVersion(trx, targetBytes, input.now);
        const written = await readMember(trx, vaultBytes, targetBytes);
        if (written === undefined) {
          throw new Error(`the membership just inserted for ${input.userId} cannot be read back`);
        }
        await deps.audit.record(trx, {
          action: 'vault.member.added',
          actorType: 'user',
          actorId: input.actor.userId,
          actorDisplay: input.actor.displayName,
          credentialType: 'session',
          credentialId: input.actor.sessionId,
          vaultId: input.vaultId,
          targetType: 'user',
          targetId: input.userId,
          outcome: 'success',
          context: input.context,
          metadata: { role, targetDisplay: target.display_name },
        });
        return {
          member: toMemberDto(written),
          created: true,
          event: {
            type: 'membership.role_changed',
            userId: input.userId,
            vaultId: input.vaultId,
            role,
            userAuthzVersion: bumped,
            memberVersion: written.version,
          },
        };
      }

      if (input.ifMatch === undefined) {
        throw new ProblemError('precondition_required', {
          detail:
            'This membership already exists, so the change requires an If-Match header carrying the version you read.',
          current: toMemberDto(existing),
        });
      }
      if (existing.role === role) {
        // Idempotent: the row already says what the request asks for, so nothing is written, no
        // version moves and no audit row claims a change that did not happen. The validator is still
        // compared — a stale `If-Match` means the caller is reasoning about a row that has since
        // changed, whether or not this particular request would have changed it.
        assertVersionMatches(existing.version, input.ifMatch, toMemberDto(existing));
        return { member: toMemberDto(existing), created: false, event: null };
      }

      assertNotSelf(input.actor, input.userId);
      await assertManagerRemains(trx, vaultBytes, targetBytes, existing.role);

      const updated = await trx
        .updateTable('vault_members')
        .set({ role, version: sql<number>`version + 1`, updated_at: input.now })
        .where('vault_id', '=', vaultBytes)
        .where('user_id', '=', targetBytes)
        .where('version', '=', input.ifMatch)
        .executeTakeFirst();
      assertVersionedUpdate(
        updated,
        { table: 'vault_members', id: input.userId, expected: input.ifMatch },
        { current: toMemberDto(existing) },
      );

      const bumped = await bumpAuthzVersion(trx, targetBytes, input.now);
      const written = await readMember(trx, vaultBytes, targetBytes);
      if (written === undefined) {
        throw new Error(`the membership just updated for ${input.userId} cannot be read back`);
      }
      await deps.audit.record(trx, {
        action: 'vault.member.role_changed',
        actorType: 'user',
        actorId: input.actor.userId,
        actorDisplay: input.actor.displayName,
        credentialType: 'session',
        credentialId: input.actor.sessionId,
        vaultId: input.vaultId,
        targetType: 'user',
        targetId: input.userId,
        outcome: 'success',
        context: input.context,
        metadata: { before: { role: existing.role }, after: { role } },
      });
      return {
        member: toMemberDto(written),
        created: false,
        event: {
          type: 'membership.role_changed',
          userId: input.userId,
          vaultId: input.vaultId,
          role,
          userAuthzVersion: bumped,
          memberVersion: written.version,
        },
      };
    },
    (result) => (result.event === null ? [] : [result.event]),
  );
}

/**
 * `DELETE /vaults/:vaultId/members/:userId` — remove a membership.
 *
 * @throws ProblemError `404 not_found`, `409 stale_version`, `409 vault_archived`,
 * `422 validation_failed` (`self_role_change`, `last_manager`), `428 precondition_required`.
 */
export async function removeMember(
  deps: { readonly mutations: AuthzMutationRunner; readonly audit: AuditRecorder },
  input: MemberWriteInput,
): Promise<MemberRemoveResult> {
  const vaultBytes = idBytes(input.vaultId);
  const targetBytes = idBytes(input.userId);

  return deps.mutations.run(
    { userId: input.userId, isolation: 'repeatable read' },
    async (trx) => {
      await lockVault(trx, vaultBytes);
      const existing = await readMember(trx, vaultBytes, targetBytes);
      if (existing === undefined) throw new ProblemError('not_found');
      if (input.ifMatch === undefined) {
        throw new ProblemError('precondition_required', {
          detail:
            'Removing a membership requires an If-Match header carrying the version you read.',
          current: toMemberDto(existing),
        });
      }

      assertNotSelf(input.actor, input.userId);
      await assertManagerRemains(trx, vaultBytes, targetBytes, existing.role);

      const deleted = await trx
        .deleteFrom('vault_members')
        .where('vault_id', '=', vaultBytes)
        .where('user_id', '=', targetBytes)
        .where('version', '=', input.ifMatch)
        .executeTakeFirst();
      // A versioned `DELETE` is the same compare-and-set shape as a versioned `UPDATE`: `0` matched
      // rows is a conflict, and the helper owns the answer (03-data-model.md §7.2).
      assertVersionedUpdate(
        { numUpdatedRows: deleted.numDeletedRows },
        { table: 'vault_members', id: input.userId, expected: input.ifMatch },
        { current: toMemberDto(existing) },
      );

      const bumped = await bumpAuthzVersion(trx, targetBytes, input.now);
      await deps.audit.record(trx, {
        action: 'vault.member.removed',
        actorType: 'user',
        actorId: input.actor.userId,
        actorDisplay: input.actor.displayName,
        credentialType: 'session',
        credentialId: input.actor.sessionId,
        vaultId: input.vaultId,
        targetType: 'user',
        targetId: input.userId,
        outcome: 'success',
        context: input.context,
        metadata: { before: { role: existing.role } },
      });
      return {
        event: {
          type: 'membership.removed',
          userId: input.userId,
          vaultId: input.vaultId,
          userAuthzVersion: bumped,
        },
      };
    },
    (result) => (result.event === null ? [] : [result.event]),
  );
}
