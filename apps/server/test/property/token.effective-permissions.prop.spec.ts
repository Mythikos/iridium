// oxlint-disable vitest/no-standalone-expect -- `test.prop(...)(name, fn)` is the
// @fast-check/vitest form of a test block, which this rule does not know about yet.
/**
 * `token.effective-permissions.prop` (04-auth-and-access-control.md sections 5.4, 9.1 and 9.2;
 * 10-testing-and-quality.md, "`token.effective-permissions.prop`"; A31; F4; HP-3): the six
 * properties of a token's effective permission set, driven against **real memberships** — random
 * users, vaults, `vault_members` and `access_tokens` rows in the worker schema, the real
 * `verifyToken` over `access_tokens`, and the real `authorize()` over the one membership lookup —
 * so the invariant is proven where it is relied on rather than only in the contracts' pure
 * `decide()` (`packages/contracts/src/token.effective-permissions.prop.spec.ts` is that half).
 *
 *  1. `effective(token) ⊆ live explicit permissions of the owner`, for every vault, always.
 *  2. `is_server_admin` never widens a token: an administrator's `all_vaults` token reaches exactly
 *     the vaults where the administrator holds an explicit membership.
 *  3. An expired, revoked or owner-disabled token has the empty set — it does not verify at all.
 *  4. `vaults.mcp_enabled = 0` or the server-wide switch empties the set on the MCP surface while
 *     the REST reads stay governed by the membership rule alone.
 *  5. Rotation: inside the overlap window the old and the new secret resolve to the identical set;
 *     after it, the old secret resolves to the empty set.
 *  6. The set is monotone in the owner's role: raising the role never removes a permission.
 *
 * The budget is `PROP_DB` (200 runs on a pull request, 5 000 nightly): every run seeds its own rows
 * and every authorization is one real query, which is what makes this the database-backed twin.
 */
import { test } from '@fast-check/vitest';
import {
  PERMISSIONS,
  ROLE_RANK,
  ROLES,
  SCOPES,
  SessionId,
  toEffectivePermissions,
  VAULT_STATUSES,
  type Permission,
  type Principal,
  type Role,
  type Scope,
  type TokenPrincipal,
  type UserPrincipal,
  type VaultId,
  type VaultStatus,
} from '@iridium/contracts';
import { PROP_DB } from '@iridium/testkit';
import * as fc from 'fast-check';
import { afterAll, beforeAll, describe, expect } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { KyselyTokenRepository, TokenVerifier } from '../../src/auth/tokens/verify.ts';
import {
  createAuthorizer,
  createMembershipLookup,
  type Authorizer,
} from '../../src/authz/authorize.ts';
import { startPlatformApp, type PlatformApp } from '../integration/platform-app.ts';
import { insertMembership, insertToken, insertUser, insertVault } from '../support/seed.ts';

const HOUR_MS = 3_600_000;
const STEP_UP_WINDOW_MS = 600_000;
/** A session id for the owner's user principal; no session row is needed to authorize. */
const SESSION_ID = '019948c4-0000-7000-8000-0000000000aa';

let platform: PlatformApp;
/** `authorize()` with the server-wide MCP switch on, over the real membership lookup. */
let authorizer: Authorizer;
/** The same, with `server_settings.mcp_enabled` off (`MCP_ENABLED=false` at M1). */
let serverSwitchOff: Authorizer;
let verifier: TokenVerifier;
let seeded = 0;

beforeAll(async () => {
  platform = await startPlatformApp();
  const connected = platform.app.database.dbApp;
  if (connected === null) throw new Error('the app booted without a database');
  const now = (): number => platform.app.clock.now();
  const lookup = createMembershipLookup(() => connected);
  authorizer = createAuthorizer({
    lookup,
    now,
    stepUpWindowMs: STEP_UP_WINDOW_MS,
    mcpServerEnabled: () => true,
  });
  serverSwitchOff = createAuthorizer({
    lookup,
    now,
    stepUpWindowMs: STEP_UP_WINDOW_MS,
    mcpServerEnabled: () => false,
  });
  verifier = new TokenVerifier(() => new KyselyTokenRepository(connected), now);
});

afterAll(async () => {
  await platform.close();
});

function db() {
  const executor = platform.app.database.dbApp;
  if (executor === null) throw new Error('no database');
  return executor;
}

function nowMs(): number {
  return platform.app.clock.now();
}

/** A fresh, unique address per seeded user, so runs never collide inside one truncation window. */
function nextEmail(): string {
  seeded += 1;
  return `prop-${String(seeded)}-${String(nowMs())}@example.test`;
}

// ---- the generated world ----------------------------------------------------------------------

interface VaultSpec {
  readonly status: VaultStatus;
  readonly mcpEnabled: boolean;
  /** The owner's explicit membership on this vault, or none. */
  readonly role: Role | null;
  /** Whether an explicit allowlist names this vault. */
  readonly allowlisted: boolean;
}

interface World {
  readonly isServerAdmin: boolean;
  readonly vaults: readonly VaultSpec[];
  readonly scopes: readonly Scope[];
  readonly allVaults: boolean;
}

const vaultSpec: fc.Arbitrary<VaultSpec> = fc.record({
  status: fc.constantFrom<VaultStatus>(...VAULT_STATUSES),
  mcpEnabled: fc.boolean(),
  role: fc.constantFrom<Role | null>(null, ...ROLES),
  allowlisted: fc.boolean(),
});

const world: fc.Arbitrary<World> = fc.record({
  isServerAdmin: fc.boolean(),
  vaults: fc.array(vaultSpec, { minLength: 1, maxLength: 3 }),
  scopes: fc.uniqueArray(fc.constantFrom<Scope>(...SCOPES), { maxLength: SCOPES.length }),
  allVaults: fc.boolean(),
});

/** The three ways a token stops verifying before any authorization (property 3). */
type Deadness = 'expired' | 'revoked' | 'owner_disabled';

const tokenDeadness: fc.Arbitrary<Deadness> = fc.constantFrom<Deadness>(
  'expired',
  'revoked',
  'owner_disabled',
);

interface SeededWorld {
  readonly ownerId: UserPrincipal['userId'];
  readonly vaultIds: readonly VaultId[];
  readonly token: TokenPrincipal;
  readonly owner: UserPrincipal;
  /** The owner with the admin flag stripped: the explicit-membership view of property 1. */
  readonly ownerExplicit: UserPrincipal;
}

async function seedWorld(spec: World): Promise<SeededWorld> {
  const ownerId = await insertUser(
    db(),
    { email: nextEmail(), isServerAdmin: spec.isServerAdmin },
    nowMs(),
  );
  const vaultIds: VaultId[] = [];
  for (const [index, vault] of spec.vaults.entries()) {
    // eslint-disable-next-line no-await-in-loop -- rows are seeded in order, one vault at a time
    const vaultId = await insertVault(
      db(),
      {
        name: `prop-${String(seeded)}-${String(index)}`,
        createdBy: ownerId,
        status: vault.status,
        mcpEnabled: vault.mcpEnabled,
      },
      nowMs(),
    );
    vaultIds.push(vaultId);
    if (vault.role !== null) {
      // eslint-disable-next-line no-await-in-loop -- the membership follows its vault
      await insertMembership(
        db(),
        { vaultId, userId: ownerId, role: vault.role, grantedBy: ownerId },
        nowMs(),
      );
    }
  }
  const allowlist = vaultIds.filter((_vaultId, index) => spec.vaults[index]?.allowlisted === true);
  const minted = await insertToken(
    db(),
    {
      ownerId,
      scopes: spec.scopes,
      allVaults: spec.allVaults,
      vaultIds: spec.allVaults ? [] : allowlist,
      expiresAt: new Date(nowMs() + HOUR_MS),
      adminOwned: spec.isServerAdmin,
    },
    nowMs(),
  );
  const verified = await verifier.verifyToken(minted.raw, { mount: 'rest' });
  if (!verified.ok) throw new Error(`a live token was refused: ${verified.reason}`);
  const owner: UserPrincipal = {
    kind: 'user',
    userId: ownerId,
    sessionId: SessionId.parse(SESSION_ID),
    sessionKind: 'web',
    isServerAdmin: spec.isServerAdmin,
    authzVersion: 1,
    lastAuthenticatedAt: new Date(nowMs()),
  };
  return {
    ownerId,
    vaultIds,
    token: verified.principal,
    owner,
    ownerExplicit: { ...owner, isServerAdmin: false },
  };
}

// ---- the effective set ------------------------------------------------------------------------

type Surface = 'rest' | 'mcp';

/** Every permission `authorize()` allows a principal on one vault, at one surface. */
async function effective(
  decide: Authorizer,
  principal: Principal,
  vaultId: VaultId,
  surface: Surface,
): Promise<ReadonlySet<Permission>> {
  const allowed = new Set<Permission>();
  for (const permission of PERMISSIONS) {
    const scope = permission.startsWith('server:') ? {} : { vaultId, surface };
    // eslint-disable-next-line no-await-in-loop -- one lookup per permission, in vocabulary order
    const decision = await decide.authorize(principal, permission, scope);
    if (decision === 'allow') allowed.add(permission);
  }
  return allowed;
}

function isSubset(left: ReadonlySet<Permission>, right: ReadonlySet<Permission>): boolean {
  return [...left].every((permission) => right.has(permission));
}

const VISIBLE: ReadonlySet<VaultStatus> = new Set<VaultStatus>(['active', 'archived']);

describe('token.effective-permissions.prop [hp:HP-3]', () => {
  test.prop([world], PROP_DB)(
    'a token never exceeds its owner explicit live permissions, on any vault, on either surface',
    async (spec) => {
      const seededWorld = await seedWorld(spec);
      for (const [index, vaultId] of seededWorld.vaultIds.entries()) {
        const vault = spec.vaults[index];
        if (vault === undefined) throw new Error('vault spec missing');
        for (const surface of ['rest', 'mcp'] as const) {
          // eslint-disable-next-line no-await-in-loop -- each set is a sequence of real lookups
          const token = await effective(authorizer, seededWorld.token, vaultId, surface);
          // eslint-disable-next-line no-await-in-loop -- the owner's set follows the token's
          const explicit = await effective(authorizer, seededWorld.ownerExplicit, vaultId, 'rest');
          // eslint-disable-next-line no-await-in-loop -- and the owner as they really are
          const owner = await effective(authorizer, seededWorld.owner, vaultId, 'rest');
          expect(isSubset(token, explicit)).toBe(true);
          expect(isSubset(token, owner)).toBe(true);
          // The exact set: the read scopes it holds, on a visible vault it may reach, through the
          // owner's explicit role — and nothing a server or write permission could add.
          const reachable =
            VISIBLE.has(vault.status) &&
            vault.role !== null &&
            (spec.allVaults || vault.allowlisted) &&
            (surface === 'rest' || vault.mcpEnabled);
          const expected = new Set<Permission>(
            reachable ? toEffectivePermissions(spec.scopes) : [],
          );
          expect([...token].toSorted()).toStrictEqual([...expected].toSorted());
        }
      }
    },
  );

  test.prop([world.filter((spec) => spec.isServerAdmin && spec.allVaults)], PROP_DB)(
    'an administrator all_vaults token reaches exactly the vaults with an explicit membership',
    async (spec) => {
      const seededWorld = await seedWorld(spec);
      for (const [index, vaultId] of seededWorld.vaultIds.entries()) {
        const vault = spec.vaults[index];
        if (vault === undefined) throw new Error('vault spec missing');
        // eslint-disable-next-line no-await-in-loop -- one real set per vault
        const token = await effective(authorizer, seededWorld.token, vaultId, 'rest');
        // eslint-disable-next-line no-await-in-loop -- the administrator's own set follows
        const admin = await effective(authorizer, seededWorld.owner, vaultId, 'rest');
        const visible = VISIBLE.has(vault.status);
        // The administrator reads every visible vault; the token only where a row exists.
        expect(admin.has('vault:read')).toBe(visible);
        expect(token.size > 0).toBe(
          visible && vault.role !== null && toEffectivePermissions(spec.scopes).length > 0,
        );
        // Server permissions never flow to a token, whoever owns it.
        for (const permission of PERMISSIONS) {
          if (permission.startsWith('server:')) expect(token.has(permission)).toBe(false);
        }
      }
    },
  );

  test.prop([tokenDeadness, fc.boolean()], PROP_DB)(
    'an expired, revoked or owner-disabled token does not verify, so its set is empty',
    async (deadness, allVaults) => {
      const ownerId = await insertUser(
        db(),
        { email: nextEmail(), status: deadness === 'owner_disabled' ? 'disabled' : 'active' },
        nowMs(),
      );
      const vaultId = await insertVault(
        db(),
        { name: `prop-dead-${String(seeded)}`, createdBy: ownerId },
        nowMs(),
      );
      await insertMembership(
        db(),
        { vaultId, userId: ownerId, role: 'manager', grantedBy: ownerId },
        nowMs(),
      );
      const minted = await insertToken(
        db(),
        {
          ownerId,
          allVaults,
          vaultIds: allVaults ? [] : [vaultId],
          expiresAt: new Date(nowMs() + (deadness === 'expired' ? -1 : HOUR_MS)),
          revokedAt: deadness === 'revoked' ? new Date(nowMs() - 1) : null,
        },
        nowMs(),
      );
      for (const mount of ['rest', 'mcp'] as const) {
        // eslint-disable-next-line no-await-in-loop -- one verification per mount
        const result = await verifier.verifyToken(minted.raw, { mount });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.reason).toBe(deadness === 'owner_disabled' ? 'user_inactive' : deadness);
      }
    },
  );

  test.prop([fc.boolean(), fc.constantFrom<Role>(...ROLES)], PROP_DB)(
    'the MCP switches empty the set on the MCP surface and leave the REST reads to the membership',
    async (vaultSwitch, role) => {
      const ownerId = await insertUser(db(), { email: nextEmail() }, nowMs());
      const vaultId = await insertVault(
        db(),
        { name: `prop-mcp-${String(seeded)}`, createdBy: ownerId, mcpEnabled: vaultSwitch },
        nowMs(),
      );
      await insertMembership(db(), { vaultId, userId: ownerId, role, grantedBy: ownerId }, nowMs());
      const minted = await insertToken(
        db(),
        { ownerId, allVaults: true, expiresAt: new Date(nowMs() + HOUR_MS) },
        nowMs(),
      );
      const verified = await verifier.verifyToken(minted.raw, { mount: 'mcp' });
      if (!verified.ok) throw new Error(`refused: ${verified.reason}`);
      const rest = await effective(authorizer, verified.principal, vaultId, 'rest');
      const mcp = await effective(authorizer, verified.principal, vaultId, 'mcp');
      const mcpServerOff = await effective(serverSwitchOff, verified.principal, vaultId, 'mcp');
      const restServerOff = await effective(serverSwitchOff, verified.principal, vaultId, 'rest');
      const reads = toEffectivePermissions(SCOPES);
      expect([...rest].toSorted()).toStrictEqual([...reads].toSorted());
      expect([...restServerOff].toSorted()).toStrictEqual([...reads].toSorted());
      expect([...mcp].toSorted()).toStrictEqual(vaultSwitch ? [...reads].toSorted() : []);
      expect(mcpServerOff.size).toBe(0);
    },
  );

  test.prop([fc.uniqueArray(fc.constantFrom<Scope>(...SCOPES), { minLength: 1 })], PROP_DB)(
    'a rotated secret is identical inside its overlap window and empty after it',
    async (scopes) => {
      const ownerId = await insertUser(db(), { email: nextEmail() }, nowMs());
      const vaultId = await insertVault(
        db(),
        { name: `prop-rotate-${String(seeded)}`, createdBy: ownerId },
        nowMs(),
      );
      await insertMembership(
        db(),
        { vaultId, userId: ownerId, role: 'editor', grantedBy: ownerId },
        nowMs(),
      );
      const shared = {
        ownerId,
        scopes,
        vaultIds: [vaultId],
        expiresAt: new Date(nowMs() + HOUR_MS),
      };
      const replacement = await insertToken(db(), shared, nowMs());
      const overlapping = await insertToken(
        db(),
        { ...shared, rotationOverlapUntil: new Date(nowMs() + HOUR_MS) },
        nowMs(),
      );
      const lapsed = await insertToken(
        db(),
        { ...shared, rotationOverlapUntil: new Date(nowMs()) },
        nowMs(),
      );
      const fresh = await verifier.verifyToken(replacement.raw, { mount: 'rest' });
      const inWindow = await verifier.verifyToken(overlapping.raw, { mount: 'rest' });
      if (!fresh.ok || !inWindow.ok) throw new Error('a live token was refused');
      const freshSet = await effective(authorizer, fresh.principal, vaultId, 'rest');
      const windowSet = await effective(authorizer, inWindow.principal, vaultId, 'rest');
      expect([...windowSet].toSorted()).toStrictEqual([...freshSet].toSorted());
      const after = await verifier.verifyToken(lapsed.raw, { mount: 'rest' });
      expect(after).toMatchObject({ ok: false, reason: 'rotation_overlap_elapsed' });
    },
  );

  test.prop(
    [
      fc.uniqueArray(fc.constantFrom<Scope>(...SCOPES), { maxLength: SCOPES.length }),
      fc.constantFrom<VaultStatus>('active', 'archived'),
    ],
    PROP_DB,
  )(
    'the set is monotone in the owner role: raising it never removes a permission',
    async (scopes, status) => {
      const ownerId = await insertUser(db(), { email: nextEmail() }, nowMs());
      const vaultId = await insertVault(
        db(),
        { name: `prop-role-${String(seeded)}`, createdBy: ownerId, status },
        nowMs(),
      );
      const minted = await insertToken(
        db(),
        { ownerId, scopes, vaultIds: [vaultId], expiresAt: new Date(nowMs() + HOUR_MS) },
        nowMs(),
      );
      const verified = await verifier.verifyToken(minted.raw, { mount: 'rest' });
      if (!verified.ok) throw new Error(`refused: ${verified.reason}`);
      // No membership first, then each role in rank order, each read live from `vault_members`.
      let previous = await effective(authorizer, verified.principal, vaultId, 'rest');
      expect(previous.size).toBe(0);
      const ordered = [...ROLES].toSorted((left, right) => ROLE_RANK[left] - ROLE_RANK[right]);
      for (const [index, role] of ordered.entries()) {
        if (index === 0) {
          // eslint-disable-next-line no-await-in-loop -- the first rank inserts the row
          await insertMembership(
            db(),
            { vaultId, userId: ownerId, role, grantedBy: ownerId },
            nowMs(),
          );
        } else {
          // eslint-disable-next-line no-await-in-loop -- every later rank raises the row in place
          await db()
            .updateTable('vault_members')
            .set({ role })
            .where('vault_id', '=', idBytes(vaultId))
            .where('user_id', '=', idBytes(ownerId))
            .execute();
        }
        // eslint-disable-next-line no-await-in-loop -- the set is read after each raise
        const current = await effective(authorizer, verified.principal, vaultId, 'rest');
        expect(isSubset(previous, current)).toBe(true);
        previous = current;
      }
    },
  );
});
