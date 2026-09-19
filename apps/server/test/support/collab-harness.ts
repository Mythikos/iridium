/** Real collaboration fixtures and committed-state oracles shared by the M1 suites. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoteId } from '@iridium/contracts';
import {
  createNoteDoc,
  dominates,
  loadState,
  LOAD_ORIGIN,
  projectMarkdown,
  stateVector,
  type StateVector,
} from '@iridium/crdt';
import {
  assertSchemaName,
  mysqlAdminByContainerId,
  startServer,
  workerSchemaName,
  type MysqlAdmin,
  type NoteClient,
  type SeededUser,
  type ServerNoteClientOptions,
  type StartServerOptions,
  type TestServer,
} from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { expect, inject } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { createLogger } from '../../src/ops/logging.ts';
import type { ManualClock } from './manual-clock.ts';

/** A durability observation assembled from one consistent MySQL transaction. */
export interface DurableNote {
  readonly head: number;
  readonly snapshotThrough: number;
  readonly projected: number;
  readonly snapshotBytes: number;
  readonly contentInvalid: boolean;
  readonly oversize: boolean;
  readonly text: string;
  readonly sv: StateVector;
  readonly updates: readonly {
    readonly seq: number;
    readonly origin: string;
    readonly actorId: string;
    readonly bytes: number;
  }[];
}

/** An owned server and its real clients; close clients before draining the server. */
export interface CollabHarness {
  readonly server: TestServer<FastifyInstance>;
  readonly sql: MysqlAdmin;
  readonly logs: readonly string[];
  application(): FastifyInstance;
  open(user: SeededUser, noteId: string, options?: ServerNoteClientOptions): Promise<NoteClient>;
  committed(noteId: string): Promise<DurableNote>;
  close(): Promise<void>;
}

/** Boot against the isolated worker schema, retaining explicit limits and the product boot path. */
export async function startCollab(
  options: Partial<Omit<StartServerOptions<FastifyInstance>, 'buildApp'>> & {
    readonly clock?: ManualClock;
  } = {},
): Promise<CollabHarness> {
  const { clock: fixtureClock, ...serverOptions } = options;
  const mysql = inject('iridiumMysql');
  const scratch = mkdtempSync(join(tmpdir(), 'iridium-collab-'));
  const lines: string[] = [];
  const clients = new Set<NoteClient>();
  const logger = createLogger({
    level: 'info',
    format: 'json',
    instanceId: 'collab-proof',
    destination: {
      write(line: string): void {
        lines.push(line);
      },
    },
  });
  const server = await startServer({
    mode: 'in-process',
    db: {
      host: mysql.host,
      port: mysql.port,
      schema: workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1'),
    },
    attachmentsDir: scratch,
    ...serverOptions,
    extraEnv: { METRICS_TOKEN: 'collab-fixture-not-a-secret', ...options.extraEnv },
    buildApp: (bootOptions) =>
      buildApp({
        ...bootOptions,
        logger,
        ...(fixtureClock === undefined ? {} : { clock: fixtureClock }),
      }),
  });
  const admin = await mysqlAdminByContainerId(mysql.containerId);
  return {
    server,
    sql: admin,
    get logs(): readonly string[] {
      return server.mode === 'in-process' ? lines : server.stdout;
    },
    application(): FastifyInstance {
      if (server.app === null)
        throw new Error('This observation requires an in-process collaboration server.');
      return server.app;
    },
    async open(user, noteId, clientOptions = {}): Promise<NoteClient> {
      const client = await server.client(user, noteId, clientOptions);
      clients.add(client);
      return client;
    },
    committed: (noteId) => readCommittedNote(admin, server.schema, noteId),
    async close(): Promise<void> {
      await Promise.all([...clients].map((client) => client.close()));
      try {
        if (server.app !== null) {
          const draining = server.app.drain();
          if (fixtureClock !== undefined) {
            let settled = false;
            void draining.then(
              () => {
                return (settled = true);
              },
              () => {
                return (settled = true);
              },
            );
            // Real SQL and sockets still need event-loop turns while product timers use injected time.
            await expect
              .poll(
                async () => {
                  await fixtureClock.advance(50);
                  return settled;
                },
                { timeout: 25_000, interval: 10 },
              )
              .toBe(true);
          }
          await draining;
        }
      } finally {
        try {
          await server.stop();
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      }
    },
  };
}

/** Read binary snapshot plus ordered V1 log and independently replay them into a fresh document. */
export async function readCommittedNote(
  admin: MysqlAdmin,
  schema: string,
  noteId: string,
): Promise<DurableNote> {
  assertSchemaName(schema);
  const noteHex = NoteId.parse(noteId).replaceAll('-', '');
  const rows = await admin.rows(`START TRANSACTION WITH CONSISTENT SNAPSHOT;
    SELECT d.head_seq, d.snapshot_through_seq, d.projected_seq, d.snapshot_format, d.yjs_major,
      HEX(d.snapshot), d.snapshot_size, n.content_invalid, n.oversize, n.initialized_at IS NOT NULL
      FROM ${schema}.note_docs d JOIN ${schema}.notes n ON n.node_id=d.note_id WHERE d.note_id=UNHEX('${noteHex}');
    SELECT seq, HEX(update_v1), origin, COALESCE(HEX(actor_id), ''), OCTET_LENGTH(update_v1)
      FROM ${schema}.note_updates WHERE note_id=UNHEX('${noteHex}') ORDER BY seq;
    COMMIT;`);
  const [record, ...updateRows] = rows;
  if (record === undefined) throw new Error(`No committed note ${noteId} exists in ${schema}.`);
  const head = Number(record[0]);
  const snapshotThrough = Number(record[1]);
  const projected = Number(record[2]);
  const format = Number(record[3]);
  if (format !== 1 && format !== 2)
    throw new Error(`Unexpected snapshot format ${String(format)}.`);
  expect(Number(record[4])).toBe(13);
  expect(record[9]).toBe('1');
  expect(snapshotThrough).toBeLessThanOrEqual(head);
  expect(projected).toBeLessThanOrEqual(head);
  const updates = updateRows.map((row) => ({
    seq: Number(row[0]),
    origin: row[2] ?? '',
    actorId: row[3] ?? '',
    bytes: Number(row[4]),
  }));
  expect(updates.map((row) => row.seq)).toEqual(
    Array.from({ length: head }, (_, index) => index + 1),
  );
  expect(Math.max(snapshotThrough, updates.at(-1)?.seq ?? 0)).toBe(head);
  const document = createNoteDoc({ gc: true });
  try {
    const snapshot = record[5];
    if (snapshot !== undefined && snapshot !== 'NULL' && snapshot !== '')
      loadState(document, Buffer.from(snapshot, 'hex'), format, LOAD_ORIGIN);
    for (const row of updateRows) {
      if (Number(row[0]) > snapshotThrough)
        loadState(document, Buffer.from(row[1] ?? '', 'hex'), 1, LOAD_ORIGIN);
    }
    return {
      head,
      snapshotThrough,
      projected,
      snapshotBytes: Number(record[6]),
      contentInvalid: record[7] === '1',
      oversize: record[8] === '1',
      text: projectMarkdown(document),
      sv: stateVector(document),
      updates,
    };
  } finally {
    document.destroy();
  }
}

/** Compare every connected peer and a fresh committed replay, including the whole state vector. */
export async function expectConverged(
  harness: CollabHarness,
  noteId: string,
  clients: readonly NoteClient[],
): Promise<DurableNote> {
  try {
    await Promise.all(clients.map((client) => client.waitFor('saved', { timeoutMs: 15_000 })));
  } catch (cause) {
    throw new Error(
      `Real clients did not become saved: ${JSON.stringify(
        clients.map((client) => ({
          userId: client.userId,
          state: client.saveState,
          input: client.session.input,
          states: client.states,
          closes: client.closes,
          authenticated: client.provider?.isAuthenticated,
          synced: client.provider?.synced,
          stateless: client.stateless.slice(-5),
        })),
      )}`,
      { cause },
    );
  }
  const first = clients[0];
  if (first === undefined) throw new Error('Convergence needs at least one real client.');
  await expect
    .poll(() => clients.every((client) => client.text.toJSON() === first.text.toJSON()))
    .toBe(true);
  const durable = await harness.committed(noteId);
  expect(durable.text).toBe(first.text.toJSON());
  for (const client of clients) {
    expect(dominates(durable.sv, stateVector(client.ydoc))).toBe(true);
    expect(dominates(stateVector(client.ydoc), durable.sv)).toBe(true);
  }
  return durable;
}
