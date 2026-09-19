/**
 * `verifyToken` — the single verification path for `irid_pat_…` and `irid_oat_…`
 * (04-auth-and-access-control.md section 9.1, D04-26, D04-30; 06-mcp-and-agent-access.md,
 * "Storage and verification"; A23; A31).
 *
 * One module, one exported entry point, dispatching on the credential prefix. `mcp/verifier.ts`
 * wraps it for the SDK (M3) and never duplicates it. It performs one indexed read of
 * `access_tokens` joined to `users` — with two primary-key `LEFT JOIN`s that carry consent and
 * client liveness for an OAuth token — plus the allowlist read, on **every** call: the "fresh
 * token row per call" of A23. Nothing else in the server constructs a token principal.
 *
 * The ordered steps of 06's table are numbered in `verify()` so a reader can hold the two side by
 * side. Steps 4–9 fail for a *real* row and are reported to the caller as a denial it may audit
 * (`token.denied`, bounded per token id); steps 2 and 3 cost no audit row and, for step 2, no
 * database access. Every failure answers the same status and header on the wire; only the
 * description differs.
 *
 * M1 ships the verifier only: the lifecycle REST of 06 arrives in M3, and the OAuth rows it reads
 * are created in M3 — the joins exist from the start so the OAuth branch adds no second path.
 */
import {
  idFromBytes,
  isKindAcceptedOn,
  LIMITS,
  MOUNT_ACCEPTED_KIND,
  parseTokenDetailed,
  toEffectivePermissions,
  type BearerMount,
  type TokenId,
  type TokenParseFailure,
  type TokenPrincipal,
  type UserId,
  type VaultId,
} from '@iridium/contracts';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/index.ts';
import type { TokenAuthFailureReason } from '../../ops/metrics.ts';
import { idBytes, tokenIdFromBytes, userIdFromBytes, vaultIdFromBytes } from '../ids.ts';
import { secretMatches } from '../secret-hash.ts';

/** What a caller states about the route: the mount (which fixes the accepted kind) and its URI. */
export interface VerifyTokenOptions {
  /** `'mcp'`, `'mcp-connect'` or `'rest'` — the starred REST reads accept a PAT only. */
  readonly mount: BearerMount;
  /**
   * The route's canonical RFC 8707 URI: `<PUBLIC_ORIGIN>/mcp/connect` on the connector mount,
   * where step 5a compares it with `access_tokens.resource`; `<PUBLIC_ORIGIN>/mcp` on `/mcp`,
   * where it only fills `AuthInfo.resource`; absent on the REST reads.
   */
  readonly resource?: string;
}

/** Why a token was refused; the `reason` label of `iridium_token_auth_failures_total`. */
export type TokenDenialReason =
  | TokenParseFailure
  | 'unknown_id'
  | 'secret_mismatch'
  | 'wrong_kind_for_route'
  | 'audience_mismatch'
  | 'consent_revoked'
  | 'client_disabled'
  | 'revoked'
  | 'rotation_overlap_elapsed'
  | 'expired'
  | 'user_inactive';

/**
 * The failures of steps 4–9: each names a real row, which is what makes it worth a bounded
 * `token.denied` audit row. A denial carries one of these by type, so the audit hook never has to
 * ask whether a denial is audited.
 */
export type AuditedTokenDenialReason = Exclude<TokenDenialReason, TokenParseFailure | 'unknown_id'>;

/**
 * The `iridium_token_auth_failures_total{reason}` label of each denial (11, "Metrics"). The four
 * shape failures are one `bad_format`; an absent row and a wrong secret are one `unknown`, because
 * a caller cannot tell them apart either; a rotated token past its overlap is `expired`.
 */
export const TOKEN_AUTH_FAILURE_LABELS: Readonly<
  Record<TokenDenialReason, TokenAuthFailureReason>
> = {
  not_a_credential: 'bad_format',
  unknown_kind: 'bad_format',
  malformed: 'bad_format',
  crc_mismatch: 'bad_format',
  unknown_id: 'unknown',
  secret_mismatch: 'unknown',
  wrong_kind_for_route: 'wrong_kind_for_route',
  audience_mismatch: 'audience_mismatch',
  consent_revoked: 'consent_revoked',
  client_disabled: 'client_disabled',
  revoked: 'revoked',
  rotation_overlap_elapsed: 'expired',
  expired: 'expired',
  user_inactive: 'user_disabled',
};

/**
 * A refusal of a *real* row (steps 4–9), with what the bounded `token.denied` audit row needs: the
 * row, which credential kind it is (`credential_type` is `pat` or `oauth`, 04 section 11.1) and its
 * owner (`on_behalf_of_user_id`). Steps 2 and 3 name no row and produce no denial.
 */
export interface TokenDenial {
  readonly reason: AuditedTokenDenialReason;
  readonly tokenRowId: string;
  readonly tokenKind: 'pat' | 'oauth';
  readonly ownerUserId: UserId;
}

/** What `verifyToken` answers. */
export type VerifyTokenResult =
  | { readonly ok: true; readonly principal: TokenPrincipal; readonly authInfo: AuthInfo }
  | {
      readonly ok: false;
      readonly reason: TokenDenialReason;
      /** ASCII, safe for `WWW-Authenticate`; never carries any part of the credential. */
      readonly publicReason: string;
      /** The row this denial concerns, for the bounded audit; `null` for steps 2–3. */
      readonly denial: TokenDenial | null;
    };

/** The row step 3 reads: the token, its owner's liveness, and the OAuth liveness columns. */
export interface TokenRowWithOwner {
  readonly id: Buffer;
  readonly token_id: string;
  readonly secret_hash: Buffer;
  readonly user_id: Buffer;
  readonly kind: 'pat' | 'oauth' | 'scim';
  readonly scopes: readonly string[];
  readonly all_vaults: boolean;
  readonly admin_owned: boolean;
  readonly expires_at: Date;
  readonly rate_limit_per_hour: number | null;
  readonly rotation_overlap_until: Date | null;
  readonly resource: string | null;
  readonly revoked_at: Date | null;
  readonly consent_id: Buffer | null;
  readonly user_status: 'active' | 'disabled' | 'deleted';
  readonly consent_revoked_at: Date | null;
  readonly client_public_id: string | null;
  readonly client_status: 'active' | 'disabled' | null;
}

/** The port the verifier reads through; the Kysely adapter is below, the unit test fakes it. */
export interface TokenRepository {
  findByTokenId(tokenId: string): Promise<TokenRowWithOwner | null>;
  /** The explicit allowlist of a token with `all_vaults = 0`. */
  allowlist(tokenRowId: Buffer): Promise<readonly VaultId[]>;
}

/** The Kysely adapter over `access_tokens`, `users`, `oauth_consents` and `oauth_clients`. */
export class KyselyTokenRepository implements TokenRepository {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async findByTokenId(tokenId: string): Promise<TokenRowWithOwner | null> {
    const row = await this.#db
      .selectFrom('access_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .leftJoin('oauth_consents as c', 'c.id', 't.consent_id')
      .leftJoin('oauth_clients as cl', 'cl.id', 't.client_id')
      .select([
        't.id',
        't.token_id',
        't.secret_hash',
        't.user_id',
        't.kind',
        't.scopes',
        't.all_vaults',
        't.admin_owned',
        't.expires_at',
        't.rate_limit_per_hour',
        't.rotation_overlap_until',
        't.resource',
        't.revoked_at',
        't.consent_id',
        'u.status as user_status',
        'c.revoked_at as consent_revoked_at',
        'cl.client_id as client_public_id',
        'cl.status as client_status',
      ])
      .where('t.token_id', '=', tokenId)
      .executeTakeFirst();
    return row ?? null;
  }

  async allowlist(tokenRowId: Buffer): Promise<readonly VaultId[]> {
    const rows = await this.#db
      .selectFrom('access_token_vaults')
      .select('vault_id')
      .where('token_id', '=', tokenRowId)
      .execute();
    return rows.map((row) => vaultIdFromBytes(row.vault_id));
  }
}

const MS_PER_SECOND = 1000;

/** The other mount, named in a wrong-kind description so a misconfigured client can be fixed. */
function otherMountFor(mount: BearerMount): string {
  return MOUNT_ACCEPTED_KIND[mount] === 'pat' ? '/mcp/connect' : '/mcp';
}

function describe(reason: TokenDenialReason, mount: BearerMount): string {
  switch (reason) {
    case 'wrong_kind_for_route':
      return `this credential kind is accepted at ${otherMountFor(mount)}, not here`;
    case 'expired':
      return 'the token has expired';
    case 'not_a_credential':
    case 'unknown_kind':
    case 'malformed':
    case 'crc_mismatch':
      return 'the bearer credential is malformed';
    default:
      return 'the token is not valid';
  }
}

/** Verifies bearer credentials. One instance per process, reading `dbApp` per call. */
export class TokenVerifier {
  readonly #repository: () => TokenRepository | null;
  readonly #now: () => number;
  readonly #defaultRateLimitPerHour: number;

  constructor(
    repository: () => TokenRepository | null,
    now: () => number,
    defaultRateLimitPerHour: number = LIMITS.MCP_TOKEN_PER_HOUR,
  ) {
    this.#repository = repository;
    this.#now = now;
    this.#defaultRateLimitPerHour = defaultRateLimitPerHour;
  }

  /** The ordered verification of 06, "Storage and verification". */
  async verifyToken(raw: string, options: VerifyTokenOptions): Promise<VerifyTokenResult> {
    const fail = (reason: TokenDenialReason, denial: TokenDenial | null): VerifyTokenResult => ({
      ok: false,
      reason,
      publicReason: describe(reason, options.mount),
      denial,
    });

    // 2. shape and CRC, no database access; a `ses`/`tkt`/`spl`/`oac`/`ort` bearer is malformed here
    const shape = parseTokenDetailed(raw);
    if (!shape.ok) return fail(shape.reason, null);
    const parsed = shape.token;
    if (parsed.kind !== 'pat' && parsed.kind !== 'oat') return fail('unknown_kind', null);

    // 3. one indexed read; an absent row still pays one constant-time comparison
    const repository = this.#repository();
    if (repository === null) throw new TokenStoreUnavailableError();
    const row = await repository.findByTokenId(parsed.tokenId);
    if (row === null) {
      secretMatches(parsed.secret, null);
      return fail('unknown_id', null);
    }
    const rowId = tokenIdFromBytes(row.id);
    const presentedKind = parsed.kind === 'pat' ? 'pat' : 'oauth';
    const denialOf = (reason: AuditedTokenDenialReason): VerifyTokenResult =>
      fail(reason, {
        reason,
        tokenRowId: rowId,
        tokenKind: presentedKind,
        ownerUserId: userIdFromBytes(row.user_id),
      });

    // 4. the secret
    if (!secretMatches(parsed.secret, row.secret_hash)) return denialOf('secret_mismatch');

    // 5. the row's kind is the presented kind, and the mount accepts that kind
    if (row.kind !== presentedKind || !isKindAcceptedOn(parsed.kind, options.mount)) {
      return denialOf('wrong_kind_for_route');
    }

    // 5a. audience, OAuth only (RFC 8707)
    if (parsed.kind === 'oat' && row.resource !== (options.resource ?? null)) {
      return denialOf('audience_mismatch');
    }

    // 5b. consent and client liveness, OAuth only. The client's public id is what the SDK's
    // `AuthInfo.clientId` names, so a live OAuth token always carries one.
    let oauthClientId: string | null = null;
    if (parsed.kind === 'oat') {
      if (row.consent_revoked_at !== null) return denialOf('consent_revoked');
      if (row.client_status !== 'active' || row.client_public_id === null) {
        return denialOf('client_disabled');
      }
      oauthClientId = row.client_public_id;
    }

    // 6–9. revocation, rotation overlap, expiry, owner status
    const nowMs = this.#now();
    if (row.revoked_at !== null) return denialOf('revoked');
    if (row.rotation_overlap_until !== null && nowMs >= row.rotation_overlap_until.getTime()) {
      return denialOf('rotation_overlap_elapsed');
    }
    if (nowMs >= row.expires_at.getTime()) return denialOf('expired');
    if (row.user_status !== 'active') return denialOf('user_inactive');

    // 10. the allowlist
    const vaultScope = row.all_vaults
      ? ({ all: true } as const)
      : ({ vaultIds: await repository.allowlist(row.id) } as const);

    // 11. the principal and the SDK's AuthInfo
    const scopes = toEffectivePermissions(row.scopes);
    const principal: TokenPrincipal = {
      kind: 'token',
      tokenKind: presentedKind,
      tokenId: rowId,
      publicTokenId: row.token_id,
      userId: userIdFromBytes(row.user_id),
      clientId: row.client_public_id,
      consentId: row.consent_id === null ? null : idFromBytes(row.consent_id),
      resource: row.resource,
      scopes,
      vaultScope,
      isServerAdmin: false,
      adminOwned: row.admin_owned,
      surface: options.mount === 'rest' ? 'rest' : 'mcp',
      rateLimitPerHour: row.rate_limit_per_hour ?? this.#defaultRateLimitPerHour,
      expiresAt: row.expires_at,
    };
    const authInfo: AuthInfo = {
      token: raw,
      clientId: oauthClientId === null ? `pat:${row.token_id}` : `oauth:${oauthClientId}`,
      scopes: [...scopes],
      expiresAt: Math.floor(row.expires_at.getTime() / MS_PER_SECOND),
      ...(options.resource === undefined ? {} : { resource: new URL(options.resource) }),
      extra: { principal },
    };
    return { ok: true, principal, authInfo };
  }
}

/**
 * Thrown when the database is not connected. A verification that cannot read its row is a `503`,
 * never `401`: a database outage must not tell every agent its credential is invalid (D06-15).
 */
export class TokenStoreUnavailableError extends Error {
  constructor() {
    super(
      'token verification needs dbApp, which is not connected; the request answers 503 unavailable ' +
        'rather than 401 so agents do not rotate working credentials (06, D06-15)',
    );
    this.name = 'TokenStoreUnavailableError';
  }
}

/**
 * Thrown when a verified token principal names an `access_tokens` row that is gone by the time a
 * handler reads it — the row was deleted between verification and the read. The auth plugin maps
 * it to `401 unauthenticated`, the answer any unknown credential gets (09 section 1.5).
 */
export class PrincipalTokenMissingError extends Error {
  readonly tokenId: TokenId;

  constructor(tokenId: TokenId) {
    super(
      `the authenticated principal's token ${tokenId} has no access_tokens row; the credential ` +
        'outlived its row, so the caller must mint a new token (09-api-reference.md section 2.4)',
    );
    this.name = 'PrincipalTokenMissingError';
    this.tokenId = tokenId;
  }
}

/** The columns `GET /auth/me` renders for a token principal beyond what the principal carries. */
export interface TokenRowForMe {
  readonly name: string;
}

/** The token row a principal names; throws `PrincipalTokenMissingError` when it is gone. */
export async function requireTokenRow(
  db: Kysely<Database>,
  tokenId: TokenId,
): Promise<TokenRowForMe> {
  const row = await db
    .selectFrom('access_tokens')
    .select('name')
    .where('id', '=', idBytes(tokenId))
    .executeTakeFirst();
  if (row === undefined) throw new PrincipalTokenMissingError(tokenId);
  return row;
}
