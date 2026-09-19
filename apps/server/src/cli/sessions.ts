/**
 * `iridium sessions revoke-all [--user <email>]` hands a durable request to the serving owner.
 * That process fences admission and drains accepted edits before the revocation transaction. With
 * no serving owner, the CLI acquires the same schema lease and executes the identical command path.
 * A returned success means both the mutation and local revocation delivery completed. A lost or
 * delayed outcome remains addressable by the printed command id; it is never guessed as rollback.
 */
import { newId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';

import type { AuditEventContext } from '../audit/chain.ts';
import { userIdFromBytes } from '../auth/ids.ts';
import {
  SESSION_REVOCATION_POLL_MS,
  type SessionCommandResult,
} from '../authz/session-revocations.ts';
import { requireDatabase } from './app.ts';
import type { CliActor } from './attribution.ts';
import { EXIT } from './exit.ts';
import { renderPairs, type CliIo } from './output.ts';

/** CLI result-wait deadline, not an authorization grace period or a command expiry. */
const SESSION_COMMAND_WAIT_MS = 30_000;

export interface RevokeAllInput {
  readonly io: CliIo;
  readonly app: FastifyInstance;
  readonly userEmail: string | undefined;
  readonly actor: CliActor;
  readonly context: AuditEventContext;
}

/** Runs one durable request. A pending command keeps its id and authority after the CLI exits. */
export async function runSessionsRevokeAll(input: RevokeAllInput): Promise<number> {
  const db = requireDatabase(input.app, 'sessions revoke-all');
  const target =
    input.userEmail === undefined
      ? null
      : await db
          .selectFrom('users')
          .select('id')
          .where('email_key', '=', input.userEmail.toLowerCase())
          .executeTakeFirst();
  if (target === undefined) {
    input.io.err(`iridium sessions revoke-all: no user carries the address ${input.userEmail}`);
    return EXIT.refused;
  }
  const userId = target === null ? null : userIdFromBytes(target.id);
  const { store, relay } = input.app.authz.sessionCommands;
  const commandId = newId();
  // Print before INSERT too: its response can be lost after the request actually committed.
  input.io.out(renderPairs([['command', commandId]]));
  await store.submit({ id: commandId, userId, actor: input.actor, context: input.context });
  const deadline = input.app.clock.monotonic() + SESSION_COMMAND_WAIT_MS;
  let outcome: SessionCommandResult | null = null;
  try {
    while (input.app.clock.monotonic() < deadline) {
      // A denied attempt does not mutate. If the owner exits while this CLI waits, the same lease
      // safely turns it into the offline executor, including during a rolling restart.
      // eslint-disable-next-line no-await-in-loop -- ownership may change while waiting for this command
      if (await input.app.collab.ownerLease.tryAcquire()) {
        // eslint-disable-next-line no-await-in-loop -- one owned command and its effects at a time
        await relay.poll();
      }
      // eslint-disable-next-line no-await-in-loop -- read the result of this durable request
      const command = await store.find(commandId);
      if (command?.delivered === true) {
        outcome = command.result;
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- injected-clock polling with a fixed deadline
      await new Promise<void>((resolve) => {
        input.app.clock.after(SESSION_REVOCATION_POLL_MS, resolve);
      });
    }
  } finally {
    await input.app.collab.ownerLease.relinquish();
  }
  if (outcome === null) {
    input.io.err(
      `iridium sessions revoke-all: command ${commandId} remains pending; no rollback is implied. Inspect its durable result and server logs before issuing another command.`,
    );
    return EXIT.internal;
  }
  if (!outcome.ok) {
    input.io.err(
      `iridium sessions revoke-all: command ${commandId} rolled back; no sessions were revoked by it. Inspect server logs before retrying.`,
    );
    return EXIT.internal;
  }
  input.io.out(
    renderPairs([
      ['scope', userId ?? 'every user'],
      ['users', String(outcome.users)],
      ['sessions revoked', String(outcome.sessions.length)],
    ]),
  );
  return EXIT.success;
}
