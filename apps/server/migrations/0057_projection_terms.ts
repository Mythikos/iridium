/** One replay-safe DDL statement for bounded normalized tag and alias lookup. */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS note_projection_terms (
    note_id BINARY(16) NOT NULL,
    vault_id BINARY(16) NOT NULL,
    kind ENUM('tag','alias') NOT NULL,
    term_hash BINARY(32) NOT NULL,
    PRIMARY KEY (note_id,kind,term_hash),
    KEY ix_projection_terms_lookup (vault_id,kind,term_hash,note_id),
    CONSTRAINT fk_projection_term_projection FOREIGN KEY (note_id) REFERENCES note_projections(note_id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS note_projection_terms`.execute(db);
}
