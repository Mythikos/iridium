/** Real Kysely compiles test probes; only the database and container I/O boundary is substituted. */
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import {
  corruptCallbackDeliberately,
  corruptDeliberately,
  corruptMysqlDeliberately,
  corruptShippedMysqlDeliberately,
  probeShippedMysqlWrite,
} from './db/corrupt.ts';
import { inspectAdvisoryLock, inspectConnectionIdentity } from './db/inspect.ts';
import type { ShippedMysqlClient } from './env/shipped-mysql-client.ts';

function fixture(failure?: Error): {
  readonly database: Kysely<Record<string, never>>;
  readonly queries: CompiledQuery[];
  readonly lifecycle: string[];
} {
  const queries: CompiledQuery[] = [];
  const lifecycle: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<Result>(query: CompiledQuery): Promise<QueryResult<Result>> {
      queries.push(query);
      if (failure !== undefined) throw failure;
      return { rows: [], numAffectedRows: 1n };
    },
    streamQuery(): never {
      throw new Error('This fixture does not stream.');
    },
  };
  class ProbeDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      lifecycle.push('acquire');
      return connection;
    }
    override async releaseConnection(): Promise<void> {
      lifecycle.push('release');
    }
    override async beginTransaction(): Promise<void> {
      lifecycle.push('begin');
    }
    override async commitTransaction(): Promise<void> {
      lifecycle.push('commit');
    }
    override async rollbackTransaction(): Promise<void> {
      lifecycle.push('rollback');
    }
  }
  const database = new Kysely<Record<string, never>>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new ProbeDriver(),
      createIntrospector: (client) => new MysqlIntrospector(client),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  return { database, queries, lifecycle };
}

describe('testkit.db-probes.unit [area:testing]', () => {
  it('preserves callback transport arguments, return identity and synchronous errors', () => {
    const result = { command: true };
    const statements: string[] = [];
    const operations: string[] = [];
    expect(
      corruptCallbackDeliberately(
        (statement) => {
          statements.push(statement);
          return result;
        },
        'deadline-note-update',
        (kind) => operations.push(kind),
      ),
    ).toBe(result);
    const failure = new Error('native callback driver error');
    expect(() =>
      corruptCallbackDeliberately(
        (statement) => {
          statements.push(statement);
          throw failure;
        },
        'duplicate-user-insert',
        (kind) => operations.push(kind),
      ),
    ).toThrow(failure);
    expect(statements).toEqual(['UPDATE notes SET body=?', 'INSERT INTO users VALUES (?)']);
    expect(operations).toEqual(['deadline-note-update', 'duplicate-user-insert']);
  });

  it('retains the caller transaction, affected-row result, parameter binding and operation-only log', async () => {
    const context = fixture();
    const operations: string[] = [];
    try {
      await context.database.transaction().execute(async (transaction) => {
        expect(
          await corruptDeliberately(transaction, { kind: 'transport-insert', value: 7 }, (kind) =>
            operations.push(kind),
          ),
        ).toEqual({ rows: [], numAffectedRows: 1n });
        await corruptDeliberately(transaction, { kind: 'contend-install-row' }, (kind) =>
          operations.push(kind),
        );
        await inspectConnectionIdentity(transaction);
      });
      expect(context.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
      expect(context.queries[0]?.sql).toBe('INSERT INTO note_updates VALUES (?)');
      expect(context.queries[0]?.parameters).toEqual([7]);
      expect(context.queries[1]?.sql).toContain("WHERE `key` = 'iridium_version'");
      expect(context.queries[2]?.sql).toBe('SELECT CONNECTION_ID() AS id');
      expect(operations).toEqual(['transport-insert', 'contend-install-row']);
    } finally {
      await context.database.destroy();
    }
  });

  it('preserves a native failure and leaves rollback/retry decisions with the caller', async () => {
    const failure = new Error('native 1205 fixture');
    const context = fixture(failure);
    try {
      await expect(
        context.database
          .transaction()
          .execute((transaction) =>
            corruptDeliberately(transaction, { kind: 'contend-install-row' }),
          ),
      ).rejects.toBe(failure);
      expect(context.queries).toHaveLength(1);
      expect(context.lifecycle).toEqual(['acquire', 'begin', 'rollback', 'release']);
    } finally {
      await context.database.destroy();
    }
  });

  it('binds a password as data, does not log it, and refuses unsafe identifiers before I/O', async () => {
    const context = fixture();
    const operations: string[] = [];
    const password = "fixture'; DROP DATABASE unexpected; --";
    try {
      await corruptDeliberately(
        context.database,
        { kind: 'create-account', account: 'iridium_app', password },
        (kind) => operations.push(kind),
      );
      expect(context.queries[0]?.sql).toBe(
        "CREATE USER ?@'%' IDENTIFIED WITH caching_sha2_password BY ?",
      );
      expect(context.queries[0]?.parameters).toEqual(['iridium_app', password]);
      expect(operations).toEqual(['create-account']);
      await expect(
        corruptDeliberately(context.database, {
          kind: 'create-schema',
          schema: 'probe; DROP DATABASE iridium',
        }),
      ).rejects.toThrow('identifier');
      expect(context.queries).toHaveLength(1);
    } finally {
      await context.database.destroy();
    }
  });

  it('validates the complete DBA script before issuing any statement and keeps product grant order', async () => {
    const context = fixture();
    const statements = [
      "GRANT SELECT, INSERT ON `iridium_w1`.`audit_events` TO 'iridium_app'@'%'",
      "GRANT SELECT, UPDATE (`result`, `delivered_at`) ON `iridium_w1`.`session_revocation_commands` TO 'iridium_app'@'%'",
    ];
    try {
      await expect(
        corruptDeliberately(context.database, {
          kind: 'apply-dba-grants',
          statements: [...statements, 'DROP TABLE users'],
        }),
      ).rejects.toThrow('product-generated');
      expect(context.queries).toEqual([]);
      await corruptDeliberately(context.database, { kind: 'apply-dba-grants', statements });
      expect(context.queries.map((query) => query.sql)).toEqual(statements);
      await expect(
        corruptDeliberately(context.database, {
          kind: 'grant-schema',
          schema: 'probe',
          account: 'iridium_app',
          privileges: ['SELECT; DROP TABLE users'],
        }),
      ).rejects.toThrow('privilege');
      expect(context.queries).toHaveLength(2);
    } finally {
      await context.database.destroy();
    }
  });

  it('binds advisory-lock names while observing through the original executor', async () => {
    const context = fixture();
    const name = "name'); DROP TABLE users; --";
    try {
      await inspectAdvisoryLock(context.database, name);
      expect(context.queries[0]?.sql).toContain('IS_USED_LOCK(?)');
      expect(context.queries[0]?.parameters).toEqual([name]);
      expect(context.lifecycle).toEqual(['acquire', 'release']);
    } finally {
      await context.database.destroy();
    }
  });

  it('uses the existing MysqlAdmin session with exact kill/grant/tamper behavior and no result rewriting', async () => {
    const statements: string[] = [];
    const admin = {
      run: async (statement: string): Promise<string> => {
        statements.push(statement);
        return 'actual stdout';
      },
    };
    expect(
      await corruptMysqlDeliberately(admin, { kind: 'kill-connection', connectionId: 42 }),
    ).toBe('actual stdout');
    expect(
      await corruptMysqlDeliberately(admin, {
        kind: 'grant-app-schema-read',
        schema: 'iridium_pending',
        flushPrivileges: true,
      }),
    ).toBe('actual stdout');
    await corruptMysqlDeliberately(admin, {
      kind: 'tamper-audit-reason',
      schema: 'iridium_w1',
      chainId: 'server',
    });
    expect(statements).toEqual([
      'KILL 42',
      "GRANT SELECT ON `iridium_pending`.* TO 'iridium_app'@'%'; FLUSH PRIVILEGES",
      "UPDATE `iridium_w1`.audit_events SET reason = 'tampered' WHERE chain_id = 'server'",
    ]);
    expect(() =>
      corruptMysqlDeliberately(admin, { kind: 'kill-connection', connectionId: 0 }),
    ).toThrow('identifier');
    expect(statements).toHaveLength(3);
  });

  it('preserves shipped-client roles, native denial results and the archive session/rollback command', async () => {
    const calls: unknown[] = [];
    const nativeResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'ERROR 1142 (42000)',
      output: 'ERROR 1142 (42000)',
    };
    const client: Pick<ShippedMysqlClient, 'execute' | 'query'> = {
      execute: async (role, statement) => {
        calls.push({ role, statement, method: 'execute' });
        return nativeResult;
      },
      query: async (role, statement) => {
        calls.push({ role, statement, method: 'query' });
        return 'wire stdout';
      },
    };
    expect(await probeShippedMysqlWrite(client, 'backup', 'backup-insert-schema-meta')).toBe(
      nativeResult,
    );
    expect(
      await corruptShippedMysqlDeliberately(client, 'migrator', 'archive-delete-audit-event'),
    ).toBe('wire stdout');
    expect(calls).toEqual([
      {
        role: 'backup',
        method: 'execute',
        statement: 'INSERT INTO schema_meta SELECT * FROM schema_meta',
      },
      {
        role: 'migrator',
        method: 'query',
        statement:
          'SET @iridium_audit_archive=1; START TRANSACTION; DELETE FROM audit_events; ROLLBACK',
      },
    ]);
  });
});
