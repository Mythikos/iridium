/** Archived vaults freeze every currently mounted mutation, including administrator writes. */
import { ALLOW_ARCHIVED_ROUTES, API_ROUTES } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

/**
 * Every vault-scoped mutation the freeze must cover, sorted. The list is committed rather than
 * derived so that mounting a new vault write is a deliberate decision here: either it freezes on an
 * archived vault, or it joins `ALLOW_ARCHIVED_ROUTES` and is proven to lift instead (D04-12).
 */
const FROZEN_OPERATIONS = [
  'attachments.delete',
  'attachments.upload',
  'members.delete',
  'members.put',
  'nodes.create',
  'nodes.purge',
  'nodes.restore',
  'nodes.trash',
  'nodes.update',
  'revisions.create',
  'revisions.restore',
  'vaults.update',
];

/** The writes 04 section 5.6 exempts, so an archived vault can still be returned to active use. */
const LIFTED_OPERATIONS = ['vaults.archive', 'vaults.unarchive'];

describe('authz.archived-vault.integration [area:authz]', () => {
  it('refuses every frozen vault write without side effects while preserving committed member reads', async () => {
    const harness = await startCollab();
    try {
      const cast = await harness.server.seed.kernel();
      const admin = await harness.server.seed.admin();
      const client = await harness.server.loginAs(admin);
      const reader = await harness.server.loginAs(cast.editorA);
      const app = harness.application();
      const db = app.database.dbApp;
      if (db === null) throw new Error('Archived-vault proof requires a real database.');
      const mountedWrites = API_ROUTES.filter(
        (route) =>
          typeof route.auth === 'object' &&
          'vaultFrom' in route.auth &&
          !['GET', 'HEAD', 'OPTIONS'].includes(route.method),
      );
      const lifts = new Set<string>(ALLOW_ARCHIVED_ROUTES);
      const partition = (lifted: boolean): readonly string[] =>
        mountedWrites
          .filter((route) => lifts.has(`${route.method} ${route.path}`) === lifted)
          .map((route) => route.operationId)
          .toSorted();
      expect(partition(false)).toEqual(FROZEN_OPERATIONS);
      expect(partition(true)).toEqual(LIFTED_OPERATIONS);
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
