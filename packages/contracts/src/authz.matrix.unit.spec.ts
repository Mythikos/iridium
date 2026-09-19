import { describe, expect, it } from 'vitest';

import {
  decide,
  INVISIBLE_VAULT_STATUSES,
  isReadPermission,
  matrixAllows,
  MATRIX_ROLES,
  maxRole,
  PERMISSION_GROUP,
  PERMISSION_MATRIX,
  PERMISSION_SCOPE,
  PERMISSIONS,
  permissionsOf,
  PRINCIPAL_KINDS,
  READ_BUNDLE,
  ROLE_RANK,
  ROLES,
  VAULT_STATUSES,
  type DecideInput,
  type Decision,
  type MatrixRole,
  type Permission,
  type Role,
  type VaultStatus,
} from './authz.ts';

/** The matrix of 04-auth-and-access-control.md section 5.3, restated from its Group column. */
function granted(role: MatrixRole | null, permission: Permission): boolean {
  const group = PERMISSION_GROUP[permission];
  if (role === null) return false;
  if (role === 'viewer') return group === 'read';
  if (role === 'editor') return group === 'read' || group === 'write';
  if (role === 'manager') return group !== 'server';
  return true;
}

/** What `decide` must answer a user principal, from the matrix and the order of its steps. */
function expectedForUser(explicitRole: Role | null, permission: Permission): Decision {
  if (PERMISSION_SCOPE[permission] === 'server') return { deny: 'forbidden' };
  if (explicitRole === null) return { deny: 'not_found' };
  return granted(explicitRole, permission) ? 'allow' : { deny: 'forbidden' };
}

/** The same for a token principal carrying every grantable scope. */
function expectedForToken(explicitRole: Role | null, permission: Permission): Decision {
  const expected = expectedForUser(explicitRole, permission);
  if (expected !== 'allow') return expected;
  return isReadPermission(permission) ? 'allow' : { deny: 'forbidden' };
}

const roleStates: readonly (Role | null)[] = [null, 'viewer', 'editor', 'manager'];

function input(overrides: Partial<DecideInput> = {}): DecideInput {
  return {
    principalKind: 'user',
    isServerAdmin: false,
    explicitRole: 'viewer',
    vaultStatus: 'active',
    permission: 'note:read',
    scopes: [],
    vaultAllowed: true,
    mcpEnabled: true,
    stepUpOk: true,
    allowArchived: false,
    ...overrides,
  };
}

describe('authz.matrix.unit [spec:viewer-enforcement]', () => {
  describe('the vocabulary', () => {
    it('is closed and has no duplicate', () => {
      expect(PERMISSIONS).toHaveLength(28);
      expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
      expect(ROLES).toStrictEqual(['viewer', 'editor', 'manager']);
      expect(MATRIX_ROLES).toStrictEqual(['viewer', 'editor', 'manager', 'serverAdmin']);
      expect(VAULT_STATUSES).toStrictEqual(['importing', 'active', 'archived', 'deleting']);
      expect(INVISIBLE_VAULT_STATUSES).toStrictEqual(['importing', 'deleting']);
    });

    it('gives every permission a group, a scope and a row in every role', () => {
      for (const permission of PERMISSIONS) {
        expect(PERMISSION_GROUP[permission]).toBeDefined();
        expect(PERMISSION_SCOPE[permission]).toBe(
          PERMISSION_GROUP[permission] === 'server' ? 'server' : 'vault',
        );
        for (const role of MATRIX_ROLES) {
          expect(typeof PERMISSION_MATRIX[role][permission]).toBe('boolean');
        }
      }
    });

    it('has the read bundle and the read group as one set', () => {
      const readGroup = PERMISSIONS.filter((p) => PERMISSION_GROUP[p] === 'read');
      expect([...READ_BUNDLE]).toStrictEqual(readGroup);
      for (const permission of PERMISSIONS) {
        expect(isReadPermission(permission)).toBe(PERMISSION_GROUP[permission] === 'read');
      }
    });

    it('keeps the principal union closed at user, token and system', () => {
      expect(PRINCIPAL_KINDS).toStrictEqual(['user', 'token', 'system']);
    });

    it('orders the roles viewer < editor < manager', () => {
      expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor);
      expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.manager);
      expect(maxRole(null, null)).toBeNull();
      expect(maxRole(null, 'viewer')).toBe('viewer');
      expect(maxRole('viewer', null)).toBe('viewer');
      expect(maxRole('viewer', 'manager')).toBe('manager');
      expect(maxRole('manager', 'viewer')).toBe('manager');
      expect(maxRole('editor', 'editor')).toBe('editor');
    });

    it('lists a role’s permissions in vocabulary order', () => {
      expect(permissionsOf('viewer')).toStrictEqual([...READ_BUNDLE]);
      expect(permissionsOf('serverAdmin')).toStrictEqual([...PERMISSIONS]);
      expect(permissionsOf('manager')).toHaveLength(20);
      expect(permissionsOf('editor')).toHaveLength(14);
    });
  });

  describe('the matrix', () => {
    it.each(MATRIX_ROLES)('matches the published table for %s', (role) => {
      for (const permission of PERMISSIONS) {
        expect(matrixAllows(role, permission)).toBe(granted(role, permission));
      }
    });

    it('gives a viewer no write, manage or server permission', () => {
      const nonReads = PERMISSIONS.filter((p) => PERMISSION_GROUP[p] !== 'read');
      expect(nonReads.map((p) => matrixAllows('viewer', p))).toStrictEqual(
        nonReads.map(() => false),
      );
    });

    it('gives a server administrator everything a manager has, plus the server group', () => {
      const managerHolds = permissionsOf('manager');
      expect(managerHolds.every((permission) => matrixAllows('serverAdmin', permission))).toBe(
        true,
      );
      expect(permissionsOf('serverAdmin').length).toBe(managerHolds.length + 8);
    });
  });

  describe('decide, over the whole cross-product', () => {
    it.each(roleStates)('answers for a user principal with role %s', (explicitRole) => {
      const answers = PERMISSIONS.map((permission) => decide(input({ explicitRole, permission })));
      expect(answers).toStrictEqual(
        PERMISSIONS.map((permission) => expectedForUser(explicitRole, permission)),
      );
    });

    it.each(roleStates)('answers for a server administrator whose explicit role is %s', (role) => {
      const answers = PERMISSIONS.map((permission) =>
        decide(input({ explicitRole: role, isServerAdmin: true, permission })),
      );
      expect(answers).toStrictEqual(PERMISSIONS.map(() => 'allow'));
    });

    it.each(roleStates)('answers for a token principal whose owner is %s', (explicitRole) => {
      // A token carrying every grantable scope: the intersection is then the owner's role alone.
      const answers = PERMISSIONS.map((permission) =>
        decide(
          input({ principalKind: 'token', explicitRole, permission, scopes: [...READ_BUNDLE] }),
        ),
      );
      expect(answers).toStrictEqual(
        PERMISSIONS.map((permission) => expectedForToken(explicitRole, permission)),
      );
    });

    it('allows every permission to a system principal', () => {
      const answers = PERMISSIONS.map((permission) =>
        decide(input({ principalKind: 'system', explicitRole: null, permission })),
      );
      expect(answers).toStrictEqual(PERMISSIONS.map(() => 'allow'));
    });
  });

  describe('decide, on the rules the order encodes', () => {
    it('refuses a server permission to a token and to a non-administrator', () => {
      expect(decide(input({ permission: 'server:users', isServerAdmin: false }))).toStrictEqual({
        deny: 'forbidden',
      });
      expect(
        decide(
          input({
            principalKind: 'token',
            permission: 'server:users',
            isServerAdmin: true,
            scopes: [...PERMISSIONS],
          }),
        ),
      ).toStrictEqual({ deny: 'forbidden' });
      expect(
        decide(input({ permission: 'server:users', isServerAdmin: true, explicitRole: null })),
      ).toBe('allow');
    });

    it('hides a vault that does not exist, is importing or is deleting', () => {
      expect(decide(input({ vaultStatus: null }))).toStrictEqual({ deny: 'not_found' });
      for (const status of INVISIBLE_VAULT_STATUSES) {
        expect(decide(input({ vaultStatus: status, isServerAdmin: true }))).toStrictEqual({
          deny: 'not_found',
        });
      }
    });

    it('makes an archived vault read-only', () => {
      const vaultPermissions = PERMISSIONS.filter((p) => PERMISSION_SCOPE[p] === 'vault');
      const archived: VaultStatus = 'archived';
      const answers = vaultPermissions.map((permission) =>
        decide(input({ vaultStatus: archived, explicitRole: 'manager', permission })),
      );
      expect(answers).toStrictEqual(
        vaultPermissions.map((permission) =>
          isReadPermission(permission) ? 'allow' : { deny: 'forbidden' },
        ),
      );
      // The members of `ALLOW_ARCHIVED_ROUTES` lift the freeze (section 5.6): a manager may then
      // do everything the matrix grants, and the matrix still refuses a viewer the same write.
      const lifted = vaultPermissions.map((permission) =>
        decide(
          input({
            vaultStatus: archived,
            explicitRole: 'manager',
            permission,
            allowArchived: true,
          }),
        ),
      );
      expect(lifted).toStrictEqual(vaultPermissions.map(() => 'allow'));
      expect(
        decide(
          input({
            vaultStatus: archived,
            explicitRole: 'viewer',
            permission: 'vault:archive',
            allowArchived: true,
          }),
        ),
      ).toStrictEqual({ deny: 'forbidden' });
    });

    it('intersects a token with its scopes, its allowlist and the MCP switches', () => {
      const base = {
        principalKind: 'token' as const,
        explicitRole: 'manager' as const,
        permission: 'note:read' as const,
      };
      expect(decide(input({ ...base, scopes: [...READ_BUNDLE] }))).toBe('allow');
      expect(decide(input({ ...base, scopes: ['vault:read'] }))).toStrictEqual({
        deny: 'forbidden',
      });
      expect(
        decide(input({ ...base, scopes: [...READ_BUNDLE], vaultAllowed: false })),
      ).toStrictEqual({ deny: 'not_found' });
      expect(decide(input({ ...base, scopes: [...READ_BUNDLE], mcpEnabled: false }))).toStrictEqual(
        {
          deny: 'not_found',
        },
      );
    });

    it('evaluates step-up last, so it never reveals that an action would be allowed', () => {
      expect(decide(input({ explicitRole: null, stepUpOk: false }))).toStrictEqual({
        deny: 'not_found',
      });
      expect(
        decide(input({ explicitRole: 'viewer', permission: 'node:create', stepUpOk: false })),
      ).toStrictEqual({ deny: 'forbidden' });
      expect(decide(input({ explicitRole: 'manager', stepUpOk: false }))).toStrictEqual({
        deny: 'step_up_required',
      });
      expect(
        decide(input({ permission: 'server:users', isServerAdmin: true, stepUpOk: false })),
      ).toStrictEqual({ deny: 'step_up_required' });
      // A token principal has no step-up window at all.
      expect(
        decide(
          input({
            principalKind: 'token',
            explicitRole: 'viewer',
            scopes: [...READ_BUNDLE],
            stepUpOk: false,
          }),
        ),
      ).toBe('allow');
    });
  });
});
