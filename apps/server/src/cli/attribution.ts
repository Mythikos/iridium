/**
 * Who a CLI mutation was, as the audit row records it (OPS-19; 11-operations-and-deployment.md, the
 * `Audit` row of "Running the CLI").
 *
 * The rule is one sentence and this module is all of it: *CLI mutations record `actor_type='system'`,
 * `credential_type='cli'`, and `context = {os_user, host, request_id, argv_shape}`; the optional
 * `--actor <email>` sets `actor_id` to a named server admin.* Two halves are worth stating because
 * both are easy to get wrong in the direction that loses evidence:
 *
 *  - **`argv_shape`, never the argv.** An audit row that quoted the command line would eventually
 *    carry an email address, a note id or — the day a flag takes one — a secret. The shape answers
 *    "what was run" without carrying a single value (`cli/args.ts`'s `argvShape`).
 *  - **`--actor` attributes, it does not authorise.** Resolving an email to a server administrator
 *    puts a human in the row; it grants nothing, because an operator holding the environment already
 *    has every capability the CLI has. That is why a non-admin or a disabled account is refused
 *    rather than silently recorded: an `actor_id` naming someone who could not have done this is
 *    worse than no `actor_id` at all.
 */
import { hostname, userInfo } from 'node:os';

import { newId, type Principal, type UserId } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import type { AuditEventContext, AuditEventInput } from '../audit/chain.ts';
import { userIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/index.ts';

/** The three actor columns of an audited CLI mutation. */
export interface CliActor {
  readonly actorType: AuditEventInput['actorType'];
  readonly actorId: string | null;
  readonly actorDisplay: string | null;
  /** The resolved administrator, for `SystemPrincipal.onBehalfOf`; `null` without `--actor`. */
  readonly userId: UserId | null;
}

/** The default: an operator holding the environment, attributable to no human. */
export const SYSTEM_ACTOR: CliActor = Object.freeze({
  actorType: 'system',
  actorId: null,
  actorDisplay: null,
  userId: null,
});

/** What resolving `--actor` answers. A refusal carries the sentence the operator reads. */
export type ActorResult =
  | { readonly ok: true; readonly actor: CliActor }
  | { readonly ok: false; readonly message: string };

/**
 * Resolves `--actor <email>` to an active server administrator.
 *
 * Unknown, disabled, deleted and non-administrator all refuse, and the message says which: this is an
 * operator typing an address at a terminal, so naming the reason costs nothing and saves a support
 * round trip. There is no enumeration concern here — the caller already holds the database.
 */
export async function resolveCliActor(
  db: Kysely<Database>,
  email: string | undefined,
): Promise<ActorResult> {
  if (email === undefined) return { ok: true, actor: SYSTEM_ACTOR };

  const row = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'is_server_admin', 'status'])
    .where('email_key', '=', email.toLowerCase())
    .executeTakeFirst();

  if (row === undefined) {
    return { ok: false, message: `--actor ${email}: no user carries that address` };
  }
  if (row.status !== 'active') {
    return { ok: false, message: `--actor ${email}: that account is ${row.status}, not active` };
  }
  if (!row.is_server_admin) {
    return {
      ok: false,
      message:
        `--actor ${email}: that account is not a server administrator. The flag attributes the ` +
        'action to a human who could have performed it; it grants nothing.',
    };
  }

  const userId = userIdFromBytes(row.id);
  return {
    ok: true,
    actor: {
      actorType: 'user',
      actorId: userId,
      // `actor_display` is a name an auditor needs and never an email (03-data-model.md §12.1).
      actorDisplay: row.display_name,
      userId,
    },
  };
}

/** One run's `audit_events.context`, as OPS-19 spells it. */
export interface CliContextOptions {
  /** `cli/args.ts`'s `argvShape`: the command path with every value elided. */
  readonly argvShape: string;
  /** Correlates the audit rows of one invocation; generated once per run. */
  readonly requestId: string;
}

/**
 * The context every CLI audit row carries.
 *
 * `ip`, `user_agent`, `client` and `mcp_client` are deliberately absent rather than `null`: an absent
 * member and a null one are distinguishable in the stored JSON and in the hashed pre-image, and "this
 * surface has no such thing" is the honest one for a command run at a terminal.
 */
export function cliAuditContext(options: CliContextOptions): AuditEventContext {
  return {
    os_user: osUser(),
    host: hostname(),
    request_id: options.requestId,
    argv_shape: options.argvShape,
  };
}

/** A fresh correlation id for one invocation. */
export function newRequestId(): string {
  return newId();
}

/**
 * The system principal a CLI command hands to a service (04-auth-and-access-control.md §5.1, D04-21:
 * "Construct one yourself only in the job scheduler, migrations, the CLI and
 * `CollabGateway.openServerEdit()`"). `onBehalfOf` carries the `--actor` administrator when one was
 * resolved, so a service that records who it acted for records the same human the audit row names.
 */
export function cliPrincipal(commandPath: string, actor: CliActor): Principal {
  return {
    kind: 'system',
    job: `cli:${commandPath}`,
    ...(actor.userId === null ? {} : { onBehalfOf: actor.userId }),
  };
}

/** The invoking OS user, or `null` where the platform cannot name one. */
function osUser(): string | null {
  try {
    return userInfo().username;
  } catch {
    // `userInfo()` throws when the uid has no passwd entry — a container running as an arbitrary
    // uid, which is exactly how the production image runs. The row stays honest with `null`.
    return null;
  }
}
