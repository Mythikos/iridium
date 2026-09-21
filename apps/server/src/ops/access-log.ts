/** REST access observations are separate from transactional, immutable audit events. */
import { toCanonicalId } from '@iridium/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { idBytes } from '../auth/ids.ts';
import type { AccessLogStatus } from '../db/schema.ts';
import { toAddressBytes } from '../security/ip-range.ts';

function statusOf(status: number): AccessLogStatus {
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'denied';
  return status < 400 ? 'ok' : 'error';
}

/** Log authenticated refusals and token reads after sending the response, without a resource lookup. */
export function applyRestAccessLog(app: FastifyInstance): void {
  const started = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', async (request) => {
    started.set(request, app.clock.monotonic());
  });
  app.addHook('onResponse', async (request, reply) => {
    const principal = request.principal;
    const action = request.routeOptions.schema?.operationId;
    if (principal === null || principal.kind === 'system' || typeof action !== 'string') return;
    const refused =
      reply.statusCode === 401 ||
      reply.statusCode === 403 ||
      reply.statusCode === 404 ||
      reply.statusCode === 429;
    const tokenRead =
      principal.kind === 'token' && (request.method === 'GET' || request.method === 'HEAD');
    if (!refused && !tokenRead) return;
    const db = app.database.dbApp;
    if (db === null) return;
    const requestId = toCanonicalId(request.requestId);
    const ip = toAddressBytes(request.ip);
    const length = Number(reply.getHeader('content-length'));
    try {
      await db
        .insertInto('access_log')
        .values({
          occurred_at: app.clock.date(),
          user_id: idBytes(principal.userId),
          token_id: principal.kind === 'token' ? idBytes(principal.tokenId) : null,
          surface: 'rest',
          action,
          // A refused resource is never resolved again for logging, including its existence or vault.
          vault_id: refused || request.vault === null ? null : idBytes(request.vault.id),
          note_ids: null,
          note_ids_truncated: false,
          revision: null,
          status: statusOf(reply.statusCode),
          latency_ms: Math.min(
            4_294_967_295,
            Math.max(
              0,
              Math.round(app.clock.monotonic() - (started.get(request) ?? app.clock.monotonic())),
            ),
          ),
          bytes_out:
            Number.isSafeInteger(length) && length >= 0 && length <= 4_294_967_295 ? length : null,
          client_name: request.iridiumClient,
          client_version: boundedClientVersion(request.iridiumClientVersion),
          oauth_client_id: null,
          ip: ip === null ? null : Buffer.from(ip),
          request_id: requestId === null ? null : idBytes(requestId),
        })
        .execute();
    } catch (error) {
      // Access telemetry cannot change an already-sent response or manufacture an audit mutation.
      request.log.error(
        { event: 'access_log.write_failed', err: error, action },
        'Access observation could not be recorded',
      );
    }
  });
}

/** VARCHAR(32) counts Unicode code points; this is protocol metadata, not display text. */
function boundedClientVersion(value: string | null): string | null {
  if (value === null) return null;
  // eslint-disable-next-line typescript/no-misused-spread -- preserve whole code points within the column bound
  return [...value].slice(0, 32).join('');
}
