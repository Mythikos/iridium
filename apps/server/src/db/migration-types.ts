/**
 * The type every migration's `up`/`down` takes.
 *
 * A migration runs against a schema that is mid-change, so it is deliberately untyped: `Database` in
 * `schema.ts` describes the schema *after* the whole set has been applied, and typing a migration
 * against it would make `0001_users` claim that `note_links` already exists. Every statement in
 * `apps/server/migrations/**` is therefore a raw `sql` template or an `information_schema` probe
 * built with the `sql` tag, which is checkable on its own.
 */
import type { Kysely } from 'kysely';

/** A Kysely instance with no table types: what a migration receives. */
export type MigrationDb = Kysely<Record<string, never>>;
