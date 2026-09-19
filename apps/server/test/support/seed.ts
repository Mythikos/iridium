/**
 * Seeding for the auth suites (10-testing-and-quality.md, "Seeding, tickets, sessions").
 *
 * Seeding goes through the product's own paths wherever one exists at M1: every credential is
 * created by consuming a real set-password link through `POST /auth/set-password`, and every
 * session by `POST /auth/sessions`. The rows no M1 route creates yet — users (`POST /admin/users`
 * is the wave-2 `kernel-rest` stream's), vaults, memberships and access tokens (the token
 * lifecycle is M3) — are inserted through the product's own Kysely schema, which is the seam
 * `seed.kernel()` in the testkit replaces when it lands.
 */
import {
  mintToken,
  newId,
  READ_BUNDLE,
  type Role,
  type Scope,
  type TokenId,
  type UserId,
  type VaultId,
} from '@iridium/contracts';
import { createCookieJar, type CookieJar } from '@iridium/testkit';
import type { Kysely } from 'kysely';

import {
  idBytes,
  tokenIdFromBytes,
  userIdFromBytes,
  vaultIdFromBytes,
} from '../../src/auth/ids.ts';
import { secretHash } from '../../src/auth/secret-hash.ts';
import type { Database } from '../../src/db/index.ts';
import type { UserStatus } from '../../src/db/schema.ts';
import { desktopClient, webClient, webHeaders, type AuthTestServer } from './auth-app.ts';

/** A user the suite created. */
export interface SeededUser {
  readonly id: UserId;
  readonly email: string;
  readonly password: string;
}

/** A fixed, obviously fake password that satisfies the policy (fixture policy rule 9). */
export const SEED_PASSWORD = 'correct horse battery staple 2026';

/** Golden-angle presence colours, as `users/service.ts` will assign them (03 section 3). */
const GOLDEN_ANGLE = 137.508;

export async function insertUser(
  db: Kysely<Database>,
  input: {
    readonly email: string;
    readonly displayName?: string;
    readonly isServerAdmin?: boolean;
    readonly status?: UserStatus;
  },
  nowMs: number,
): Promise<UserId> {
  const id = newId();
  const now = new Date(nowMs);
  const { n: ordinal } = await db
    .selectFrom('users')
    .select(db.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  await db
    .insertInto('users')
    .values({
      id: idBytes(id),
      email: input.email,
      display_name: input.displayName ?? input.email.split('@')[0] ?? input.email,
      is_server_admin: input.isServerAdmin ?? false,
      status: input.status ?? 'active',
      color_hue: Math.round((ordinal * GOLDEN_ANGLE) % 360),
      created_at: now,
      updated_at: now,
      last_login_at: null,
    })
    .execute();
  return userIdFromBytes(idBytes(id));
}

/** Issues a link through the product's own issuer and consumes it through the real route. */
export async function setPasswordThroughLink(
  context: AuthTestServer,
  userId: UserId,
  password: string,
): Promise<{ readonly link: string }> {
  const issued = await context.app.auth.setpw.issue(context.db, {
    userId,
    purpose: 'initial',
    issuedBy: userId,
  });
  const token = issued.link.slice(issued.link.indexOf('#') + 1);
  const response = await desktopClient(context).post('/auth/set-password', {
    json: { token, password },
  });
  if (response.status !== 204) {
    throw new Error(
      `set-password answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  }
  return { link: issued.link };
}

/** A user with a credential: inserted, then given a password through the set-password route. */
export async function seedUser(
  context: AuthTestServer,
  input: { readonly email: string; readonly isServerAdmin?: boolean; readonly password?: string },
): Promise<SeededUser> {
  const password = input.password ?? SEED_PASSWORD;
  const id = await insertUser(
    context.db,
    {
      email: input.email,
      ...(input.isServerAdmin === undefined ? {} : { isServerAdmin: input.isServerAdmin }),
    },
    context.clock.now(),
  );
  await setPasswordThroughLink(context, id, password);
  return { id, email: input.email, password };
}

/** `POST /auth/sessions {client:'web'}`: the jar then carries the `__Host-` cookie. */
export async function signInWeb(context: AuthTestServer, user: SeededUser): Promise<CookieJar> {
  const jar = createCookieJar();
  const response = await webClient(context, jar).post('/auth/sessions', {
    json: { email: user.email, password: user.password, client: 'web' },
    headers: webHeaders(context.origin),
  });
  if (response.status !== 201) {
    throw new Error(
      `web sign-in answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  }
  return jar;
}

/** `POST /auth/sessions {client:'desktop'}`: the bearer the main process would hold. */
export async function signInDesktop(
  context: AuthTestServer,
  user: SeededUser,
  deviceName: string = 'test-device',
): Promise<{ readonly token: string; readonly sessionId: string }> {
  const response = await desktopClient(context).post<{ token: string; session: { id: string } }>(
    '/auth/sessions',
    { json: { email: user.email, password: user.password, client: 'desktop', deviceName } },
  );
  if (response.status !== 201) {
    throw new Error(
      `desktop sign-in answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  }
  return { token: response.body.token, sessionId: response.body.session.id };
}

export async function insertVault(
  db: Kysely<Database>,
  input: {
    readonly name: string;
    readonly createdBy: UserId;
    readonly status?: 'active' | 'archived' | 'importing' | 'deleting';
    readonly mcpEnabled?: boolean;
  },
  nowMs: number,
): Promise<VaultId> {
  const id = newId();
  const now = new Date(nowMs);
  const rootId = newId();
  await db
    .insertInto('vaults')
    .values({
      id: idBytes(id),
      name: input.name,
      slug: input.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'),
      description: null,
      root_node_id: null,
      status: input.status ?? 'active',
      archived_at: input.status === 'archived' ? now : null,
      ai_guidance: null,
      mcp_enabled: input.mcpEnabled ?? true,
      created_by: idBytes(input.createdBy),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('nodes')
    .values({
      id: idBytes(rootId),
      vault_id: idBytes(id),
      parent_id: idBytes(rootId),
      kind: 'category',
      name: '',
      deleted_at: null,
      created_by: idBytes(input.createdBy),
      updated_by: idBytes(input.createdBy),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .updateTable('vaults')
    .set({ root_node_id: idBytes(rootId) })
    .where('id', '=', idBytes(id))
    .execute();
  return vaultIdFromBytes(idBytes(id));
}

export async function insertMembership(
  db: Kysely<Database>,
  input: {
    readonly vaultId: VaultId;
    readonly userId: UserId;
    readonly role: Role;
    readonly grantedBy: UserId;
  },
  nowMs: number,
): Promise<void> {
  const now = new Date(nowMs);
  await db
    .insertInto('vault_members')
    .values({
      vault_id: idBytes(input.vaultId),
      user_id: idBytes(input.userId),
      role: input.role,
      granted_by: idBytes(input.grantedBy),
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/** A node under a vault's root, for the `node:`/`note:` resolutions of the route policy. */
export async function insertNode(
  db: Kysely<Database>,
  input: {
    readonly vaultId: VaultId;
    readonly kind: 'note' | 'category';
    readonly name: string;
    readonly createdBy: UserId;
    readonly deletedAt?: Date | null;
  },
  nowMs: number,
): Promise<string> {
  const id = newId();
  const now = new Date(nowMs);
  const root = await db
    .selectFrom('vaults')
    .select('root_node_id')
    .where('id', '=', idBytes(input.vaultId))
    .executeTakeFirstOrThrow();
  if (root.root_node_id === null) throw new Error('the vault has no root node');
  await db
    .insertInto('nodes')
    .values({
      id: idBytes(id),
      vault_id: idBytes(input.vaultId),
      parent_id: root.root_node_id,
      kind: input.kind,
      name: input.name,
      deleted_at: input.deletedAt ?? null,
      created_by: idBytes(input.createdBy),
      updated_by: idBytes(input.createdBy),
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

/** An `attachments` row, for the `attachment:` resolution of the route policy. */
export async function insertAttachment(
  db: Kysely<Database>,
  input: { readonly vaultId: VaultId; readonly uploadedBy: UserId },
  nowMs: number,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('attachments')
    .values({
      id: idBytes(id),
      vault_id: idBytes(input.vaultId),
      sha256: Buffer.alloc(32, 7),
      size_bytes: 1,
      mime: 'image/png',
      original_name: 'seeded.png',
      path_hint: null,
      storage_key: `seeded/${id}`,
      key_version: null,
      iv: null,
      auth_tag: null,
      uploaded_by: idBytes(input.uploadedBy),
      created_at: new Date(nowMs),
      deleted_at: null,
    })
    .execute();
  return id;
}

/** A `jobs` row, for the `job:` resolution of the route policy (04 section 6.8). */
export async function insertJob(
  db: Kysely<Database>,
  input: { readonly vaultId: VaultId | null; readonly requestedBy: UserId | null },
  nowMs: number,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('jobs')
    .values({
      id: idBytes(id),
      type: 'export',
      status: 'queued',
      vault_id: input.vaultId === null ? null : idBytes(input.vaultId),
      requested_by: input.requestedBy === null ? null : idBytes(input.requestedBy),
      payload: JSON.stringify({}),
      progress: null,
      result: null,
      error: null,
      locked_by: null,
      locked_at: null,
      created_at: new Date(nowMs),
      started_at: null,
      finished_at: null,
    })
    .execute();
  return id;
}

/** An `access_tokens` row for the verifier; the M3 lifecycle route is what will replace this. */
export async function insertToken(
  db: Kysely<Database>,
  input: {
    readonly ownerId: UserId;
    /** What the row stores: any scope string, reserved write scopes included (they grant nothing). */
    readonly scopes?: readonly Scope[];
    readonly allVaults?: boolean;
    readonly vaultIds?: readonly VaultId[];
    readonly expiresAt: Date;
    readonly revokedAt?: Date | null;
    readonly rotationOverlapUntil?: Date | null;
    readonly kind?: 'pat' | 'oauth';
    readonly resource?: string | null;
    readonly adminOwned?: boolean;
  },
  nowMs: number,
): Promise<{ readonly raw: string; readonly id: TokenId }> {
  const minted = mintToken(input.kind === 'oauth' ? 'oat' : 'pat');
  const id = newId();
  const now = new Date(nowMs);
  await db
    .insertInto('access_tokens')
    .values({
      id: idBytes(id),
      token_id: minted.tokenId,
      secret_hash: secretHash(minted.secret),
      user_id: idBytes(input.ownerId),
      kind: input.kind ?? 'pat',
      name: 'seeded',
      display_prefix: minted.displayPrefix,
      scopes: JSON.stringify(input.scopes ?? READ_BUNDLE),
      all_vaults: input.allVaults ?? false,
      admin_owned: input.adminOwned ?? false,
      expires_at: input.expiresAt,
      rate_limit_per_hour: null,
      created_at: now,
      created_from_session_id: null,
      created_ip: null,
      created_user_agent: null,
      rotated_from_id: null,
      rotation_overlap_until: input.rotationOverlapUntil ?? null,
      client_id: null,
      consent_id: null,
      refresh_id: null,
      resource: input.resource ?? null,
      revoked_at: input.revokedAt ?? null,
      revoked_by: null,
      revoke_reason: null,
    })
    .execute();
  for (const vaultId of input.vaultIds ?? []) {
    // eslint-disable-next-line no-await-in-loop -- a handful of rows, inserted in order
    await db
      .insertInto('access_token_vaults')
      .values({ token_id: idBytes(id), vault_id: idBytes(vaultId) })
      .execute();
  }
  return { raw: minted.raw, id: tokenIdFromBytes(idBytes(id)) };
}

/** Every `audit_events` row of one action, oldest first — what a suite asserts a flow wrote. */
export async function auditRows(
  db: Kysely<Database>,
  action: string,
): Promise<
  readonly {
    readonly action: string;
    readonly outcome: string;
    readonly metadata: unknown;
    readonly credential_type: string;
  }[]
> {
  return db
    .selectFrom('audit_events')
    .select(['action', 'outcome', 'metadata', 'credential_type'])
    .where('action', '=', action)
    .orderBy('id', 'asc')
    .execute();
}
