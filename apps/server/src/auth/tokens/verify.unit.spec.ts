/**
 * `auth.token-verify.unit` (04-auth-and-access-control.md section 9.1; 06-mcp-and-agent-access.md,
 * "Storage and verification"; D04-26; D04-30): the ordered verification of a bearer credential over
 * a fake repository — every step's refusal, the constant-time comparison on an absent row, the kind
 * per mount, the OAuth audience and liveness checks, and the principal plus `AuthInfo` a live token
 * resolves to. The reserved write scopes are dropped from the principal here, which is what keeps
 * them inert.
 */
import { mintToken, READ_BUNDLE, TokenId, VaultId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { withOtherSecret } from '../../../test/support/credentials.ts';
import { fakeDatabase } from '../../../test/support/fake-driver.ts';
import { idBytes } from '../ids.ts';
import { secretHash } from '../secret-hash.ts';
import {
  PrincipalTokenMissingError,
  requireTokenRow,
  TokenStoreUnavailableError,
  TokenVerifier,
  type TokenRepository,
  type TokenRowWithOwner,
} from './verify.ts';

const NOW_MS = Date.parse('2026-09-13T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const ROW_ID = '019948c4-0000-7000-8000-00000000f001';
const OWNER_ID = '019948c4-0000-7000-8000-000000000001';
const VAULT_A = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const CONNECT = 'https://iridium.example/mcp/connect';

interface Fixture {
  readonly raw: string;
  readonly row: TokenRowWithOwner;
  readonly repository: TokenRepository & { lookups: number; allowlistCalls: number };
  readonly verifier: TokenVerifier;
}

function fixture(
  kind: 'pat' | 'oat' = 'pat',
  overrides: Partial<TokenRowWithOwner> = {},
  allowlist: readonly VaultId[] = [VAULT_A],
): Fixture {
  const minted = mintToken(kind);
  const row: TokenRowWithOwner = {
    id: idBytes(ROW_ID),
    token_id: minted.tokenId,
    secret_hash: secretHash(minted.secret),
    user_id: idBytes(OWNER_ID),
    kind: kind === 'pat' ? 'pat' : 'oauth',
    scopes: [...READ_BUNDLE, 'note:write', 'note:propose'],
    all_vaults: false,
    admin_owned: false,
    expires_at: new Date(NOW_MS + HOUR_MS),
    rate_limit_per_hour: null,
    rotation_overlap_until: null,
    resource: kind === 'oat' ? CONNECT : null,
    revoked_at: null,
    consent_id: kind === 'oat' ? idBytes('019948c4-0000-7000-8000-00000000c001') : null,
    user_status: 'active',
    consent_revoked_at: null,
    client_public_id: kind === 'oat' ? 'https://client.example/cimd.json' : null,
    client_status: kind === 'oat' ? 'active' : null,
    ...overrides,
  };
  const repository = {
    lookups: 0,
    allowlistCalls: 0,
    async findByTokenId(tokenId: string): Promise<TokenRowWithOwner | null> {
      repository.lookups += 1;
      return tokenId === row.token_id ? row : null;
    },
    async allowlist(): Promise<readonly VaultId[]> {
      repository.allowlistCalls += 1;
      return allowlist;
    },
  };
  return {
    raw: minted.raw,
    row,
    repository,
    verifier: new TokenVerifier(
      () => repository,
      () => NOW_MS,
      3000,
    ),
  };
}

describe('auth.token-verify.unit [area:tokens]', () => {
  it('refuses a malformed bearer with no database access and no audit', async () => {
    const built = fixture();
    const result = await built.verifier.verifyToken('irid_pat_nope', { mount: 'rest' });
    expect(result).toMatchObject({ ok: false, reason: 'malformed', denial: null });
    expect(built.repository.lookups).toBe(0);
    // A session credential is not a token: refused before any query.
    const session = await built.verifier.verifyToken(mintToken('ses').raw, { mount: 'rest' });
    expect(session).toMatchObject({ ok: false, reason: 'unknown_kind', denial: null });
    expect(built.repository.lookups).toBe(0);
  });

  it('answers unknown_id for an absent row after one lookup, with no audit row', async () => {
    const built = fixture();
    const result = await built.verifier.verifyToken(mintToken('pat').raw, { mount: 'rest' });
    expect(result).toMatchObject({ ok: false, reason: 'unknown_id', denial: null });
    expect(built.repository.lookups).toBe(1);
  });

  it('answers secret_mismatch for a real id with the wrong secret, naming the row for the audit', async () => {
    const built = fixture();
    const wrong = withOtherSecret(built.raw);
    const result = await built.verifier.verifyToken(wrong, { mount: 'rest' });
    expect(result).toMatchObject({
      ok: false,
      reason: 'secret_mismatch',
      denial: {
        reason: 'secret_mismatch',
        tokenRowId: ROW_ID,
        tokenKind: 'pat',
        ownerUserId: OWNER_ID,
      },
    });
  });

  it('names every parse failure of the closed vocabulary, with one public reason and no lookup', async () => {
    const built = fixture();
    const raw = built.raw;
    const cases = [
      ['Bearer-looking garbage', 'not_a_credential'],
      [`irid_zzz_${raw.slice('irid_pat_'.length)}`, 'unknown_kind'],
      ['irid_pat_nope', 'malformed'],
      [`${raw.slice(0, -1)}${raw.endsWith('A') ? 'B' : 'A'}`, 'crc_mismatch'],
    ] as const;
    for (const [presented, reason] of cases) {
      // eslint-disable-next-line no-await-in-loop -- the vocabulary is checked in order
      const result = await built.verifier.verifyToken(presented, { mount: 'rest' });
      expect(result).toStrictEqual({
        ok: false,
        reason,
        publicReason: 'the bearer credential is malformed',
        denial: null,
      });
    }
    expect(built.repository.lookups).toBe(0);
  });

  it('requires the row a token principal names, throwing the typed error when it is gone', async () => {
    const tokenId = TokenId.parse(ROW_ID);
    const found = fakeDatabase({ script: () => ({ rows: [{ name: 'ci bot' }] }) });
    await expect(requireTokenRow(found.db, tokenId)).resolves.toStrictEqual({ name: 'ci bot' });
    expect(found.executed[0]?.parameters).toStrictEqual([idBytes(ROW_ID)]);
    const gone = fakeDatabase({ script: () => ({ rows: [] }) });
    const thrown = await requireTokenRow(gone.db, tokenId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(PrincipalTokenMissingError);
    expect(thrown).toMatchObject({ tokenId, message: expect.stringContaining(ROW_ID) });
  });

  it('refuses the wrong kind for a mount, naming the other endpoint', async () => {
    const pat = fixture('pat');
    const onConnect = await pat.verifier.verifyToken(pat.raw, {
      mount: 'mcp-connect',
      resource: CONNECT,
    });
    expect(onConnect).toMatchObject({
      ok: false,
      reason: 'wrong_kind_for_route',
      publicReason: expect.stringContaining('/mcp'),
    });
    const oat = fixture('oat');
    const onMcp = await oat.verifier.verifyToken(oat.raw, {
      mount: 'mcp',
      resource: 'https://iridium.example/mcp',
    });
    expect(onMcp).toMatchObject({
      ok: false,
      reason: 'wrong_kind_for_route',
      publicReason: expect.stringContaining('/mcp/connect'),
      // The denial names the credential kind that was presented, which is what the audit row records.
      denial: { tokenKind: 'oauth', tokenRowId: ROW_ID },
    });
    // A row whose stored kind disagrees with its own prefix is refused the same way.
    const mismatched = fixture('pat', { kind: 'oauth' });
    await expect(
      mismatched.verifier.verifyToken(mismatched.raw, { mount: 'rest' }),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'wrong_kind_for_route',
    });
  });

  it('checks the OAuth audience and the consent and client liveness before the token row', async () => {
    const audience = fixture('oat');
    await expect(
      audience.verifier.verifyToken(audience.raw, {
        mount: 'mcp-connect',
        resource: 'https://other.example/mcp/connect',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'audience_mismatch' });
    await expect(
      audience.verifier.verifyToken(audience.raw, { mount: 'mcp-connect' }),
    ).resolves.toMatchObject({ ok: false, reason: 'audience_mismatch' });
    const consent = fixture('oat', { consent_revoked_at: new Date(NOW_MS - 1) });
    await expect(
      consent.verifier.verifyToken(consent.raw, { mount: 'mcp-connect', resource: CONNECT }),
    ).resolves.toMatchObject({ ok: false, reason: 'consent_revoked' });
    const client = fixture('oat', { client_status: 'disabled' });
    await expect(
      client.verifier.verifyToken(client.raw, { mount: 'mcp-connect', resource: CONNECT }),
    ).resolves.toMatchObject({ ok: false, reason: 'client_disabled' });
  });

  it('refuses a revoked, overlap-elapsed, expired or owner-inactive token in that order', async () => {
    const revoked = fixture('pat', {
      revoked_at: new Date(NOW_MS - 1),
      expires_at: new Date(NOW_MS - 1),
    });
    await expect(
      revoked.verifier.verifyToken(revoked.raw, { mount: 'rest' }),
    ).resolves.toMatchObject({ ok: false, reason: 'revoked' });
    const overlap = fixture('pat', { rotation_overlap_until: new Date(NOW_MS) });
    await expect(
      overlap.verifier.verifyToken(overlap.raw, { mount: 'rest' }),
    ).resolves.toMatchObject({ ok: false, reason: 'rotation_overlap_elapsed' });
    const stillOverlapping = fixture('pat', { rotation_overlap_until: new Date(NOW_MS + 1) });
    await expect(
      stillOverlapping.verifier.verifyToken(stillOverlapping.raw, { mount: 'rest' }),
    ).resolves.toMatchObject({ ok: true });
    const expired = fixture('pat', { expires_at: new Date(NOW_MS) });
    const expiredResult = await expired.verifier.verifyToken(expired.raw, { mount: 'rest' });
    expect(expiredResult).toMatchObject({
      ok: false,
      reason: 'expired',
      publicReason: expect.stringContaining('expired'),
    });
    const inactive = fixture('pat', { user_status: 'disabled' });
    await expect(
      inactive.verifier.verifyToken(inactive.raw, { mount: 'rest' }),
    ).resolves.toMatchObject({ ok: false, reason: 'user_inactive' });
  });

  it('builds the principal from the row and the allowlist, dropping reserved scopes', async () => {
    const built = fixture();
    const result = await built.verifier.verifyToken(built.raw, { mount: 'rest' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal).toStrictEqual({
      kind: 'token',
      tokenKind: 'pat',
      tokenId: ROW_ID,
      publicTokenId: built.row.token_id,
      userId: OWNER_ID,
      clientId: null,
      consentId: null,
      resource: null,
      scopes: [...READ_BUNDLE],
      vaultScope: { vaultIds: [VAULT_A] },
      isServerAdmin: false,
      adminOwned: false,
      surface: 'rest',
      rateLimitPerHour: 3000,
      expiresAt: built.row.expires_at,
    });
    expect(built.repository.allowlistCalls).toBe(1);
    expect(result.authInfo).toStrictEqual({
      token: built.raw,
      clientId: `pat:${built.row.token_id}`,
      scopes: [...READ_BUNDLE],
      expiresAt: Math.floor(built.row.expires_at.getTime() / 1000),
      extra: { principal: result.principal },
    });
  });

  it('resolves all_vaults without an allowlist read, the row rate limit, and the OAuth identity', async () => {
    const built = fixture('oat', { all_vaults: true, rate_limit_per_hour: 120, admin_owned: true });
    const result = await built.verifier.verifyToken(built.raw, {
      mount: 'mcp-connect',
      resource: CONNECT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(built.repository.allowlistCalls).toBe(0);
    expect(result.principal).toMatchObject({
      tokenKind: 'oauth',
      clientId: 'https://client.example/cimd.json',
      consentId: '019948c4-0000-7000-8000-00000000c001',
      resource: CONNECT,
      vaultScope: { all: true },
      rateLimitPerHour: 120,
      adminOwned: true,
      surface: 'mcp',
      isServerAdmin: false,
    });
    expect(result.authInfo.clientId).toBe('oauth:https://client.example/cimd.json');
    expect(result.authInfo.resource).toStrictEqual(new URL(CONNECT));
  });

  it('throws, never denies, when the store is not connected', async () => {
    const verifier = new TokenVerifier(
      () => null,
      () => NOW_MS,
    );
    await expect(
      verifier.verifyToken(mintToken('pat').raw, { mount: 'rest' }),
    ).rejects.toBeInstanceOf(TokenStoreUnavailableError);
  });
});
