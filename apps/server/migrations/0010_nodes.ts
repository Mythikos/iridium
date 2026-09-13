/**
 * 0010_nodes
 *
 * `nodes` (03-data-model.md section 6.1), with the `live` virtual generated column and the
 * self-referencing `fk_nodes_parent`.
 *
 * The table must exist before the unique key over its generated column, which is why `uq_sibling` is
 * `0011` and not part of this statement. `name` is `VARCHAR(255)` because `LIMITS.NODE_NAME_MAX_BYTES`
 * is 255, and it collates `utf8mb4_0900_as_ci` so sibling uniqueness means what Windows, macOS and
 * Obsidian mean by it: `Readme` and `readme` collide, `resume` and `resume` with an accent do not.
 *
 * Every vault's root row satisfies `fk_nodes_parent` with `parent_id = id`, which InnoDB's immediate
 * foreign-key check accepts inside the inserting statement.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS nodes (
      id          BINARY(16)   NOT NULL PRIMARY KEY,
      vault_id    BINARY(16)   NOT NULL,
      parent_id   BINARY(16)   NOT NULL,
      kind        ENUM('category','note') NOT NULL,
      name        VARCHAR(255) COLLATE utf8mb4_0900_as_ci NOT NULL,
      deleted_at  DATETIME(6)  NULL,
      live        TINYINT GENERATED ALWAYS AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL,
      version     INT UNSIGNED NOT NULL DEFAULT 1,
      created_by  BINARY(16)   NOT NULL,
      updated_by  BINARY(16)   NOT NULL,
      created_at  DATETIME(6)  NOT NULL,
      updated_at  DATETIME(6)  NOT NULL,
      KEY ix_nodes_vault_parent (vault_id, parent_id, kind),
      KEY ix_nodes_vault_deleted (vault_id, deleted_at),
      KEY ix_nodes_vault_name (vault_id, name),
      CONSTRAINT fk_nodes_vault FOREIGN KEY (vault_id) REFERENCES vaults(id),
      CONSTRAINT fk_nodes_parent FOREIGN KEY (parent_id) REFERENCES nodes(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS nodes`.execute(db);
}
