import { newId, NodeId, noteDocName, SessionId } from '@iridium/contracts';
import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { idBytes } from '../auth/ids.ts';
import { createAuthExtension } from '../collab/hooks/auth.ts';
import {
  authenticatePayload,
  hookHarness,
  hookOf,
  preAuthContext,
} from '../collab/testing/hook-deps.ts';
import type { Database } from '../db/schema.ts';
import { withVaultLock } from '../db/withVaultLock.ts';
import { systemClock } from '../ops/clock.ts';
import { ProblemError } from '../security/problem.ts';
import { trashNode, type TreeLifecycleDeps } from '../tree/trash.ts';

vi.mock('../db/withVaultLock.ts', () => ({ withVaultLock: vi.fn<typeof withVaultLock>() }));
afterEach(() => {
  vi.resetAllMocks();
});

describe('notes.lifecycle.closing-set.unit [area:notes]', () => {
  it.each(['busy', 'stale_version'] as const)(
    'releases every owned closing mark when the structural transaction refuses %s',
    async (code) => {
      const hooks = hookHarness();
      const vaultId = hooks.world.vault();
      const noteId = hooks.world.note(vaultId);
      const nodeId = NodeId.parse(noteId);
      const second = hooks.world.note(vaultId);
      const userId = hooks.world.user();
      hooks.world.member(vaultId, userId, 'editor');
      const rows = [nodeId, nodeId, second].map((id) => ({ id: idBytes(id), kind: 'note' }));
      // The read-only driver result is the database boundary. Tree reads and closing ownership run
      // unchanged; only transaction admission is forced to fail at the named rollback cut point.
      const db = new Kysely<Database>({
        dialect: {
          createDriver: () => new DummyDriver(),
          createAdapter: () => new MysqlAdapter(),
          createQueryCompiler: () => new MysqlQueryCompiler(),
          createIntrospector: (executor) => new MysqlIntrospector(executor),
        },
        plugins: [
          { transformQuery: (args) => args.node, transformResult: () => Promise.resolve({ rows }) },
        ],
      });
      const markClosing = vi.fn<TreeLifecycleDeps['markClosing']>((id) =>
        hooks.gateway.markClosing(id),
      );
      const clearClosing = vi.fn<TreeLifecycleDeps['clearClosing']>((id) =>
        hooks.gateway.clearClosing(id),
      );
      const deps: TreeLifecycleDeps = {
        searchIndex: {
          index: vi.fn<TreeLifecycleDeps['searchIndex']['index']>(),
          remove: vi.fn<TreeLifecycleDeps['searchIndex']['remove']>(),
        },
        db,
        clock: systemClock,
        audit: { record: vi.fn<TreeLifecycleDeps['audit']['record']>() },
        ownerFence: {
          assertActive: vi.fn<TreeLifecycleDeps['ownerFence']['assertActive']>(),
          assertCurrent: vi.fn<TreeLifecycleDeps['ownerFence']['assertCurrent']>(),
        },
        notes: { initialize: vi.fn<TreeLifecycleDeps['notes']['initialize']>() },
        markClosing,
        clearClosing,
        checkpointTrash: vi.fn<TreeLifecycleDeps['checkpointTrash']>(),
        afterTrash: vi.fn<TreeLifecycleDeps['afterTrash']>(),
        beginPurge: vi.fn<TreeLifecycleDeps['beginPurge']>(),
        beforePurge: vi.fn<TreeLifecycleDeps['beforePurge']>(),
        afterPurge: vi.fn<TreeLifecycleDeps['afterPurge']>(),
      };
      hooks.gateway.markClosing(noteId); // A separate owner cannot lose its fence to this failure.
      const failure = new ProblemError(code);
      vi.mocked(withVaultLock).mockRejectedValue(failure);
      try {
        await expect(
          trashNode(
            deps,
            {
              vaultId,
              nodeId,
              version: 1,
              actor: { userId, sessionId: SessionId.parse(newId()), displayName: 'Actor' },
              context: {},
            },
            true,
          ),
        ).rejects.toBe(failure);
        expect(markClosing.mock.calls.map(([id]) => id)).toEqual([noteId, second]);
        expect(clearClosing.mock.calls.map(([id]) => id)).toEqual([noteId, second]);
        expect(hooks.gateway.isClosing(noteId)).toBe(true);
        expect(hooks.gateway.isClosing(second)).toBe(false);
        hooks.gateway.clearClosing(noteId);
        expect(hooks.gateway.isClosing(noteId)).toBe(false);
        expect(deps.afterTrash).not.toHaveBeenCalled();
        const credentials = hooks.world.credentials(userId);
        const authentication = authenticatePayload({
          documentName: noteDocName(noteId),
          token: credentials.ticket,
          context: preAuthContext(hooks.clock),
        });
        await expect(
          hookOf(createAuthExtension(hooks.deps), 'onAuthenticate')(authentication),
        ).resolves.toMatchObject({ userId, noteId, role: 'editor' });
      } finally {
        await db.destroy();
      }
    },
  );
});
