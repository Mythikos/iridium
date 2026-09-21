// oxlint-disable eslint/no-await-in-loop -- real role statements run in order; each must complete before its next privilege assertion.
/** Exact least-privilege grants and unmodified dump/reload through the shipped MySQL 9.7 clients. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import {
  corruptShippedMysqlDeliberately,
  probeShippedMysqlWrite,
  migrateSchema,
  startServer,
  startShippedMysqlClient,
  TEST_SECRETS,
  type DatabaseRole,
  type KernelSeed,
  type MysqlWriteProbe,
  type ShippedMysqlClient,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { buildApp } from '../../src/app.ts';
import { GRANT_MATRIX, MYSQLDUMP_ARGV } from '../../src/db/grants.ts';
import { MIGRATION_NAMES } from '../../src/db/migrations.ts';
import { startIridiumMysql, type IridiumMysql } from '../db-mysql-container.ts';

const snapshot = fileURLToPath(new URL('../fixtures/db-grants.snapshot.sql', import.meta.url));

/** Compare effective grants, independent of MySQL's static/dynamic statement grouping and order. */
function grantSurface(statements: readonly string[]): string[] {
  return statements
    .flatMap((line) => {
      const normalized = line.replaceAll('`', '').replaceAll("'", '').trim().replace(/;$/, '');
      const match = /^GRANT (.+) ON (\S+) TO (\S+)( WITH GRANT OPTION)?$/.exec(normalized);
      if (match === null) throw new Error(`unrecognized SHOW GRANTS row: ${line}`);
      const privileges = match[1];
      if (privileges === undefined) throw new Error('grant has no privilege list');
      return (
        privileges
          // Commas inside a column privilege are not privilege separators. SHOW GRANTS may also
          // reorder those columns, so compare each effective column grant independently.
          .split(/,(?![^()]*\))/)
          .flatMap((privilege) => {
            const columnGrant = /^([A-Z_ ]+)\s*\(([^)]+)\)$/.exec(privilege.trim());
            const effective =
              columnGrant === null
                ? [privilege.trim()]
                : (columnGrant[2] ?? '')
                    .split(',')
                    .map((column) => `${columnGrant[1]?.trim()}(${column.trim()})`);
            return effective.map(
              (right) =>
                `${match[3]}|${match[2]}|${right}|${match[4] === undefined ? 'NO' : 'YES'}`,
            );
          })
      );
    })
    .toSorted();
}

async function denied(
  client: ShippedMysqlClient,
  role: DatabaseRole,
  statement: MysqlWriteProbe,
  code: number,
): Promise<void> {
  const result = await probeShippedMysqlWrite(client, role, statement);
  expect(result.exitCode, statement).not.toBe(0);
  expect(result.stderr, statement).toMatch(
    new RegExp(`ERROR ${String(code)} \\(${code === 1644 ? '45000' : '[A-Z0-9]+'}\\)`),
  );
}

async function tableCounts(
  client: ShippedMysqlClient,
  tables: readonly string[] = GRANT_MATRIX.map((row) => row.table),
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (!GRANT_MATRIX.some((row) => row.table === table)) {
      throw new Error(`The fixture names an unknown table: ${table}`);
    }
    // eslint-disable-next-line no-await-in-loop -- exercise the backup role against every table
    counts[table] = Number(
      (await client.query('backup', `SELECT COUNT(*) FROM \`${table}\``)).trim(),
    );
  }
  return counts;
}

function writeUpgradeFixture(input: {
  dump: string;
  seeded: KernelSeed;
  counts: Readonly<Record<string, number>>;
  mysqlVersion: string;
  clientVersion: string;
}): void {
  if (process.env['IRIDIUM_FIXTURE_WRITE_UPGRADE'] !== '1') return;
  if (process.env['IRIDIUM_TEST_TARGET_MILESTONE'] !== 'M1') return;
  if (!input.mysqlVersion.startsWith('8.4.')) {
    throw new Error(
      'the v0.1.0 fixture must originate on 8.4 so both required LTS lines can restore it',
    );
  }
  const directory = fileURLToPath(new URL('../fixtures/upgrade/v0.1.0/', import.meta.url));
  mkdirSync(`${directory}/attachments`, { recursive: true });
  const compressed = gzipSync(Buffer.from(input.dump, 'utf8'), { level: 9 });
  writeFileSync(`${directory}/dump.sql.gz`, compressed);
  writeFileSync(`${directory}/attachments/.gitkeep`, '');
  const manifest = {
    format: 'iridium-upgrade-fixture/1',
    milestone: 'M1',
    version: 'v0.1.0',
    generated_at: new Date().toISOString(),
    dataset: 'seed.kernel',
    mysql_line: '8.4',
    mysql_version: input.mysqlVersion,
    mysql_client: input.clientVersion,
    dump: {
      file: 'dump.sql.gz',
      compression: 'gzip',
      bytes: compressed.byteLength,
      sha256: createHash('sha256').update(compressed).digest('hex'),
      argv: MYSQLDUMP_ARGV,
      role: 'iridium_backup',
      restored_with_shipped_mysql: true,
    },
    counts: input.counts,
    counts_provenance: 'unmodified dump restored into an isolated same-line schema',
    attachments: { count: 0, bytes: 0, files: [] },
    kernel: {
      vault_id: input.seeded.vault.id,
      note_id: input.seeded.note.id,
      markdown: input.seeded.note.markdown,
      users: [
        input.seeded.admin,
        input.seeded.editorA,
        input.seeded.editorB,
        input.seeded.editorC,
        input.seeded.viewer,
        input.seeded.outsider,
      ].map((user) => ({ id: user.id, email: user.email })),
    },
    // Deliberately public fixture credentials, never deployment keys. M8 needs the same pepper and
    // HMAC key to sign in and verify chains that this milestone's real CLI/routes produced.
    fixture_keys: TEST_SECRETS,
  };
  writeFileSync(`${directory}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

const UpgradeFixtureManifest = z.object({
  format: z.literal('iridium-upgrade-fixture/1'),
  milestone: z.literal('M1'),
  version: z.literal('v0.1.0'),
  mysql_line: z.literal('8.4'),
  mysql_version: z.string().startsWith('8.4.'),
  dump: z.object({
    file: z.literal('dump.sql.gz'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    role: z.literal('iridium_backup'),
    argv: z.array(z.string()),
    restored_with_shipped_mysql: z.literal(true),
  }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  attachments: z.object({ count: z.literal(0), bytes: z.literal(0), files: z.array(z.never()) }),
  kernel: z.object({ note_id: z.uuid(), markdown: z.string() }),
  fixture_keys: z.object({
    AUTH_PASSWORD_PEPPER: z.string().min(1),
    AUDIT_HMAC_KEY: z.string().min(1),
    MCP_CURSOR_KEY: z.string().min(1),
  }),
});

describe('db-grants.integration [area:db]', () => {
  it('restores the persisted M1 fixture with the shipped client and keeps its data intact through the current migrator', async () => {
    const directory = fileURLToPath(new URL('../fixtures/upgrade/v0.1.0/', import.meta.url));
    const manifest = UpgradeFixtureManifest.parse(
      JSON.parse(readFileSync(`${directory}/manifest.json`, 'utf8')),
    );
    const compressed = readFileSync(`${directory}/dump.sql.gz`);
    expect(compressed.byteLength).toBe(manifest.dump.bytes);
    expect(createHash('sha256').update(compressed).digest('hex')).toBe(manifest.dump.sha256);
    expect(manifest.dump.argv).toEqual(MYSQLDUMP_ARGV);
    const fixtureMigrationCount = manifest.counts['kysely_migration'] ?? 0;
    expect(fixtureMigrationCount).toBeGreaterThan(0);
    expect(fixtureMigrationCount).toBeLessThanOrEqual(MIGRATION_NAMES.length);
    expect(readdirSync(`${directory}/attachments`)).toEqual(['.gitkeep']);
    const dump = gunzipSync(compressed).toString('utf8');
    expect(dump).not.toMatch(/CREATE[^;]*TRIGGER/);

    const target = await startIridiumMysql();
    let client: ShippedMysqlClient | undefined;
    try {
      client = await startShippedMysqlClient({
        mysqlContainerId: target.container.getId(),
        ...(process.env['IRIDIUM_TEST_SERVER_IMAGE'] === undefined
          ? {}
          : { image: process.env['IRIDIUM_TEST_SERVER_IMAGE'] }),
      });
      expect(await client.version('mysql')).toContain('9.7.2');
      await client.restore(dump);
      expect(await tableCounts(client, Object.keys(manifest.counts))).toEqual(manifest.counts);
      expect(
        (await client.query('backup', 'SELECT name FROM kysely_migration ORDER BY name'))
          .trim()
          .split('\n'),
      ).toEqual(MIGRATION_NAMES.slice(0, fixtureMigrationCount));
      const statements = [
        'SELECT HEX(note_id),head_seq,snapshot_format,HEX(snapshot),HEX(snapshot_sv),snapshot_through_seq,projected_seq FROM note_docs ORDER BY note_id',
        'SELECT HEX(note_id),seq,HEX(update_v1),HEX(sv_after),HEX(actor_id),HEX(session_id),origin FROM note_updates ORDER BY note_id,seq',
        'SELECT HEX(note_id),revision,HEX(markdown),HEX(content_hash) FROM note_projections ORDER BY note_id',
        'SELECT HEX(id),HEX(email_key),display_name FROM users ORDER BY id',
      ];
      const reader = client;
      const before = await Promise.all(
        statements.map((statement) => reader.query('backup', statement)),
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
      const after = await Promise.all(
        statements.map((statement) => reader.query('backup', statement)),
      );
      expect(after).toEqual(before);
      expect(
        (
          await client.query(
            'backup',
            `SELECT HEX(markdown) FROM note_projections WHERE note_id=X'${manifest.kernel.note_id.replaceAll('-', '')}'`,
          )
        ).trim(),
      ).toBe(Buffer.from(manifest.kernel.markdown, 'utf8').toString('hex').toUpperCase());
      // Full restore runs migrate ensure-guards in M8. This M1 artifact proof neither manufactures
      // grants/triggers nor boots an application around the reserved command's future boundary.
    } finally {
      await client?.stop();
      await target.stop();
    }
  }, 600_000);

  it('enforces the exact role matrix, audit guards and shipped-client backup/restore on the selected LTS line', async () => {
    const source = await startIridiumMysql();
    let client: ShippedMysqlClient | undefined;
    let restored: IridiumMysql | undefined;
    let restoredClient: ShippedMysqlClient | undefined;
    try {
      await migrateSchema({ host: source.host, port: source.port, schema: 'iridium' });
      client = await startShippedMysqlClient({
        mysqlContainerId: source.container.getId(),
        ...(process.env['IRIDIUM_TEST_SERVER_IMAGE'] === undefined
          ? {}
          : { image: process.env['IRIDIUM_TEST_SERVER_IMAGE'] }),
      });
      const dumpVersion = await client.version('mysqldump');
      expect(dumpVersion).toContain('9.7.2');
      expect(await client.version('mysql')).toContain('9.7.2');
      expect(await client.version('mysqlbinlog')).toContain('9.7.2');
      const expected = readFileSync(snapshot, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('GRANT '));
      const actual: string[] = [];
      for (const role of ['app', 'migrator', 'backup']) {
        // eslint-disable-next-line no-await-in-loop -- SHOW GRANTS separately names each principal
        actual.push(
          ...(await client.query('root', `SHOW GRANTS FOR 'iridium_${role}'@'%'`))
            .trim()
            .split('\n'),
        );
      }
      expect(grantSurface(actual)).toEqual(grantSurface(expected));
      const tables = (
        await client.query(
          'root',
          "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='iridium' AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME",
        )
      )
        .trim()
        .split('\n');
      expect(tables).toEqual(GRANT_MATRIX.map((row) => row.table).toSorted());
      expect(
        (
          await client.query(
            'root',
            "SELECT TABLE_NAME FROM information_schema.TABLES t WHERE TABLE_SCHEMA='iridium' AND (ENGINE <> 'InnoDB' OR TABLE_COLLATION NOT LIKE 'utf8mb4_%' OR NOT EXISTS (SELECT 1 FROM information_schema.STATISTICS s WHERE s.TABLE_SCHEMA=t.TABLE_SCHEMA AND s.TABLE_NAME=t.TABLE_NAME AND s.INDEX_NAME='PRIMARY'))",
          )
        ).trim(),
      ).toBe('');
      const appRights = (
        await client.query(
          'root',
          `
        SELECT CONCAT(TABLE_NAME,'.',PRIVILEGE_TYPE) FROM information_schema.TABLE_PRIVILEGES
         WHERE TABLE_SCHEMA='iridium' AND GRANTEE="'iridium_app'@'%'"
        UNION ALL SELECT CONCAT(TABLE_NAME,'.',PRIVILEGE_TYPE,'(',COLUMN_NAME,')')
          FROM information_schema.COLUMN_PRIVILEGES WHERE TABLE_SCHEMA='iridium' AND GRANTEE="'iridium_app'@'%'"
      `,
        )
      )
        .trim()
        .split('\n')
        .toSorted();
      expect(appRights).toEqual(
        GRANT_MATRIX.flatMap((row) =>
          row.app.flatMap((right) =>
            right.columns === undefined
              ? [`${row.table}.${right.name}`]
              : right.columns.map((column) => `${row.table}.${right.name}(${column})`),
          ),
        ).toSorted(),
      );

      const server = await startServer({
        mode: 'in-process',
        db: { host: source.host, port: source.port, schema: 'iridium' },
        buildApp,
        extraEnv: { ARGON2_MEMORY_KIB: '8192', ARGON2_TIME_COST: '1' },
      });
      let seeded: KernelSeed;
      try {
        seeded = await server.seed.kernel();
      } finally {
        await server.stop();
      }
      const sourceCounts = await tableCounts(client);
      expect(sourceCounts['users']).toBe(6);
      expect(sourceCounts['vault_members']).toBe(4);
      expect(sourceCounts['attachments']).toBe(0);
      const dump = await client.dump(MYSQLDUMP_ARGV);
      expect(dump).toContain('CREATE DATABASE');
      expect(dump).toContain('CHANGE REPLICATION SOURCE TO');
      expect(dump).not.toMatch(/CREATE[^;]*TRIGGER/);
      expect(dump).toMatch(/INSERT INTO `note_docs` VALUES/);
      expect(dump).toMatch(/0x[0-9A-Fa-f]{32}/);
      restored = await startIridiumMysql({ image: source.image });
      restoredClient = await startShippedMysqlClient({
        mysqlContainerId: restored.container.getId(),
        ...(process.env['IRIDIUM_TEST_SERVER_IMAGE'] === undefined
          ? {}
          : { image: process.env['IRIDIUM_TEST_SERVER_IMAGE'] }),
      });
      await restoredClient.restore(dump);
      const restoredCounts = await tableCounts(restoredClient);
      expect(restoredCounts).toEqual(sourceCounts);
      for (const statement of [
        'SELECT HEX(note_id),head_seq,snapshot_format,HEX(snapshot),HEX(snapshot_sv),snapshot_through_seq,projected_seq FROM note_docs ORDER BY note_id',
        'SELECT HEX(note_id),seq,HEX(update_v1),HEX(sv_after),HEX(actor_id),HEX(session_id),origin FROM note_updates ORDER BY note_id,seq',
        'SELECT HEX(note_id),revision,HEX(markdown),HEX(content_hash) FROM note_projections ORDER BY note_id',
        'SELECT id,chain_id,HEX(prev_hash),HEX(hash),key_version FROM audit_events ORDER BY id',
        'SELECT chain_id,last_id,HEX(last_hash) FROM audit_chain_heads ORDER BY chain_id',
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each dump/restore equality has a named SQL oracle
        expect(await restoredClient.query('backup', statement), statement).toBe(
          await client.query('backup', statement),
        );
      }
      const mysqlVersion = (await client.query('backup', 'SELECT VERSION()')).trim();
      writeUpgradeFixture({
        dump,
        seeded,
        counts: restoredCounts,
        mysqlVersion,
        clientVersion: dumpVersion,
      });

      await corruptShippedMysqlDeliberately(client, 'backup', 'flush-binlog');
      const logName = (await client.query('backup', 'SHOW BINARY LOGS'))
        .trim()
        .split('\n')[0]
        ?.split('\t')[0];
      if (logName === undefined) throw new Error('MySQL exposed no closed binary log');
      expect(await client.streamBinaryLog(logName)).toBe('fe62696e');
      await denied(client, 'backup', 'backup-insert-schema-meta', 1142);
      for (const statement of [
        'forge-audit-event',
        'delete-audit-event',
        'forge-audit-archive',
        'delete-audit-archive',
        'delete-audit-head',
        'forge-note-update',
        'forge-access-log',
        'delete-access-log',
        'alter-migration-ledger',
        'delete-migration-lock',
        'create-forbidden-table',
        'drop-audit-trigger',
        'alter-audit-table',
        'reorganize-access-partition',
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- each forbidden privilege must fail independently
        await denied(client, 'app', statement, 1142);
      }
      await denied(client, 'app', 'forge-note-revision', 1143);
      await corruptShippedMysqlDeliberately(client, 'app', 'noop-note-revision');
      await corruptShippedMysqlDeliberately(client, 'app', 'rollback-delete-note-revisions');
      await corruptShippedMysqlDeliberately(client, 'app', 'rollback-delete-note-updates');
      await corruptShippedMysqlDeliberately(client, 'migrator', 'copy-audit-archive');
      for (const [forge, remove, archive] of [
        ['forge-audit-event', 'delete-audit-event', 'archive-delete-audit-event'],
        ['forge-audit-archive', 'delete-audit-archive', 'archive-delete-audit-archive'],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop -- both independent tamper triggers must fire
        await denied(client, 'migrator', forge, 1644);
        // eslint-disable-next-line no-await-in-loop -- both independent tamper triggers must fire
        await denied(client, 'migrator', remove, 1644);
        // The sanctioned archive session can delete, and ROLLBACK preserves the proof dataset.
        // eslint-disable-next-line no-await-in-loop -- the bypass is deliberately scoped to one session
        await corruptShippedMysqlDeliberately(client, 'migrator', archive);
      }
      await corruptShippedMysqlDeliberately(
        client,
        'migrator',
        'reorganize-and-drop-access-partition',
      );
    } finally {
      await restoredClient?.stop();
      await restored?.stop();
      await client?.stop();
      await source.stop();
    }
  }, 600_000);
});
