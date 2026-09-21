/** Immutable M2 upgrade artefact metadata and byte-level dump/attachment verification (D12-4). */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

import { PIPELINE_VERSION } from '@iridium/markdown';
import {
  STRUCTURE_NODE_COUNT,
  TEST_SECRETS,
  type ShippedMysqlClient,
  type StructureSeed,
} from '@iridium/testkit';
import { z } from 'zod';

import { GRANT_MATRIX, MYSQLDUMP_ARGV } from '../../src/db/grants.ts';

const FixtureNode = z.object({
  id: z.uuid(),
  parentId: z.uuid(),
  name: z.string(),
  path: z.string(),
});
const FixtureNote = FixtureNode.extend({
  source: z.string(),
  markdown: z.string(),
  originalEol: z.enum(['lf', 'crlf']),
  hadBom: z.boolean(),
});

/** Storage names are relative content-addressed keys, so a manifest cannot escape its directory. */
const StorageKey = z.string().regex(/^[a-f\d-]{36}\/[a-f\d]{2}\/[a-f\d]{64}$/);

/** The fixture is additive to M1; its version and source LTS floor never follow CURRENT. */
export const StructureUpgradeManifest = z.object({
  format: z.literal('iridium-upgrade-fixture/1'),
  milestone: z.literal('M2'),
  version: z.literal('v0.2.0'),
  generated_at: z.iso.datetime(),
  dataset: z.literal('seed.structure'),
  mysql_line: z.literal('8.4'),
  mysql_version: z.string().startsWith('8.4.'),
  mysql_client: z.string(),
  dump: z.object({
    file: z.literal('dump.sql.gz'),
    compression: z.literal('gzip'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f\d]{64}$/),
    argv: z.array(z.string()),
    role: z.literal('iridium_backup'),
    restored_with_shipped_mysql: z.literal(true),
  }),
  grants: z.object({
    file: z.literal('db-grants.sql'),
    source: z.literal('docs/ops/db-grants.sql'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f\d]{64}$/),
    role: z.literal('root'),
    unmodified: z.literal(true),
    applied_before_current_migrations: z.literal(true),
  }),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  counts_provenance: z.literal('unmodified dump restored into an isolated same-line schema'),
  fingerprints: z.record(z.string(), z.string().regex(/^[a-f\d]{64}$/)),
  attachments: z.object({
    count: z.literal(1),
    bytes: z.number().int().positive(),
    files: z
      .array(
        z.object({
          storageKey: StorageKey,
          bytes: z.number().int().positive(),
          sha256: z.string().regex(/^[a-f\d]{64}$/),
        }),
      )
      .length(1),
  }),
  structure: z.object({
    pipeline_version: z.number().int().positive(),
    total_node_rows: z.literal(STRUCTURE_NODE_COUNT),
    listed_node_rows: z.number().int().positive(),
    vault_id: z.uuid(),
    root_node_id: z.uuid(),
    selected_paths: z.array(FixtureNode).min(3),
    notes: z.object({
      target: FixtureNote,
      sharedLibrary: FixtureNote,
      sharedArchive: FixtureNote,
      links: FixtureNote,
      crlf: FixtureNote,
      bom: FixtureNote,
    }),
    attachment: z.object({
      id: z.uuid(),
      sha256: z.string().regex(/^[a-f\d]{64}$/),
      pathHint: z.string(),
    }),
    administrator: z.object({
      id: z.uuid(),
      email: z.email(),
      displayName: z.string(),
      isServerAdmin: z.literal(true),
    }),
    users: z.array(z.object({ id: z.uuid(), email: z.email() })).length(6),
  }),
  fixture_keys: z.object({
    AUTH_PASSWORD_PEPPER: z.string().min(1),
    AUDIT_HMAC_KEY: z.string().min(1),
    MCP_CURSOR_KEY: z.string().min(1),
  }),
});

export type StructureUpgradeManifest = z.infer<typeof StructureUpgradeManifest>;
export type StructureFixtureContent = StructureUpgradeManifest['structure'];

export const STRUCTURE_UPGRADE_DIRECTORY = fileURLToPath(
  new URL('../fixtures/upgrade/v0.2.0/', import.meta.url),
);

/** SHA-256 of the exact bytes, shared by SQL-output, compressed-dump and attachment checks. */
export function fixtureHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** All table names originate in the authoritative grants inventory. */
export async function structureTableCounts(
  client: ShippedMysqlClient,
  tables: readonly string[] = GRANT_MATRIX.map(({ table }) => table),
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (!GRANT_MATRIX.some((row) => row.table === table))
      throw new Error(`The structure fixture names an unknown table: ${table}`);
    // eslint-disable-next-line no-await-in-loop -- the backup principal must read every bounded table independently
    const value = await client.query('backup', `SELECT COUNT(*) FROM \`${table}\``);
    counts[table] = Number(value.trim());
  }
  return counts;
}

const FINGERPRINT_QUERIES: Readonly<Record<string, string>> = {
  nodes:
    'SELECT HEX(id),HEX(vault_id),HEX(parent_id),kind,HEX(name),version,deleted_at FROM nodes ORDER BY id',
  notes:
    'SELECT HEX(node_id),original_eol,had_bom,size_chars,oversize,content_invalid FROM notes ORDER BY node_id',
  note_docs:
    'SELECT HEX(note_id),head_seq,snapshot_format,HEX(snapshot),HEX(snapshot_sv),snapshot_through_seq,projected_seq FROM note_docs ORDER BY note_id',
  note_updates:
    'SELECT HEX(note_id),seq,HEX(update_v1),HEX(sv_after),HEX(actor_id),HEX(session_id),origin FROM note_updates ORDER BY note_id,seq',
  note_projections:
    'SELECT HEX(note_id),revision,HEX(markdown),HEX(content_hash),HEX(frontmatter_raw),fm_tags,fm_aliases,status,pipeline_version FROM note_projections ORDER BY note_id',
  note_projection_terms:
    'SELECT HEX(note_id),HEX(vault_id),kind,HEX(term_hash) FROM note_projection_terms ORDER BY note_id,kind,term_hash',
  note_search:
    'SELECT HEX(note_id),HEX(vault_id),HEX(title),HEX(body_text),revision FROM note_search ORDER BY note_id',
  note_links:
    'SELECT id,HEX(from_note_id),ordinal,revision,kind,HEX(raw_target),HEX(resolved_node_id),HEX(resolved_attachment_id),status,start_offset,end_offset,line FROM note_links ORDER BY id',
  note_revisions:
    'SELECT id,HEX(note_id),seq,kind,label,HEX(markdown),HEX(content_hash),HEX(snapshot),restored_from_revision_id FROM note_revisions ORDER BY id',
  attachments:
    'SELECT HEX(id),HEX(vault_id),HEX(sha256),size_bytes,mime,HEX(path_hint),storage_key FROM attachments ORDER BY id',
  audit_events:
    'SELECT id,chain_id,HEX(prev_hash),HEX(hash),key_version FROM audit_events ORDER BY id',
  audit_chain_heads:
    'SELECT chain_id,last_id,HEX(last_hash) FROM audit_chain_heads ORDER BY chain_id',
};

/** Compare complete content rows without putting SQL or binary snapshots into a checked-in manifest. */
export async function structureFingerprints(
  client: ShippedMysqlClient,
  retainedAuditEventCount?: number,
): Promise<Record<string, string>> {
  if (
    retainedAuditEventCount !== undefined &&
    (!Number.isSafeInteger(retainedAuditEventCount) || retainedAuditEventCount < 0)
  ) {
    throw new Error('The retained audit prefix length must be a nonnegative safe integer.');
  }
  const hashes: Record<string, string> = {};
  for (const [name, statement] of Object.entries(FINGERPRINT_QUERIES)) {
    // Forward migrations append audited events and advance chain heads; every original event must
    // still be the same ordered prefix. The live CLI verifier checks the extended HMAC chain.
    if (retainedAuditEventCount !== undefined && name === 'audit_chain_heads') continue;
    const query =
      retainedAuditEventCount !== undefined && name === 'audit_events'
        ? `${statement} LIMIT ${String(retainedAuditEventCount)}`
        : statement;
    // eslint-disable-next-line no-await-in-loop -- bound the shipped client's captured SQL output to one table at a time
    hashes[name] = fixtureHash(await client.query('backup', query));
  }
  return hashes;
}

/** Public fixture fields, with the live client deliberately excluded from serialization. */
export function structureFixtureContent(seed: StructureSeed): StructureFixtureContent {
  const last = seed.nodes.at(-1);
  if (last === undefined) throw new Error('The populated structure fixture must have a last node.');
  return {
    pipeline_version: PIPELINE_VERSION,
    total_node_rows: STRUCTURE_NODE_COUNT,
    listed_node_rows: seed.nodes.length,
    vault_id: seed.vault.id,
    root_node_id: seed.vault.rootNodeId,
    selected_paths: [seed.categories.provenance, seed.notes.links, last].map(
      ({ id, parentId, name, path }) => ({ id, parentId, name, path }),
    ),
    notes: seed.notes,
    attachment: {
      id: seed.attachment.id,
      sha256: seed.attachment.sha256,
      pathHint: seed.attachment.pathHint,
    },
    administrator: {
      id: seed.admin.id,
      email: seed.admin.email,
      displayName: seed.admin.displayName,
      isServerAdmin: true,
    },
    users: [seed.admin, seed.editorA, seed.editorB, seed.editorC, seed.viewer, seed.outsider].map(
      ({ id, email }) => ({ id, email }),
    ),
  };
}

/** Resolve only validated content-addressed storage names within the requested attachment root. */
export function structureAttachmentPath(directory: string, storageKey: string): string {
  return resolve(directory, ...StorageKey.parse(storageKey).split('/'));
}

/** Regeneration is explicit, floor-only, and writes v0.2.0 without touching v0.1.0. */
export function writeStructureUpgradeFixture(input: {
  readonly dump: string;
  readonly grants: Uint8Array;
  readonly seed: StructureSeed;
  readonly counts: Readonly<Record<string, number>>;
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly mysqlVersion: string;
  readonly clientVersion: string;
  readonly attachment: { readonly storageKey: string; readonly bytes: Uint8Array };
}): void {
  if (process.env['IRIDIUM_FIXTURE_WRITE_UPGRADE'] !== '1') return;
  if (process.env['IRIDIUM_TEST_TARGET_MILESTONE'] !== 'M2') return;
  if (!input.mysqlVersion.startsWith('8.4.'))
    throw new Error('The v0.2.0 fixture must originate on MySQL 8.4.');
  const directory = STRUCTURE_UPGRADE_DIRECTORY;
  mkdirSync(directory, { recursive: true });
  const compressed = gzipSync(Buffer.from(input.dump, 'utf8'), { level: 9 });
  const attachmentPath = structureAttachmentPath(
    join(directory, 'attachments'),
    input.attachment.storageKey,
  );
  mkdirSync(dirname(attachmentPath), { recursive: true });
  writeFileSync(attachmentPath, input.attachment.bytes);
  writeFileSync(join(directory, 'dump.sql.gz'), compressed);
  writeFileSync(join(directory, 'db-grants.sql'), input.grants);
  const manifest = StructureUpgradeManifest.parse({
    format: 'iridium-upgrade-fixture/1',
    milestone: 'M2',
    version: 'v0.2.0',
    generated_at: new Date().toISOString(),
    dataset: 'seed.structure',
    mysql_line: '8.4',
    mysql_version: input.mysqlVersion,
    mysql_client: input.clientVersion,
    dump: {
      file: 'dump.sql.gz',
      compression: 'gzip',
      bytes: compressed.byteLength,
      sha256: fixtureHash(compressed),
      argv: MYSQLDUMP_ARGV,
      role: 'iridium_backup',
      restored_with_shipped_mysql: true,
    },
    grants: {
      file: 'db-grants.sql',
      source: 'docs/ops/db-grants.sql',
      bytes: input.grants.byteLength,
      sha256: fixtureHash(input.grants),
      role: 'root',
      unmodified: true,
      applied_before_current_migrations: true,
    },
    counts: input.counts,
    counts_provenance: 'unmodified dump restored into an isolated same-line schema',
    fingerprints: input.fingerprints,
    attachments: {
      count: 1,
      bytes: input.attachment.bytes.byteLength,
      files: [
        {
          storageKey: input.attachment.storageKey,
          bytes: input.attachment.bytes.byteLength,
          sha256: fixtureHash(input.attachment.bytes),
        },
      ],
    },
    structure: structureFixtureContent(input.seed),
    fixture_keys: TEST_SECRETS,
  });
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Verify every persisted byte before attempting a restore with the shipped MySQL client. */
export function readStructureUpgradeFixture(): {
  readonly manifest: StructureUpgradeManifest;
  readonly dump: string;
  readonly grants: string;
} {
  const manifest = StructureUpgradeManifest.parse(
    JSON.parse(readFileSync(join(STRUCTURE_UPGRADE_DIRECTORY, 'manifest.json'), 'utf8')),
  );
  const compressed = readFileSync(join(STRUCTURE_UPGRADE_DIRECTORY, manifest.dump.file));
  if (
    compressed.byteLength !== manifest.dump.bytes ||
    fixtureHash(compressed) !== manifest.dump.sha256
  ) {
    throw new Error('The M2 upgrade dump does not match its manifest.');
  }
  const grants = readFileSync(join(STRUCTURE_UPGRADE_DIRECTORY, manifest.grants.file));
  if (grants.byteLength !== manifest.grants.bytes || fixtureHash(grants) !== manifest.grants.sha256)
    throw new Error('The M2 DBA grant artifact does not match its manifest.');
  for (const file of manifest.attachments.files) {
    const bytes = readFileSync(
      structureAttachmentPath(join(STRUCTURE_UPGRADE_DIRECTORY, 'attachments'), file.storageKey),
    );
    if (bytes.byteLength !== file.bytes || fixtureHash(bytes) !== file.sha256)
      throw new Error('The M2 fixture attachment does not match its manifest.');
  }
  return {
    manifest,
    dump: gunzipSync(compressed).toString('utf8'),
    grants: grants.toString('utf8'),
  };
}
