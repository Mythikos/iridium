/**
 * The administrative user writes of M1 (09-api-reference.md §2.15.1; 04-auth-and-access-control.md
 * §2, A28).
 *
 * **A user is created without credentials.** The row is inserted, a one-time `irid_spl_…` link is
 * issued in the same transaction, and the administrator delivers it out of band — so no plaintext
 * password ever passes through an administrator, and `hasCredentials` stays `false` until the link
 * is consumed. The link is returned once and is never stored in plaintext.
 *
 * **Disable is the supported removal.** There is no `DELETE /admin/users/:userId` in the MVP:
 * `note_updates.actor_id` and `audit_events.actor_id` must stay resolvable, so the row survives and
 * `status` carries the decision. Disabling bumps `users.authz_version`, revokes every session, and
 * the route publishes `user.disabled` after COMMIT — which is what closes the user's live
 * collaboration connections within a second.
 *
 * **The last server admin cannot be disabled.** A deployment with no administrator has no way back
 * except the CLI, so the refusal is `422 validation_failed` with `errors[0].code = 'last_admin'`
 * rather than a lockout an operator discovers afterwards.
 */
import { newId, UserId, type Role, type SessionId, type VaultId } from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import type { LoginThrottle } from '../auth/credentials/throttle.ts';
import { idBytes } from '../auth/ids.ts';
import type { SessionRepository } from '../auth/sessions/repository.ts';
import type { SetPasswordLinks } from '../auth/setpw/service.ts';
import { toUserDto, type UserDto } from '../auth/users.ts';
import type { AuthzEvent } from '../authz/bus.ts';
import type { AuthzMutationRunner } from '../authz/mutations.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import type { Database } from '../db/index.ts';
import { ProblemError } from '../security/problem.ts';
import { bumpAuthzVersion } from '../vaults/service.ts';
import { colorHueForOrdinal } from './color.ts';

/** The policy code a refused last-admin change carries (§2.15.1). */
export const LAST_ADMIN_CODE = 'last_admin';

/** The `version` a `vault_members` row is inserted with, carried by the membership event. */
const FIRST_MEMBER_VERSION = 1;

/**
 * Who is making the change.
 *
 * Two shapes, because there are two callers and their audit rows differ: `POST /admin/users` is a
 * signed-in administrator (`actor_type='user'`, `credential_type='session'`), and `iridium admin
 * create-user` is an operator holding the environment (`actor_type='system'`,
 * `credential_type='cli'`, OPS-19), optionally attributed to a named administrator through
 * `--actor`. 04-auth-and-access-control.md §3.2 is verbatim that the two run the same
 * `users/service.ts#createUser`, so the difference is a parameter and not a second code path.
 */
export type AdminActor =
  | {
      readonly kind: 'session';
      readonly userId: UserId;
      readonly sessionId: SessionId;
      readonly displayName: string;
    }
  | {
      readonly kind: 'cli';
      /** The `--actor <email>` administrator, when one was resolved. Attribution, never authority. */
      readonly onBehalfOf?: { readonly userId: UserId; readonly displayName: string } | undefined;
    };

/** The actor columns of an audit row (03-data-model.md §12.1), for either caller. */
export function auditActorOf(actor: AdminActor): {
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly actorDisplay: string | null;
  readonly credentialType: 'session' | 'cli';
  readonly credentialId: string | null;
} {
  if (actor.kind === 'session') {
    return {
      actorType: 'user',
      actorId: actor.userId,
      actorDisplay: actor.displayName,
      credentialType: 'session',
      credentialId: actor.sessionId,
    };
  }
  const named = actor.onBehalfOf;
  return {
    actorType: named === undefined ? 'system' : 'user',
    actorId: named?.userId ?? null,
    actorDisplay: named?.displayName ?? null,
    credentialType: 'cli',
    credentialId: null,
  };
}

/** The `users.id` an audit row and a `granted_by` column attribute a change to, when there is one. */
function attributedUserId(actor: AdminActor): UserId | null {
  return actor.kind === 'session' ? actor.userId : (actor.onBehalfOf?.userId ?? null);
}

/** What creating a user takes. */
export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly isServerAdmin: boolean;
  readonly memberships?: readonly { readonly vaultId: VaultId; readonly role: Role }[] | undefined;
  readonly actor: AdminActor;
  readonly context: AuditEventContext;
  readonly now: Date;
}

/** What creating a user answers: the `201` body's parts, and the events to publish after COMMIT. */
export interface CreatedUser {
  readonly user: UserDto;
  readonly setPasswordLink: string;
  readonly expiresAt: Date;
  readonly events: readonly AuthzEvent[];
}

/** What disabling or enabling a user answers. */
export interface UserStatusChange {
  readonly user: UserDto;
  readonly events: readonly AuthzEvent[];
}

/** What the writes need from the instance. */
export interface UserServiceDeps {
  /** REST captures this at admission; the separate operator create-user path has no HTTP request. */
  readonly ownerFence?: OwnerFence;
  readonly db: Kysely<Database>;
  readonly audit: AuditRecorder;
  readonly setpw: SetPasswordLinks;
  readonly sessionRepository: (executor: Transaction<Database>) => SessionRepository;
}

function policyRefusal(code: string, detail: string, path: string): ProblemError {
  return new ProblemError('validation_failed', {
    detail,
    errors: [{ path, message: code, code }],
  });
}

/** The user row a route addresses, locked for the duration of the change. */
async function lockUser(
  trx: Transaction<Database>,
  userId: Buffer,
): Promise<{
  readonly status: 'active' | 'disabled' | 'deleted';
  readonly is_server_admin: boolean;
}> {
  const row = await trx
    .selectFrom('users')
    .select(['status', 'is_server_admin'])
    .where('id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new ProblemError('not_found', { detail: 'No such user.' });
  return row;
}

/** The user row after a change, as the `200`/`201` body renders it. */
async function readUserDto(
  executor: Kysely<Database> | Transaction<Database>,
  userId: UserId,
): Promise<UserDto> {
  const row = await executor
    .selectFrom('users')
    .leftJoin('user_credentials', 'user_credentials.user_id', 'users.id')
    .select([
      'users.id',
      'users.email',
      'users.email_key',
      'users.display_name',
      'users.is_server_admin',
      'users.status',
      'users.color_hue',
      'users.authz_version',
      'users.version',
      'users.created_at',
      'users.updated_at',
      'users.last_login_at',
      'user_credentials.password_hash',
      'user_credentials.pepper_version',
    ])
    .where('users.id', '=', idBytes(userId))
    .executeTakeFirst();
  if (row === undefined) throw new ProblemError('not_found', { detail: 'No such user.' });
  return toUserDto(row);
}

/**
 * Serialize user creation ordinals and last-administrator decisions before any user, foreign-key,
 * or audit lock. This metadata row protects predicates without acquiring another user's row.
 */
async function lockAdminUsers(trx: Transaction<Database>): Promise<void> {
  await trx
    .selectFrom('schema_meta')
    .select('value')
    .where('key', '=', 'admin_users_lock')
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/** Read while the admin_users_lock singleton excludes every concurrent disable. */
async function adminRemains(trx: Transaction<Database>, excluding: Buffer): Promise<boolean> {
  const other = await trx
    .selectFrom('users')
    .select('id')
    .where('is_server_admin', '=', true)
    .where('status', '=', 'active')
    .where('id', '!=', excluding)
    .executeTakeFirst();
  return other !== undefined;
}
/** The vault a membership grant names, or the `404` an unknown id answers. */
async function requireVault(trx: Transaction<Database>, vaultId: VaultId): Promise<void> {
  const row = await trx
    .selectFrom('vaults')
    .select('id')
    .where('id', '=', idBytes(vaultId))
    .executeTakeFirst();
  if (row === undefined) {
    throw new ProblemError('not_found', { detail: `No such vault: ${vaultId}.` });
  }
}

/**
 * `POST /admin/users` — the row, its memberships and its one-time link, in one transaction.
 *
 * SetPasswordLinks owns READ COMMITTED for this whole transaction; its user lock protects issuance.
 * The admin-users metadata lock precedes every data write and protects the count used as the color
 * ordinal, so simultaneous creations cannot reuse the same ordinal. Membership grants and their
 * audit chains remain ordered by vault id; all audit locks follow every data lock.
 *
 * @throws ProblemError `409 email_conflict` through `db/failure.ts`, `404 not_found` for a membership
 * naming a vault that does not exist.
 */
export async function createUser(
  deps: UserServiceDeps,
  input: CreateUserInput,
): Promise<CreatedUser> {
  const userId = UserId.parse(newId());
  const userBytes = idBytes(userId);
  const attributedTo = attributedUserId(input.actor);
  const grants = [...(input.memberships ?? [])].toSorted((left, right) =>
    left.vaultId.localeCompare(right.vaultId),
  );
  const events: AuthzEvent[] = [];
  const actor = {
    ...auditActorOf(input.actor),
    outcome: 'success',
    context: input.context,
  } as const;

  const issued = await deps.setpw.withIssuanceTransaction(deps.db, async ({ db: trx, issue }) => {
    await deps.ownerFence?.assertCurrent(trx);
    await lockAdminUsers(trx);
    const ordinal = await trx
      .selectFrom('users')
      .select((eb) => eb.fn.countAll().as('count'))
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('users')
      .values({
        id: userBytes,
        email: input.email,
        display_name: input.displayName,
        is_server_admin: input.isServerAdmin,
        status: 'active',
        color_hue: colorHueForOrdinal(Number(ordinal.count)),
        created_at: input.now,
        updated_at: input.now,
        last_login_at: null,
      })
      .execute();

    const memberVersions: number[] = [];
    for (const grant of grants) {
      // Sequential by design: each grant validates its vault, writes the membership row and bumps
      // that member's `users.authz_version`; the three are one ordered unit per vault.
      // eslint-disable-next-line no-await-in-loop -- one grant is one ordered unit
      await requireVault(trx, grant.vaultId);
      // eslint-disable-next-line no-await-in-loop -- see above
      await trx
        .insertInto('vault_members')
        .values({
          vault_id: idBytes(grant.vaultId),
          user_id: userBytes,
          role: grant.role,
          granted_by: idBytes(attributedTo ?? userId),
          created_at: input.now,
          updated_at: input.now,
        })
        .execute();
      // eslint-disable-next-line no-await-in-loop -- see above
      memberVersions.push(await bumpAuthzVersion(trx, userBytes, input.now));
    }

    // `issued_by` is a `users.id` foreign key, so an operator with no `--actor` attributes the link
    // to the account it creates: the row it would otherwise name does not exist.
    const link = await issue({
      userId,
      purpose: 'initial',
      issuedBy: attributedTo ?? userId,
    });

    // Every audit row after every data row: `record` locks `audit_chain_heads`, always last (A46).
    await deps.audit.record(trx, {
      ...actor,
      action: 'admin.user.created',
      targetType: 'user',
      targetId: userId,
      metadata: {
        displayName: input.displayName,
        isServerAdmin: input.isServerAdmin,
        membershipCount: grants.length,
        setPasswordTokenId: link.tokenRowId,
      },
    });
    for (const [index, grant] of grants.entries()) {
      // eslint-disable-next-line no-await-in-loop -- the chain is a sequence; rows enter it in order
      await deps.audit.record(trx, {
        ...actor,
        action: 'vault.member.added',
        vaultId: grant.vaultId,
        targetType: 'user',
        targetId: userId,
        metadata: { role: grant.role },
      });
      events.push({
        type: 'membership.role_changed',
        userId,
        vaultId: grant.vaultId,
        role: grant.role,
        userAuthzVersion: memberVersions[index] ?? 0,
        memberVersion: FIRST_MEMBER_VERSION,
      });
    }
    return link;
  });

  return {
    user: await readUserDto(deps.db, userId),
    setPasswordLink: issued.link,
    expiresAt: issued.expiresAt,
    events,
  };
}

/**
 * `POST /admin/users/:userId/disable` — block authentication and revoke every session.
 *
 * Idempotent: a user who is already disabled answers `200` with the unchanged row, writes nothing and
 * publishes nothing, because the state the caller asked for is the state that holds.
 *
 * @throws ProblemError `404 not_found`, `422 validation_failed` (`last_admin`).
 */
export async function disableUser(
  deps: UserServiceDeps & { readonly mutations: AuthzMutationRunner },
  input: {
    readonly userId: UserId;
    readonly reason?: string | undefined;
    readonly actor: AdminActor;
    readonly context: AuditEventContext;
    readonly now: Date;
  },
): Promise<UserStatusChange> {
  const userBytes = idBytes(input.userId);

  const events = await deps.mutations.run(
    { userId: input.userId, isolation: 'read committed' },
    async (trx) => {
      await lockAdminUsers(trx);

      const current = await lockUser(trx, userBytes);
      if (current.status === 'disabled') return [];
      if (current.is_server_admin && !(await adminRemains(trx, userBytes))) {
        throw policyRefusal(
          LAST_ADMIN_CODE,
          'This is the last active server administrator; promote another one first.',
          'params.userId',
        );
      }

      await trx
        .updateTable('users')
        .set({
          status: 'disabled',
          authz_version: sql<number>`authz_version + 1`,
          version: sql<number>`version + 1`,
          updated_at: input.now,
        })
        .where('id', '=', userBytes)
        .execute();

      const revoked = await deps
        .sessionRepository(trx)
        .revokeAllForUser(input.userId, input.now, 'user_disabled');

      await deps.audit.record(trx, {
        action: 'admin.user.disabled',
        ...auditActorOf(input.actor),
        targetType: 'user',
        targetId: input.userId,
        outcome: 'success',
        ...(input.reason === undefined ? {} : { reason: 'admin' }),
        context: input.context,
        metadata: {
          sessionsRevoked: revoked.length,
          ...(input.reason === undefined ? {} : { adminReason: input.reason }),
        },
      });

      return [{ type: 'user.disabled', userId: input.userId }] satisfies AuthzEvent[];
    },
    (committed) => committed,
  );

  return { user: await readUserDto(deps.db, input.userId), events };
}

/**
 * `POST /admin/users/:userId/enable` — allow authentication again.
 *
 * `authz_version` is **not** bumped: enabling invalidates nothing, and every credential the user held
 * was revoked when they were disabled. Idempotent for an already-active user.
 *
 * @throws ProblemError `404 not_found`.
 */
export async function enableUser(
  deps: UserServiceDeps,
  input: {
    readonly userId: UserId;
    readonly actor: AdminActor;
    readonly context: AuditEventContext;
    readonly now: Date;
  },
): Promise<UserStatusChange> {
  const userBytes = idBytes(input.userId);

  await deps.db.transaction().execute(async (trx) => {
    await deps.ownerFence?.assertCurrent(trx);
    const current = await lockUser(trx, userBytes);
    if (current.status !== 'disabled') return;

    await trx
      .updateTable('users')
      .set({ status: 'active', version: sql<number>`version + 1`, updated_at: input.now })
      .where('id', '=', userBytes)
      .execute();

    await deps.audit.record(trx, {
      action: 'admin.user.enabled',
      ...auditActorOf(input.actor),
      targetType: 'user',
      targetId: input.userId,
      outcome: 'success',
      context: input.context,
      metadata: {},
    });
  });

  return { user: await readUserDto(deps.db, input.userId), events: [] };
}

/**
 * Removes the old password and every session before issuing the administrator's reset link.
 * The same user lock as link consumption protects the whole READ COMMITTED transaction; the
 * account throttle clears in it too. PAT rows are deliberately outside this account operation.
 */
export async function resetUserPassword(
  deps: UserServiceDeps & {
    readonly throttle: Pick<LoginThrottle, 'clearAccount'>;
    readonly mutations: AuthzMutationRunner;
  },
  input: {
    readonly userId: UserId;
    readonly actor: AdminActor;
    readonly context: AuditEventContext;
    readonly now: Date;
  },
): Promise<{
  readonly setPasswordLink: string;
  readonly expiresAt: Date;
  readonly events: readonly AuthzEvent[];
}> {
  const userBytes = idBytes(input.userId);
  return deps.setpw.withIssuanceMutation(
    deps.mutations,
    input.userId,
    async ({ db: trx, issue }) => {
      // Reset references both target and issuer. Lock them in primary-key order before any write,
      // so two administrators resetting each other cannot deadlock through issued_by foreign keys.
      const issuer = attributedUserId(input.actor) ?? input.userId;
      await trx
        .selectFrom('users')
        .select('id')
        .where('id', 'in', [userBytes, idBytes(issuer)])
        .orderBy('id')
        .forUpdate()
        .execute();
      const user = await trx
        .selectFrom('users')
        .select('email_key')
        .where('id', '=', userBytes)
        .forUpdate()
        .executeTakeFirst();
      if (user === undefined) throw new ProblemError('not_found', { detail: 'No such user.' });
      await trx.deleteFrom('user_credentials').where('user_id', '=', userBytes).execute();
      const revoked = await deps
        .sessionRepository(trx)
        .revokeAllForUser(input.userId, input.now, 'admin');
      await bumpAuthzVersion(trx, userBytes, input.now);
      const link = await issue({
        userId: input.userId,
        purpose: 'reset',
        issuedBy: issuer,
      });
      await deps.throttle.clearAccount(user.email_key, trx);
      // Audit-chain locking is last, after every account, session, link, and throttle write.
      await deps.audit.record(trx, {
        action: 'admin.user.password_reset',
        ...auditActorOf(input.actor),
        targetType: 'user',
        targetId: input.userId,
        outcome: 'success',
        context: input.context,
        metadata: { sessionsRevoked: revoked.length, setPasswordTokenId: link.tokenRowId },
      });
      return {
        setPasswordLink: link.link,
        expiresAt: link.expiresAt,
        events: revoked.map((sessionId): AuthzEvent => ({
          type: 'session.revoked',
          userId: input.userId,
          sessionId,
          reason: 'admin',
        })),
      };
    },
    (result) => result.events,
  );
}
