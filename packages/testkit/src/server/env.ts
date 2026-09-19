/**
 * The environment the harness hands the product binary — one definition for `iridium migrate up`
 * (the template and per-worker schema path) and for `startServer({ mode: 'child' })`, because the two
 * must not drift: a migration that ran under different configuration from the server that serves it is
 * the failure mode the one-boot-path principle exists to prevent.
 *
 * Names are the `EnvSchema` ones owned by 11-operations-and-deployment.md, "Configuration reference".
 * Nothing here invents a key: `IRIDIUM_MYSQL_IMAGE` and the `IRIDIUM_TEST_*` / `IRIDIUM_PROP_*` /
 * `IRIDIUM_CHAOS_*` prefixes are the reserved harness namespaces of 02-system-architecture.md ARCH-25,
 * which `EnvSchema` lists as known-and-ignored precisely so the `child` mode can inherit a CI job's
 * whole environment without the unknown-key rule killing the process.
 */

/**
 * The fixed, obviously fake test secrets of the fixture policy (10-testing-and-quality.md, rule 9).
 * `config.rejects-test-secrets.unit` asserts `EnvSchema` refuses any value matching `/not-a-secret/`
 * when `NODE_ENV=production`, so these cannot leak into a real deployment by copy-paste.
 */
export const TEST_SECRETS: Readonly<Record<string, string>> = {
  AUTH_PASSWORD_PEPPER: 'test-pepper-not-a-secret',
  AUDIT_HMAC_KEY: 'test-audit-not-a-secret',
  MCP_CURSOR_KEY: 'test-cursor-not-a-secret',
};

/** Passwords supplied by a fixture, including random material for production-mode tests. */
export interface DatabasePasswords {
  readonly root: string;
  readonly app: string;
  readonly migrator: string;
  readonly backup: string;
}

/** MySQL role passwords for the container. Fake by construction, for the same reason. */
export const TEST_DB_PASSWORDS = {
  root: 'test-root-not-a-secret',
  app: 'test-app-not-a-secret',
  migrator: 'test-migrator-not-a-secret',
  backup: 'test-backup-not-a-secret',
} as const;

/** The application schema every Testcontainers fixture uses inside the container. */
export const DEFAULT_DATABASE_NAME = 'iridium';

/** The migrated schema per-worker schemas are cloned from (10-testing-and-quality.md, `startTestEnv`). */
export const TEMPLATE_SCHEMA = 'iridium_tpl';

/** `iridium_w<N>` — one schema per Vitest worker, 1-based in Vitest 5. */
export function workerSchemaName(workerId: string | number): string {
  return `iridium_w${String(workerId)}`;
}

export interface ServerEnvOptions {
  /** `mysql://host:port` coordinates of the running container. */
  readonly host: string;
  readonly port: number;
  /** The schema this process reads and writes. */
  readonly schema: string;
  readonly passwords?: DatabasePasswords;
  /** `http://127.0.0.1:<port>`; also the `/collab` Origin allowlist entry. */
  readonly publicOrigin: string;
  /** `IRIDIUM_FAULT`, already rendered by `formatFaultEnv`. Omitted when empty. */
  readonly faults?: string;
  /** Hocuspocus `debounce` / `maxDebounce` and the ticket TTL, per suite. */
  readonly collab?: {
    readonly debounceMs?: number;
    readonly maxDebounceMs?: number;
    readonly ticketTtlS?: number;
  };
  /** Per-test attachment directory, under the OS temp dir (fixture policy rule 10). */
  readonly attachmentsDir?: string;
  /** Anything else the suite needs; merged last, so a test can override a default deliberately. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** `mysql://<role>:<password>@<host>:<port>/<schema>`. */
export function databaseUrl(
  role: 'app' | 'migrator' | 'backup',
  o: { host: string; port: number; schema: string; passwords?: DatabasePasswords },
): string {
  const user = `iridium_${role}`;
  const password = (o.passwords ?? TEST_DB_PASSWORDS)[role];
  return `mysql://${user}:${encodeURIComponent(password)}@${o.host}:${String(o.port)}/${o.schema}`;
}

/**
 * The full environment for a product process. `NODE_ENV=test` is what arms the `IRIDIUM_FAULT`
 * registry and the `/__test__` namespace, and it is the reason `child` mode exists at all: the chaos
 * project needs a process it can `SIGKILL` mid-transaction (10-testing-and-quality.md, mode table).
 */
export function buildServerEnv(o: ServerEnvOptions): Record<string, string> {
  const passwords = o.passwords ?? TEST_DB_PASSWORDS;
  const coordinates = { host: o.host, port: o.port, schema: o.schema, passwords };
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    BIND_ADDRESS: '127.0.0.1',
    PORT: '0',
    PUBLIC_ORIGIN: o.publicOrigin,
    LOG_LEVEL: 'warn',
    LOG_FORMAT: 'json',
    DATABASE_URL: databaseUrl('app', coordinates),
    DATABASE_PASSWORD: passwords.app,
    DATABASE_MIGRATE_URL: databaseUrl('migrator', coordinates),
    DATABASE_MIGRATE_PASSWORD: passwords.migrator,
    DATABASE_BACKUP_URL: databaseUrl('backup', coordinates),
    DATABASE_BACKUP_PASSWORD: passwords.backup,
    ...TEST_SECRETS,
  };

  if (o.faults !== undefined && o.faults !== '') {
    env['IRIDIUM_FAULT'] = o.faults;
  }
  if (o.attachmentsDir !== undefined) {
    env['ATTACHMENTS_DIR'] = o.attachmentsDir;
  }
  if (o.collab?.debounceMs !== undefined) {
    env['COLLAB_DEBOUNCE_MS'] = String(o.collab.debounceMs);
  }
  if (o.collab?.maxDebounceMs !== undefined) {
    env['COLLAB_MAX_DEBOUNCE_MS'] = String(o.collab.maxDebounceMs);
  }
  if (o.collab?.ticketTtlS !== undefined) {
    env['COLLAB_TICKET_TTL_S'] = String(o.collab.ticketTtlS);
  }
  return { ...env, ...o.extraEnv };
}
