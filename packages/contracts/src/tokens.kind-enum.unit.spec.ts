import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_KINDS,
  AccessTokenKind,
  BEARER_MOUNTS,
  CREDENTIAL_LENGTH,
  credentialRegex,
  credentialSchema,
  displayPrefix,
  isKindAcceptedOn,
  kindOf,
  mintToken,
  MOUNT_ACCEPTED_KIND,
  parseToken,
  RESERVED_TOKEN_KINDS,
  TOKEN_KIND_SPECS,
  TOKEN_KINDS,
  TokenKind,
  type BearerMount,
} from './tokens.ts';

describe('tokens.kind-enum.unit [area:tokens]', () => {
  describe('the access_tokens.kind union', () => {
    it('holds pat and oauth live and scim reserved', () => {
      expect([...ACCESS_TOKEN_KINDS]).toStrictEqual(['pat', 'oauth', 'scim']);
      expect(AccessTokenKind.safeParse('pat').success).toBe(true);
      expect(AccessTokenKind.safeParse('oauth').success).toBe(true);
      expect(AccessTokenKind.safeParse('ticket').success).toBe(false);
      expect(TOKEN_KIND_SPECS.pat).toStrictEqual({
        store: 'access_tokens',
        accessTokenKind: 'pat',
        issued: true,
      });
      expect(TOKEN_KIND_SPECS.oat.accessTokenKind).toBe('oauth');
      expect(TOKEN_KIND_SPECS.scim.issued).toBe(false);
    });

    it('keeps the refresh token and the authorization code in their own tables', () => {
      expect(TOKEN_KIND_SPECS.ort.store).toBe('oauth_refresh_tokens');
      expect(TOKEN_KIND_SPECS.ort.accessTokenKind).toBeNull();
      expect(TOKEN_KIND_SPECS.oac.store).toBe('oauth_authorization_codes');
      expect(TOKEN_KIND_SPECS.oac.accessTokenKind).toBeNull();
      expect(TOKEN_KIND_SPECS.ses.store).toBe('sessions');
      expect(TOKEN_KIND_SPECS.tkt.store).toBe('TicketStore');
      expect(TOKEN_KIND_SPECS.spl.store).toBe('password_setup_tokens');
    });

    it('describes every kind, reserved ones included, and nothing else', () => {
      expect(Object.keys(TOKEN_KIND_SPECS).toSorted()).toStrictEqual(
        [...TOKEN_KINDS, ...RESERVED_TOKEN_KINDS].toSorted(),
      );
    });
  });

  describe('prefix dispatch', () => {
    it('is exhaustive over the issued kinds', () => {
      for (const kind of TOKEN_KINDS) {
        const minted = mintToken(kind);
        expect(kindOf(minted.raw)).toBe(kind);
        expect(parseToken(minted.raw)?.kind).toBe(kind);
        expect(minted.raw).toHaveLength(CREDENTIAL_LENGTH);
        expect(minted.displayPrefix).toBe(displayPrefix(kind, minted.tokenId));
        expect(TokenKind.safeParse(kind).success).toBe(true);
      }
    });

    it('refuses the reserved kind and anything that is not a credential', () => {
      for (const reserved of RESERVED_TOKEN_KINDS) {
        expect(kindOf(`irid_${reserved}_0000000000000000_${'0'.repeat(49)}`)).toBeNull();
        expect(TokenKind.safeParse(reserved).success).toBe(false);
      }
      expect(kindOf('github_pat_11AAA')).toBeNull();
      expect(kindOf('irid_xyz_0000000000000000_0')).toBeNull();
      expect(kindOf('')).toBeNull();
    });

    it('accepts exactly one credential kind per bearer mount', () => {
      const mounts: readonly BearerMount[] = BEARER_MOUNTS;
      expect(Object.keys(MOUNT_ACCEPTED_KIND).toSorted()).toStrictEqual(mounts.toSorted());
      expect(isKindAcceptedOn('pat', 'mcp')).toBe(true);
      expect(isKindAcceptedOn('oat', 'mcp')).toBe(false);
      expect(isKindAcceptedOn('oat', 'mcp-connect')).toBe(true);
      expect(isKindAcceptedOn('pat', 'mcp-connect')).toBe(false);
      expect(isKindAcceptedOn('pat', 'rest')).toBe(true);
      expect(isKindAcceptedOn('ses', 'rest')).toBe(false);
    });
  });

  describe('the per-kind wire schemas', () => {
    it('accepts only a credential of its own kind, with the CRC verified', () => {
      const ticket = mintToken('tkt');
      const link = mintToken('spl');
      expect(credentialSchema('tkt').safeParse(ticket.raw).success).toBe(true);
      expect(credentialSchema('tkt').safeParse(link.raw).success).toBe(false);
      expect(credentialSchema('spl').safeParse(link.raw).success).toBe(true);
      expect(credentialRegex('tkt').test(ticket.raw)).toBe(true);
      expect(credentialRegex('spl').test(ticket.raw)).toBe(false);
    });

    it('refuses a well-shaped credential whose check digits do not verify', () => {
      const session = mintToken('ses');
      const lastDigit = session.raw.slice(-1) === '0' ? '1' : '0';
      const tampered = `${session.raw.slice(0, -1)}${lastDigit}`;
      expect(credentialRegex('ses').test(tampered)).toBe(true);
      expect(credentialSchema('ses').safeParse(tampered).success).toBe(false);
    });

    it('refuses a credential of the wrong length before the CRC runs', () => {
      expect(credentialSchema('pat').safeParse('irid_pat_short').success).toBe(false);
    });
  });
});
