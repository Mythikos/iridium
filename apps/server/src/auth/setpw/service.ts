/**
 * One-time set-password links (04-auth-and-access-control.md section 3.3; D04-02; A28).
 *
 * One code path serves initial credential delivery and the administrator reset. Issuing a link
 * first supersedes every outstanding link of the same user by setting `expires_at = now` (only the
 * newest link is ever valid; `consumed_at` keeps its meaning "used"), then inserts
 * `{token_id, secret_hash, user_id, purpose, issued_by, expires_at}`. The link is
 * `<PUBLIC_ORIGIN>/set-password#<token>` — the token travels in the URL fragment, so it never
 * reaches a server, proxy or `Referer` log.
 *
 * Consumption runs inside the caller's transaction: the user then token are locked, the secret compared, the
 * three liveness conditions checked, the policy applied, `user_credentials` upserted,
 * `consumed_at` set and `users.authz_version` bumped. Invalid, expired, consumed and superseded
 * links all produce one answer (`invalid_link`) with no distinction. The route revokes the user's
 * sessions and audits `user.password.set`; PATs are untouched (A28).
 */
import { idFromBytes, mintToken, parseToken, type UserId } from '@iridium/contracts';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { AuthzEvent } from '../../authz/bus.ts';
import type { AuthzMutationRunner } from '../../authz/mutations.ts';
import type { Database } from '../../db/index.ts';
import type { PasswordSetupPurpose } from '../../db/schema.ts';
import type { PasswordHasher } from '../credentials/hasher.ts';
import type { PasswordPolicy, PasswordRuleId } from '../credentials/policy.ts';
import { idBytes, userIdFromBytes } from '../ids.ts';
import { secretHash, secretMatches } from '../secret-hash.ts';

/**
 * `password_policy.setupLinkHours` (03-data-model.md section 13.1), 24 h by default. The
 * `server_settings` row that tightens it arrives with the settings store (M7); until then the
 * default is the policy.
 */
export const SETUP_LINK_HOURS_DEFAULT = 24;

const MS_PER_HOUR = 3_600_000;

/** The SPA route that reads the fragment. */
export const SET_PASSWORD_PATH = '/set-password';

/** What issuing a link takes. */
export interface IssueLinkInput {
  readonly userId: UserId;
  readonly purpose: PasswordSetupPurpose;
  /** The administrator (or, for the CLI, the operator's resolved user) who issued it. */
  readonly issuedBy: UserId;
}

/** What issuing a link answers: the link (shown once) and the row id for the audit event. */
export interface IssuedLink {
  /** `<PUBLIC_ORIGIN>/set-password#irid_spl_…`. */
  readonly link: string;
  readonly tokenRowId: string;
  readonly expiresAt: Date;
}

/** What consuming a link takes. */
export interface ConsumeLinkInput {
  readonly token: string;
  readonly password: string;
}

/** What consuming a link answers. `invalid_link` covers every way a link can be unusable. */
export type ConsumeLinkResult =
  | {
      readonly ok: true;
      readonly userId: UserId;
      readonly purpose: PasswordSetupPurpose;
      readonly tokenRowId: string;
    }
  | { readonly ok: false; readonly failure: 'invalid_link' }
  | {
      readonly ok: false;
      readonly failure: 'policy';
      readonly violations: readonly PasswordRuleId[];
    };

/** What the service needs; the executor is passed per call so a caller's transaction is used. */
export interface SetPasswordLinksOptions {
  readonly publicOrigin: URL;
  readonly hasher: PasswordHasher;
  readonly policy: PasswordPolicy;
  readonly now: () => number;
  readonly newId: () => string;
  readonly setupLinkHours?: number;
}

/** An issuance transaction whose isolation and lifetime are owned by the set-password service. */
export interface SetupLinkTransaction {
  /** Other account writes and their audit events join this same transaction; audit locks stay last. */
  readonly db: Transaction<Database>;
  /** Issues on this transaction after taking the target user's primary-key lock. */
  readonly issue: (input: IssueLinkInput) => Promise<IssuedLink>;
}

/** An arbitrary open transaction cannot provide the issuance isolation guarantee. */
export class SetupLinkTransactionError extends Error {
  constructor() {
    super(
      'auth/setpw/service.ts cannot issue a link inside an arbitrary open transaction. ' +
        'Use SetPasswordLinks.withIssuanceTransaction with the database, and call its scoped issue function.',
    );
    this.name = 'SetupLinkTransactionError';
  }
}

/** Issues and consumes set-password links. One instance per process. */
export class SetPasswordLinks {
  readonly #options: SetPasswordLinksOptions;

  constructor(options: SetPasswordLinksOptions) {
    this.#options = options;
  }

  /** The link for a raw token, so the CLI and the admin route render it identically. */
  linkFor(raw: string): string {
    return `${this.#options.publicOrigin.origin}${SET_PASSWORD_PATH}#${raw}`;
  }

  /**
   * Owns READ COMMITTED for issuance and any surrounding account writes (04 section 3.3).
   *
   * Under REPEATABLE READ, expiring an empty ix_spl_user range takes a gap lock: issuers for
   * different new users can then deadlock when inserting into that same gap. READ COMMITTED
   * avoids those range locks; the explicit users primary-key lock serializes one user's links.
   * An already-open transaction is refused because its isolation cannot be changed here.
   */
  async withIssuanceTransaction<T>(
    db: Kysely<Database>,
    work: (scope: SetupLinkTransaction) => Promise<T>,
  ): Promise<T> {
    if (db.isTransaction) throw new SetupLinkTransactionError();
    return db
      .transaction()
      .setIsolationLevel('read committed')
      .execute((trx) =>
        work({
          db: trx,
          issue: (input) => this.#issue(trx, input),
        }),
      );
  }

  /** The same issuance scope, with the serving owner's admission and COMMIT barrier. */
  async withIssuanceMutation<T>(
    mutations: AuthzMutationRunner,
    userId: UserId,
    work: (scope: SetupLinkTransaction) => Promise<T>,
    eventsOf: (result: T) => readonly AuthzEvent[],
  ): Promise<T> {
    return mutations.run(
      { userId, isolation: 'read committed' },
      (trx) => work({ db: trx, issue: (input) => this.#issue(trx, input) }),
      eventsOf,
    );
  }

  /**
   * Resolve a secret-verified recipient before pausing live writes. This grants no authority:
   * consume rechecks the token and account under their ordinary locks in the mutation transaction.
   */
  async recipient(db: Kysely<Database>, token: string): Promise<UserId | null> {
    const parsed = parseToken(token);
    if (parsed === null || parsed.kind !== 'spl') return null;
    const row = await db
      .selectFrom('password_setup_tokens')
      .select(['user_id', 'secret_hash', 'expires_at', 'consumed_at'])
      .where('token_id', '=', parsed.tokenId)
      .executeTakeFirst();
    if (
      row === undefined ||
      !secretMatches(parsed.secret, row.secret_hash) ||
      row.consumed_at !== null ||
      this.#options.now() >= row.expires_at.getTime()
    )
      return null;
    return userIdFromBytes(row.user_id);
  }

  /** Issues and commits a link. Account writes use withIssuanceTransaction to remain atomic. */
  async issue(db: Kysely<Database>, input: IssueLinkInput): Promise<IssuedLink> {
    return this.withIssuanceTransaction(db, (scope) => scope.issue(input));
  }

  async #issue(db: Transaction<Database>, input: IssueLinkInput): Promise<IssuedLink> {
    const userId = idBytes(input.userId);
    await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    // Read time only after serialization: waiting for another issuer does not consume this TTL.
    const nowMs = this.#options.now();
    const now = new Date(nowMs);
    const hours = this.#options.setupLinkHours ?? SETUP_LINK_HOURS_DEFAULT;
    const expiresAt = new Date(nowMs + hours * MS_PER_HOUR);

    await db
      .updateTable('password_setup_tokens')
      .set({ expires_at: now })
      .where('user_id', '=', userId)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', now)
      .execute();

    const minted = mintToken('spl');
    const rowId = this.#options.newId();
    await db
      .insertInto('password_setup_tokens')
      .values({
        id: idBytes(rowId),
        token_id: minted.tokenId,
        secret_hash: secretHash(minted.secret),
        user_id: userId,
        purpose: input.purpose,
        issued_by: idBytes(input.issuedBy),
        expires_at: expiresAt,
        consumed_at: null,
        created_at: now,
      })
      .execute();

    return { link: this.linkFor(minted.raw), tokenRowId: rowId, expiresAt };
  }

  /**
   * Consumes in the caller's transaction, or owns one for a bare database. User then token are
   * locked in issuance order. The token is reread after the user lock, so supersession cannot race.
   */
  async consume(db: Kysely<Database>, input: ConsumeLinkInput): Promise<ConsumeLinkResult> {
    const parsed = parseToken(input.token);
    if (parsed === null || parsed.kind !== 'spl') return { ok: false, failure: 'invalid_link' };

    if (!db.isTransaction) {
      return db.transaction().execute((trx) => this.consume(trx, input));
    }

    // This discovery read grants nothing and takes no token lock. Locking the joined token first
    // would invert issuance's users -> token order. Its snapshot may be old; validation below is
    // against a fresh locking read after the same user serialization point as issuance.
    const candidate = await db
      .selectFrom('password_setup_tokens')
      .select(['id', 'user_id', 'secret_hash'])
      .where('token_id', '=', parsed.tokenId)
      .executeTakeFirst();
    if (!secretMatches(parsed.secret, candidate?.secret_hash ?? null) || candidate === undefined) {
      return { ok: false, failure: 'invalid_link' };
    }
    const user = await db
      .selectFrom('users')
      .select(['email', 'status'])
      .where('id', '=', candidate.user_id)
      .forUpdate()
      .executeTakeFirst();
    if (user === undefined) return { ok: false, failure: 'invalid_link' };
    const row = await db
      .selectFrom('password_setup_tokens')
      .select(['id', 'secret_hash', 'user_id', 'purpose', 'expires_at', 'consumed_at'])
      .where('id', '=', candidate.id)
      .where('user_id', '=', candidate.user_id)
      .forUpdate()
      .executeTakeFirst();

    if (!secretMatches(parsed.secret, row?.secret_hash ?? null) || row === undefined) {
      return { ok: false, failure: 'invalid_link' };
    }
    const nowMs = this.#options.now();
    if (row.consumed_at !== null || nowMs >= row.expires_at.getTime() || user.status !== 'active') {
      return { ok: false, failure: 'invalid_link' };
    }

    const checked = this.#options.policy.check(input.password, { email: user.email });
    if (!checked.ok) return { ok: false, failure: 'policy', violations: checked.violations };

    const hashed = await this.#options.hasher.hash(checked.normalized);
    const now = new Date(nowMs);
    await db
      .insertInto('user_credentials')
      .values({
        user_id: row.user_id,
        password_hash: hashed.phc,
        pepper_version: hashed.pepperVersion,
        password_changed_at: now,
      })
      .onDuplicateKeyUpdate({
        password_hash: hashed.phc,
        pepper_version: hashed.pepperVersion,
        password_changed_at: now,
      })
      .execute();
    await db
      .updateTable('password_setup_tokens')
      .set({ consumed_at: now })
      .where('id', '=', row.id)
      .execute();
    await db
      .updateTable('users')
      .set({ authz_version: sql`authz_version + 1`, updated_at: now })
      .where('id', '=', row.user_id)
      .execute();

    return {
      ok: true,
      userId: userIdFromBytes(row.user_id),
      purpose: row.purpose,
      tokenRowId: idFromBytes(row.id),
    };
  }
}
