/** Key metadata recovery and fail-closed signing configuration (ARCH-09). */
import { describe, expect, it } from 'vitest';

import { fakeDatabase } from '../../test/support/fake-driver.ts';
import {
  configuredAuditKeyVersions,
  createAuditKeys,
  readPromotedAuditKeyVersion,
} from './keys.ts';

describe('audit.keys.unit [area:audit]', () => {
  it('uses the seeded version only when the pre-migration metadata row is absent', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [] }) });
    try {
      expect(await readPromotedAuditKeyVersion(fake.db)).toBe(1);
      expect(fake.executed[0]?.parameters).toEqual(['audit_key_version']);
    } finally {
      await fake.db.destroy();
    }
  });

  it.each(['', 'invalid', '-1', '0', '1.5', '9007199254740992'])(
    'refuses invalid present metadata %s instead of falling back to a retired key',
    async (value) => {
      const fake = fakeDatabase({ script: () => ({ rows: [{ value }] }) });
      try {
        await expect(readPromotedAuditKeyVersion(fake.db)).rejects.toMatchObject({
          code: 'config.key_version_invalid',
          exitCode: 2,
        });
      } finally {
        await fake.db.destroy();
      }
    },
  );
  it('preserves a valid promoted version independently of the highest configured key', async () => {
    const fake = fakeDatabase({ script: () => ({ rows: [{ value: '3' }] }) });
    try {
      expect(await readPromotedAuditKeyVersion(fake.db)).toBe(3);
    } finally {
      await fake.db.destroy();
    }
  });

  it('lists configured versions in numeric order regardless of configuration insertion order', () => {
    expect(
      configuredAuditKeyVersions({
        highest: 12,
        versions: new Map([
          [12, new Uint8Array(32)],
          [2, new Uint8Array(32)],
        ]),
        sources: new Map(),
      }),
    ).toEqual([2, 12]);
  });
  it('names the exact missing material when no signing key is configured', () => {
    expect(() =>
      createAuditKeys({
        keyring: { versions: new Map(), highest: 0, sources: new Map() },
        signingVersion: 2,
      }),
    ).toThrow(/carries no version.*AUDIT_HMAC_KEY_V2_FILE/);
  });
});
