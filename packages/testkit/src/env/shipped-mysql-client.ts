import { GenericContainer, Wait, type ExecResult } from 'testcontainers';

/** Execute the clients copied into the production image, never host-installed replacements. */
import { TEST_DB_PASSWORDS, type DatabasePasswords } from '../server/env.ts';

export type DatabaseRole = 'app' | 'migrator' | 'backup' | 'root';
export interface ShippedMysqlClient {
  version(tool: 'mysql' | 'mysqldump' | 'mysqlbinlog'): Promise<string>;
  streamBinaryLog(name: string): Promise<string>;
  execute(role: DatabaseRole, statement: string, schema?: string): Promise<ExecResult>;
  query(role: DatabaseRole, statement: string, schema?: string): Promise<string>;
  dump(argv: readonly string[]): Promise<string>;
  restore(dump: string): Promise<void>;
  stop(): Promise<void>;
}

/** The client shares only the task-owned database's network namespace and writes solely in /tmp. */
export interface ShippedMysqlClientOptions {
  readonly mysqlContainerId: string;
  readonly image?: string;
  readonly passwords?: DatabasePasswords;
}

const connection = (role: DatabaseRole): string[] => [
  '--protocol=TCP',
  '--host=127.0.0.1',
  '--port=3306',
  `--user=${role === 'root' ? 'root' : `iridium_${role}`}`,
];
const checked = (result: ExecResult, operation: string): string => {
  if (result.exitCode !== 0)
    throw new Error(
      `${operation} failed (${String(result.exitCode)}): ${result.stderr || result.stdout}`,
    );
  return result.stdout;
};

export async function startShippedMysqlClient(
  options: ShippedMysqlClientOptions,
): Promise<ShippedMysqlClient> {
  const passwords = options.passwords ?? TEST_DB_PASSWORDS;
  const container = await new GenericContainer(options.image ?? 'iridium-server:ci')
    .withNetworkMode(`container:${options.mysqlContainerId}`)
    .withEntrypoint(['node'])
    .withCommand(['-e', 'console.log("iridium-client-ready");setInterval(() => {}, 2147483647)'])
    .withWaitStrategy(Wait.forLogMessage(/^iridium-client-ready$/m))
    .withStartupTimeout(30_000)
    .start();
  const execute = (
    role: DatabaseRole,
    statement: string,
    schema = 'iridium',
  ): Promise<ExecResult> =>
    container.exec(
      [
        'mysql',
        ...connection(role),
        '--batch',
        '--raw',
        '--skip-column-names',
        '--max-allowed-packet=1G',
        `--database=${schema}`,
        '--execute',
        statement,
      ],
      { env: { MYSQL_PWD: passwords[role] } },
    );
  return {
    async version(tool) {
      return checked(await container.exec([tool, '--version']), `${tool} version`).trim();
    },
    async streamBinaryLog(name) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('unexpected MySQL binlog filename');
      checked(
        await container.exec(
          [
            'mysqlbinlog',
            ...connection('backup'),
            '--read-from-remote-server',
            '--raw',
            '--result-file=/tmp/',
            name,
          ],
          { env: { MYSQL_PWD: passwords.backup } },
        ),
        'backup binlog streaming',
      );
      return checked(
        await container.exec([
          'node',
          '-e',
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1]).subarray(0,4).toString("hex"))',
          `/tmp/${name}`,
        ]),
        'read streamed binlog magic',
      );
    },
    execute,
    async query(role, statement, schema) {
      return checked(await execute(role, statement, schema), `mysql ${role}: ${statement}`);
    },
    async dump(argv) {
      return checked(
        await container.exec(['mysqldump', ...connection('backup'), ...argv], {
          env: { MYSQL_PWD: passwords.backup },
        }),
        'the canonical backup-role mysqldump',
      );
    },
    async restore(dump) {
      await container.copyContentToContainer([
        { content: dump, target: '/tmp/iridium-restore.sql', mode: 0o444 },
      ]);
      // The official batch restore path passes the file unchanged to stdin, including CREATE
      // DATABASE / USE iridium. All shell text is constant; passwords remain in the exec environment.
      checked(
        await container.exec(
          [
            'sh',
            '-c',
            'exec mysql --protocol=TCP --host=127.0.0.1 --port=3306 --user=iridium_migrator --max-allowed-packet=1G < /tmp/iridium-restore.sql',
          ],
          { env: { MYSQL_PWD: passwords.migrator } },
        ),
        'shipped mysql restore',
      );
    },
    async stop() {
      await container.stop();
    },
  };
}
