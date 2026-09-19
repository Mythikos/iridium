/** Negative entrypoint probe: source the actual shipped bootstrap after stale role metadata. */
import { MySqlContainer } from '@testcontainers/mysql';

import { MYSQL_CONF_FILE, MYSQL_INIT_ROLES_FILE } from '../paths.ts';
import { TEST_DB_PASSWORDS } from '../server/env.ts';
import {
  MOUNTED_FILE_MODE,
  MYSQL_CONF_TARGET,
  MYSQL_FIXTURE_COMMAND,
  MYSQL_INIT_TARGET,
  resolveMysqlImage,
  ROLE_SECRET_FILES,
} from './mysql.ts';

export interface MysqlRolePluginProbe {
  readonly refused: boolean;
  readonly log: string;
}

/** The only changed input is a pre-existing backup role with an unavailable authentication plugin. */
export async function probeRejectedMysqlRolePlugin(image?: string): Promise<MysqlRolePluginProbe> {
  const lines: string[] = [];
  const staleRole = [
    "CREATE USER 'iridium_backup'@'%' IDENTIFIED WITH caching_sha2_password BY 'stale-role-not-a-secret';",
    "UPDATE mysql.user SET plugin = 'iridium_invalid_auth_plugin' WHERE user = 'iridium_backup' AND host = '%';",
    'FLUSH PRIVILEGES;',
  ].join('\n');
  const broken = new MySqlContainer(resolveMysqlImage(image))
    .withDatabase('iridium')
    .withRootPassword(TEST_DB_PASSWORDS.root)
    .withTmpFs({ '/var/lib/mysql': 'rw' })
    .withCommand([...MYSQL_FIXTURE_COMMAND])
    .withCopyFilesToContainer([
      { source: MYSQL_CONF_FILE, target: MYSQL_CONF_TARGET, mode: MOUNTED_FILE_MODE },
      { source: MYSQL_INIT_ROLES_FILE, target: MYSQL_INIT_TARGET, mode: MOUNTED_FILE_MODE },
    ])
    .withCopyContentToContainer([
      {
        content: staleRole,
        target: '/docker-entrypoint-initdb.d/00_stale_role.sql',
        mode: MOUNTED_FILE_MODE,
      },
      ...(['app', 'migrator', 'backup'] as const).map((role) => ({
        content: TEST_DB_PASSWORDS[role],
        target: ROLE_SECRET_FILES[role],
        mode: MOUNTED_FILE_MODE,
      })),
    ])
    .withEnvironment({
      IRIDIUM_DB_APP_PASSWORD_FILE: ROLE_SECRET_FILES.app,
      IRIDIUM_DB_MIGRATOR_PASSWORD_FILE: ROLE_SECRET_FILES.migrator,
      IRIDIUM_DB_BACKUP_PASSWORD_FILE: ROLE_SECRET_FILES.backup,
    })
    .withLogConsumer((stream) => {
      stream.on('data', (chunk: Buffer) => {
        lines.push(chunk.toString('utf8'));
      });
      stream.on('err', (chunk: Buffer) => {
        lines.push(chunk.toString('utf8'));
      });
    })
    .withStartupTimeout(45_000);
  const refused = await broken.start().then(
    async (started) => {
      await started.stop();
      return false;
    },
    () => true,
  );
  return { refused, log: lines.join('') };
}
