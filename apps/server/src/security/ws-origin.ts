/**
 * The `/collab` Origin allowlist (04-auth-and-access-control.md §7.5; skeleton A24).
 *
 * It runs as `preValidation` on `app.get('/collab', {websocket: true, …})` — that is, on the HTTP upgrade
 * request — and answers `403` before any WebSocket handshake completes. The allowlist is:
 *
 * ```
 * PUBLIC_ORIGIN
 * app://iridium                                        (the Electron renderer's privileged scheme)
 * DEV_ORIGINS                                          (only when NODE_ENV=development)
 * ```
 *
 * **An absent `Origin` is rejected, always, with no bypass switch.** Non-browser clients can always set
 * the header, and an environment flag such as `IRIDIUM_ALLOW_NO_ORIGIN_WS` would inevitably be enabled in
 * production "to make the desktop work" and would then accept any CLI or server-side attacker that can
 * reach the port. That is settled in A24, and `EnvSchema` refuses the flag *by name* so nobody can
 * reintroduce it as configuration (`config/env.ts`, `REJECTED_KEYS`).
 *
 * The comparison is an exact string comparison against the serialised origin — `scheme://host[:port]`,
 * lower-cased host — so a case-mutated host or a different port is a different origin. `new URL().origin`
 * is what normalises the configured values; the header is compared as sent, because a browser sends the
 * serialised form and anything else is not a browser.
 *
 * **Why it lives in `security/` and not in `collab/`.** Cross-site WebSocket hijacking is a transport
 * concern, the same one the CSRF guard answers for REST, and the `collab-server` stream mounts this hook
 * rather than writing its own. The Host check of the same `preValidation` chain is `security/plugin.ts`'s
 * Host guard, which already covers every route.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { IridiumConfig } from '../config/env.ts';
import { sendProblem } from './problem.ts';

/** The Electron renderer's origin: the privileged `app://iridium` scheme registered with CORS enabled. */
export const DESKTOP_ORIGIN = 'app://iridium';

/** Why an upgrade was refused. */
export type WsOriginRejection = 'absent' | 'not_allowed';

/**
 * The three configured values the allowlist is built from — a slice, never the whole configuration
 * object, so the policy can be stated in a test without constructing a server's configuration.
 */
export interface CollabOriginPolicy {
  /** `NODE_ENV`; only `development` admits `DEV_ORIGINS`. */
  readonly env: string;
  /** `PUBLIC_ORIGIN`, already serialised (`scheme://host[:port]`). */
  readonly publicOrigin: string;
  readonly devOrigins: readonly string[];
}

/** The slice out of a parsed configuration. */
export function collabOriginPolicy(config: IridiumConfig): CollabOriginPolicy {
  return {
    env: config.env,
    publicOrigin: config.server.publicOrigin.origin,
    devOrigins: config.server.devOrigins,
  };
}

/**
 * The origins an upgrade may carry, in the order §7.5 lists them.
 *
 * `DEV_ORIGINS` is admitted **only** under `NODE_ENV=development`; `EnvSchema` already refuses the key
 * outside development, so this is the second of two independent gates rather than the only one.
 */
export function collabAllowedOrigins(policy: CollabOriginPolicy): readonly string[] {
  const allowed = [policy.publicOrigin, DESKTOP_ORIGIN];
  if (policy.env === 'development') allowed.push(...policy.devOrigins);
  return Object.freeze(allowed);
}

/** §7.5's decision, as a pure function so `security.ws-origin.integration` can drive the table. */
export function collabOriginDecision(
  origin: string | undefined,
  allowed: readonly string[],
): { readonly allow: true } | { readonly allow: false; readonly reason: WsOriginRejection } {
  if (origin === undefined) return { allow: false, reason: 'absent' };
  return allowed.includes(origin) ? { allow: true } : { allow: false, reason: 'not_allowed' };
}

/** A `preValidation` hook the `collab` plugin mounts on the `/collab` upgrade route. */
export type CollabOriginHook = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Builds the hook.
 *
 * The rejection is a `ProblemDetails` `403 forbidden` body, which is what 09-api-reference.md §1.4 and
 * §3.1 specify for the two upgrade guards (the socket caps answer `429 rate_limited` instead), and it is
 * logged as `authz.origin_rejected`.
 */
export function createCollabOriginGuard(policy: CollabOriginPolicy): CollabOriginHook {
  const allowed = collabAllowedOrigins(policy);

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.origin;
    const origin = Array.isArray(header) ? header[0] : header;
    const decision = collabOriginDecision(origin, allowed);
    if (decision.allow) return;

    request.log.warn(
      {
        event: 'authz.origin_rejected',
        route: request.routeOptions.url ?? request.url,
        reason: decision.reason,
        ip: request.ip,
      },
      'collab upgrade rejected by the origin allowlist',
    );
    await sendProblem(request, reply, 'forbidden', {
      detail:
        decision.reason === 'absent'
          ? 'A /collab upgrade must carry an Origin header. There is no bypass for an absent Origin (A24).'
          : 'This Origin is not allowed to open a collaboration connection to this server.',
    });
  };
}
