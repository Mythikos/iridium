/**
 * Boot step 4, the `auth` plugin.
 *
 * M1 fills it in: `request.principal`, `authenticate()` as an `onRequest` hook, argon2id credentials
 * through `@node-rs/argon2`, sessions, the single token verifier `verifyToken` (`irid_pat_` and
 * `irid_oat_`), the `TicketStore`, set-password links and the `RateLimiterMySQL` login throttle
 * (04-auth-and-access-control.md sections 3 to 6).
 *
 * Two things are already true and are what this stub records, so the pieces around it are correct
 * before it exists. `request.principal` is `null` here, which is the anonymous case every later branch
 * starts from; and `request.principalKey` — declared by the security plugin, because the rate limiter
 * needs one key source rather than two — stays `null`, which selects the 60/min per-IP tier of
 * 09-api-reference.md section 1.8 rather than the 600/min per-principal one.
 */
import type { FastifyInstance } from 'fastify';

/** Applies boot step 4. An empty stub until the milestone named above. */
export function applyAuthPlugin(_app: FastifyInstance): void {
  // Intentionally empty: the plugin order of 02-system-architecture.md is established at M0
  // so that a later milestone adds behaviour to a named step rather than a new step.
}
