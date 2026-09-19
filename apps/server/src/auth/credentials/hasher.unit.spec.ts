/**
 * `auth.hasher.unit` (04-auth-and-access-control.md sections 3.5 and 3.6; D04-03; D04-05; S13):
 * argon2id with `m`, `t`, `p=1`, the versioned pepper as the binding's `secret`, `outputLen` as the
 * hash length, the dummy hash for timing equalisation, the concurrency semaphore, and the failure
 * branches — a mismatch and a malformed stored string both answer `false`, a missing pepper version
 * throws with the remedy.
 */
import { describe, expect, it } from 'vitest';

import {
  ARGON2_OUTPUT_LEN,
  PasswordHasher,
  PepperVersionMissingError,
  type Argon2Binding,
  type Argon2HashOptions,
  type PasswordHasherOptions,
} from './hasher.ts';
import { needsRehash, parsePhc } from './phc.ts';

/** Small parameters so the native binding answers quickly; the unit asserts the *shape*. */
const MEMORY_KIB = 8_192;
const TIME_COST = 1;
const PEPPER_V1 = new Uint8Array(32).fill(1);
const PEPPER_V2 = new Uint8Array(32).fill(2);
const PEPPERS = new Map<number, Uint8Array>([
  [1, PEPPER_V1],
  [2, PEPPER_V2],
]);

let fillCounter = 0;
const deterministicFill = (bytes: Uint8Array): void => {
  for (let index = 0; index < bytes.length; index += 1) {
    fillCounter += 1;
    bytes[index] = fillCounter % 251;
  }
};

function hasher(overrides: Partial<PasswordHasherOptions> = {}): PasswordHasher {
  return new PasswordHasher({
    memoryKib: MEMORY_KIB,
    timeCost: TIME_COST,
    concurrency: 4,
    peppers: PEPPERS,
    currentPepperVersion: async () => 1,
    fillRandom: deterministicFill,
    ...overrides,
  });
}

/** A binding that records calls and resolves on demand, for the semaphore and error branches. */
function recordingBinding(): Argon2Binding & {
  readonly hashCalls: Argon2HashOptions[];
  readonly verifyCalls: { hashed: string; secret: Uint8Array }[];
  release(): void;
  fail: boolean;
} {
  const waiting: (() => void)[] = [];
  const binding = {
    hashCalls: [] as Argon2HashOptions[],
    verifyCalls: [] as { hashed: string; secret: Uint8Array }[],
    fail: false,
    release(): void {
      waiting.shift()?.();
    },
    async hash(password: string, options: Argon2HashOptions): Promise<string> {
      binding.hashCalls.push(options);
      await new Promise<void>((resolve) => waiting.push(resolve));
      return `$argon2id$v=19$m=${String(options.memoryCost)},t=${String(options.timeCost)},p=${String(options.parallelism)}$c2FsdA$${password.length}`;
    },
    async verify(
      hashed: string,
      _password: string,
      options: { secret: Uint8Array },
    ): Promise<boolean> {
      binding.verifyCalls.push({ hashed, secret: options.secret });
      if (binding.fail) throw new Error('malformed');
      return true;
    },
  };
  return binding;
}

describe('auth.hasher.unit [area:auth]', () => {
  it('hashes with argon2id v19, the configured m and t, p=1, a 32-byte output and the current pepper', async () => {
    const subject = hasher();
    const { phc, pepperVersion } = await subject.hash('correct horse battery staple');
    expect(pepperVersion).toBe(1);
    const parsed = parsePhc(phc);
    expect(parsed).toMatchObject({
      variant: 'argon2id',
      version: 19,
      params: { memoryKib: MEMORY_KIB, timeCost: TIME_COST, parallelism: 1 },
    });
    // 32 raw bytes are 43 unpadded base64 characters (ARGON2_OUTPUT_LEN, the binding's outputLen).
    expect(parsed).toMatchObject({ hash: expect.stringMatching(/^[A-Za-z0-9+/]{43}$/) });
    expect(ARGON2_OUTPUT_LEN).toBe(32);
    await expect(subject.verify(phc, 'correct horse battery staple', 1)).resolves.toBe('match');
    await expect(subject.verify(phc, 'wrong password entirely!', 1)).resolves.toBe('mismatch');
  });

  it('binds the pepper: a hash made under version 1 does not verify under version 2', async () => {
    const subject = hasher();
    const { phc } = await subject.hash('correct horse battery staple');
    await expect(subject.verify(phc, 'correct horse battery staple', 2)).resolves.toBe('mismatch');
  });

  it('reads the promoted pepper version per call, so a rotation changes the next hash', async () => {
    let current = 1;
    const subject = hasher({ currentPepperVersion: async () => current });
    await expect(subject.rehashPolicy()).resolves.toMatchObject({ pepperVersion: 1 });
    current = 2;
    const { pepperVersion } = await subject.hash('correct horse battery staple');
    expect(pepperVersion).toBe(2);
    await expect(subject.rehashPolicy()).resolves.toStrictEqual({
      params: { memoryKib: MEMORY_KIB, timeCost: TIME_COST, parallelism: 1 },
      pepperVersion: 2,
    });
    expect(subject.params).toStrictEqual({
      memoryKib: MEMORY_KIB,
      timeCost: TIME_COST,
      parallelism: 1,
    });
  });

  it('decides a re-hash from the stored parameters and pepper version, never from the library', async () => {
    const subject = hasher();
    const { phc } = await subject.hash('correct horse battery staple');
    expect(needsRehash(phc, 1, await subject.rehashPolicy())).toBe(false);
    expect(needsRehash(phc, 2, await subject.rehashPolicy())).toBe(true);
    const stricter = hasher({ timeCost: TIME_COST + 1 });
    expect(needsRehash(phc, 1, await stricter.rehashPolicy())).toBe(true);
  });

  it('reports a malformed stored string as such, never throwing', async () => {
    await expect(hasher().verify('not a hash at all', 'anything at all here', 1)).resolves.toBe(
      'malformed',
    );
  });

  it('throws with the remedy when a credential names an unconfigured pepper version', async () => {
    await expect(hasher().verify('$argon2id$v=19$m=1,t=1,p=1$a$b', 'pw', 7)).rejects.toBeInstanceOf(
      PepperVersionMissingError,
    );
    await expect(hasher({ currentPepperVersion: async () => 9 }).hash('pw')).rejects.toThrow(
      /AUTH_PASSWORD_PEPPER_V9/,
    );
  });

  it('refuses a non-positive or non-integer concurrency', () => {
    expect(() => hasher({ concurrency: 0 })).toThrow(RangeError);
    expect(() => hasher({ concurrency: 1.5 })).toThrow(RangeError);
  });

  it('runs a real verification against the dummy hash and discards the result', async () => {
    const binding = recordingBinding();
    const subject = hasher({ binding });
    await expect(subject.verifyDummy('pw')).rejects.toThrow(/prime\(\)/);
    const priming = subject.prime();
    binding.release();
    await priming;
    expect(binding.hashCalls).toHaveLength(1);
    await subject.verifyDummy('irrelevant');
    expect(binding.verifyCalls).toHaveLength(1);
    const call = binding.verifyCalls[0];
    expect(call?.hashed.startsWith('$argon2id$')).toBe(true);
    // The dummy pepper is neither configured version: a stored credential can never match it.
    expect(call?.secret).not.toEqual(PEPPER_V1);
    expect(call?.secret).not.toEqual(PEPPER_V2);
    binding.fail = true;
    await expect(subject.verifyDummy('irrelevant')).resolves.toBeUndefined();
  });

  it('bounds concurrent hashing to the semaphore and serves waiters in arrival order', async () => {
    const binding = recordingBinding();
    const subject = hasher({ binding, concurrency: 2 });
    const first = subject.hash('one');
    const second = subject.hash('two');
    const third = subject.hash('three');
    await Promise.resolve();
    expect(binding.hashCalls).toHaveLength(2);
    expect(subject.waiting).toBe(1);
    binding.release();
    await first;
    await Promise.resolve();
    expect(binding.hashCalls).toHaveLength(3);
    expect(subject.waiting).toBe(0);
    binding.release();
    binding.release();
    await expect(Promise.all([second, third])).resolves.toHaveLength(2);
  });

  it('counts only admitted native operations and returns isolated snapshots through failures', async () => {
    const subject = hasher();
    const initial = subject.operationCounts();
    expect(initial).toEqual({
      hashes: 0,
      verifications: 0,
      dummyVerifications: 0,
      completed: 0,
      active: 0,
      maxActive: 0,
    });
    await expect(subject.verifyDummy('before prime')).rejects.toThrow(/prime/);
    await expect(subject.verify('unused', 'unused', 99)).rejects.toThrow(PepperVersionMissingError);
    expect(subject.operationCounts()).toEqual(initial);
    await subject.prime();
    const hashed = await subject.hash('native-operation-proof');
    await subject.verifyDummy('unknown account');
    expect(await subject.verify(hashed.phc, 'native-operation-proof', 1)).toBe('match');
    expect(await subject.verify('malformed', 'wrong', 1)).toBe('malformed');
    expect(subject.operationCounts()).toEqual({
      hashes: 2,
      verifications: 2,
      dummyVerifications: 1,
      completed: 5,
      active: 0,
      maxActive: 1,
    });
    expect(initial.hashes).toBe(0);
  });

  it('distinguishes queued callers from native work and releases the active count after rejection', async () => {
    const waiting = Promise.withResolvers<string>();
    const binding: Argon2Binding = { hash: async () => waiting.promise, verify: async () => false };
    const subject = hasher({ binding, concurrency: 1 });
    const first = subject.hash('one');
    const second = subject.hash('two');
    const outcomes = Promise.allSettled([first, second]);
    await Promise.resolve();
    expect(subject.operationCounts()).toMatchObject({
      hashes: 1,
      active: 1,
      completed: 0,
      maxActive: 1,
    });
    expect(subject.waiting).toBe(1);
    waiting.reject(new Error('native hash failed'));
    expect((await outcomes).map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(subject.operationCounts()).toMatchObject({
      hashes: 2,
      active: 0,
      completed: 2,
      maxActive: 1,
    });
    expect(subject.waiting).toBe(0);
  });
});
