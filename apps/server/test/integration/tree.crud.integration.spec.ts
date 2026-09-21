/**
 * `tree.crud.integration` — `POST /vaults/:vaultId/nodes`, the one structural write of M1
 * (09-api-reference.md §2.7; 03-data-model.md §6.2, §6.4, §6.5; 12-milestones.md §5.2, the `tree` row).
 *
 * The milestone narrows the route to `kind: 'note'`; categories, rename, move, trash and restore are
 * M2, and this file grows with them. What it owns today is everything the creation transaction has to
 * be true about:
 *
 *  - the row lands under the vault's **root** row, with the derived path the read reports;
 *  - the name is stored NFC and without its `.md` suffix (§6.5), and a name that breaks a rule is
 *    `422 validation_failed` with the policy code rather than a generic schema error;
 *  - `uq_sibling` makes a duplicate live name `409 name_conflict`, and a trashed row releases it;
 *  - `vaults.tree_version` is bumped **exactly once** per successful create and not at all per
 *    refusal, because it is what every client compares to decide its tree is stale;
 *  - one `node.created` audit row per create, on the vault's own chain;
 *  - a parent that is a note, in another vault, or trashed is `409 invalid_move` with the reason.
 *
 * Every response is asserted against the committed OpenAPI document, so the pairs this file exercises
 * are recorded for the coverage gate (`openapi.coverage.contract`).
 */
import { VaultId } from '@iridium/contracts';
import type { RestClient } from '@iridium/testkit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import {
  startAuthServer,
  webClient,
  webHeaders,
  type AuthTestServer,
} from '../support/auth-app.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';
import { insertNode, seedUser, signInWeb, type SeededUser } from '../support/seed.ts';

let context: AuthTestServer;
let admin: SeededUser;
let adminClient: RestClient;

/**
 * A vault through the product's own `POST /vaults`, so each case starts from a tree the server built.
 *
 * Seeding the rows directly would skip the one transaction that establishes the root-row convention
 * of §6.2, and a test whose fixture is not the thing under test is a test that can pass while the
 * thing under test is broken.
 */
async function freshVault(name: string): Promise<{ id: VaultId; rootNodeId: string }> {
  const created = await adminClient.post<{ id: string; rootNodeId: string; treeVersion: number }>(
    '/vaults',
    { json: { name }, headers: webHeaders(context.origin) },
  );
  if (created.status !== 201) {
    throw new Error(`POST /vaults answered ${String(created.status)}`);
  }
  await expect(created).toMatchOpenApi('vaults.create', 201);
  expect(created.body.treeVersion).toBe(0);
  return { id: VaultId.parse(created.body.id), rootNodeId: created.body.rootNodeId };
}

/** `vaults.tree_version` right now. */
async function treeVersion(vaultId: VaultId): Promise<number> {
  const row = await context.db
    .selectFrom('vaults')
    .select('tree_version')
    .where('id', '=', idBytes(vaultId))
    .executeTakeFirstOrThrow();
  return row.tree_version;
}

/** The `node.created` rows of one vault's audit chain. */
async function createdAudits(vaultId: VaultId): Promise<number> {
  const rows = await context.db
    .selectFrom('audit_events')
    .select('id')
    .where('action', '=', 'node.created')
    .where('vault_id', '=', idBytes(vaultId))
    .execute();
  return rows.length;
}

// Registered at collection time; see `support/openapi-coverage.ts` for why it cannot go in a hook.
registerRecordingOpenApiMatcher();

beforeAll(async () => {
  context = await startAuthServer();
});

// Every table is truncated after each test (`worker-schema.setup.ts`), so the administrator is
// created per case rather than once: a fixture that outlived the truncation would exist only for the
// first test of the file.
beforeEach(async () => {
  admin = await seedUser(context, { email: 'tree-admin@example.test', isServerAdmin: true });
  adminClient = webClient(context, await signInWeb(context, admin));
});

afterAll(async () => {
  await context.stop();
});

describe('tree.crud.integration [area:tree]', () => {
  it('creates a note under the vault root and reports its derived path', async () => {
    const vault = await freshVault('Tree Create');
    const before = await treeVersion(vault.id);

    const created = await adminClient.post<{
      id: string;
      path: string;
      kind: string;
      name: string;
    }>(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'Onboarding', markdown: '# Hello\n' },
      headers: webHeaders(context.origin),
    });

    expect(created.status).toBe(201);
    await expect(created).toMatchOpenApi('nodes.create', 201);
    expect(created.body.kind).toBe('note');
    expect(created.body.name).toBe('Onboarding');
    // §6.3: a top-level node's path is the root-excluded, `/`-joined name.
    expect(created.body.path).toBe('/Onboarding');
    expect(created.headers.get('location')).toBe(`/api/v1/nodes/${created.body.id}`);
    expect(await treeVersion(vault.id)).toBe(before + 1);
    expect(await createdAudits(vault.id)).toBe(1);
  });

  it('stores a note name without its `.md` suffix', async () => {
    const vault = await freshVault('Tree Suffix');
    const created = await adminClient.post<{ name: string; path: string }>(
      `/vaults/${vault.id}/nodes`,
      {
        json: { kind: 'note', parentId: vault.rootNodeId, name: 'Release Notes.md' },
        headers: webHeaders(context.origin),
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Release Notes');
    expect(created.body.path).toBe('/Release Notes');
  });

  it('refuses a duplicate live name with `name_conflict`, and bumps nothing', async () => {
    const vault = await freshVault('Tree Conflict');
    const first = await adminClient.post(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'Twice' },
      headers: webHeaders(context.origin),
    });
    expect(first.status).toBe(201);
    const after = await treeVersion(vault.id);

    const second = await adminClient.post(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'Twice' },
      headers: webHeaders(context.origin),
    });
    expect(second.status).toBe(409);
    await expect(second).toMatchOpenApi('nodes.create', 409);
    expect(await treeVersion(vault.id)).toBe(after);
    expect(await createdAudits(vault.id)).toBe(1);
  });

  it('collides case-insensitively, as the column collation does', async () => {
    const vault = await freshVault('Tree Collation');
    await adminClient.post(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'Readme' },
      headers: webHeaders(context.origin),
    });
    const clash = await adminClient.post(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'readme' },
      headers: webHeaders(context.origin),
    });
    expect(clash.status).toBe(409);
  });

  it('lets a trashed row release its name', async () => {
    const vault = await freshVault('Tree Trashed Name');
    await insertNode(
      context.db,
      {
        vaultId: vault.id,
        kind: 'note',
        name: 'Recycled',
        createdBy: admin.id,
        deletedAt: new Date(context.clock.now()),
      },
      context.clock.now(),
    );
    const created = await adminClient.post(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'Recycled' },
      headers: webHeaders(context.origin),
    });
    // `uq_sibling` is over `(parent_id, name, live)` and a trashed row's `live` is NULL (§6.1).
    expect(created.status).toBe(201);
  });

  it.each([
    ['a name with a separator', 'Guides/Onboarding'],
    ['a leading dot', '.hidden'],
    ['a reserved device name', 'CON'],
    ['a trailing space', 'Onboarding '],
  ])('refuses %s with the policy code', async (_case: string, name: string) => {
    const vault = await freshVault(`Tree Name ${name.length.toString()} ${_case}`);
    const before = await treeVersion(vault.id);
    const refused = await adminClient.post<{ errors?: { code: string }[] }>(
      `/vaults/${vault.id}/nodes`,
      {
        json: { kind: 'note', parentId: vault.rootNodeId, name },
        headers: webHeaders(context.origin),
      },
    );
    expect(refused.status).toBe(422);
    await expect(refused).toMatchOpenApi('nodes.create', 422);
    expect(refused.body.errors?.[0]?.code).toBe('invalid_name');
    expect(await treeVersion(vault.id)).toBe(before);
  });

  it('creates a category without a note document and rejects Markdown on categories', async () => {
    const vault = await freshVault('Tree Category');
    const before = await treeVersion(vault.id);
    const beforeNodes = await context.db
      .selectFrom('nodes')
      .selectAll()
      .where('vault_id', '=', idBytes(vault.id))
      .orderBy('id')
      .execute();
    const refused = await adminClient.post<{ errors?: { path: string; code: string }[] }>(
      `/vaults/${vault.id}/nodes`,
      {
        json: { kind: 'category', parentId: vault.rootNodeId, name: 'Kernel', markdown: '' },
        headers: webHeaders(context.origin),
      },
    );
    expect(refused.status).toBe(422);
    await expect(refused).toMatchOpenApi('nodes.create', 422);
    expect(refused.body.errors).toEqual([
      expect.objectContaining({ path: 'body/markdown', code: 'custom' }),
    ]);
    expect(await treeVersion(vault.id)).toBe(before);
    expect(await createdAudits(vault.id)).toBe(0);
    const afterNodes = await context.db
      .selectFrom('nodes')
      .selectAll()
      .where('vault_id', '=', idBytes(vault.id))
      .orderBy('id')
      .execute();
    expect(afterNodes).toStrictEqual(beforeNodes);
    const created = await adminClient.post<{ id: string; kind: string }>(
      `/vaults/${vault.id}/nodes`,
      {
        json: { kind: 'category', parentId: vault.rootNodeId, name: 'Category' },
        headers: webHeaders(context.origin),
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.kind).toBe('category');
    expect(
      await context.db
        .selectFrom('note_docs')
        .selectAll()
        .where('note_id', '=', idBytes(created.body.id))
        .execute(),
    ).toEqual([]);
    expect(await treeVersion(vault.id)).toBe(before + 1);
  });

  it('refuses an unknown parent as `not_found`', async () => {
    const vault = await freshVault('Tree Unknown Parent');
    const refused = await adminClient.post(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', name: 'Orphan' },
      headers: webHeaders(context.origin),
    });
    expect(refused.status).toBe(404);
    await expect(refused).toMatchOpenApi('nodes.create', 404);
  });

  it('refuses a note as a parent with `invalid_move`', async () => {
    const vault = await freshVault('Tree Note Parent');
    const note = await adminClient.post<{ id: string }>(`/vaults/${vault.id}/nodes`, {
      json: { kind: 'note', parentId: vault.rootNodeId, name: 'Parent Note' },
      headers: webHeaders(context.origin),
    });
    expect(note.status).toBe(201);

    const refused = await adminClient.post<{ errors?: { code: string }[] }>(
      `/vaults/${vault.id}/nodes`,
      {
        json: { kind: 'note', parentId: note.body.id, name: 'Child' },
        headers: webHeaders(context.origin),
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.errors?.[0]?.code).toBe('parent_not_category');
  });

  it('refuses a parent from another vault with `cross_vault`', async () => {
    const here = await freshVault('Tree Here');
    const elsewhere = await freshVault('Tree Elsewhere');
    const refused = await adminClient.post<{ errors?: { code: string }[] }>(
      `/vaults/${here.id}/nodes`,
      {
        json: { kind: 'note', parentId: elsewhere.rootNodeId, name: 'Foreign' },
        headers: webHeaders(context.origin),
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.errors?.[0]?.code).toBe('cross_vault');
  });
});
