/** Archived vaults freeze every currently mounted mutation, including administrator writes. */
import { M1_ROUTES } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

const WRITE_OPERATIONS = ['members.delete', 'members.put', 'nodes.create'];

describe('authz.archived-vault.integration [area:authz]', () => {
  it('refuses every M1 vault write without side effects while preserving committed member reads', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const admin = await harness.server.seed.admin();
      const client = await harness.server.loginAs(admin);
      const reader = await harness.server.loginAs(cast.editorA);
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Archived-vault proof requires a real database.');
      const mountedWrites = M1_ROUTES.filter(
        (route) =>
          typeof route.auth === 'object' &&
          'vaultFrom' in route.auth &&
          !['GET', 'HEAD', 'OPTIONS'].includes(route.method),
      )
        .map((route) => route.operationId)
        .toSorted();
      expect(mountedWrites).toEqual(WRITE_OPERATIONS);
      const vault = await db
        .selectFrom('vaults')
        .select('root_node_id')
        .where('id', '=', idBytes(cast.vault.id))
        .executeTakeFirstOrThrow();
      if (vault.root_node_id === null) throw new Error('The seeded vault must have a root.');
      const membership = await db
        .selectFrom('vault_members')
        .select('version')
        .where('vault_id', '=', idBytes(cast.vault.id))
        .where('user_id', '=', idBytes(cast.editorB.id))
        .executeTakeFirstOrThrow();
      await db
        .updateTable('vaults')
        .set({ status: 'archived', archived_at: app.clock.date() })
        .where('id', '=', idBytes(cast.vault.id))
        .execute();
      const snapshot = () =>
        Promise.all(
          (['vault_members', 'nodes', 'notes', 'note_updates', 'audit_events'] as const).map(
            (table) => db.selectFrom(table).selectAll().execute(),
          ),
        );
      const before = await snapshot();
      const results = await Promise.all([
        client.del(`/vaults/${cast.vault.id}/members/${cast.editorB.id}`, {
          headers: { 'if-match': `"${membership.version}"` },
        }),
        client.put(`/vaults/${cast.vault.id}/members/${cast.editorB.id}`, {
          json: { role: 'viewer' },
        }),
        client.post(`/vaults/${cast.vault.id}/nodes`, {
          json: { kind: 'note', name: 'Refused', parentId: cast.vault.rootNodeId },
        }),
      ]);
      expect(results.map((response) => response.status)).toEqual([409, 409, 409]);
      expect(results.map((response) => response.body)).toEqual([
        expect.objectContaining({ code: 'vault_archived' }),
        expect.objectContaining({ code: 'vault_archived' }),
        expect.objectContaining({ code: 'vault_archived' }),
      ]);
      expect(await snapshot()).toEqual(before);
      const readPaths = [
        `/vaults/${cast.vault.id}`,
        `/vaults/${cast.vault.id}/members`,
        `/notes/${cast.note.id}`,
        `/notes/${cast.note.id}/markdown`,
      ];
      const reads = await Promise.all(readPaths.map((path) => reader.get(path)));
      expect(reads.map((response) => response.status)).toEqual([200, 200, 200, 200]);
      expect(reads[3]?.body).toBe(cast.note.markdown);
    } finally {
      await harness.close();
    }
  });
});
