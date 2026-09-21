import { PatchVaultBody, type Node, type ProblemDetails, type Vault } from '@iridium/contracts';
import {
  createCollabSocket,
  createVaultClient,
  noteClientWebSocket,
  restTicketSource,
  type RestClient,
} from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { idBytes } from '../../src/auth/ids.ts';
import {
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { seedUser, signInWeb } from '../support/seed.ts';
import { createTreeNode, createTreeVault, treeHeaders } from './tree-test-helpers.ts';

let context: AuthTestServer;
let adminClient: RestClient;
beforeAll(async () => {
  context = await startAuthServer();
});
beforeEach(async () => {
  const admin = await seedUser(context, {
    email: 'vault-settings@example.test',
    isServerAdmin: true,
  });
  adminClient = webClient(context, await signInWeb(context, admin));
});
afterAll(async () => {
  await context.stop();
});

const CHANGES = {
  name: 'Renamed vault',
  description: 'A changed description',
  markdownFlavor: 'obsidian-compat',
  softBreaks: true,
  attachmentFolder: 'media/images',
  loadExternalImages: 'never',
  mcpEnabled: false,
  aiGuidance: 'Read committed revisions.',
  trashRetentionDays: 31,
  autoCheckpointIntervalMin: 7,
} satisfies Required<PatchVaultBody>;

describe('vaults.settings.integration [area:vaults]', () => {
  it('validates every schema field, requires a manager and validator, and writes minimal audited changes', async () => {
    let vault = await createTreeVault(context, adminClient, 'Settings');
    const manager = await seedUser(context, { email: 'manager@example.test' });
    const viewer = await seedUser(context, { email: 'settings-viewer@example.test' });
    const editor = await seedUser(context, { email: 'settings-editor@example.test' });
    for (const [user, role] of [
      [manager, 'manager'],
      [viewer, 'viewer'],
      [editor, 'editor'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- membership admission is established before each user's client is exercised
      const granted = await adminClient.put(`/vaults/${vault.id}/members/${user.id}`, {
        json: { role },
        headers: webHeaders(context.origin),
      });
      expect(granted.status).toBe(201);
    }
    const managerClient = webClient(context, await signInWeb(context, manager));
    const viewerClient = webClient(context, await signInWeb(context, viewer));
    const editorClient = webClient(context, await signInWeb(context, editor));
    const denied = await viewerClient.patch(`/vaults/${vault.id}`, {
      json: { description: 'No' },
      headers: treeHeaders(context, vault.version),
    });
    expect(denied.status).toBe(403);
    expect(
      (
        await editorClient.patch(`/vaults/${vault.id}`, {
          json: { description: 'No' },
          headers: treeHeaders(context, vault.version),
        })
      ).status,
    ).toBe(403);
    const missing = await managerClient.patch(`/vaults/${vault.id}`, {
      json: { description: 'No validator' },
      headers: webHeaders(context.origin),
    });
    expect(missing.status).toBe(428);
    for (let index = 0; index < 20; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- seed each projected note through the real initializer
      await createTreeNode(context, managerClient, vault, {
        kind: 'note',
        name: `Unchanged ${String(index)}`,
        markdown: '# Heading\n',
      });
    }
    const projectedNotes = context.db
      .selectFrom('nodes')
      .select('id')
      .where('vault_id', '=', idBytes(vault.id));
    const projections = await context.db
      .selectFrom('note_projections')
      .selectAll()
      .where('note_id', 'in', projectedNotes)
      .orderBy('note_id')
      .execute();
    expect(PatchVaultBody).toBeInstanceOf(z.ZodObject);
    if (!(PatchVaultBody instanceof z.ZodObject))
      throw new Error('Vault patches must declare their fields.');
    expect(Object.keys(CHANGES).toSorted()).toEqual(Object.keys(PatchVaultBody.shape).toSorted());
    const socket = createCollabSocket({
      url: context.server.wsUrl,
      webSocketPolyfill: noteClientWebSocket({ defaultOrigin: context.origin }),
    });
    const channel = createVaultClient({
      socket,
      vaultId: vault.id,
      tickets: restTicketSource(managerClient),
    });
    await channel.waitConnected();
    try {
      for (const [key, value] of Object.entries(CHANGES)) {
        // eslint-disable-next-line no-await-in-loop -- each accepted patch supplies the validator for the next one
        const updated = await managerClient.patch<Vault>(`/vaults/${vault.id}`, {
          json: { [key]: value },
          headers: treeHeaders(context, vault.version),
        });
        expect(updated.status).toBe(200);
        expect(updated.body.version).toBe(vault.version + 1);
        // eslint-disable-next-line no-await-in-loop -- inspect this patch's own audit row before the next patch is issued
        const audit = await context.db
          .selectFrom('audit_events')
          .select(['metadata', 'actor_id'])
          .where('vault_id', '=', idBytes(vault.id))
          .where('action', '=', 'vault.settings.changed')
          .orderBy('id', 'desc')
          .executeTakeFirstOrThrow();
        expect(audit.metadata).toMatchObject({ after: { [key]: value } });
        expect(audit.actor_id).toEqual(idBytes(manager.id));
        const metadata = z
          .object({ after: z.record(z.string(), z.unknown()) })
          .parse(audit.metadata);
        expect(Object.keys(metadata.after)).toEqual([key]);
        vault = updated.body;
        // eslint-disable-next-line no-await-in-loop -- each accepted patch has one independently observable announcement
        await expect
          .poll(() => channel.messages.findLast((event) => event.t === 'vault-updated'))
          .toMatchObject({ version: vault.version, changed: [key] });
        // eslint-disable-next-line no-await-in-loop -- the read path must reflect the committed settings row
        expect((await managerClient.get<Vault>(`/vaults/${vault.id}`)).body).toEqual(vault);
      }
      expect(channel.messages.filter((event) => event.t === 'vault-updated')).toHaveLength(
        Object.keys(CHANGES).length,
      );
      expect(channel.messages.filter((event) => event.t === 'tree-changed')).toEqual([]);
      expect(
        await context.db
          .selectFrom('note_projections')
          .selectAll()
          .where('note_id', 'in', projectedNotes)
          .orderBy('note_id')
          .execute(),
      ).toEqual(projections);
      const floor = await managerClient.patch<ProblemDetails>(`/vaults/${vault.id}`, {
        json: { trashRetentionDays: 29 },
        headers: treeHeaders(context, vault.version),
      });
      expect(floor.status).toBe(422);
      expect(floor.body.errors?.[0]?.code).toBe('below_env_floor');
      const invalidPath = await managerClient.patch(`/vaults/${vault.id}`, {
        json: { attachmentFolder: '../escape' },
        headers: treeHeaders(context, vault.version),
      });
      expect(invalidPath.status).toBe(422);
      const invalidBodies = [
        { trashRetentionDays: 0 },
        { trashRetentionDays: 3651 },
        { autoCheckpointIntervalMin: 0 },
        { autoCheckpointIntervalMin: 1441 },
        { attachmentFolder: '/abs' },
        { attachmentFolder: '' },
        { description: 'x'.repeat(501) },
        { aiGuidance: 'x'.repeat(4001) },
        { markdownFlavor: 'unknown' },
        { loadExternalImages: 'unknown' },
        {},
      ];
      const unchanged = await context.db
        .selectFrom('vaults')
        .selectAll()
        .where('id', '=', idBytes(vault.id))
        .executeTakeFirstOrThrow();
      for (const body of invalidBodies) {
        // eslint-disable-next-line no-await-in-loop -- every invalid patch is isolated against the same validator
        const response = await managerClient.patch<ProblemDetails>(`/vaults/${vault.id}`, {
          json: body,
          headers: treeHeaders(context, vault.version),
        });
        expect(response.status).toBe(422);
        expect(response.body.code).toBe('validation_failed');
        expect(response.body.errors?.length).toBeGreaterThan(0);
      }
      const stale = await managerClient.patch<ProblemDetails>(`/vaults/${vault.id}`, {
        json: { name: 'Stale' },
        headers: treeHeaders(context, 1),
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('stale_version');
      expect(
        await context.db
          .selectFrom('vaults')
          .selectAll()
          .where('id', '=', idBytes(vault.id))
          .executeTakeFirstOrThrow(),
      ).toEqual(unchanged);
      expect(channel.messages.filter((event) => event.t === 'vault-updated')).toHaveLength(
        Object.keys(CHANGES).length,
      );
      const audits = await context.db
        .selectFrom('audit_events')
        .select('id')
        .where('vault_id', '=', idBytes(vault.id))
        .where('action', '=', 'vault.settings.changed')
        .execute();
      expect(audits).toHaveLength(Object.keys(CHANGES).length);
    } finally {
      channel.close();
      socket.destroy();
    }
  });

  it('archives with step-up and If-Match, freezes writes, and unarchives without changing tree_version', async () => {
    const vault = await createTreeVault(context, adminClient, 'Archive');
    const note = await createTreeNode(context, adminClient, vault, {
      kind: 'note',
      name: 'Still readable',
      markdown: 'content',
    });
    const archived = await adminClient.post<Vault>(`/vaults/${vault.id}/archive`, {
      json: { confirm: true },
      headers: treeHeaders(context, vault.version),
    });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ status: 'archived', treeVersion: 1, version: 2 });
    const again = await adminClient.post<ProblemDetails>(`/vaults/${vault.id}/archive`, {
      json: { confirm: true },
      headers: treeHeaders(context, 2),
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_state');
    const frozen = await adminClient.patch<ProblemDetails>(`/vaults/${vault.id}`, {
      json: { name: 'Frozen' },
      headers: treeHeaders(context, 2),
    });
    expect(frozen.status).toBe(409);
    expect(frozen.body.code).toBe('vault_archived');
    expect((await adminClient.get<Node>(`/nodes/${note.id}`)).status).toBe(200);
    const restored = await adminClient.post<Vault>(`/vaults/${vault.id}/unarchive`, {
      json: { confirm: true },
      headers: treeHeaders(context, 2),
    });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({
      status: 'active',
      archivedAt: null,
      treeVersion: 1,
      version: 3,
    });
  });
});
