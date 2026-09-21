/**
 * The SIEM vocabulary (11-operations-and-deployment.md, "Named events"; ARCH-15).
 *
 * `log.info({ event: … })` only compiles with a member of `LogEvent`, so the vocabulary cannot
 * drift: a new event is a change here, which is a change a reviewer sees. The grammar is
 * `<domain>.<object>.<verb>`, and `event` is the only field alerting and SIEM rules match on.
 *
 * The full list is declared at M0 even though most producers arrive with later milestones, because
 * the alternative is a union that grows by accident and a SIEM rule set written against whatever
 * happened to exist.
 */

/** Every named log event, as one closed list. */
export const LOG_EVENTS = [
  // Authentication
  'auth.login.succeeded',
  'auth.login.failed',
  'auth.login.throttled',
  'auth.logout',
  'auth.reauth.succeeded',
  'auth.reauth.failed',
  'auth.setpw.consumed',
  'auth.session.expired',
  'auth.session.revoked',
  // Authorization
  'authz.denied',
  'authz.csrf_rejected',
  'authz.origin_rejected',
  'authz.epoch_mismatch',
  // Collaboration
  'collab.connection.accepted',
  'collab.connection.rejected',
  'collab.connection.closed',
  'collab.write.rejected',
  'collab.role.changed',
  'collab.awareness.spoof',
  'collab.limit.exceeded',
  'collab.admission.refused',
  'collab.state_vector.oversize',
  'collab.owner_lease.denied',
  'collab.hook.error',
  // Persistence
  'persist.committed',
  'persist.failed',
  'persist.recovered',
  'persist.backpressure',
  'persist.cas_mismatch',
  'persist.drain_timeout',
  'compaction.completed',
  'compaction.refused',
  // Projection
  'projection.completed',
  'projection.timeout',
  'projection.invalid_content',
  'projection.reindex.progress',
  'links.index_capacity',
  // MCP
  'mcp.call',
  'mcp.denied',
  'mcp.rate_limited',
  'mcp.factory_error',
  'mcp.cursor_rejected',
  'mcp.handler.constructed',
  // OAuth
  'oauth.authorize.denied',
  'oauth.consent.granted',
  'oauth.consent.revoked',
  'oauth.token.issued',
  'oauth.token.denied',
  'oauth.refresh.rotated',
  'oauth.refresh.reuse_detected',
  'oauth.code.replayed',
  'oauth.client.registered',
  'oauth.client.expired',
  'oauth.cimd.fetch_refused',
  // Jobs and transfers
  'job.started',
  'job.succeeded',
  'job.failed',
  'job.cancelled',
  'access_log.write_failed',
  'import.scanned',
  'import.committed',
  'export.completed',
  // Operations
  'config.loaded',
  'migration.applied',
  'migration.pending',
  'migration.newer_schema_tolerated',
  'readyz.degraded',
  'readyz.recovered',
  'shutdown.started',
  'shutdown.drained',
  'backup.started',
  'backup.completed',
  'backup.failed',
  'restore.verify.completed',
  'keys.rotated',
  'pressure.shed',
  // HTTP — one line per response (ARCH-15, `disableRequestLogging`)
  'http.request',
] as const;

/** A member of the closed SIEM vocabulary. */
export type LogEvent = (typeof LOG_EVENTS)[number];
