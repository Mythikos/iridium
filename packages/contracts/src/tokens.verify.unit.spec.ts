import { describe, expect, it } from 'vitest';

import { PERMISSIONS, READ_BUNDLE, type Permission } from './authz.ts';
import {
  ABSENT_SECRET_HASH,
  ACCESS_TOKEN_KINDS,
  BEARER_MOUNTS,
  GrantableBundleSchema,
  isKindAcceptedOn,
  kindOf,
  mintToken,
  MOUNT_ACCEPTED_KIND,
  parseToken,
  READ_SCOPES,
  RESERVED_TOKEN_KINDS,
  RESERVED_WRITE_SCOPES,
  SCOPE_BUNDLES,
  SCOPES,
  ScopeSchema,
  SECRET_VERIFICATION,
  TOKEN_KIND_SPECS,
  TOKEN_KINDS,
  toEffectivePermissions,
} from './tokens.ts';

describe('tokens.verify.unit [area:tokens]', () => {
  describe('kind dispatch', () => {
    it('dispatches every live kind to the store that holds its row', () => {
      expect(Object.keys(TOKEN_KIND_SPECS)).toStrictEqual([
        ...TOKEN_KINDS,
        ...RESERVED_TOKEN_KINDS,
      ]);
      expect(TOKEN_KIND_SPECS.pat).toStrictEqual({
        store: 'access_tokens',
        accessTokenKind: 'pat',
        issued: true,
      });
      expect(TOKEN_KIND_SPECS.oat).toStrictEqual({
        store: 'access_tokens',
        accessTokenKind: 'oauth',
        issued: true,
      });
      expect(TOKEN_KIND_SPECS.ses.store).toBe('sessions');
      expect(TOKEN_KIND_SPECS.tkt.store).toBe('TicketStore');
      expect(TOKEN_KIND_SPECS.spl.store).toBe('password_setup_tokens');
      expect(TOKEN_KIND_SPECS.ort.store).toBe('oauth_refresh_tokens');
      expect(TOKEN_KIND_SPECS.oac.store).toBe('oauth_authorization_codes');
    });

    it('keeps `scim` schema-valid and never issuable', () => {
      expect(ACCESS_TOKEN_KINDS).toStrictEqual(['pat', 'oauth', 'scim']);
      expect(TOKEN_KIND_SPECS.scim.issued).toBe(false);
      expect(TOKEN_KINDS).not.toContain('scim');
      // A `scim` credential cannot even be spelled: the kind is outside the published regex.
      expect(kindOf('irid_scim_0123456789ABCDEF_x')).toBeNull();
      expect(parseToken('irid_scim_0123456789ABCDEF_x')).toBeNull();
    });

    it('is exhaustive: every live kind has a spec and every spec a live kind', () => {
      for (const kind of TOKEN_KINDS) {
        expect(TOKEN_KIND_SPECS[kind].issued).toBe(true);
        expect(kindOf(mintToken(kind).raw)).toBe(kind);
      }
    });

    it('accepts exactly one credential kind per bearer mount', () => {
      expect(BEARER_MOUNTS).toStrictEqual(['mcp', 'mcp-connect', 'rest']);
      expect(MOUNT_ACCEPTED_KIND).toStrictEqual({ mcp: 'pat', 'mcp-connect': 'oat', rest: 'pat' });
      for (const mount of BEARER_MOUNTS) {
        for (const kind of TOKEN_KINDS) {
          expect(isKindAcceptedOn(kind, mount)).toBe(MOUNT_ACCEPTED_KIND[mount] === kind);
        }
      }
      expect(isKindAcceptedOn('oat', 'mcp')).toBe(false);
      expect(isKindAcceptedOn('pat', 'mcp-connect')).toBe(false);
      expect(isKindAcceptedOn('ses', 'rest')).toBe(false);
    });
  });

  describe('the secret comparison contract', () => {
    it('is SHA-256 over the presented base62 secret, unpeppered, 32 bytes at rest', () => {
      expect(SECRET_VERIFICATION).toStrictEqual({
        hashAlgorithm: 'sha256',
        hashedInput: 'ascii(secret43)',
        hashBytes: 32,
        comparisonIsConstantTime: true,
        comparesOnAbsentRow: true,
        lookupBy: 'token_id',
      });
    });

    it('publishes a fixed 32-byte buffer for the absent-row comparison', () => {
      expect(ABSENT_SECRET_HASH).toHaveLength(SECRET_VERIFICATION.hashBytes);
      expect([...ABSENT_SECRET_HASH].every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('scopes', () => {
    it('is the six read permissions, and they are the ones the matrix calls reads', () => {
      expect([...READ_SCOPES]).toStrictEqual([...READ_BUNDLE]);
      expect([...READ_SCOPES]).toStrictEqual([
        'vault:read',
        'note:read',
        'search:read',
        'history:read',
        'attachment:read',
        'export:read',
      ]);
      expect(SCOPE_BUNDLES.read).toBe(READ_SCOPES);
    });

    it('accepts only the bundle name `read`', () => {
      expect(GrantableBundleSchema.parse('read')).toBe('read');
      expect(GrantableBundleSchema.safeParse('write').success).toBe(false);
      expect(GrantableBundleSchema.safeParse('admin').success).toBe(false);
    });

    it('keeps the reserved write scopes schema-valid', () => {
      expect([...SCOPES]).toStrictEqual([...READ_SCOPES, ...RESERVED_WRITE_SCOPES]);
      for (const scope of RESERVED_WRITE_SCOPES) {
        expect(ScopeSchema.parse(scope)).toBe(scope);
      }
      expect(ScopeSchema.safeParse('server:users').success).toBe(false);
    });

    it('makes a reserved scope grant nothing', () => {
      expect(toEffectivePermissions([...RESERVED_WRITE_SCOPES])).toStrictEqual([]);
      expect(toEffectivePermissions(['note:read', 'note:write'])).toStrictEqual(['note:read']);
      // `note:propose` is a scope string and not a permission at all, so it cannot even be
      // spelled where `authorize()` reads.
      expect(RESERVED_WRITE_SCOPES).toContain('note:propose');
      expect(PERMISSIONS as readonly string[]).not.toContain('note:propose');
    });

    it('returns permissions in vocabulary order and without duplicates', () => {
      const shuffled = ['export:read', 'note:read', 'note:read', 'vault:read'];
      expect(toEffectivePermissions(shuffled)).toStrictEqual([
        'vault:read',
        'note:read',
        'export:read',
      ] satisfies Permission[]);
    });
  });
});
