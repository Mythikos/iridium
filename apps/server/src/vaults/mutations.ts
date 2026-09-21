/** Vault metadata writes serialize with structural operations but do not bump tree_version. */
import {
  type PatchVaultBody,
  type Role,
  type SessionId,
  type UserId,
  type Vault,
  type VaultId,
} from '@iridium/contracts';
import { sql, type Kysely } from 'kysely';

import type { AuditEventContext, AuditRecorder } from '../auth/audit.ts';
import { idBytes } from '../auth/ids.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { assertVersionedUpdate } from '../db/cas.ts';
import type { Database } from '../db/schema.ts';
import { withVaultLock } from '../db/withVaultLock.ts';
import type { Clock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';
import { storedVaultName } from '../tree/names.ts';
import { readVault, settingsColumns } from './service.ts';
import { assertVaultSettingsFloor, type VaultSettingsFloor } from './settings.ts';

/** Metadata mutations need the same lease, clock and audit writer as structural mutations. */
export interface VaultMutationDeps {
  readonly db: Kysely<Database>;
  readonly ownerFence: OwnerFence;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
  readonly floors: VaultSettingsFloor;
}

/** Authenticated actor and current metadata version. */
export interface VaultMutationInput {
  readonly vaultId: VaultId;
  readonly version: number;
  readonly actor: {
    readonly userId: UserId;
    readonly sessionId: SessionId;
    readonly displayName: string;
  };
  readonly viewer: { readonly role: Role | null; readonly isServerAdmin: boolean };
  readonly context: AuditEventContext;
}

/** Apply a validated patch and audit only fields whose values actually changed. */
export async function patchVault(
  deps: VaultMutationDeps,
  input: VaultMutationInput,
  patch: PatchVaultBody,
): Promise<{ readonly vault: Vault; readonly changed: readonly string[] }> {
  assertVaultSettingsFloor(patch, deps.floors);
  const name = patch.name === undefined ? undefined : storedVaultName(patch.name);
  return withVaultLock(
    {
      db: deps.db,
      clock: deps.clock,
      ownerFence: deps.ownerFence,
      vaultId: input.vaultId,
      mode: 'metadata',
    },
    async (ctx) => {
      const current = await readVault(ctx.trx, input.vaultId, input.viewer);
      if (current === null) throw new ProblemError('not_found');
      if (current.version !== input.version) throw new ProblemError('stale_version', { current });
      const oldValues: Readonly<Record<string, unknown>> = {
        name: current.name,
        description: current.description,
        ...current.settings,
      };
      const requested: Readonly<Record<string, unknown>> = {
        ...patch,
        ...(name === undefined ? {} : { name }),
      };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const key of Object.keys(requested)) {
        if (requested[key] === oldValues[key]) continue;
        before[key] = oldValues[key];
        after[key] = requested[key];
      }
      const changed = Object.keys(after);
      if (changed.length === 0) return { vault: current, changed };
      const updated = await ctx.trx
        .updateTable('vaults')
        .set({
          ...settingsColumns(patch),
          ...(name === undefined ? {} : { name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          version: sql<number>`version + 1`,
          updated_at: deps.clock.date(),
        })
        .where('id', '=', idBytes(input.vaultId))
        .where('version', '=', input.version)
        .executeTakeFirstOrThrow();
      assertVersionedUpdate(updated, {
        table: 'vaults',
        id: input.vaultId,
        expected: input.version,
      });
      const vault = await readVault(ctx.trx, input.vaultId, input.viewer);
      if (vault === null) throw new ProblemError('not_found');
      await deps.audit.record(ctx.trx, {
        action: 'vault.settings.changed',
        actorType: 'user',
        actorId: input.actor.userId,
        actorDisplay: input.actor.displayName,
        credentialType: 'session',
        credentialId: input.actor.sessionId,
        vaultId: input.vaultId,
        targetType: 'vault',
        targetId: input.vaultId,
        outcome: 'success',
        context: input.context,
        metadata: { before, after },
      });
      return { vault, changed };
    },
  );
}

/** Archive and unarchive share CAS and the audit-last transaction; session closure is post-COMMIT. */
export async function archiveVault(
  deps: VaultMutationDeps,
  input: VaultMutationInput,
  archived: boolean,
): Promise<Vault> {
  return withVaultLock(
    {
      db: deps.db,
      clock: deps.clock,
      ownerFence: deps.ownerFence,
      vaultId: input.vaultId,
      mode: 'metadata',
      statuses: ['active', 'archived'],
    },
    async (ctx) => {
      const current = await readVault(ctx.trx, input.vaultId, input.viewer);
      if (current === null) throw new ProblemError('not_found');
      if (current.version !== input.version) throw new ProblemError('stale_version', { current });
      if ((current.status === 'archived') === archived)
        throw new ProblemError('invalid_state', {
          detail: archived ? 'The vault is already archived.' : 'The vault is already active.',
        });
      const updated = await ctx.trx
        .updateTable('vaults')
        .set({
          status: archived ? 'archived' : 'active',
          archived_at: archived ? deps.clock.date() : null,
          version: sql<number>`version + 1`,
          updated_at: deps.clock.date(),
        })
        .where('id', '=', idBytes(input.vaultId))
        .where('version', '=', input.version)
        .executeTakeFirstOrThrow();
      assertVersionedUpdate(updated, {
        table: 'vaults',
        id: input.vaultId,
        expected: input.version,
      });
      const vault = await readVault(ctx.trx, input.vaultId, input.viewer);
      if (vault === null) throw new ProblemError('not_found');
      await deps.audit.record(ctx.trx, {
        action: archived ? 'vault.archived' : 'vault.restored',
        actorType: 'user',
        actorId: input.actor.userId,
        actorDisplay: input.actor.displayName,
        credentialType: 'session',
        credentialId: input.actor.sessionId,
        vaultId: input.vaultId,
        targetType: 'vault',
        targetId: input.vaultId,
        outcome: 'success',
        context: input.context,
      });
      return vault;
    },
  );
}
