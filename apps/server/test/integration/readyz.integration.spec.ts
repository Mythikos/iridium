/**
 * `readyz.integration` (12-milestones.md section 4.6; 11-operations-and-deployment.md, "Health";
 * 09-api-reference.md section 2.17).
 *
 * The M0 exit criterion, item by item:
 *
 *  - `/readyz` returns `503` with `migrations: pending` **before** `migrate up` and `200` after;
 *  - `innodb_flush_log_at_trx_commit` is reported;
 *  - the `mysql_version` check is `ok` on both required images (the two-entry `ci.yml › integration`
 *    matrix runs this file on each) and `warn` under `IRIDIUM_ALLOW_UNTESTED_MYSQL=true` for a version
 *    outside the supported set;
 *  - the served check-name set still equals `ReadyzCheckName`.
 *
 * **Every case is order-independent.** The root Vitest configuration shuffles tests as well as files
 * (`sequence.shuffle`), so the migration sequence is driven inside one test against a schema and a
 * server it owns, rather than spread across sibling tests that would only pass in declaration order.
 *
 * This file provisions its own schemas because `global/worker-schema.setup.ts` hands every test a
 * schema that is already migrated, and observing the *pending* state needs one that is not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  corruptMysqlDeliberately,
  createSchema,
  DEFAULT_DATABASE_NAME,
  dropSchema,
  keepSchema,
  migrateSchema,
  mysqlAdminByContainerId,
  replicateSchemaGrants,
  startServer,
  waitFor,
  type MysqlAdmin,
  type TestServer,
} from '@iridium/testkit';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { mysqlVersionOutcome } from '../../src/boot/db.ts';
import type { MysqlServerVersion } from '../../src/db/index.ts';
import {
  docBudgetOutcome,
  FAIL_CLOSED_CHECKS,
  persistBacklogOutcome,
  READYZ_CHECK_NAMES,
  type ReadyzBody,
} from '../../src/ops/readiness.ts';
import { selectedMysqlLane } from '../db-mysql-container.ts';

/** ≥ 32 characters and obviously fake, so `/metrics` is both reachable and actually protected. */
const METRICS_TOKEN = 'readyz-integration-metrics-not-a-secret';
const READY_SCHEMA = 'iridium_readyz_ready';

// This file owns its schemas and never touches the worker's, and its subject is a migration sequence —
// the case 10-testing-and-quality.md names for opting out of the per-test truncation.
keepSchema();

const scratch = mkdtempSync(join(tmpdir(), 'iridium-readyz-'));
let admin: MysqlAdmin;
let mysql: { host: string; port: number; containerId: string };
/** A server on a fully migrated schema: the `200` half, shared by every read-only case. */
let ready: TestServer;

/**
 * An empty schema the app role can *reach* but that carries no migrations.
 *
 * `01_roles.sh` deliberately grants `iridium_app` no table rights — they are migration `0034_grants`,
 * because a grant needs its table to exist — so on a truly pristine schema MySQL refuses the app
 * role's connection outright and `/readyz` reports `db_app: fail` with `migrations` unable to answer.
 * That is a real state and it is covered below; it is not the state the fail-closed contract exists
 * for, which is the upgrade case: a binary whose migration list is ahead of a schema it can otherwise
 * read. One schema-level `SELECT` is the whole difference, so the fixture grants it explicitly rather
 * than leaving the distinction to chance.
 */
async function provisionReachableSchema(name: string): Promise<void> {
  await dropSchema(admin, name);
  await createSchema(admin, name);
  await replicateSchemaGrants(admin, DEFAULT_DATABASE_NAME, name);
  await corruptMysqlDeliberately(admin, {
    kind: 'grant-app-schema-read',
    schema: name,
    flushPrivileges: true,
  });
}

async function startAgainst(schema: string, label: string): Promise<TestServer> {
  return startServer({
    mode: 'in-process',
    db: { host: mysql.host, port: mysql.port, schema },
    attachmentsDir: join(scratch, label),
    extraEnv: { METRICS_TOKEN },
  });
}

/** The body both statuses serve; the HTTP status is the signal (09 section 2.17). */
async function readyz(target: TestServer): Promise<{ status: number; body: ReadyzBody }> {
  // The harness client is generic over the parsed body, so the served shape is named here rather
  // than asserted afterwards: a cast would claim a type nothing checked.
  const response = await target.rest().request<ReadyzBody>('GET', '/readyz');
  return { status: response.status, body: response.body };
}

function checkNamed(body: ReadyzBody, name: string): ReadyzBody['checks'][number] {
  const check = body.checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`/readyz served no ${name} check`);
  return check;
}

beforeAll(async () => {
  mysql = inject('iridiumMysql');
  admin = await mysqlAdminByContainerId(mysql.containerId);
  await provisionReachableSchema(READY_SCHEMA);
  await migrateSchema({ host: mysql.host, port: mysql.port, schema: READY_SCHEMA });
  ready = await startAgainst(READY_SCHEMA, 'attachments-ready');
  await ready.waitReady({ timeoutMs: 30_000 });
});

afterAll(async () => {
  await ready.stop();
  await dropSchema(admin, READY_SCHEMA);
  rmSync(scratch, { recursive: true, force: true });
});

describe('readyz.integration [area:ops]', () => {
  describe('fail-closed on migrations', () => {
    it('answers 503 with migrations pending, then 200 after migrate up, with no restart', async () => {
      const schema = 'iridium_readyz_pending';
      await provisionReachableSchema(schema);
      const server = await startAgainst(schema, 'attachments-pending');
      try {
        const pending = await readyz(server);
        expect(pending.status).toBe(503);
        expect(pending.body.status).toBe('fail');
        const migrations = checkNamed(pending.body, 'migrations');
        expect(migrations.status).toBe('fail');
        expect(migrations.detail).toContain('pending');
        expect(migrations.detail).toContain('0001_users');

        // `/healthz` must keep answering 200: a pending migration is not a reason for an orchestrator
        // to restart-loop the process, which would lose every loaded Y.Doc and the TicketStore.
        const health = await server.rest().request<{ status: string }>('GET', '/healthz');
        expect(health.status).toBe(200);
        expect(health.body.status).toBe('ok');

        // And `/metrics` must keep answering: a monitoring system that goes blind at the moment it is
        // needed is the worse outcome (11-operations-and-deployment.md, fail-closed readiness).
        const metrics = await server.rest().request<string>('GET', '/metrics', {
          headers: { authorization: `Bearer ${METRICS_TOKEN}` },
        });
        expect(metrics.status).toBe(200);
        const exposition = metrics.body;
        expect(exposition).toContain('iridium_build_info');
        expect(exposition).toMatch(/iridium_migrations_pending [1-9]/);
        expect(exposition).toMatch(/iridium_readyz_check_status\{check="migrations"\} 0/);

        // The documented HA procedure: an operator migrates from a sidecar and the server comes up.
        await migrateSchema({ host: mysql.host, port: mysql.port, schema });
        await waitFor(async () => (await readyz(server)).status === 200, {
          timeoutMs: 30_000,
          description: '/readyz to become ready after migrate up',
        });

        const after = await readyz(server);
        expect(after.status).toBe(200);
        expect(after.body.status === 'ok' || after.body.status === 'warn').toBe(true);
        const applied = checkNamed(after.body, 'migrations');
        expect(applied.status).toBe('ok');
        expect(applied.detail).toContain('applied');
      } finally {
        await server.stop();
        await dropSchema(admin, schema);
      }
    });

    it('gates every non-operational route with 503 not_ready while migrations are pending', async () => {
      const schema = 'iridium_readyz_gate';
      await provisionReachableSchema(schema);
      const server = await startAgainst(schema, 'attachments-gate');
      try {
        const response = await server
          .rest()
          .request<{ code?: string; title?: string; requestId?: string }>('GET', '/meta');
        expect(response.status).toBe(503);
        const problem = response.body;
        // `not_ready` is the only code for "the process is up but not serving", whatever the cause
        // (ARCH-02, ARCH-12, 09-api-reference.md section 1.5).
        expect(problem.code).toBe('not_ready');
        expect(problem.requestId).toBeDefined();
        expect(response.contentType).toBe('application/problem+json');
        expect(response.headers.get('retry-after')).toBe('5');
        expect(response.headers.get('x-request-id')).toBe(problem.requestId);
      } finally {
        await server.stop();
        await dropSchema(admin, schema);
      }
    });

    it('refuses /metrics without the configured bearer, with a bare 401', async () => {
      // Prometheus does not parse application/problem+json (D09-11).
      const response = await ready.rest().request('GET', '/metrics');
      expect(response.status).toBe(401);
    });
  });

  describe('the served checks', () => {
    let body: ReadyzBody;

    beforeAll(async () => {
      ({ body } = await readyz(ready));
    });

    it('serves exactly the ReadyzCheckName set, with no duplicates and no omissions', () => {
      const served = body.checks.map((check) => check.name);
      expect(served.toSorted((a, b) => a.localeCompare(b))).toEqual(
        READYZ_CHECK_NAMES.toSorted((a, b) => a.localeCompare(b)),
      );
      expect(new Set(served).size).toBe(served.length);
      expect(served).toHaveLength(16);
    });

    it('serves collab_owner_lease, the sixteenth check M1 adds', () => {
      // 12-milestones.md section 5.2's `ops` row adds it; 09 section 2.17's enum and 11's readiness table
      // predate that row and need the name (the platform stream's report asks for the amendment).
      expect(READYZ_CHECK_NAMES).toContain('collab_owner_lease');
      expect(body.checks.map((check) => check.name)).toContain('collab_owner_lease');
    });

    it('refuses product traffic for pending migrations or absent serving ownership', () => {
      // A standby serves operations only; this prevents authorization mutation on a process whose
      // in-memory collaboration epochs cannot synchronously fence the active owner's connections.
      expect([...FAIL_CLOSED_CHECKS]).toEqual(['migrations', 'collab_owner_lease']);
    });

    it('reports the registered kernel probes from their owning subsystems', () => {
      for (const name of [
        'collab_owner_lease',
        'persist_backlog',
        'doc_budget',
        'projection_workers',
      ]) {
        const check = checkNamed(body, name);
        expect(check.status).toBe('ok');
        expect(check.detail).not.toContain('not registered');
      }
      expect(checkNamed(body, 'projection_workers').detail).toMatch(
        /^0 projection tasks admitted; [1-9]\d* worker slots$/,
      );
    });
    it('reports key_versions as ok once the audit plugin has compared them with schema_meta', () => {
      const keyVersions = checkNamed(body, 'key_versions');
      expect(keyVersions.status).toBe('ok');
      expect(keyVersions.detail).toContain('signing audit rows with v1');
    });

    it('reports innodb_flush_log_at_trx_commit in the durability check', () => {
      const durability = checkNamed(body, 'durability');
      expect(durability.detail).toContain('innodb_flush_log_at_trx_commit');
      // The shipped my.cnf sets it to 1, which is what makes the acknowledged-save contract true.
      expect(durability.status).toBe('ok');
      expect(durability.detail).toContain('innodb_flush_log_at_trx_commit=1');
    });

    it('reports the selected required engine as ok and an admitted advisory engine as warn', () => {
      const lane = selectedMysqlLane();
      const version = checkNamed(body, 'mysql_version');
      expect(version.status).toBe(lane.required ? 'ok' : 'warn');
      expect(version.detail).toMatch(lane.versionPattern);
      expect(version.detail?.includes('IRIDIUM_ALLOW_UNTESTED_MYSQL=true')).toBe(!lane.required);
    });

    it('reports mysql_version as a permanent warn for a version outside the supported set', () => {
      // The same mapping the live check uses. `db.version-floor.integration` pays for the container
      // start that proves the boot refusal; this asserts the state the override leaves behind, which
      // can never be `fail` because a running process has already passed the boot gate (OPS-62).
      const untested: MysqlServerVersion = {
        raw: '10.1.0',
        major: 10,
        minor: 1,
        patch: 0,
        verdict: 'unknown_line',
        line: null,
      };
      const outcome = mysqlVersionOutcome(untested);
      expect(outcome.status).toBe('warn');
      expect(outcome.detail).toContain('10.1.0');
      expect(outcome.detail).toContain('IRIDIUM_ALLOW_UNTESTED_MYSQL=true');
    });

    it('gives every check a status from the documented vocabulary and a measured duration', () => {
      for (const check of body.checks) {
        expect(['ok', 'warn', 'fail']).toContain(check.status);
        expect(Number.isInteger(check.durationMs)).toBe(true);
        expect(check.durationMs).toBeGreaterThanOrEqual(0);
      }
      expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    });

    it('pings both pools separately, so a starved persistence pool is visible on its own', () => {
      expect(checkNamed(body, 'db_app').status).toBe('ok');
      expect(checkNamed(body, 'db_persist').status).toBe('ok');
    });

    it('probes the configured attachment driver and reports its measured latency', () => {
      const attachments = checkNamed(body, 'attachment_store');
      expect(attachments.status).toBe('ok');
      expect(attachments.detail).toMatch(/^fs \(\d+ms\)$/);
    });

    it('reports clock skew between the database and the process', () => {
      const skew = checkNamed(body, 'clock_skew');
      expect(skew.status).toBe('ok');
      expect(skew.detail).toMatch(/^\d+ms$/);
    });

    it('reports grants as ok after recorded application and effective privilege probes', () => {
      expect(checkNamed(body, 'grants').status).toBe('ok');
    });

    it('reports tls_cert as ok and unconfigured when TLS terminates at the proxy', () => {
      const tls = checkNamed(body, 'tls_cert');
      expect(tls.status).toBe('ok');
      expect(tls.detail).toContain('not configured');
    });

    it('reports shutdown as ok while the process is not draining', () => {
      expect(checkNamed(body, 'shutdown').status).toBe('ok');
    });
  });

  describe('the thresholds the wave-2 probes report against', () => {
    it('warns at 80 % of either admission budget and fails at 100 % (A49, A50)', () => {
      const budget = { maxLoadedDocs: 10, maxStateBytes: 1_000 };
      expect(docBudgetOutcome({ ...budget, loadedDocs: 7, stateBytes: 700 }).status).toBe('ok');
      expect(docBudgetOutcome({ ...budget, loadedDocs: 8, stateBytes: 0 }).status).toBe('warn');
      expect(docBudgetOutcome({ ...budget, loadedDocs: 0, stateBytes: 800 }).status).toBe('warn');
      // A server that can admit no new document is not ready for new traffic, even though already-open
      // documents are never evicted (A50 refuses rather than evicting).
      expect(docBudgetOutcome({ ...budget, loadedDocs: 10, stateBytes: 0 }).status).toBe('fail');
      expect(docBudgetOutcome({ ...budget, loadedDocs: 0, stateBytes: 1_000 }).status).toBe('fail');
    });

    it('warns from a 10 s backlog and fails past 30 s, or on a writer failed for over 60 s', () => {
      const none = { failedWriters: 0, longestFailedMs: 0 };
      expect(persistBacklogOutcome({ ...none, oldestPendingMs: 0 }).status).toBe('ok');
      expect(persistBacklogOutcome({ ...none, oldestPendingMs: 9_999 }).status).toBe('ok');
      expect(persistBacklogOutcome({ ...none, oldestPendingMs: 10_000 }).status).toBe('warn');
      expect(persistBacklogOutcome({ ...none, oldestPendingMs: 30_001 }).status).toBe('fail');
      // A failed writer warns immediately and fails once it has been failed for more than a minute.
      expect(
        persistBacklogOutcome({ oldestPendingMs: 0, failedWriters: 1, longestFailedMs: 1_000 })
          .status,
      ).toBe('warn');
      expect(
        persistBacklogOutcome({ oldestPendingMs: 0, failedWriters: 1, longestFailedMs: 60_001 })
          .status,
      ).toBe('fail');
    });
  });

  describe('one body, two statuses', () => {
    it('serves the identical shape at 200 and at 503, so a script written once keeps working', async () => {
      const healthy = await readyz(ready);
      expect(healthy.status).toBe(200);

      const schema = 'iridium_readyz_shape';
      await provisionReachableSchema(schema);
      const server = await startAgainst(schema, 'attachments-shape');
      try {
        const failing = await readyz(server);
        expect(failing.status).toBe(503);
        for (const body of [healthy.body, failing.body]) {
          expect(Object.keys(body).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'checkedAt',
            'checks',
            'status',
          ]);
        }
        expect(failing.body.checks.map((check) => check.name)).toEqual(
          healthy.body.checks.map((check) => check.name),
        );
      } finally {
        await server.stop();
        await dropSchema(admin, schema);
      }
    });
  });

  describe('an unreachable database', () => {
    it('comes up not ready rather than failing the boot, and says which pool is down', async () => {
      // A truly pristine schema: no grant at all for the app role, which is what a fresh deployment
      // looks like before `0034_grants`. The process must still listen and still answer the three
      // operational routes, because the documented recovery is "migrate from a sidecar", not "restart".
      const schema = 'iridium_readyz_norole';
      await dropSchema(admin, schema);
      await createSchema(admin, schema);
      await replicateSchemaGrants(admin, DEFAULT_DATABASE_NAME, schema);
      const server = await startAgainst(schema, 'attachments-norole');
      try {
        const { status, body } = await readyz(server);
        expect(status).toBe(503);
        expect(checkNamed(body, 'db_app').status).toBe('fail');
        // `migrations` is deliberately `warn`, not `fail`: it means "the schema is behind the code",
        // and a database outage is `db_app`'s to report, so a blip cannot masquerade as a bad schema.
        expect(checkNamed(body, 'migrations').status).toBe('warn');
        expect((await server.rest().request('GET', '/healthz')).status).toBe(200);
      } finally {
        await server.stop();
        await dropSchema(admin, schema);
      }
    });
  });
});
