/**
 * The current pepper version (04-auth-and-access-control.md section 3.6; D04-05; ARCH-09).
 *
 * `schema_meta.pepper_version` names the version every **new** hash uses; the keyring
 * (`AUTH_PASSWORD_PEPPER_V<n>`) must carry it, and must keep carrying every version still present
 * in `user_credentials`. `iridium keys rotate pepper --to <n>` writes the row and touches no
 * environment variable, so the row is the only source of truth — and this module reads it on
 * every call rather than caching it. A rotation must be observed by the very next hash and by the
 * very next re-hash decision: one primary-key read per password operation is what makes that true,
 * and a cached copy would be exactly the "environment selects the version" state ARCH-09 forbids,
 * one step removed.
 *
 * Boot proceeds without a database (ARCH-02), so a version the keyring lacks is not fatal at boot:
 * the auth plugin logs it at `error` level the moment a database is reachable, the `key_versions`
 * readiness check reports the referenced versions, and every password operation answers `503`
 * (`PepperVersionMissingError`) until an operator adds the key or promotes a version this host has.
 */
import type { Kysely } from 'kysely';

import type { Database } from '../../db/index.ts';
import { PepperVersionMissingError } from './hasher.ts';

/** The `schema_meta` key. */
export const PEPPER_VERSION_KEY = 'pepper_version';

/** Reads `schema_meta.pepper_version`, validated against the keyring, on every call. */
export class PepperVersionSource {
  readonly #db: () => Kysely<Database> | null;
  readonly #peppers: ReadonlyMap<number, Uint8Array>;

  constructor(db: () => Kysely<Database> | null, peppers: ReadonlyMap<number, Uint8Array>) {
    this.#db = db;
    this.#peppers = peppers;
  }

  /**
   * The promoted version, read now. Throws `PepperStoreUnavailableError` without a database,
   * `PepperVersionRowError` when the row is absent or not a positive integer, and
   * `PepperVersionMissingError` when the keyring does not carry the promoted version.
   */
  async current(): Promise<number> {
    return (await this.#read()).version;
  }

  /** The pepper bytes of the promoted version, for the salted email hash of D04-17. */
  async currentPepper(): Promise<Uint8Array> {
    return (await this.#read()).pepper;
  }

  /** One read and one keyring lookup serve both accessors, so neither can disagree with the other. */
  async #read(): Promise<{ readonly version: number; readonly pepper: Uint8Array }> {
    const db = this.#db();
    if (db === null) throw new PepperStoreUnavailableError();
    const row = await db
      .selectFrom('schema_meta')
      .select('value')
      .where('key', '=', PEPPER_VERSION_KEY)
      .executeTakeFirst();
    const version = row === undefined ? Number.NaN : Number(row.value);
    if (!Number.isInteger(version) || version < 1) throw new PepperVersionRowError(row?.value);
    const pepper = this.#peppers.get(version);
    if (pepper === undefined) throw new PepperVersionMissingError(version);
    return { version, pepper };
  }
}

/** Thrown when the database is not connected; a `503`, never a wrong hash. */
export class PepperStoreUnavailableError extends Error {
  constructor() {
    super(
      'the pepper version cannot be read: dbApp is not connected; password operations answer 503 ' +
        'until it is (04-auth-and-access-control.md section 3.6)',
    );
    this.name = 'PepperStoreUnavailableError';
  }
}

/** Thrown when the row is absent or not a positive integer; migration 0032 seeds it. */
export class PepperVersionRowError extends Error {
  constructor(observed: string | undefined) {
    super(
      `schema_meta.pepper_version is ${observed === undefined ? 'absent' : JSON.stringify(observed)}, ` +
        'not a positive integer; migration 0032_schema_meta seeds it and `iridium keys rotate pepper` ' +
        'is the only writer',
    );
    this.name = 'PepperVersionRowError';
  }
}
