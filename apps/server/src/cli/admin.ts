/**
 * `iridium admin create-user --email <e> --display-name <n> [--server-admin]`
 * (04-auth-and-access-control.md §3.2; 11-operations-and-deployment.md, "Users, vaults, sessions,
 * tokens"; 12-milestones.md §5.2, the `apps/server/src/cli` row).
 *
 * This is how a deployment gets its first human. There is no registration route and no
 * environment-variable bootstrap of an admin password, because no plaintext password may ever transit
 * an operator or an environment (A28) — so the command creates the row **without credentials** and
 * prints a one-time set-password link that the new administrator consumes through
 * `POST /auth/set-password`.
 *
 * **It creates nothing itself.** §3.2 is verbatim that the CLI and `POST /admin/users` "run the same
 * `users/service.ts#createUser`", so this module resolves the flags, builds that service's
 * dependencies from the instance and renders what it answered. A second insert path would eventually
 * disagree with the route about the email uniqueness rule, the link's lifetime or the audit row — and
 * the audit row is written by the service, inside the same transaction as the user it describes, with
 * `credential_type='cli'` because the actor it is handed is the CLI's.
 *
 * **The flag spellings are 12 §5.2's and §3.2's**: `--email`, `--display-name`, `--server-admin`.
 * 11's own CLI table spells the same two flags `--name` and `--admin` and 02's bootstrap row spells
 * `--admin`; three spellings of two flags is a plan discrepancy rather than a choice, and the
 * milestone's is followed because `@iridium/testkit`'s seed drives it.
 */
import { DisplayName, Email } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import type { AuditEventContext } from '../audit/chain.ts';
import { toProblem as toDatabaseProblem } from '../db/failure.ts';
import { ProblemError } from '../security/problem.ts';
import { createUser, type AdminActor, type UserServiceDeps } from '../users/service.ts';
import { requireDatabase } from './app.ts';
import type { CliActor } from './attribution.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderPairs, type CliIo } from './output.ts';

/** What `admin create-user` needs after the flags are parsed. */
export interface CreateUserInput {
  readonly io: CliIo;
  readonly app: FastifyInstance;
  readonly email: string | undefined;
  readonly displayName: string | undefined;
  readonly serverAdmin: boolean;
  readonly actor: CliActor;
  readonly context: AuditEventContext;
  /** `--json`: the `AdminUserCreated` body `POST /admin/users` answers, so one shape serves both. */
  readonly json: boolean;
}

/** The service's dependencies, built from the instance exactly as `applyAdminUserRoutes` builds them. */
export function userServiceDeps(app: FastifyInstance, command: string): UserServiceDeps {
  return {
    db: requireDatabase(app, command),
    audit: app.audit,
    setpw: app.auth.setpw,
    sessionRepository: (trx) => app.auth.sessionRepository(trx),
  };
}

/** The CLI's `AdminActor`: the operator, carrying the `--actor` administrator when one was resolved. */
export function adminActorOf(actor: CliActor): AdminActor {
  return {
    kind: 'cli',
    ...(actor.userId === null || actor.actorDisplay === null
      ? {}
      : { onBehalfOf: { userId: actor.userId, displayName: actor.actorDisplay } }),
  };
}

/** Runs `iridium admin create-user`. */
export async function runCreateUser(input: CreateUserInput): Promise<number> {
  const email = Email.safeParse(input.email);
  if (!email.success) {
    input.io.err(
      'iridium admin create-user: --email must be an address the server accepts, for example ' +
        '--email ops@example.com',
    );
    return EXIT.usage;
  }
  const displayName = DisplayName.safeParse(input.displayName);
  if (!displayName.success) {
    input.io.err(
      'iridium admin create-user: --display-name must be a name the server accepts, for example ' +
        '--display-name "Ops Team". It is what an auditor sees; the address never appears in an ' +
        'audit row.',
    );
    return EXIT.usage;
  }

  let created: Awaited<ReturnType<typeof createUser>>;
  try {
    created = await createUser(userServiceDeps(input.app, 'admin create-user'), {
      email: email.data,
      displayName: displayName.data,
      isServerAdmin: input.serverAdmin,
      actor: adminActorOf(input.actor),
      context: input.context,
      now: input.app.clock.date(),
    });
  } catch (error) {
    // A duplicate address reaches the route as `409 email_conflict` through the problem registry,
    // which is an HTTP boundary this command does not have — so the same mapper is applied here,
    // rather than matching on a driver message a second time. To an operator it is a refused
    // precondition and not a crash.
    const problem = error instanceof ProblemError ? error : toDatabaseProblem(error);
    if (problem?.code === 'email_conflict') {
      input.io.err(
        `iridium admin create-user: ${email.data} already has an account. Addresses are unique ` +
          'case-insensitively; `iridium admin reset-password` is the command for an existing user.',
      );
      return EXIT.refused;
    }
    throw error;
  }

  // The events a creation justifies are published after its COMMIT, exactly as the route does; a
  // creation without memberships justifies none, and the loop says so rather than assuming it.
  for (const event of created.events) input.app.authz.bus.publish(event);

  if (input.json) {
    // The `AdminUserCreated` body verbatim (`@iridium/contracts/rest/admin-users.ts`), because
    // `@iridium/testkit`'s seed reads one shape whichever path created the user.
    input.io.out(
      renderJson({
        user: created.user,
        setPasswordLink: created.setPasswordLink,
        expiresAt: created.expiresAt.toISOString(),
      }),
    );
    return EXIT.success;
  }

  input.io.out(
    renderPairs([
      ['user', created.user.id],
      ['email', created.user.email],
      ['display name', created.user.displayName],
      ['server admin', created.user.isServerAdmin ? 'yes' : 'no'],
      ['set-password', created.setPasswordLink],
      ['expires', created.expiresAt.toISOString()],
    ]),
  );
  // On stderr, so a script capturing stdout captures the report and nothing else.
  input.io.err(
    'The set-password link is shown once and is not stored in plaintext. Deliver it out of band; ' +
      'it expires with the time above, and issuing another link supersedes this one.',
  );
  return EXIT.success;
}
