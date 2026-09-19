/**
 * `iridium tokens revoke-all [--user <email>]` (11-operations-and-deployment.md, "Users, vaults,
 * sessions, tokens"; 04-auth-and-access-control.md §8; 12-milestones.md §5.2).
 *
 * Sets `revoked_at` on every live access token — rows are **never** deleted, because the access log
 * and the audit trail reference them — and publishes one `token.revoked` per token after COMMIT, so
 * the next MCP or REST call presenting it fails. The CLI never creates or prints a token secret
 * (11: "an operator who could mint an agent credential from a shell would defeat the 'a token can
 * never exceed its owner' property"); revoking is the only direction it works in.
 *
 * **Why the write lives here at M1, and where it goes next.** 12-milestones.md §5.2 gives M1
 * `tokens.ts` as a *verifier only* — "the lifecycle REST arrives in M3" — so this command is the only
 * writer of `access_tokens.revoked_at` in the milestone, and `auth/tokens/` deliberately has no
 * revocation module to call. `revokeTokens` below is written service-shaped rather than as inline
 * command code for exactly that reason: when M3 adds `DELETE /me/tokens/:tokenId` and
 * `POST /admin/users/:userId/revoke-tokens`, this function moves to `auth/tokens/revoke.ts` unchanged
 * and gains a second caller. It must not be copied — two revocation paths would eventually disagree
 * about the version bump and about which rows count as live.
 */
import type { TokenId, UserId } from '@iridium/contracts';
import type { FastifyInstance } from 'fastify';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuditEventContext } from '../audit/chain.ts';
import { idBytes, tokenIdFromBytes, userIdFromBytes } from '../auth/ids.ts';
import type { Database } from '../db/index.ts';
import { requireDatabase } from './app.ts';
import type { CliActor } from './attribution.ts';
import { EXIT } from './exit.ts';
import { renderPairs, type CliIo } from './output.ts';

/** `access_tokens.revoke_reason` for an operator-initiated revocation. */
const REVOKE_REASON = 'admin';

/** What `tokens revoke-all` needs after the flags are parsed. */
export interface RevokeTokensInput {
  readonly io: CliIo;
  readonly app: FastifyInstance;
  /** `--user <email>`; every live token on the server when absent. */
  readonly userEmail: string | undefined;
  readonly actor: CliActor;
  readonly context: AuditEventContext;
}

/** One revoked token, carried out of the transaction so it can be published after COMMIT. */
export interface RevokedToken {
  readonly userId: UserId;
  readonly tokenId: TokenId;
}

/**
 * Revokes every live token, optionally of one owner, inside the caller's transaction.
 *
 * The rows are read first so the caller can publish one bus event per token: `token.revoked` carries
 * the token id, and a bulk `UPDATE` that only answered a row count could not produce them. The
 * `version` bump is deliberate — a row whose state changed without its version moving would break the
 * `If-Match` the M3 token routes will take.
 */
export async function revokeTokens(
  trx: Transaction<Database>,
  options: {
    readonly userId: UserId | null;
    readonly revokedAt: Date;
    readonly revokedBy: UserId | null;
  },
): Promise<readonly RevokedToken[]> {
  let live = trx
    .selectFrom('access_tokens')
    .select(['id', 'user_id'])
    .where('revoked_at', 'is', null);
  if (options.userId !== null) live = live.where('user_id', '=', idBytes(options.userId));
  const rows = await live.execute();
  if (rows.length === 0) return [];

  await trx
    .updateTable('access_tokens')
    .set({
      revoked_at: options.revokedAt,
      revoked_by: options.revokedBy === null ? null : idBytes(options.revokedBy),
      revoke_reason: REVOKE_REASON,
      version: sql<number>`version + 1`,
    })
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .where('revoked_at', 'is', null)
    .execute();

  return rows.map((row) => ({
    userId: userIdFromBytes(row.user_id),
    tokenId: tokenIdFromBytes(row.id),
  }));
}

/** Runs `iridium tokens revoke-all`. */
export async function runTokensRevokeAll(input: RevokeTokensInput): Promise<number> {
  const db = requireDatabase(input.app, 'tokens revoke-all');
  const owner = await resolveOwner(db, input.userEmail);
  if (!owner.ok) {
    input.io.err(`iridium tokens revoke-all: ${owner.message}`);
    return EXIT.refused;
  }

  const revokedAt = input.app.clock.date();
  const revoked = await db.transaction().execute(async (trx) => {
    const tokens = await revokeTokens(trx, {
      userId: owner.userId,
      revokedAt,
      revokedBy: input.actor.userId,
    });

    // The audit row is the last statement of the transaction. A run that revoked nothing is still
    // recorded: "no agent credential was live when the operator reached for the hammer" is the fact
    // an incident review needs, and it is indistinguishable from "the command was never run" if the
    // no-op writes nothing.
    await input.app.audit.record(trx, {
      action: 'token.revoked_all',
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      actorDisplay: input.actor.actorDisplay,
      credentialType: 'cli',
      ...(owner.userId === null ? {} : { targetType: 'user', targetId: owner.userId }),
      targets: tokens.map((token) => ({ type: 'token', id: token.tokenId })),
      outcome: 'success',
      reason: REVOKE_REASON,
      context: input.context,
      metadata: {
        scope: owner.userId === null ? 'server' : 'user',
        revoked: tokens.length,
      },
    });
    return tokens;
  });

  for (const token of revoked) {
    input.app.authz.bus.publish({
      type: 'token.revoked',
      userId: token.userId,
      tokenId: token.tokenId,
    });
  }

  input.io.out(
    renderPairs([
      ['scope', owner.userId === null ? 'every user' : owner.userId],
      ['tokens revoked', String(revoked.length)],
    ]),
  );
  return EXIT.success;
}

/** The owner a run covers, or the sentence naming why the address resolves to nobody. */
type OwnerResult =
  | { readonly ok: true; readonly userId: UserId | null }
  | { readonly ok: false; readonly message: string };

async function resolveOwner(db: Kysely<Database>, email: string | undefined): Promise<OwnerResult> {
  if (email === undefined) return { ok: true, userId: null };
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('email_key', '=', email.toLowerCase())
    .executeTakeFirst();
  if (row === undefined) return { ok: false, message: `no user carries the address ${email}` };
  return { ok: true, userId: userIdFromBytes(row.id) };
}
