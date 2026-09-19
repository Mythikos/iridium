/**
 * `auth.pepper-version.unit` (04-auth-and-access-control.md section 3.6; D04-05; ARCH-09): the
 * promoted pepper version is one `schema_meta` read per call, never cached; a missing database, an
 * absent or malformed row and a version the keyring lacks are three typed errors that each carry
 * their remedy; and the pepper bytes come from the same read as the version.
 */
import { describe, expect, it } from 'vitest';

import { fakeDatabase, type ScriptedAnswer } from '../../../test/support/fake-driver.ts';
import { PepperVersionMissingError } from './hasher.ts';
import {
  PEPPER_VERSION_KEY,
  PepperStoreUnavailableError,
  PepperVersionRowError,
  PepperVersionSource,
} from './pepper-version.ts';

const PEPPERS = new Map<number, Uint8Array>([
  [1, new Uint8Array(32).fill(1)],
  [2, new Uint8Array(32).fill(2)],
]);

function source(answer: ScriptedAnswer) {
  const fake = fakeDatabase({ script: () => answer });
  return { fake, source: new PepperVersionSource(() => fake.db, PEPPERS) };
}

describe('auth.pepper-version.unit [area:auth]', () => {
  it('reads the promoted version and its pepper per call, from the schema_meta row', async () => {
    const { fake, source: subject } = source({ rows: [{ value: '2' }] });
    await expect(subject.current()).resolves.toBe(2);
    await expect(subject.currentPepper()).resolves.toStrictEqual(PEPPERS.get(2));
    expect(fake.executed).toHaveLength(2);
    expect(fake.executed[0]?.sql).toContain('schema_meta');
    expect(fake.executed[0]?.parameters).toStrictEqual([PEPPER_VERSION_KEY]);
  });

  it('throws the store error, before any query, while the database is not connected', async () => {
    const subject = new PepperVersionSource(() => null, PEPPERS);
    await expect(subject.current()).rejects.toBeInstanceOf(PepperStoreUnavailableError);
    await expect(subject.currentPepper()).rejects.toThrow(/503/);
  });

  it('refuses an absent row and a value that is not a positive integer, naming what it saw', async () => {
    await expect(source({ rows: [] }).source.current()).rejects.toBeInstanceOf(
      PepperVersionRowError,
    );
    await expect(source({ rows: [] }).source.current()).rejects.toThrow(/is absent/);
    await expect(source({ rows: [{ value: 'two' }] }).source.current()).rejects.toThrow(/"two"/);
    await expect(source({ rows: [{ value: '0' }] }).source.current()).rejects.toThrow(
      PepperVersionRowError,
    );
    await expect(source({ rows: [{ value: '1.5' }] }).source.current()).rejects.toThrow(
      /migration 0032/,
    );
  });

  it('refuses a promoted version the keyring does not carry, naming the variable to set', async () => {
    const { source: subject } = source({ rows: [{ value: '7' }] });
    await expect(subject.current()).rejects.toBeInstanceOf(PepperVersionMissingError);
    await expect(subject.currentPepper()).rejects.toThrow(/AUTH_PASSWORD_PEPPER_V7/);
  });
});
