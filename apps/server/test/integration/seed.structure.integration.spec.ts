/** Populated M2 structure seed and an immutable backup-role upgrade fixture (12 §6.2, D12-4). */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Node, NoteLinks, NoteMeta, SearchPage } from '@iridium/contracts';
import {
  migrateSchema,
  SEED_PASSWORD,
  startServer,
  startShippedMysqlClient,
  STRUCTURE_NODE_COUNT,
  STRUCTURE_PNG_BYTES,
  type RestClient,
  type ShippedMysqlClient,
  type StructureSeed,
  type TestServer,
} from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { MYSQLDUMP_ARGV } from '../../src/db/grants.ts';
import { MIGRATION_NAMES } from '../../src/db/migrations.ts';
import { startIridiumMysql, type IridiumMysql } from '../db-mysql-container.ts';
import { createStructureWriter } from '../support/seed-structure.ts';
import {
  fixtureHash,
  readStructureUpgradeFixture,
  STRUCTURE_UPGRADE_DIRECTORY,
  structureAttachmentPath,
  structureFingerprints,
  structureFixtureContent,
  structureTableCounts,
  writeStructureUpgradeFixture,
  type StructureFixtureContent,
} from '../support/structure-upgrade.ts';

const FIXTURE_ENV: Readonly<Record<string, string>> = {
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_TIME_COST: '1',
  JOBS_ENABLED: 'false',
};

async function shippedClient(database: IridiumMysql): Promise<ShippedMysqlClient> {
  return startShippedMysqlClient({
    mysqlContainerId: database.container.getId(),
    ...(process.env['IRIDIUM_TEST_SERVER_IMAGE'] === undefined
      ? {}
      : { image: process.env['IRIDIUM_TEST_SERVER_IMAGE'] }),
  });
}

async function fixtureServer(
  database: IridiumMysql,
  attachmentsDir: string,
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<TestServer<FastifyInstance>> {
  const server = await startServer({
    mode: 'in-process',
    db: { host: database.host, port: database.port, schema: 'iridium' },
    attachmentsDir,
    buildApp,
    structureWriter: createStructureWriter,
    extraEnv: { ...FIXTURE_ENV, ...extraEnv },
  });
  try {
    await server.waitReady();
    return server;
  } catch (error) {
    await server.stop();
    throw error;
  }
}

/** Public reads prove the restored bytes, provenance, paths and indexed resolution as a client sees them. */
async function expectStructureReads(
  client: RestClient,
  fixture: StructureFixtureContent,
): Promise<void> {
  await Promise.all(
    fixture.selected_paths.map(async (expected) => {
      const response = await client.get(`/nodes/${expected.id}`);
      expect(response.status).toBe(200);
      expect(Node.parse(response.body)).toMatchObject(expected);
    }),
  );
  await Promise.all(
    Object.values(fixture.notes).map(async (expected) => {
      const [metadata, markdown] = await Promise.all([
        client.get(`/notes/${expected.id}`),
        client.get<string>(`/notes/${expected.id}/markdown`),
      ]);
      expect(metadata.status).toBe(200);
      expect(markdown.status).toBe(200);
      expect(markdown.body).toBe(expected.markdown);
      expect(NoteMeta.parse(metadata.body)).toMatchObject({
        id: expected.id,
        path: expected.path,
        originalEol: expected.originalEol,
        hadBom: expected.hadBom,
        contentHash: fixtureHash(expected.markdown),
        revision: 1,
        headRevision: 1,
        projectionStatus: 'ok',
        pipelineVersion: fixture.pipeline_version,
      });
    }),
  );
  const metadata = await client.get(`/notes/${fixture.notes.target.id}`);
  expect(NoteMeta.parse(metadata.body)).toMatchObject({
    fmTags: ['fixtures', 'm2'],
    fmAliases: ['fixture-target'],
    frontmatter: { tags: ['fixtures', 'm2'], aliases: ['fixture-target'] },
  });
  const outgoing = await client.get(`/notes/${fixture.notes.links.id}/links`);
  expect(outgoing.status).toBe(200);
  const links = NoteLinks.parse(outgoing.body);
  expect(links.revision).toBe(1);
  expect(links.items.map(({ status }) => status)).toEqual([
    'resolved',
    'broken',
    'ambiguous',
    'resolved',
    'resolved',
    'external',
  ]);
  expect(links.items[0]?.resolvedNodeId).toBe(fixture.notes.target.id);
  expect(links.items[3]?.resolvedNodeId).toBe(fixture.notes.target.id);
  expect(links.items[4]?.resolvedAttachmentId).toBe(fixture.attachment.id);
  const search = await client.get(`/vaults/${fixture.vault_id}/search`, { query: { q: 'needle' } });
  expect(search.status).toBe(200);
  expect(SearchPage.parse(search.body).results.map(({ noteId }) => noteId)).toContain(
    fixture.notes.target.id,
  );
  const downloaded = await client.get<Uint8Array>(
    `/vaults/${fixture.vault_id}/attachments/${fixture.attachment.id}`,
  );
  expect(downloaded.status).toBe(200);
  expect(Buffer.from(downloaded.body)).toEqual(Buffer.from(STRUCTURE_PNG_BYTES));
  expect(fixtureHash(downloaded.body)).toBe(fixture.attachment.sha256);
}

describe('seed.structure.integration [area:testkit]', () => {
  it('seeds exactly 20k real nodes and preserves the populated dataset through the shipped dump and restore clients', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'iridium-structure-upgrade-'));
    const sourceAttachments = join(scratch, 'source-attachments');
    const targetAttachments = join(scratch, 'target-attachments');
    const source = await startIridiumMysql();
    let target: IridiumMysql | undefined;
    let sourceClient: ShippedMysqlClient | undefined;
    let targetClient: ShippedMysqlClient | undefined;
    let sourceServer: TestServer<FastifyInstance> | undefined;
    let targetServer: TestServer<FastifyInstance> | undefined;
    try {
      await migrateSchema({ host: source.host, port: source.port, schema: 'iridium' });
      sourceServer = await fixtureServer(source, sourceAttachments);
      const seed: StructureSeed = await sourceServer.seed.structure({
        progress: (created) =>
          process.stdout.write(`[seed.structure] ${String(created)} committed nodes\n`),
      });
      expect(seed.nodes).toHaveLength(STRUCTURE_NODE_COUNT - 1);
      expect(new Set(seed.nodes.map(({ id }) => id)).size).toBe(STRUCTURE_NODE_COUNT - 1);
      const content = structureFixtureContent(seed);
      await expectStructureReads(seed.admin.client, content);
      await sourceServer.stop();
      sourceServer = undefined;
      sourceClient = await shippedClient(source);
      const dumpVersion = await sourceClient.version('mysqldump');
      expect(dumpVersion).toContain('9.7.2');
      const counts = await structureTableCounts(sourceClient);
      expect(counts['nodes']).toBe(STRUCTURE_NODE_COUNT);
      expect(counts['notes']).toBe(7);
      expect(counts['note_docs']).toBe(7);
      expect(counts['note_projections']).toBe(7);
      expect(counts['note_links']).toBe(6);
      expect(counts['attachments']).toBe(1);
      const fingerprints = await structureFingerprints(sourceClient);
      const storageKey = (
        await sourceClient.query('backup', 'SELECT storage_key FROM attachments')
      ).trim();
      const attachment = readFileSync(structureAttachmentPath(sourceAttachments, storageKey));
      expect(attachment).toEqual(Buffer.from(STRUCTURE_PNG_BYTES));
      const dump = await sourceClient.dump(MYSQLDUMP_ARGV);
      expect(dump).toContain('CREATE DATABASE');
      expect(dump).toContain('CHANGE REPLICATION SOURCE TO');
      expect(dump).not.toMatch(/CREATE[^;]*TRIGGER/);
      target = await startIridiumMysql({ image: source.image });
      targetClient = await shippedClient(target);
      await targetClient.restore(dump);
      expect(await structureTableCounts(targetClient)).toEqual(counts);
      expect(await structureFingerprints(targetClient)).toEqual(fingerprints);
      cpSync(sourceAttachments, targetAttachments, { recursive: true });
      const grants = readFileSync(new URL('../../../../docs/ops/db-grants.sql', import.meta.url));
      await targetClient.applyDbaGrants(grants.toString('utf8'));
      expect(Number((await targetClient.query('app', 'SELECT COUNT(*) FROM nodes')).trim())).toBe(
        STRUCTURE_NODE_COUNT,
      );
      await migrateSchema({ host: target.host, port: target.port, schema: 'iridium' });
      expect(await structureFingerprints(targetClient)).toEqual(fingerprints);
      targetServer = await fixtureServer(target, targetAttachments);
      await expectStructureReads(await targetServer.loginAs(seed.admin), content);
      const verified = await targetServer.cli(['audit', 'verify-chain', '--json']);
      expect(verified.code, verified.stderr || verified.stdout).toBe(0);
      await targetServer.stop();
      targetServer = undefined;
      writeStructureUpgradeFixture({
        dump,
        grants,
        seed,
        counts,
        fingerprints,
        mysqlVersion: (await sourceClient.query('backup', 'SELECT VERSION()')).trim(),
        clientVersion: dumpVersion,
        attachment: { storageKey, bytes: attachment },
      });
    } finally {
      await targetServer?.stop();
      await sourceServer?.stop();
      await targetClient?.stop();
      await sourceClient?.stop();
      await target?.stop();
      await source.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 1_200_000);

  it('restores the persisted M2 fixture, applies current migrations, and serves its original content and attachment bytes', async () => {
    const { manifest, dump, grants } = readStructureUpgradeFixture();
    expect(manifest.dump.argv).toEqual(MYSQLDUMP_ARGV);
    expect(manifest.counts['nodes']).toBe(STRUCTURE_NODE_COUNT);
    expect(manifest.structure.listed_node_rows).toBe(STRUCTURE_NODE_COUNT - 1);
    const migrationCount = manifest.counts['kysely_migration'] ?? 0;
    expect(migrationCount).toBeGreaterThan(0);
    expect(migrationCount).toBeLessThanOrEqual(MIGRATION_NAMES.length);
    const scratch = mkdtempSync(join(tmpdir(), 'iridium-structure-restored-'));
    const attachmentsDir = join(scratch, 'attachments');
    const target = await startIridiumMysql();
    let client: ShippedMysqlClient | undefined;
    let server: TestServer<FastifyInstance> | undefined;
    try {
      client = await shippedClient(target);
      await client.restore(dump);
      expect(await structureTableCounts(client, Object.keys(manifest.counts))).toEqual(
        manifest.counts,
      );
      expect(await structureFingerprints(client)).toEqual(manifest.fingerprints);
      expect(
        (await client.query('backup', 'SELECT name FROM kysely_migration ORDER BY name'))
          .trim()
          .split('\n'),
      ).toEqual(MIGRATION_NAMES.slice(0, migrationCount));
      await client.applyDbaGrants(grants);
      expect(Number((await client.query('app', 'SELECT COUNT(*) FROM nodes')).trim())).toBe(
        STRUCTURE_NODE_COUNT,
      );
      await migrateSchema({
        host: target.host,
        port: target.port,
        schema: 'iridium',
        extraEnv: manifest.fixture_keys,
      });
      expect(
        (await client.query('backup', 'SELECT name FROM kysely_migration ORDER BY name'))
          .trim()
          .split('\n'),
      ).toEqual(MIGRATION_NAMES);
      expect(await structureFingerprints(client, manifest.counts['audit_events'] ?? 0)).toEqual(
        Object.fromEntries(
          Object.entries(manifest.fingerprints).filter(([name]) => name !== 'audit_chain_heads'),
        ),
      );
      cpSync(join(STRUCTURE_UPGRADE_DIRECTORY, 'attachments'), attachmentsDir, { recursive: true });
      server = await fixtureServer(target, attachmentsDir, manifest.fixture_keys);
      const administrator = { ...manifest.structure.administrator, password: SEED_PASSWORD };
      await expectStructureReads(await server.loginAs(administrator), manifest.structure);
      const verified = await server.cli(['audit', 'verify-chain', '--json']);
      expect(verified.code, verified.stderr || verified.stdout).toBe(0);
    } finally {
      await server?.stop();
      await client?.stop();
      await target.stop();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 600_000);
});
