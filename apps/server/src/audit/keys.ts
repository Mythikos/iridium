/**
 * The audit HMAC keyring as the chain sees it (11-operations-and-deployment.md, "Key rotation";
 * ARCH-09).
 *
 * Two rules, and they are the reason this is a module rather than two lines inside the plugin:
 *
 *  1. **The environment never selects the version in use.** `schema_meta.audit_key_version` does. A
 *     configured keyring is the set of versions this process can use; the promoted version is the one it
 *     signs with. `iridium keys rotate` writes a key file and touches no database; `iridium keys promote`
 *     changes `schema_meta` and nothing else.
 *  2. **Every version data references must be present.** A stale or restored environment file that no
 *     longer carries the promoted version is `config.key_version_downgrade` — refused rather than
 *     silently signing with a retired key — and a historical version that has gone missing makes
 *     `verify-chain` fail closed on the rows that used it.
 *
 * The same factory serves the server's audit plugin and the CLI's `audit verify-chain`, which is what
 * keeps "the CLI verifies what the server wrote" true by construction.
 */
import type { Kysely } from 'kysely';

import type { Keyring } from '../config/env.ts';
import type { Database } from '../db/schema.ts';
import type { AuditKeys } from './chain.ts';

/** The `schema_meta` key naming the promoted audit version (03-data-model.md §13.2). */
export const AUDIT_KEY_VERSION_META_KEY = 'audit_key_version';

/** The version used when `schema_meta` carries no row yet — a schema before migration `0032`. */
const FIRST_KEY_VERSION = 1;

/** Thrown when the promoted version is not in the configured keyring. */
export class AuditKeyVersionDowngradeError extends Error {
  readonly code = 'config.key_version_downgrade';
  readonly exitCode = 2;

  constructor(promoted: number, configured: readonly number[]) {
    super(
      `schema_meta.audit_key_version is ${String(promoted)} and the configured AUDIT_HMAC_KEY keyring ` +
        `carries ${configured.length === 0 ? 'no version' : `v${configured.join(', v')}`}. A process ` +
        'that signed new rows with an older version would fork the chain at the rotation boundary, so ' +
        'the server refuses new audited writes. Add AUDIT_HMAC_KEY_V' +
        `${String(promoted)}_FILE from the encrypted secrets bundle of the backup set (A47), or ` +
        '`iridium keys promote audit --to <n>` to a version this host actually has.',
    );
    this.name = 'AuditKeyVersionDowngradeError';
  }
}

/** A present metadata row must identify a real version, never silently select the legacy key. */
class AuditKeyVersionInvalidError extends Error {
  readonly code = 'config.key_version_invalid';
  readonly exitCode = 2;

  constructor(value: string) {
    super(
      `schema_meta.audit_key_version must be a positive safe integer, received ${JSON.stringify(value)}. Restore the promoted audit version from the backup metadata before accepting audited writes.`,
    );
    this.name = 'AuditKeyVersionInvalidError';
  }
}
/**
 * The promoted audit key version, read from `schema_meta`.
 *
 * A missing row means a schema older than migration `0032`, which the readiness `migrations` check
 * already reports; version 1 is the honest answer in the meantime, because that is what a fresh install
 * is seeded with.
 */
export async function readPromotedAuditKeyVersion(db: Kysely<Database>): Promise<number> {
  const row = await db
    .selectFrom('schema_meta')
    .select('value')
    .where('key', '=', AUDIT_KEY_VERSION_META_KEY)
    .executeTakeFirst();
  if (row === undefined) return FIRST_KEY_VERSION;
  const parsed = Number(row.value);
  if (!Number.isSafeInteger(parsed) || parsed < FIRST_KEY_VERSION) {
    throw new AuditKeyVersionInvalidError(row.value);
  }
  return parsed;
}

/**
 * Builds the `AuditKeys` view over a configured keyring.
 *
 * @throws AuditKeyVersionDowngradeError when `signingVersion` is not one of the configured versions.
 */
export function createAuditKeys(options: {
  readonly keyring: Keyring;
  readonly signingVersion: number;
}): AuditKeys {
  const { keyring, signingVersion } = options;
  const configured = [...keyring.versions.keys()].toSorted((left, right) => left - right);
  if (!keyring.versions.has(signingVersion)) {
    throw new AuditKeyVersionDowngradeError(signingVersion, configured);
  }
  return {
    signingVersion,
    keyFor(version: number): Uint8Array | undefined {
      return keyring.versions.get(version);
    },
  };
}

/** Every audit key version the environment configured, ascending — what `keys status` prints. */
export function configuredAuditKeyVersions(keyring: Keyring): readonly number[] {
  return [...keyring.versions.keys()].toSorted((left, right) => left - right);
}

/** Every `audit_events.key_version` that rows actually reference, ascending. */
export async function referencedAuditKeyVersions(db: Kysely<Database>): Promise<readonly number[]> {
  const rows = await db
    .selectFrom('audit_events')
    .select('key_version')
    .distinct()
    .orderBy('key_version', 'asc')
    .execute();
  return rows.map((row) => row.key_version);
}

/** Every `user_credentials.pepper_version` that rows reference, ascending. */
export async function referencedPepperVersions(db: Kysely<Database>): Promise<readonly number[]> {
  const rows = await db
    .selectFrom('user_credentials')
    .select('pepper_version')
    .distinct()
    .orderBy('pepper_version', 'asc')
    .execute();
  return rows.map((row) => row.pepper_version);
}
