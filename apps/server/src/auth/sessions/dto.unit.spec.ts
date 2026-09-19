/**
 * `auth.session-dto.unit` (09-api-reference.md section 2.3): the `Session` representation renders
 * every column the wire names and nothing it does not — no secret, no MFA column — with the address
 * restored, `current` from the presented session, and the revocation pair rendered for a revoked
 * row so the one mapper serves the live listings and the administrator's view alike.
 */
import { SessionId } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../ids.ts';
import { ipToBytes } from '../ip.ts';
import { toSessionDto } from './dto.ts';
import type { SessionRow } from './repository.ts';

const SESSION = SessionId.parse('019948c4-0000-7000-8000-0000000000aa');
const OTHER = SessionId.parse('019948c4-0000-7000-8000-0000000000ab');
const NOW = new Date('2026-09-13T12:00:00.000Z');
const LATER = new Date('2026-09-13T13:00:00.000Z');

const ROW: SessionRow = {
  id: idBytes(SESSION),
  token_id: 'ABCDEFGHIJKLMNOP',
  secret_hash: Buffer.alloc(32, 7),
  user_id: idBytes('019948c4-0000-7000-8000-000000000001'),
  kind: 'desktop',
  created_at: NOW,
  last_seen_at: NOW,
  idle_expires_at: LATER,
  absolute_expires_at: LATER,
  last_authenticated_at: NOW,
  ip: ipToBytes('203.0.113.7'),
  user_agent: 'Iridium/1.0',
  client_name: 'desktop',
  device_name: 'studio',
  client_version: '1.0.0',
  revoked_at: null,
  revoked_reason: null,
};

describe('auth.session-dto.unit [area:auth]', () => {
  it('renders a live row with the wire spellings, marking the presented session current', () => {
    expect(toSessionDto(ROW, SESSION)).toStrictEqual({
      id: SESSION,
      kind: 'desktop',
      current: true,
      createdAt: NOW.toISOString(),
      lastSeenAt: NOW.toISOString(),
      idleExpiresAt: LATER.toISOString(),
      absoluteExpiresAt: LATER.toISOString(),
      lastAuthenticatedAt: NOW.toISOString(),
      ip: '203.0.113.7',
      userAgent: 'Iridium/1.0',
      clientName: 'desktop',
      deviceName: 'studio',
      clientVersion: '1.0.0',
      revokedAt: null,
      revokedReason: null,
    });
    expect(toSessionDto(ROW, OTHER).current).toBe(false);
    expect(JSON.stringify(toSessionDto(ROW, SESSION))).not.toContain('secret');
  });

  it('renders the revocation pair of a revoked row, and a null address as null', () => {
    expect(
      toSessionDto({ ...ROW, ip: null, revoked_at: LATER, revoked_reason: 'logout' }, OTHER),
    ).toMatchObject({
      ip: null,
      current: false,
      revokedAt: LATER.toISOString(),
      revokedReason: 'logout',
    });
  });
});
