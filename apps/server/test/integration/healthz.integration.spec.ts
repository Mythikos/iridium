/** Real liveness, readiness independence and pressure admission (09 §2.17; 11 Health/Metrics). */
import {
  corruptMysqlDeliberately,
  createDeferred,
  createSchema,
  DEFAULT_DATABASE_NAME,
  dropSchema,
  mysqlAdminByContainerId,
  openOriginWebSocket,
  replicateSchemaGrants,
  withDeadline,
} from '@iridium/testkit';
import { describe, expect, inject, it } from 'vitest';

import type { HealthzBody } from '../../src/ops/plugin.ts';
import type { ReadyzBody } from '../../src/ops/readiness.ts';
import { startAuthServer } from '../support/auth-app.ts';
import { startCollab } from '../support/collab-harness.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { startPlatformApp, type PlatformApp } from './platform-app.ts';

const METRICS_TOKEN = 'health-proof-metrics-not-a-secret';

describe('healthz.integration [area:ops]', () => {
  it.each(['inaccessible database', 'pending migrations'] as const)(
    'remains alive while readiness refuses traffic for %s',
    async (failure) => {
      const mysql = inject('iridiumMysql');
      const admin = await mysqlAdminByContainerId(mysql.containerId);
      const schema =
        failure === 'pending migrations' ? 'iridium_health_pending' : 'iridium_health_noaccess';
      let target: PlatformApp | undefined;
      await createSchema(admin, schema);
      try {
        await replicateSchemaGrants(admin, DEFAULT_DATABASE_NAME, schema);
        if (failure === 'pending migrations') {
          // An upgrade can read its old schema while the binary expects unapplied migrations.
          await corruptMysqlDeliberately(admin, { kind: 'grant-app-schema-read', schema });
        }
        target = await startPlatformApp({
          connection: { host: mysql.host, port: mysql.port, schema },
          extraEnv: { METRICS_TOKEN },
        });
        const ready = await target.app.inject({ method: 'GET', url: '/readyz' });
        expect(ready.statusCode).toBe(503);
        const body = ready.json<ReadyzBody>();
        const failedCheck = failure === 'pending migrations' ? 'migrations' : 'db_app';
        expect(body.checks.find((check) => check.name === failedCheck)?.status).toBe('fail');
        const blocked = await target.app.inject({
          method: 'GET',
          url: '/api/v1/meta',
          headers: { host: target.app.iridiumConfig.server.publicHost },
        });
        expect(blocked.statusCode).toBe(503);
        expect(blocked.json()).toMatchObject({ code: 'not_ready' });
        expect(blocked.headers['retry-after']).toBe('5');

        // An arbitrary proxy Host also cannot turn a liveness probe into a product request.
        const health = await target.app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { host: 'supervisor.invalid' },
        });
        expect(health.statusCode).toBe(200);
        expect(health.headers['content-type']).toContain('application/json');
        expect(health.headers['cache-control']).toBe('no-store');
        expect(health.json<HealthzBody>()).toEqual({
          status: 'ok',
          version: expect.any(String),
          uptimeSeconds: expect.any(Number),
          eventLoopLagMs: expect.any(Number),
        });
        expect(health.json<HealthzBody>().eventLoopLagMs).toBeLessThan(1_000);
        const metrics = await target.app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer ' + METRICS_TOKEN },
        });
        expect(metrics.statusCode).toBe(200);
        expect(metrics.body).toContain(
          'iridium_readyz_check_status{check="' + failedCheck + '"} 0',
        );
      } finally {
        try {
          await target?.close();
        } finally {
          await dropSchema(admin, schema);
        }
      }
    },
  );

  it('uses the real lag probe at its exact threshold and recovers without restarting', async () => {
    const clock = new ManualClock(Date.now());
    const target = await startAuthServer({ clock });
    try {
      const client = target.server.rest();
      await clock.stall(1_499); // 500 ms sample interval + 999 ms delayed delivery.
      const healthy = await client.request<HealthzBody>('GET', '/healthz');
      expect(healthy.status).toBe(200);
      expect(healthy.body.eventLoopLagMs).toBe(999);
      await clock.stall(1_500);
      const degraded = await client.request('GET', '/healthz');
      expect(degraded.status).toBe(503);
      expect(degraded.contentType).toBe('application/problem+json');
      expect(degraded.body).toMatchObject({ code: 'unavailable', detail: 'event loop lag 1000ms' });
      await clock.stall(500);
      const recovered = await client.request<HealthzBody>('GET', '/healthz');
      expect(recovered.status).toBe(200);
      expect(recovered.body.eventLoopLagMs).toBe(0);
      expect(recovered.body.uptimeSeconds).toBeGreaterThan(healthy.body.uptimeSeconds);
      await target.app.drain();
      expect((await client.request('GET', '/readyz')).status).toBe(503);
      expect((await client.request('GET', '/healthz')).status).toBe(200);
    } finally {
      await target.stop();
    }
  });

  it('sheds real sampled heap pressure while ops probes and the collaboration upgrade keep working', async () => {
    // A supported low threshold produces actual pressure without allocating an unsafe heap.
    // Both production pressure gates remain enabled; the sampler and its real timers are untouched.
    const target = await startCollab({ extraEnv: { PRESSURE_MAX_HEAP_BYTES: '1', METRICS_TOKEN } });
    try {
      const app = target.application();
      await expect.poll(() => app.isUnderPressure(), { timeout: 5_000 }).toBe(true);
      expect(app.memoryUsage().heapUsed).toBeGreaterThan(1);
      const client = target.server.rest();
      const shed = await client.get('/meta');
      expect(shed.status).toBe(503);
      expect(shed.contentType).toBe('application/problem+json');
      expect(shed.body).toMatchObject({ code: 'unavailable', retryAfterMs: 10_000 });
      expect(shed.headers.get('retry-after')).toBe('10');
      expect(target.logs.some((line) => line.includes('"event":"pressure.shed"'))).toBe(true);
      expect((await client.request('GET', '/healthz')).status).toBe(200);
      expect((await client.request('GET', '/readyz')).status).toBe(200);
      const metrics = await target.server.metrics();
      expect(
        metrics['iridium_http_requests_total{method="GET",route="/api/v1/meta",status="503"}'],
      ).toBe(1);
      const socket = openOriginWebSocket(target.server.wsUrl, { origin: target.server.origin });
      const opened = createDeferred<void>();
      socket.once('open', () => opened.resolve(undefined));
      socket.on('error', (error) => opened.reject(error));
      try {
        await withDeadline(opened.promise, {
          timeoutMs: 2_000,
          description: 'real /collab upgrade under heap pressure',
        });
        expect(socket.readyState).toBe(1);
      } finally {
        socket.terminate();
      }
    } finally {
      await target.close();
    }
  });
});
