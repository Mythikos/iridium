/**
 * Boot step 9, the `collab` plugin.
 *
 * M1 fills it in: the `Hocuspocus` instance with the four Iridium extensions, the
 * `app.get('/collab', { websocket: true, preValidation: [originAllowlist, connectionCaps] })` mount,
 * the `CollabGateway`, and the boot-time sweep that closes any loaded document whose note is trashed
 * (02-system-architecture.md boot step 9; 05-collaboration-and-durability.md).
 *
 * The three readiness checks this subsystem owns — `persist_backlog`, `doc_budget` and the
 * `collab_owner_lease` half of `db_persist` — are registered here when it lands. Until then `/readyz`
 * serves them as `warn` with a detail naming the absent subsystem rather than omitting them, because
 * the served check-name set must always equal `ReadyzCheckName`: a check that disappears would make the
 * alert expression that matches on it silently stop matching.
 */
import type { FastifyInstance } from 'fastify';

/** Applies boot step 9. An empty stub until the milestone named above. */
export function applyCollabPlugin(_app: FastifyInstance): void {
  // Intentionally empty: the plugin order of 02-system-architecture.md is established at M0
  // so that a later milestone adds behaviour to a named step rather than a new step.
}
