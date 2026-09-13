/**
 * 0017_note_projections
 *
 * `note_projections` (03-data-model.md section 9.1) **without** the two multi-valued indexes, which
 * are `0018`.
 *
 * A table create and a functional index have different rollback stories, which is why they are two
 * files. This is the single byte-source for REST `/markdown`, MCP `get_note`, export entries, snippet
 * location and the diff view: no read path ever decodes Yjs.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS note_projections (
      note_id           BINARY(16)      NOT NULL PRIMARY KEY,
      revision          BIGINT UNSIGNED NOT NULL,
      markdown          MEDIUMTEXT      NOT NULL,
      content_hash      BINARY(32)      NOT NULL,
      heading_title     VARCHAR(255)    NULL,
      frontmatter_raw   TEXT            NULL,
      frontmatter       JSON            NULL,
      frontmatter_error VARCHAR(500)    NULL,
      fm_tags           JSON            NULL,
      fm_aliases        JSON            NULL,
      headings          JSON            NULL,
      tasks             JSON            NULL,
      code_langs        JSON            NULL,
      obsidian_findings JSON            NULL,
      word_count        INT UNSIGNED    NULL,
      line_count        INT UNSIGNED    NULL,
      status            ENUM('ok','pending','too_large','too_complex','timeout','error','invalid_content') NOT NULL,
      pipeline_version  SMALLINT UNSIGNED NOT NULL,
      projected_at      DATETIME(6)     NOT NULL,
      KEY ix_proj_pipeline (pipeline_version),
      CONSTRAINT fk_proj_note FOREIGN KEY (note_id) REFERENCES notes(node_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_projections`.execute(db);
}
