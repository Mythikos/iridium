/**
 * Boot step 12, the `jobs` plugin.
 *
 * M2 onwards fills it in: the scheduler claiming due rows in the `jobs` table with
 * `locked_by = <instanceId>`, and the ten scheduled types of 11-operations-and-deployment.md,
 * "Scheduled maintenance jobs".
 *
 * The mode table of ARCH-01 is what this stub has to respect when it lands: the scheduler runs in
 * `container` and `child` modes, and is off by default in `in-process` so a test calls `jobs.run(type)`
 * directly. `JOBS_ENABLED=false` turns it off in every mode, and `iridium_job_interval_seconds` is
 * published for every scheduled type even then — which is what makes a job that has never run alertable
 * rather than invisible.
 */
import type { FastifyInstance } from 'fastify';

/** Applies boot step 12. An empty stub until the milestone named above. */
export function applyJobsPlugin(_app: FastifyInstance): void {
  // Intentionally empty: the plugin order of 02-system-architecture.md is established at M0
  // so that a later milestone adds behaviour to a named step rather than a new step.
}
