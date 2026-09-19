/**
 * `auth.phc.unit` (04-auth-and-access-control.md section 3.5; spike S13): the PHC string round
 * trip, the typed failure for an unparseable or unknown-variant hash (never a silent accept), and
 * the re-hash decision on parameter or pepper-version drift.
 */
import { describe, expect, it } from 'vitest';

import {
  ARGON2_PARALLELISM,
  ARGON2_VARIANT,
  ARGON2_VERSION,
  isPhcFailure,
  needsRehash,
  parsePhc,
  type RehashPolicy,
} from './phc.ts';

const SALT = 'c2FsdHNhbHRzYWx0c2FsdA';
const HASH = 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';
const STORED = `$argon2id$v=19$m=65536,t=3,p=1$${SALT}$${HASH}`;
const POLICY: RehashPolicy = {
  params: { memoryKib: 65_536, timeCost: 3, parallelism: ARGON2_PARALLELISM },
  pepperVersion: 1,
};

describe('auth.phc.unit [area:auth]', () => {
  it('parses the stored form into its variant, version, parameters, salt and hash', () => {
    expect(parsePhc(STORED)).toStrictEqual({
      variant: ARGON2_VARIANT,
      version: ARGON2_VERSION,
      params: { memoryKib: 65_536, timeCost: 3, parallelism: 1 },
      salt: SALT,
      hash: HASH,
    });
  });

  it('accepts the other parameter order the reference library writes (m, p, t)', () => {
    const parsed = parsePhc(`$argon2id$v=19$m=131072,p=1,t=6$${SALT}$${HASH}`);
    expect(isPhcFailure(parsed)).toBe(false);
    expect(parsed).toMatchObject({ params: { memoryKib: 131_072, timeCost: 6, parallelism: 1 } });
  });

  it('answers a typed failure for every malformed shape, never a value', () => {
    expect(parsePhc('not a hash')).toStrictEqual({ failure: 'not_phc' });
    expect(parsePhc('$argon2id$v=19$m=65536,t=3,p=1$salt')).toStrictEqual({
      failure: 'malformed_body',
    });
    expect(parsePhc(`$argon2i$v=19$m=65536,t=3,p=1$${SALT}$${HASH}`)).toStrictEqual({
      failure: 'unknown_variant',
    });
    expect(parsePhc(`$argon2id$v=16$m=65536,t=3,p=1$${SALT}$${HASH}`)).toStrictEqual({
      failure: 'unsupported_version',
    });
    expect(parsePhc(`$argon2id$v=19$m=65536,t=3$${SALT}$${HASH}`)).toStrictEqual({
      failure: 'malformed_params',
    });
    expect(parsePhc(`$argon2id$v=19$m=lots,t=3,p=1$${SALT}$${HASH}`)).toStrictEqual({
      failure: 'malformed_params',
    });
    expect(parsePhc(`$argon2id$v=19$m=65536,t=3,p=1,x$${SALT}$${HASH}`)).toStrictEqual({
      failure: 'malformed_params',
    });
  });

  it('needs no re-hash when parameters and pepper version match', () => {
    expect(needsRehash(STORED, 1, POLICY)).toBe(false);
  });

  it('needs a re-hash on memory, time, parallelism or pepper-version drift', () => {
    expect(
      needsRehash(STORED, 1, { ...POLICY, params: { ...POLICY.params, memoryKib: 131_072 } }),
    ).toBe(true);
    expect(needsRehash(STORED, 1, { ...POLICY, params: { ...POLICY.params, timeCost: 6 } })).toBe(
      true,
    );
    expect(
      needsRehash(STORED, 1, { ...POLICY, params: { ...POLICY.params, parallelism: 2 } }),
    ).toBe(true);
    expect(needsRehash(STORED, 2, POLICY)).toBe(true);
    expect(needsRehash(STORED, 1, { ...POLICY, pepperVersion: 2 })).toBe(true);
  });

  it('treats an unparseable stored hash as needing a re-hash', () => {
    expect(needsRehash('garbage', 1, POLICY)).toBe(true);
  });
});
