/**
 * The operations surface (09-api-reference.md section 2.17): `/healthz`, `/readyz` and `/metrics`.
 *
 * These three are the only routes outside `/api/v1` that Iridium answers itself with a body of its
 * own design, and they are the only ones that keep answering while `ReadinessState ≠ ready`. They
 * carry no path version, because a probe URL lives in a compose file, a systemd unit and a proxy
 * configuration that Iridium cannot edit (D09-31).
 *
 * The readiness check names are the readiness table of 11-operations-and-deployment.md, the `check`
 * label of `iridium_readyz_check_status` and what the alert rules match on — one list, so
 * `readyz.integration` can assert the served set equals it.
 */

import { z } from 'zod';

import { Timestamp } from '../time.ts';

/** `GET /healthz` — liveness. `503` while the event-loop lag is at or above one second. */
export interface HealthzBody {
  readonly status: 'ok';
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly eventLoopLagMs: number;
}

/** `GET /healthz`. */
export const HealthzBody: z.ZodType<HealthzBody> = z
  .strictObject({
    status: z.literal('ok'),
    version: z.string(),
    uptimeSeconds: z.int().nonnegative(),
    eventLoopLagMs: z.number().nonnegative(),
  })
  .meta({ id: 'HealthzBody' });

/** The sixteen readiness checks. */
export const READYZ_CHECK_NAMES = [
  'mysql_version',
  'db_app',
  'db_persist',
  'migrations',
  'grants',
  'durability',
  'attachment_store',
  'persist_backlog',
  'doc_budget',
  'collab_owner_lease',
  'projection_workers',
  'clock_skew',
  'key_versions',
  'tls_cert',
  'shutdown',
  'access_log_partitions',
] as const;

/** One of the sixteen readiness checks. */
export type ReadyzCheckName = (typeof READYZ_CHECK_NAMES)[number];

/** One of the sixteen readiness checks. */
export const ReadyzCheckName: z.ZodType<ReadyzCheckName> = z
  .enum(READYZ_CHECK_NAMES)
  .meta({ id: 'ReadyzCheckName' });

/** The per-check and overall vocabulary. One `fail` makes the whole body `fail` and the status 503. */
export const READYZ_STATUSES = ['ok', 'warn', 'fail'] as const;

/** A readiness status. */
export type ReadyzStatus = (typeof READYZ_STATUSES)[number];

/** A readiness status. */
export const ReadyzStatus: z.ZodType<ReadyzStatus> = z
  .enum(READYZ_STATUSES)
  .meta({ id: 'ReadyzStatus' });

/** One check as served. `durationMs` is measured by the runner, never by the check. */
export interface ReadyzCheck {
  readonly name: ReadyzCheckName;
  readonly status: ReadyzStatus;
  readonly detail?: string | undefined;
  readonly durationMs: number;
}

/** One check as served. */
export const ReadyzCheck: z.ZodType<ReadyzCheck> = z
  .strictObject({
    name: ReadyzCheckName,
    status: ReadyzStatus,
    detail: z.string().optional(),
    durationMs: z.int().nonnegative(),
  })
  .meta({ id: 'ReadyzCheck' });

/** `GET /readyz` — the same body with `200` and with `503`; the HTTP status is the signal. */
export interface ReadyzBody {
  readonly status: ReadyzStatus;
  readonly checks: readonly ReadyzCheck[];
  readonly checkedAt: string;
}

/** `GET /readyz`. */
export const ReadyzBody: z.ZodType<ReadyzBody> = z
  .strictObject({
    status: ReadyzStatus,
    checks: z.array(ReadyzCheck),
    checkedAt: Timestamp,
  })
  .meta({ id: 'ReadyzBody' });
