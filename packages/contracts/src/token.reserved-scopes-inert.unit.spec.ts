import { describe, expect, it } from 'vitest';

import { matrixAllows, Permission, PERMISSIONS, READ_BUNDLE } from './authz.ts';
import {
  GrantableBundleSchema,
  READ_SCOPES,
  RESERVED_WRITE_SCOPES,
  SCOPE_BUNDLES,
  SCOPES,
  ScopeSchema,
  toEffectivePermissions,
} from './tokens.ts';

describe('token.reserved-scopes-inert.unit [area:tokens]', () => {
  describe('the scope vocabulary', () => {
    it('is the read bundle plus the reserved write scopes, in that order', () => {
      expect([...SCOPES]).toStrictEqual([...READ_SCOPES, ...RESERVED_WRITE_SCOPES]);
      expect([...READ_SCOPES]).toStrictEqual([...READ_BUNDLE]);
    });

    it('accepts every reserved write scope as a stored value', () => {
      for (const scope of RESERVED_WRITE_SCOPES) {
        expect(ScopeSchema.safeParse(scope).success).toBe(true);
      }
      expect(ScopeSchema.safeParse('server:users').success).toBe(false);
    });

    it('offers exactly one grantable bundle, which expands to the read bundle', () => {
      expect(GrantableBundleSchema.safeParse('read').success).toBe(true);
      expect(GrantableBundleSchema.safeParse('write').success).toBe(false);
      expect([...SCOPE_BUNDLES.read]).toStrictEqual([...READ_SCOPES]);
    });
  });

  describe('inertness', () => {
    it('grants nothing for a row that carries only reserved write scopes', () => {
      expect(toEffectivePermissions([...RESERVED_WRITE_SCOPES])).toStrictEqual([]);
    });

    it('keeps only the read bundle when a row mixes the two', () => {
      const mixed = ['note:write', 'note:read', 'note:propose', 'vault:read'];
      // Vocabulary order, not the order the row happens to store them in.
      expect(toEffectivePermissions(mixed)).toStrictEqual(['vault:read', 'note:read']);
    });

    it('drops a scope that is not a permission at all', () => {
      expect(Permission.safeParse('note:propose').success).toBe(false);
      expect(PERMISSIONS).not.toContain('note:propose');
      expect(toEffectivePermissions(['note:propose'])).toStrictEqual([]);
    });

    it('leaves every permission check over a reserved scope false', () => {
      expect(RESERVED_WRITE_SCOPES.map((scope) => toEffectivePermissions([scope]))).toStrictEqual(
        RESERVED_WRITE_SCOPES.map(() => []),
      );
      // A token's rights are the intersection, so a scope that survives no intersection can never
      // reach the matrix — and for the ones that are also permissions, the matrix refuses a viewer
      // anyway, which is the role every read-only token's owner is at worst.
      const alsoPermissions = RESERVED_WRITE_SCOPES.flatMap((scope) => {
        const parsed = Permission.safeParse(scope);
        return parsed.success ? [parsed.data] : [];
      });
      expect(alsoPermissions).not.toHaveLength(0);
      expect(alsoPermissions.map((permission) => matrixAllows('viewer', permission))).toStrictEqual(
        alsoPermissions.map(() => false),
      );
    });
  });
});
