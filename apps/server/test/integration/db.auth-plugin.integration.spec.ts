/** Real MySQL 8.4/9.7 role authentication and the shipped entrypoint's fail-closed assertion. */
import { probeRejectedMysqlRolePlugin, TEST_DB_PASSWORDS } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { selectedMysqlImage, startIridiumMysql } from '../db-mysql-container.ts';

describe('db.auth-plugin.integration [area:db] [area:ops]', () => {
  it('creates all three roles with caching_sha2_password and authenticates each through TCP', async () => {
    const mysql = await startIridiumMysql();
    try {
      const plugins = await mysql.container.exec(
        [
          'mysql',
          '-uroot',
          '--batch',
          '--skip-column-names',
          '--execute',
          "SELECT user, host, plugin FROM mysql.user WHERE user IN ('iridium_app','iridium_migrator','iridium_backup') ORDER BY user, host",
        ],
        { env: { MYSQL_PWD: TEST_DB_PASSWORDS.root } },
      );
      expect(plugins.exitCode, plugins.stderr).toBe(0);
      expect(plugins.stdout.trim().split('\n')).toEqual([
        'iridium_app\t%\tcaching_sha2_password',
        'iridium_backup\t%\tcaching_sha2_password',
        'iridium_migrator\t%\tcaching_sha2_password',
      ]);
      for (const role of ['app', 'migrator', 'backup'] as const) {
        // eslint-disable-next-line no-await-in-loop -- diagnose each real role independently
        const result = await mysql.container.exec(
          [
            'mysql',
            '--protocol=TCP',
            '-h127.0.0.1',
            `-uiridium_${role}`,
            '--batch',
            '--skip-column-names',
            '--execute',
            'SELECT CURRENT_USER()',
          ],
          { env: { MYSQL_PWD: TEST_DB_PASSWORDS[role] } },
        );
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout.trim()).toBe(`iridium_${role}@%`);
      }
    } finally {
      await mysql.stop();
    }
  }, 120_000);

  it('aborts a fresh entrypoint initialization when an existing Iridium account has another plugin', async () => {
    const result = await probeRejectedMysqlRolePlugin(selectedMysqlImage());
    expect(result.refused, result.log).toBe(true);
    expect(result.log).toContain(
      '1 of the three Iridium roles are not using caching_sha2_password',
    );
    expect(result.log).not.toContain('iridium_app, iridium_migrator and iridium_backup are ready');
  }, 90_000);
});
