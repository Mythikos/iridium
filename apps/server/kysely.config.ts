/**
 * `kysely-ctl` 0.21.0 configuration (03-data-model.md §14, decision A7).
 *
 * It sits in `apps/server` because that is the workspace that declares `kysely-ctl`, owns
 * `apps/server/migrations/` and ships `iridium migrate` — so `pnpm --filter @iridium/server exec
 * kysely migrate:latest` finds it without a `--config` flag, and nothing at the repository root has to
 * know that migrations exist.
 *
 * **The provider is the bundled import map, never a filesystem scan.** `apps/server/src/db/migrations.ts`
 * exports `bundledMigrationProvider` over a static import of every migration, and its header states
 * why: `/readyz` compares `kysely_migration` with the list the *binary* carries, so a server whose
 * schema is older than its code never serves traffic. If `kysely-ctl` scanned the directory instead,
 * the command line and the running server could disagree about what "all migrations" means — the
 * CLI would apply a file the image does not carry, and readiness would then pass against a schema the
 * code has never seen. One list, three consumers: `dist/main.mjs`, the in-process test harness, and
 * this file.
 *
 * **Credentials come from `DATABASE_MIGRATE_URL`, the `iridium_migrator` role** (03-data-model.md
 * §14.3). The application's own `DATABASE_URL` (`iridium_app`) cannot execute DDL at all, so pointing
 * this file at it would fail at the first `CREATE TABLE` rather than silently migrate as the wrong
 * principal. The variable is read here and nowhere else in the file, and the error below names it.
 *
 * **`iridium migrate` remains the supported command.** This configuration exists so the `kysely`
 * command line is usable for development and for the one thing the wrapper deliberately does not do —
 * `migrate:down`, `migrate:rollback` and the scaffolding commands. The product path
 * (`apps/server/src/db/migrator.ts`) additionally wraps every run in
 * `SELECT GET_LOCK('iridium_migrate', 60)` and refuses `down` in production; a bare `kysely` invocation
 * has neither, which is why operators are pointed at `iridium migrate status|up|to`.
 */
import { defineConfig } from 'kysely-ctl';
import { createPool } from 'mysql2';

import { bundledMigrationProvider } from './src/db/migrations.ts';
import { parseDatabaseUrl, poolOptions } from './src/db/pool.ts';

/** The role that may execute DDL. */
const MIGRATE_URL_KEY = 'DATABASE_MIGRATE_URL';

function migrateUrl(): string {
  // eslint-disable-next-line node/no-process-env -- a command-line configuration file is one of the
  // two places 02-system-architecture.md allows a direct environment read; the server itself parses
  // its configuration exactly once, in `config/env.ts`.
  const url = process.env[MIGRATE_URL_KEY];
  if (url === undefined || url === '') {
    throw new Error(
      `${MIGRATE_URL_KEY} is not set. kysely-ctl migrates as the \`iridium_migrator\` role ` +
        '(03-data-model.md §14.3); `DATABASE_URL` is the application role and cannot execute DDL. ' +
        'Example: DATABASE_MIGRATE_URL=mysql://iridium_migrator:<password>@127.0.0.1:3306/iridium',
    );
  }
  return url;
}

export default defineConfig({
  dialect: 'mysql2',
  dialectConfig: () => {
    const target = parseDatabaseUrl(migrateUrl());
    // Pool size 1: a migration run is serial by construction, and the advisory lock the product
    // wrapper holds lives on a connection of its own. `poolOptions` is the product's own option set —
    // `supportBigNumbers`, the `TINYINT(1)` typeCast and the rest — so the CLI connects exactly as the
    // server does rather than on mysql2's defaults.
    return { pool: createPool(poolOptions(target, 1)) };
  },
  migrations: {
    // The same list `dist/main.mjs`, the test harness and `/readyz` read. See the header.
    provider: bundledMigrationProvider,
  },
  // Every command exits after one run; leaving the pool open would hang the process on Windows.
  destroyOnExit: true,
});
