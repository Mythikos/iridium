/**
 * `auth.login-timing.unit` (04-auth-and-access-control.md sections 3.5 and 3.7 step 6): the single
 * login path runs a dummy verify for an unknown account, a disabled user and a user without a
 * credential row, so a response time does not distinguish existence — exactly one argon2 `verify()`
 * happens whichever branch is taken, and only a live credential's verification can answer `true`.
 * A stored string the binding cannot parse is a mismatch to the login and one `error`-level line
 * naming the user id and nothing else.
 */
import { describe, expect, it } from 'vitest';

import { PasswordHasher, type Argon2Binding } from './credentials/hasher.ts';
import { idBytes } from './ids.ts';
import { runVerification, verificationPlan, type MalformedCredentialLog } from './login.ts';
import type { UserWithCredential } from './users.ts';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const USER_ID = '019948c4-0000-7000-8000-000000000001';
const PEPPERS = new Map<number, Uint8Array>([[1, new Uint8Array(32).fill(7)]]);
const STORED_HASH = '$argon2id$v=19$m=8192,t=1,p=1$c2FsdA$aGFzaA';
const DUMMY_HASH = '$argon2id$v=19$m=8192,t=1,p=1$ZHVtbXk$ZHVtbXloYXNo';

function user(overrides: Partial<UserWithCredential>): UserWithCredential {
  return {
    id: idBytes(USER_ID),
    email: 'ada@example.test',
    email_key: 'ada@example.test',
    display_name: 'Ada',
    is_server_admin: false,
    status: 'active',
    color_hue: 0,
    authz_version: 1,
    version: 1,
    created_at: NOW,
    updated_at: NOW,
    last_login_at: null,
    password_hash: STORED_HASH,
    pepper_version: 1,
    ...overrides,
  };
}

function countingBinding(): Argon2Binding & { verifyCount: number; hashedSeen: string[] } {
  const binding = {
    verifyCount: 0,
    hashedSeen: [] as string[],
    async hash(): Promise<string> {
      return DUMMY_HASH;
    },
    async verify(hashed: string, password: string): Promise<boolean> {
      binding.verifyCount += 1;
      binding.hashedSeen.push(hashed);
      if (hashed === 'not a hash') throw new Error('malformed');
      return password === 'the right password!';
    },
  };
  return binding;
}

function recordingLog(): MalformedCredentialLog & { readonly lines: unknown[] } {
  const lines: unknown[] = [];
  return {
    lines,
    error: (...args: unknown[]): void => {
      lines.push(args[0]);
    },
  };
}

async function primedHasher(binding: Argon2Binding): Promise<PasswordHasher> {
  const hasher = new PasswordHasher({
    memoryKib: 8_192,
    timeCost: 1,
    concurrency: 1,
    peppers: PEPPERS,
    currentPepperVersion: async () => 1,
    fillRandom: (bytes) => bytes.fill(3),
    binding,
  });
  await hasher.prime();
  return hasher;
}

describe('auth.login-timing.unit [area:auth]', () => {
  it('plans the dummy path for an unknown email, a disabled user, a deleted user and a credential-less user', () => {
    expect(verificationPlan(null)).toStrictEqual({ kind: 'dummy' });
    expect(verificationPlan(user({ status: 'disabled' }))).toStrictEqual({ kind: 'dummy' });
    expect(verificationPlan(user({ status: 'deleted' }))).toStrictEqual({ kind: 'dummy' });
    expect(verificationPlan(user({ password_hash: null, pepper_version: null }))).toStrictEqual({
      kind: 'dummy',
    });
  });

  it('plans the credential path only for a live credential of an active user', () => {
    const live = user({});
    expect(verificationPlan(live)).toStrictEqual({ kind: 'credential', user: live });
  });

  it('performs exactly one verify() on either path, and the dummy path never answers true', async () => {
    const binding = countingBinding();
    const hasher = await primedHasher(binding);
    const log = recordingLog();

    await expect(
      runVerification(hasher, verificationPlan(null), 'the right password!', log),
    ).resolves.toBe(false);
    expect(binding.verifyCount).toBe(1);
    await expect(
      runVerification(hasher, verificationPlan(user({})), 'the right password!', log),
    ).resolves.toBe(true);
    expect(binding.verifyCount).toBe(2);
    await expect(runVerification(hasher, verificationPlan(user({})), 'wrong', log)).resolves.toBe(
      false,
    );
    expect(binding.verifyCount).toBe(3);
    // The dummy path verified against the primed hash, the credential path against the row's.
    expect(binding.hashedSeen[0]).toBe(DUMMY_HASH);
    expect(binding.hashedSeen[1]).toBe(STORED_HASH);
    expect(log.lines).toStrictEqual([]);
  });

  it('treats a stored string the binding cannot parse as a mismatch and logs the user id only', async () => {
    const binding = countingBinding();
    const hasher = await primedHasher(binding);
    const log = recordingLog();
    const broken = user({ password_hash: 'not a hash' });
    await expect(
      runVerification(hasher, verificationPlan(broken), 'the right password!', log),
    ).resolves.toBe(false);
    expect(binding.verifyCount).toBe(1);
    expect(log.lines).toStrictEqual([{ event: 'auth.credential.malformed', userId: USER_ID }]);
    expect(JSON.stringify(log.lines)).not.toContain('not a hash');
  });
});
