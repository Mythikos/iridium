/** Schema-scoped document ownership, standby refusal, and readiness handoff (D10-33). */
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoteId } from '@iridium/contracts';
import {
  corruptMysqlDeliberately,
  createOriginWebSocket,
  inspectAdvisoryLock,
  createSchema,
  DEFAULT_DATABASE_NAME,
  dropSchema,
  migrateSchema,
  mysqlAdminByContainerId,
  replicateSchemaGrants,
  startServer,
  withDeadline,
  workerSchemaName,
  type MysqlAdmin,
  type NoteClient,
  type TestServer,
} from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { idBytes } from '../../src/auth/ids.ts';
import { CollabOwnershipLost } from '../../src/collab/owner-lease.ts';
import { createLogger } from '../../src/ops/logging.ts';
import type { ReadyzBody } from '../../src/ops/readiness.ts';
import { readCommittedNote } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { registerRecordingOpenApiMatcher } from '../support/openapi-coverage.ts';

const WORKER_SCHEMA = workerSchemaName(process.env['VITEST_WORKER_ID'] ?? '1');
const OTHER_SCHEMA = `${WORKER_SCHEMA}_collab_owner_other`;
const scratch = mkdtempSync(join(tmpdir(), 'iridium-owner-lease-'));
let admin: MysqlAdmin;

registerRecordingOpenApiMatcher();

function application(server: TestServer<FastifyInstance>): FastifyInstance {
  if (server.app === null)
    throw new Error('the owner-lease integration proof needs an in-process server');
  return server.app;
}

async function startAgainst(
  schema: string,
  label: string,
  logs: string[] = [],
  options: { readonly clock?: ManualClock; readonly poolApp?: number } = {},
): Promise<TestServer<FastifyInstance>> {
  const mysql = inject('iridiumMysql');
  const logger = createLogger({
    level: 'info',
    format: 'json',
    instanceId: label,
    destination: {
      write: (line: string): void => {
        logs.push(line);
      },
    },
  });
  return startServer({
    mode: 'in-process',
    db: { host: mysql.host, port: mysql.port, schema },
    attachmentsDir: join(scratch, label),
    extraEnv: {
      METRICS_TOKEN: 'owner-lease-fixture-not-a-secret',
      ...(options.poolApp === undefined ? {} : { DB_POOL_APP: String(options.poolApp) }),
    },
    buildApp: (bootOptions) =>
      buildApp({
        ...bootOptions,
        logger,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
  });
}

async function lockOwner(
  server: TestServer<FastifyInstance>,
  name: string,
): Promise<number | null> {
  const db = application(server).database.dbApp;
  if (db === null) throw new Error('the owner-lease integration proof needs a connected app pool');
  const result = await inspectAdvisoryLock(db, name);
  const row = result.rows[0];
  expect(row?.owner).not.toBe(row?.observer);
  return row?.owner ?? null;
}

async function noteUpdateCount(
  server: TestServer<FastifyInstance>,
  noteId: string,
): Promise<number> {
  const db = application(server).database.dbApp;
  if (db === null) throw new Error('the owner-lease integration proof needs a connected app pool');
  const row = await db
    .selectFrom('note_updates')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .where('note_id', '=', idBytes(noteId))
    .executeTakeFirstOrThrow();
  return row.count;
}

async function refusedUpgrade(server: TestServer): Promise<{ code: number; reason: string }> {
  const OriginWebSocket = createOriginWebSocket({ origin: server.origin });
  const socket = new OriginWebSocket(server.wsUrl);
  try {
    return await withDeadline(
      new Promise<{ code: number; reason: string }>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('close', (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString() });
        });
      }),
      { timeoutMs: 5_000, description: 'the non-owner to refuse the collaboration upgrade' },
    );
  } finally {
    socket.terminate();
  }
}

/** Fetch forbids Upgrade headers, so exercise malformed handshake admission over actual HTTP. */
async function malformedUpgradeStatus(server: TestServer): Promise<number> {
  const request = httpRequest(new URL('/collab', server.origin), {
    headers: { upgrade: 'websocket', connection: 'Upgrade' },
  });
  try {
    return await withDeadline(
      new Promise<number>((resolve, reject) => {
        request.once('error', reject);
        request.once('response', (response) => {
          response.once('error', reject);
          response.once('end', () => resolve(response.statusCode ?? 0));
          response.resume();
        });
        request.once('upgrade', (_response, socket) => {
          socket.destroy();
          reject(new Error('A malformed non-owner handshake must not upgrade.'));
        });
        request.end();
      }),
      { timeoutMs: 5_000, description: 'the standby to refuse the malformed upgrade over HTTP' },
    );
  } finally {
    request.destroy();
  }
}

async function stopWithClock(
  server: TestServer<FastifyInstance>,
  clock: ManualClock,
): Promise<void> {
  let stopped = false;
  const stopping = server.stop().finally(() => {
    stopped = true;
  });
  await expect
    .poll(
      async () => {
        await clock.advance(1_000);
        return stopped;
      },
      { timeout: 25_000 },
    )
    .toBe(true);
  await stopping;
}

async function killReservedConnection(server: TestServer<FastifyInstance>): Promise<number> {
  const name = application(server).collab.ownerLease.lockName;
  if (name === null) throw new Error('The owner has no reserved lock name.');
  const connectionId = await lockOwner(server, name);
  if (connectionId === null || !Number.isSafeInteger(connectionId) || connectionId < 1) {
    throw new Error('The reserved MySQL connection is not alive.');
  }
  await corruptMysqlDeliberately(admin, { kind: 'kill-connection', connectionId });
  return connectionId;
}

beforeAll(async () => {
  const mysql = inject('iridiumMysql');
  admin = await mysqlAdminByContainerId(mysql.containerId);
  await createSchema(admin, OTHER_SCHEMA);
  await replicateSchemaGrants(admin, DEFAULT_DATABASE_NAME, OTHER_SCHEMA);
  await migrateSchema({ host: mysql.host, port: mysql.port, schema: OTHER_SCHEMA });
});

afterAll(async () => {
  await dropSchema(admin, OTHER_SCHEMA);
  rmSync(scratch, { recursive: true, force: true });
});

describe('collab.owner-lease.integration [hp:HP-2]', () => {
  it('keeps distinct schemas ready, refuses a same-schema standby, and hands over on release', async () => {
    const owned = new Set<TestServer<FastifyInstance>>();
    let client: NoteClient | null = null;
    try {
      const owner = await startAgainst(WORKER_SCHEMA, 'owner');
      owned.add(owner);
      await owner.waitReady();
      const ownerLease = application(owner).collab.ownerLease;
      const name = ownerLease.lockName;
      if (name === null) throw new Error('a ready collaboration server has no schema lease name');
      const originalOwner = await lockOwner(owner, name);
      expect(originalOwner).toBeGreaterThan(0);
      expect(ownerLease.connectionReserved).toBe(true);
      expect(application(owner).database.poolsInUse().persist).toBe(1);

      const adminUser = await owner.seed.admin();
      const vault = await owner.seed.vault({ name: 'Owner lease' });
      const note = await owner.seed.note({
        vault,
        name: 'Owned note',
        markdown: '# Owner lease\n',
      });
      const signedIn = await owner.loginAsDesktop(adminUser);
      if (signedIn.bearer === undefined) throw new Error('A desktop session must have a bearer.');
      const initialUpdates = await noteUpdateCount(owner, note.id);
      expect(initialUpdates).toBe(1);
      client = await owner.client(adminUser, note.id, { role: 'manager' });
      await client.waitFor('saved');
      const separate = await startAgainst(OTHER_SCHEMA, 'separate');
      owned.add(separate);
      await separate.waitReady();
      const separateLease = application(separate).collab.ownerLease;
      expect(separateLease.held).toBe(true);
      expect(separateLease.lockName).not.toBe(name);
      expect((await owner.rest().request('GET', '/readyz')).status).toBe(200);
      expect(await lockOwner(separate, name)).toBe(originalOwner);

      const deniedLogs: string[] = [];
      const standby = await startAgainst(WORKER_SCHEMA, 'standby', deniedLogs);
      owned.add(standby);
      const standbyLease = application(standby).collab.ownerLease;
      const refused = await standby.rest().request<ReadyzBody>('GET', '/readyz');
      expect(refused.status).toBe(503);
      expect(refused.body.checks.find((check) => check.name === 'collab_owner_lease')?.status).toBe(
        'fail',
      );
      expect(standbyLease.held).toBe(false);
      expect(standbyLease.lockName).toBe(name);
      expect(standbyLease.connectionReserved).toBe(true);
      expect(await Promise.all([refusedUpgrade(standby), refusedUpgrade(standby)])).toEqual([
        { code: 4503, reason: 'no-owner-lease' },
        { code: 4503, reason: 'no-owner-lease' },
      ]);
      expect(
        deniedLogs.filter((line) => line.includes('"event":"collab.owner_lease.denied"')),
      ).toHaveLength(1);
      expect(application(standby).collab.server.loadedDocuments()).toEqual([]);
      const reader = standby.rest({ bearer: signedIn.bearer, client: 'desktop' });
      const markdown = await reader.get(`/notes/${note.id}/markdown`);
      expect(markdown.status).toBe(503);
      expect(markdown.body).toMatchObject({ code: 'not_ready' });
      expect(
        (
          await standby
            .rest()
            .post('/auth/login', { json: { email: adminUser.email, password: adminUser.password } })
        ).status,
      ).toBe(503);
      expect(
        (
          await reader.post(`/vaults/${vault.id}/nodes`, {
            json: {
              kind: 'note',
              parentId: vault.rootNodeId,
              name: 'Standby forbidden',
              markdown: '',
            },
          })
        ).status,
      ).toBe(503);
      expect((await standby.rest().request('GET', '/healthz')).status).toBe(200);
      expect(
        (
          await standby.rest().request('GET', '/metrics', {
            headers: { authorization: 'Bearer owner-lease-fixture-not-a-secret' },
          })
        ).status,
      ).toBe(200);
      expect((await standby.rest().request('GET', '/collab')).status).toBe(503);
      expect(await malformedUpgradeStatus(standby)).toBe(503);
      expect(await noteUpdateCount(standby, note.id)).toBe(initialUpdates);
      expect(await lockOwner(standby, name)).toBe(originalOwner);
      client.typeAt(0, 'lease-drain-marker\n');
      await client.waitFor('saved');
      const committedText = client.text.toJSON();
      let checkedUnloaded = false;
      application(owner).onDrain({
        phase: 'unload',
        name: 'owner-lease.integration-after-unload',
        async run(): Promise<void> {
          expect(application(owner).collab.server.loadedDocuments()).toEqual([]);
          expect(ownerLease.held).toBe(true);
          expect(await lockOwner(standby, name)).toBe(originalOwner);
          const draining = await owner.rest().request('GET', '/readyz');
          expect(draining.status).toBe(503);
          checkedUnloaded = true;
        },
      });
      // The harness's stop() logs a failed drain before cleaning up. Await the product drain here
      // so an assertion in the observer above fails this test instead of becoming a teardown warning.
      await application(owner).drain();
      expect(checkedUnloaded).toBe(true);
      await owner.stop();
      owned.delete(owner);
      expect(ownerLease.held).toBe(false);
      expect(ownerLease.connectionReserved).toBe(false);
      await standby.waitReady();
      expect(standbyLease.held).toBe(true);
      expect(standbyLease.lockName).toBe(name);
      const successor = await lockOwner(standby, name);
      expect(successor).toBeGreaterThan(0);
      expect(successor).not.toBe(originalOwner);
      const recovered = await reader.get<string>(`/notes/${note.id}/markdown`);
      expect(recovered.status).toBe(200);
      expect(recovered.body).toBe(committedText);
      await expect(recovered).toMatchOpenApi('notes.getMarkdown', 200);
      expect((await separate.rest().request('GET', '/readyz')).status).toBe(200);
    } finally {
      await client?.close();
      // Standbys close before owners so a readiness timer cannot reacquire during teardown.
      for (const server of [...owned].toReversed()) {
        // eslint-disable-next-line no-await-in-loop -- each server finishes its drain before its predecessor closes
        await server.stop();
      }
    }
  });

  it('kills the reserved connection, serializes takeover behind a real old transaction, and reopens with a new lifetime', async () => {
    const clock = new ManualClock(Date.now());
    const logs: string[] = [];
    const owner = await startAgainst(WORKER_SCHEMA, 'lost-owner', logs, { clock });
    let standby: TestServer<FastifyInstance> | null = null;
    let original: NoteClient | null = null;
    let successorClient: NoteClient | null = null;
    try {
      await owner.waitReady();
      const cast = await owner.seed.kernel();
      original = await owner.client(cast.editorA, cast.note.id, { flushDelayMs: false });
      await original.waitFor('saved');
      const document = original.ydoc;
      const undo = original.undo;
      const app = application(owner);
      const lease = app.collab.ownerLease;
      const oldFence = lease.captureFence();
      const oldGeneration = lease.captureGeneration();
      const writer = app.collab.persistence.writerOf(NoteId.parse(cast.note.id));
      if (writer === undefined) throw new Error('The original writer was not loaded.');
      const before = await readCommittedNote(admin, WORKER_SCHEMA, cast.note.id);
      standby = await startAgainst(WORKER_SCHEMA, 'lost-owner-standby');
      expect(application(standby).collab.ownerLease.held).toBe(false);
      app.faults.arm({ point: 'store.slow', arg: 1_000 });
      const inFlight = original.marker('old-transaction');
      await expect
        .poll(() =>
          logs.some(
            (line) =>
              line.includes('"event":"fault.fired"') && line.includes('"point":"store.slow"'),
          ),
        )
        .toBe(true);
      app.faults.arm({ point: 'store.slow', count: 0 });
      const pending = original.marker('old-queue');
      await expect.poll(() => writer.queueLength).toBe(2);
      expect((await readCommittedNote(admin, WORKER_SCHEMA, cast.note.id)).head).toBe(before.head);
      const closed = original.waitClosed();
      await killReservedConnection(owner);
      expect(await lease.tryAcquire()).toBe(false);
      expect(await closed).toMatchObject({ code: 4503, reason: 'no-owner-lease' });
      expect(() => oldFence.assertActive()).toThrow(CollabOwnershipLost);
      const claim = application(standby).collab.ownerLease.tryAcquire();
      // Observe the real InnoDB waiter, rather than assuming a pending Promise means a row lock.
      await expect
        .poll(async () =>
          Number(
            (
              await admin.rows(
                `SELECT COUNT(*) FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID WHERE l.OBJECT_SCHEMA='${WORKER_SCHEMA}' AND l.OBJECT_NAME='collab_owner_fence'`,
              )
            )[0]?.[0],
          ),
        )
        .toBeGreaterThan(0);
      expect(application(standby).collab.ownerLease.held).toBe(false);
      await clock.advance(1_000);
      expect(await claim).toBe(true);
      await standby.waitReady();
      const takenOver = await readCommittedNote(admin, WORKER_SCHEMA, cast.note.id);
      expect(takenOver.head).toBe(before.head + 1);
      expect(takenOver.text).toContain(inFlight);
      expect(takenOver.text).not.toContain(pending);
      expect(writer.lastPersisted.seq).toBe(before.head);
      await expect
        .poll(async () => {
          await clock.advance(50);
          return app.collab.server.loadedDocuments().length;
        })
        .toBe(0);
      expect(app.collab.persistence.writers()).toEqual([]);
      expect(original.ydoc).toBe(document);
      expect(original.undo).toBe(undo);
      expect(original.text.toJSON()).toContain(pending);
      expect(original.saveState).not.toBe('saved');
      successorClient = await standby.client(cast.editorB, cast.note.id);
      await successorClient.waitFor('saved');
      expect(successorClient.text.toJSON()).toBe(takenOver.text);
      await successorClient.close();
      successorClient = null;
      await standby.stop();
      standby = null;
      expect(await lease.tryAcquire()).toBe(true);
      expect(lease.captureGeneration()).not.toBe(oldGeneration);
      expect(() => oldFence.assertActive()).toThrow(CollabOwnershipLost);
      await owner.waitReady();
      try {
        await original.waitFor('saved', { timeoutMs: 30_000 });
      } catch (cause) {
        throw new Error(
          `Original client ownership recovery: ${JSON.stringify({
            state: original.saveState,
            input: original.session.input,
            states: original.states,
            closes: original.closes,
            authenticated: original.provider?.isAuthenticated,
            synced: original.provider?.synced,
            unsynced: original.provider?.unsyncedChanges,
            stateless: original.stateless.slice(-8),
            logs: logs.slice(-20),
          })}`,
          { cause },
        );
      }
      expect(original.ydoc).toBe(document);
      expect(original.undo).toBe(undo);
      const recovered = await readCommittedNote(admin, WORKER_SCHEMA, cast.note.id);
      expect(recovered.text.split(inFlight)).toHaveLength(2);
      expect(recovered.text.split(pending)).toHaveLength(2);
      expect(recovered.text).toBe(original.text.toJSON());
      expect(app.collab.persistence.writerOf(NoteId.parse(cast.note.id))).not.toBe(writer);
      expect(logs.some((line) => line.includes('"event":"persist.cas_mismatch"'))).toBe(false);
    } finally {
      await clock.advance(1_000);
      await original?.close();
      await successorClient?.close();
      await standby?.stop();
      await stopWithClock(owner, clock);
    }
  }, 60_000);

  it('rejects a REST mutation admitted by the old owner while authentication waited for the real app pool', async () => {
    const clock = new ManualClock(Date.now());
    const owner = await startAgainst(WORKER_SCHEMA, 'stale-rest-owner', [], { clock, poolApp: 5 });
    let standby: TestServer<FastifyInstance> | null = null;
    const release = Promise.withResolvers<void>();
    const held: Promise<void>[] = [];
    try {
      await owner.waitReady();
      const user = await owner.seed.admin();
      const vault = await owner.seed.vault({ name: 'Stale request vault' });
      const reader = await owner.loginAsDesktop(user);
      const app = application(owner);
      const db = app.database.dbApp;
      const name = app.collab.ownerLease.lockName;
      if (db === null || name === null) throw new Error('The fixture owner is not ready.');
      const connectionId = await lockOwner(owner, name);
      if (connectionId === null || !Number.isSafeInteger(connectionId) || connectionId < 1)
        throw new Error('The owner connection is absent.');
      standby = await startAgainst(WORKER_SCHEMA, 'stale-rest-standby');
      let acquired = 0;
      held.push(
        ...Array.from({ length: 5 }, () =>
          db.connection().execute(async () => {
            acquired += 1;
            await release.promise;
          }),
        ),
      );
      await expect.poll(() => acquired).toBe(5);
      expect(app.database.poolsInUse().app).toBe(5);
      const pending = reader
        .post(`/vaults/${vault.id}/nodes`, {
          json: {
            kind: 'note',
            parentId: vault.rootNodeId,
            name: 'Stale owner mutation',
            markdown: 'must never be created',
          },
        })
        .then(
          (response) => ({ response }),
          (error: unknown) => ({ error }),
        );
      await expect.poll(() => app.database.pendingAcquisitions().app).toBeGreaterThan(0);
      await corruptMysqlDeliberately(admin, { kind: 'kill-connection', connectionId });
      expect(await app.collab.ownerLease.tryAcquire()).toBe(false);
      expect(await application(standby).collab.ownerLease.tryAcquire()).toBe(true);
      await standby.waitReady();
      release.resolve();
      await Promise.all(held);
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      expect(outcome.response.status).toBe(503);
      expect(outcome.response.body).toMatchObject({ code: 'unavailable' });
      expect(
        Number(
          (
            await admin.rows(
              `SELECT COUNT(*) FROM ${WORKER_SCHEMA}.nodes WHERE name='Stale owner mutation'`,
            )
          )[0]?.[0],
        ),
      ).toBe(0);
      expect(app.collab.ownerLease.held).toBe(false);
    } finally {
      release.resolve();
      await Promise.all(held);
      await standby?.stop();
      await stopWithClock(owner, clock);
    }
  }, 60_000);
});
