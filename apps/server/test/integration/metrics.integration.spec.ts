/** M1 metrics are protected, live, scrapeable and bounded in label cardinality (11 Metrics). */
import { describe, expect, it } from 'vitest';

import { READYZ_CHECK_NAMES } from '../../src/ops/readiness.ts';
import { startAuthServer } from '../support/auth-app.ts';
import { startCollab } from '../support/collab-harness.ts';

const TOKEN = 'metrics-proof-bearer-not-a-secret';

// The M1 catalogue, independently named here. Later milestone collectors/alert files are not
// manufactured as zero-valued evidence before their owning subsystem exists.
const M1_METRICS = [
  'iridium_http_requests_total',
  'iridium_http_duration_seconds',
  'iridium_build_info',
  'iridium_boot_timestamp_seconds',
  'iridium_migrations_pending',
  'iridium_readyz_check_status',
  'iridium_key_version',
  'iridium_ws_connections',
  'iridium_docs_loaded',
  'iridium_docs_loaded_max',
  'iridium_collab_state_bytes',
  'iridium_collab_state_bytes_max',
  'iridium_collab_admission_refused_total',
  'iridium_collab_messages_total',
  'iridium_collab_hook_errors_total',
  'iridium_persist_latency_seconds',
  'iridium_persist_failures_total',
  'iridium_persist_queue_depth',
  'iridium_persist_backlog_age_seconds',
  'iridium_persist_writers_failed',
  'iridium_compactions_total',
  'iridium_note_state_bytes',
  'iridium_state_vector_oversize_total',
  'iridium_content_invalid_total',
  'iridium_login_failures_total',
  'iridium_token_auth_failures_total',
  'iridium_authz_bus_handler_errors_total',
  'iridium_db_pool_in_use',
  'iridium_db_pool_size',
] as const;
const LABEL_NAMES = new Set([
  'route',
  'method',
  'status',
  'version',
  'commit',
  'node',
  'check',
  'kind',
  'doc_kind',
  'reason',
  'type',
  'hook',
  'trigger',
  'pool',
  'le',
]);

describe('metrics.integration [area:ops]', () => {
  it('accepts only the exact configured bearer and gives a bare 401 on denied scrapes', async () => {
    const target = await startAuthServer({ extraEnv: { METRICS_TOKEN: TOKEN } });
    try {
      const client = target.server.rest();
      for (const authorization of [
        undefined,
        'Bearer wrong',
        'Basic ' + TOKEN,
        'bearer ' + TOKEN,
        'Bearer ' + TOKEN + '-wrong',
      ]) {
        // eslint-disable-next-line no-await-in-loop -- each actual denied wire response must remain bare
        const refused = await client.request(
          'GET',
          '/metrics',
          authorization === undefined ? {} : { headers: { authorization } },
        );
        expect(refused.status).toBe(401);
        expect(refused.body).toBeUndefined();
        expect(refused.contentType).not.toBe('application/problem+json');
      }
      const allowed = await client.request<string>('GET', '/metrics', { bearer: TOKEN });
      expect(allowed.status).toBe(200);
      expect(allowed.contentType).toBe('text/plain');
      expect(allowed.headers.get('cache-control')).toBe('no-store');
      expect(allowed.body).toContain('# TYPE iridium_build_info gauge');
      expect(allowed.body).not.toContain(TOKEN);
    } finally {
      await target.stop();
    }
  });

  it('uses the configured CIDR after trusted-proxy resolution and preserves bearer-or-CIDR semantics', async () => {
    const target = await startAuthServer({
      extraEnv: { METRICS_TOKEN: TOKEN, METRICS_ALLOW_CIDR: '203.0.113.0/24' },
    });
    try {
      const client = target.server.rest();
      const local = await client.request('GET', '/metrics', {
        headers: { 'x-forwarded-for': '203.0.113.19' },
      });
      expect(local.status).toBe(200);
      const foreign = await client.request('GET', '/metrics', {
        headers: { 'x-forwarded-for': '203.0.114.19' },
      });
      expect(foreign.status).toBe(401);
      expect(foreign.body).toBeUndefined();
      const tokenFromForeign = await client.request('GET', '/metrics', {
        bearer: TOKEN,
        headers: { 'x-forwarded-for': '203.0.114.19' },
      });
      expect(tokenFromForeign.status).toBe(200);
      const cidrWithWrongToken = await client.request('GET', '/metrics', {
        bearer: 'wrong',
        headers: { 'x-forwarded-for': '203.0.113.19' },
      });
      expect(cidrWithWrongToken.status).toBe(200);
    } finally {
      await target.stop();
    }
  });

  it('does not trust a forged forwarded address when the immediate proxy is not trusted', async () => {
    const target = await startAuthServer({
      extraEnv: { TRUST_PROXY: '', METRICS_ALLOW_CIDR: '203.0.113.0/24' },
    });
    try {
      const response = await target.server
        .rest()
        .request('GET', '/metrics', { headers: { 'x-forwarded-for': '203.0.113.19' } });
      expect(response.status).toBe(401);
      expect(response.body).toBeUndefined();
    } finally {
      await target.stop();
    }
  });

  it.each([false, true])(
    'hides unprotected metrics and removes the disabled route (disabled=%s)',
    async (disabled) => {
      const target = await startAuthServer({
        extraEnv: disabled ? { METRICS_ENABLED: 'false', METRICS_TOKEN: TOKEN } : {},
      });
      try {
        const registered = target.app
          .routes()
          .some((route) => route.method === 'GET' && route.url === '/metrics');
        expect(registered).toBe(!disabled);
        const response = await target.server.rest().request('GET', '/metrics', { bearer: TOKEN });
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: 'not_found' });
      } finally {
        await target.stop();
      }
    },
  );

  it('exposes the M1 registry and real HTTP/collaboration commits without IDs or query text in labels', async () => {
    const target = await startCollab({ extraEnv: { METRICS_TOKEN: TOKEN } });
    try {
      const cast = await target.server.seed.kernel();
      const note = await target.open(cast.editorA, cast.note.id);
      await note.waitFor('saved');
      note.marker('metrics-lived-update');
      await note.waitFor('saved');
      note.session.flush();
      await expect
        .poll(
          async () =>
            (await target.server.metrics())[
              'iridium_compactions_total{status="ok",trigger="flush"}'
            ] ?? 0,
        )
        .toBeGreaterThan(0);
      const { client } = await target.server.sessions.current(cast.editorA);
      const markdown = await client.get('/notes/' + cast.note.id + '/markdown');
      expect(markdown.status).toBe(200);
      expect(markdown.body).toContain('metrics-lived-update');
      const queryMarker = 'metrics-private-path-and-query';
      expect(
        (await client.request('GET', '/unknown/' + queryMarker, { query: { q: queryMarker } }))
          .status,
      ).toBe(404);
      expect((await client.request('GET', '/readyz')).status).toBe(200);
      const exposition = await client.request<string>('GET', '/metrics', { bearer: TOKEN });
      expect(exposition.status).toBe(200);
      const renderedNames = [...exposition.body.matchAll(/^# TYPE ([a-z_]+) /gm)].map(
        (match) => match[1],
      );
      expect(renderedNames).toEqual(
        expect.arrayContaining([
          ...M1_METRICS,
          'process_resident_memory_bytes',
          'nodejs_heap_size_used_bytes',
          'nodejs_eventloop_lag_seconds',
        ]),
      );
      const values = await target.server.metrics();
      expect(values['iridium_docs_loaded']).toBe(1);
      expect(values['iridium_ws_connections{doc_kind="note"}']).toBe(1);
      expect(values['iridium_persist_latency_seconds_count']).toBeGreaterThan(0);
      expect(
        values[
          'iridium_http_requests_total{method="GET",route="/api/v1/notes/:noteId/markdown",status="200"}'
        ],
      ).toBe(1);
      expect(
        values['iridium_http_requests_total{method="GET",route="unmatched",status="404"}'],
      ).toBe(1);
      for (const check of READYZ_CHECK_NAMES)
        expect(values['iridium_readyz_check_status{check="' + check + '"}']).toBeGreaterThan(0);
      const routes = new Set(
        target
          .application()
          .routes()
          .map((route) => route.url),
      );
      routes.add('unmatched');
      const liveMetrics = await target.application().metrics.snapshot();
      const privateValues = [
        cast.note.id,
        cast.vault.id,
        cast.editorA.id,
        note.sessionId,
        TOKEN,
        queryMarker,
        'metrics-lived-update',
      ].filter((value): value is string => value !== null);
      for (const metric of liveMetrics.filter((candidate) =>
        candidate.name.startsWith('iridium_'),
      )) {
        for (const value of metric.values) {
          for (const [label, content] of Object.entries(value.labels)) {
            expect(LABEL_NAMES.has(label), metric.name + ': ' + label).toBe(true);
            expect(
              label !== 'route' || routes.has(String(content)),
              'route label: ' + String(content),
            ).toBe(true);
            for (const privateValue of privateValues)
              expect(String(content)).not.toContain(privateValue);
          }
        }
      }
      for (const privateValue of privateValues) expect(exposition.body).not.toContain(privateValue);
    } finally {
      await target.close();
    }
  });
});
