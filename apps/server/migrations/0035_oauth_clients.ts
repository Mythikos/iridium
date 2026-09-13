/**
 * 0035_oauth_clients
 *
 * `oauth_clients` (03-data-model.md section 4A): the connectors the authorization server knows.
 *
 * `client_id` is a `VARCHAR(512)` because a CIMD client id is an https URL; the unique key uses a
 * 191-character prefix, which is what keeps the index key inside InnoDB's limit while still making a
 * duplicate registration impossible in practice.
 *
 * `ix_oauth_clients_unused (last_authorized_at, created_at)` exists for exactly one query: the sweep
 * that removes dynamically registered clients that never reached a consent screen.
 */
import { sql } from 'kysely';

import type { MigrationDb } from '../src/db/migration-types.ts';

export async function up(db: MigrationDb): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      id                         BINARY(16)   NOT NULL PRIMARY KEY,
      client_id                  VARCHAR(512) NOT NULL,
      registration_kind          ENUM('cimd','dynamic','manual') NOT NULL,
      client_name                VARCHAR(120) NOT NULL,
      client_uri                 VARCHAR(512) NULL,
      logo_uri                   VARCHAR(512) NULL,
      application_type           ENUM('native','web') NOT NULL,
      token_endpoint_auth_method ENUM('none','client_secret_basic') NOT NULL DEFAULT 'none',
      client_secret_hash         BINARY(32)   NULL,
      client_secret_prefix       CHAR(26)     NULL,
      redirect_uris              JSON         NOT NULL,
      grant_types                JSON         NOT NULL,
      scopes                     JSON         NULL,
      cimd_document              JSON         NULL,
      cimd_fetched_at            DATETIME(6)  NULL,
      cimd_etag                  VARCHAR(120) NULL,
      status                     ENUM('active','disabled') NOT NULL DEFAULT 'active',
      created_at                 DATETIME(6)  NOT NULL,
      created_by_user_id         BINARY(16)   NULL,
      last_authorized_at         DATETIME(6)  NULL,
      disabled_at                DATETIME(6)  NULL,
      disabled_by                BINARY(16)   NULL,
      version                    INT UNSIGNED NOT NULL DEFAULT 1,
      UNIQUE KEY uq_oauth_clients_client_id (client_id(191)),
      KEY ix_oauth_clients_status (status, created_at),
      KEY ix_oauth_clients_unused (last_authorized_at, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  `.execute(db);
}

export async function down(db: MigrationDb): Promise<void> {
  await sql`DROP TABLE IF EXISTS oauth_clients`.execute(db);
}
