/**
 * `*_FILE` secrets, versioned keyrings and the one redacted rendering every surface uses
 * (02-system-architecture.md, "Runtime configuration model" principle 3 and decision ARCH-28;
 * 11-operations-and-deployment.md, "Configuration and secrets" and "Key rotation").
 *
 * Three rules are implemented here and nowhere else:
 *
 *  1. Every secret accepts a `<NAME>_FILE` twin. Setting both forms is a validation error
 *     (`config.secret_both_forms`), not a precedence question.
 *  2. Secrets that rotate are keyring families `<NAME>_V<n>`; the version *in use* lives in
 *     `schema_meta`, never in the environment (ARCH-09), so this module loads every configured
 *     version and never chooses between them.
 *  3. One redacted rendering: `<set: versions v1,v2; sha256:ab12cd34>`, a file-sourced value adding
 *     its origin as `<set: file:/run/secrets/audit_hmac_v2; sha256:ab12cd34>`, an unset optional
 *     secret as `<unset>`. A bare `***` is not an accepted rendering — the fingerprint is the
 *     control an operator uses to compare two hosts, and the path names the mount to fix.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { ConfigError } from './config-error.ts';
import type { RawEnv } from './process-env.ts';

/** Where a secret's material came from. */
export type SecretSource =
  | { readonly kind: 'value' }
  | { readonly kind: 'file'; readonly path: string };

/** One resolved secret: the material plus the origin the redacted summary names. */
export interface ResolvedSecret {
  readonly value: string;
  readonly source: SecretSource;
}

/** A versioned key family. `versions` is the ARCH-09 keyring; `sources` is what redaction prints. */
export interface Keyring {
  readonly versions: ReadonlyMap<number, Uint8Array>;
  /** The highest configured version, or `0` when the family is empty. */
  readonly highest: number;
  readonly sources: ReadonlyMap<number, SecretSource>;
}

/** A warning the loader collected: not fatal, but printed by `config check` and the boot summary. */
export interface SecretWarning {
  readonly key: string;
  readonly message: string;
}

/** The empty keyring, so an optional family is a value rather than `null` at every use site. */
export const EMPTY_KEYRING: Keyring = Object.freeze({
  versions: new Map<number, Uint8Array>(),
  highest: 0,
  sources: new Map<number, SecretSource>(),
});

function readSecretFile(key: string, path: string, warnings: SecretWarning[]): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      'config.secret_unreadable',
      `${key} names ${path}, which could not be read: ${reason}`,
      [key],
    );
  }
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(path).mode & 0o777;
      if ((mode & 0o044) !== 0) {
        warnings.push({
          key,
          message: `${path} is world- or group-readable (mode ${mode.toString(8).padStart(3, '0')}); secrets should be 0400`,
        });
      }
    } catch {
      // A file that read but cannot be stat'ed is not a reason to refuse to boot.
    }
  }
  // Exactly one trailing newline is stripped: a key that legitimately ends in a newline would be
  // written without one, and stripping every trailing newline would silently change the material.
  return raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

/**
 * Resolves `<NAME>` / `<NAME>_FILE` into one value, or `undefined` when neither is set.
 *
 * An empty string counts as unset, because a Compose `environment:` entry with no value and an
 * unset variable are the same operator intent and distinguishing them produces bug reports nobody
 * can reproduce.
 */
export function resolveSecret(
  env: RawEnv,
  name: string,
  warnings: SecretWarning[] = [],
): ResolvedSecret | undefined {
  const direct = env[name];
  const fileKey = `${name}_FILE`;
  const filePath = env[fileKey];
  const hasDirect = direct !== undefined && direct !== '';
  const hasFile = filePath !== undefined && filePath !== '';

  if (hasDirect && hasFile) {
    throw new ConfigError(
      'config.secret_both_forms',
      `${name} and ${fileKey} are both set. Set exactly one: the file form is for mounted secrets, ` +
        `the plain form for development.`,
      [name, fileKey],
    );
  }
  if (hasFile) {
    return {
      value: readSecretFile(fileKey, filePath, warnings),
      source: { kind: 'file', path: filePath },
    };
  }
  if (hasDirect) {
    return { value: direct, source: { kind: 'value' } };
  }
  return undefined;
}

const VERSIONED = /^(.+)_V(\d+)(_FILE)?$/;

/**
 * Collects a keyring family from the environment.
 *
 * Both `<NAME>_V<n>` and `<NAME>_V<n>_FILE` are accepted per version and the `both forms` rule
 * applies per version. The unversioned `<NAME>` is accepted as a spelling of version 1 so that the
 * fixed test secrets of 10-testing-and-quality.md rule 9 (`AUTH_PASSWORD_PEPPER=…`) and the
 * versioned families of 11-operations-and-deployment.md name the same key; setting both `<NAME>`
 * and `<NAME>_V1` is refused rather than resolved by precedence.
 */
export function collectKeyring(env: RawEnv, base: string, warnings: SecretWarning[] = []): Keyring {
  const versions = new Map<number, Uint8Array>();
  const sources = new Map<number, SecretSource>();

  const seen = new Set<number>();
  for (const key of Object.keys(env)) {
    const match = VERSIONED.exec(key);
    if (match === null || match[1] !== base) continue;
    const version = Number(match[2]);
    if (!Number.isSafeInteger(version) || version < 1) continue;
    seen.add(version);
  }

  for (const version of [...seen].toSorted((a, b) => a - b)) {
    const resolved = resolveSecret(env, `${base}_V${String(version)}`, warnings);
    if (resolved === undefined) continue;
    versions.set(version, new TextEncoder().encode(resolved.value));
    sources.set(version, resolved.source);
  }

  const unversioned = resolveSecret(env, base, warnings);
  if (unversioned !== undefined) {
    if (versions.has(1)) {
      throw new ConfigError(
        'config.secret_both_forms',
        `${base} and ${base}_V1 are both set; ${base} is the version-1 spelling of the same keyring. ` +
          `Set exactly one.`,
        [base, `${base}_V1`],
      );
    }
    versions.set(1, new TextEncoder().encode(unversioned.value));
    sources.set(1, unversioned.source);
  }

  const highest = versions.size === 0 ? 0 : Math.max(...versions.keys());
  return { versions, highest, sources };
}

/** The first eight hex characters of the SHA-256 of the material (ARCH-28). */
export function fingerprint(material: Uint8Array | string): string {
  const bytes = typeof material === 'string' ? new TextEncoder().encode(material) : material;
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

/** `<set: sha256:ab12cd34>`, `<set: file:/run/secrets/x; sha256:…>`, or `<unset>`. */
export function renderSecret(secret: ResolvedSecret | undefined): string {
  if (secret === undefined) return '<unset>';
  const origin = secret.source.kind === 'file' ? `file:${secret.source.path}; ` : '';
  return `<set: ${origin}sha256:${fingerprint(secret.value)}>`;
}

/**
 * `<set: versions v1,v2; sha256:ab12cd34>` — the fingerprint is the highest configured version,
 * which is the one a rotation compares across hosts; a file-sourced highest version names its path.
 */
export function renderKeyring(keyring: Keyring): string {
  if (keyring.versions.size === 0) return '<unset>';
  const list = [...keyring.versions.keys()]
    .toSorted((a, b) => a - b)
    .map((v) => `v${String(v)}`)
    .join(',');
  const material = keyring.versions.get(keyring.highest);
  const source = keyring.sources.get(keyring.highest);
  const origin = source !== undefined && source.kind === 'file' ? `file:${source.path}; ` : '';
  const digest = material === undefined ? 'unknown' : fingerprint(material);
  return `<set: versions ${list}; ${origin}sha256:${digest}>`;
}
