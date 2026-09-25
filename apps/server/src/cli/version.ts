/**
 * `iridium version [--json]` (11-operations-and-deployment.md, "Serving and diagnostics").
 *
 * A pure function of the build: it opens no database, parses no environment and is therefore the one
 * command that answers inside a broken deployment. The schema head is the **binary's** — the last
 * name in its bundled migration list — and not the database's, which is what makes "the schema head
 * the binary expects" answerable without a connection; `iridium migrate status` is the command that
 * compares the two.
 *
 * It reports the API counter `API_VERSION` and the release floor `RELEASE_MIN_CLIENT_VERSION` the
 * binary carries, both read from `@iridium/contracts` rather than copied. The release floor is not
 * the effective `minClientVersion` `GET /meta` serves: that is the SemVer maximum of the release
 * floor and the operator floor `schema_meta.min_client_version`, which needs the database this
 * command never opens (11-operations-and-deployment.md, "Serving and diagnostics"; A54 as amended).
 */
import { API_VERSION, RELEASE_MIN_CLIENT_VERSION } from '@iridium/contracts';

import { MIGRATION_NAMES } from '../db/migrator.ts';
import { BUILD_INFO } from '../ops/build-info.ts';
import { EXIT } from './exit.ts';
import { renderJson, renderPairs, type CliIo } from './output.ts';

/** What `version` reports. */
export interface VersionReport {
  readonly version: string;
  readonly commit: string;
  readonly node: string;
  /** The last migration this binary carries; `iridium migrate status` compares it with the schema. */
  readonly schemaHead: string;
  /** `GET /meta.apiVersion`, the integer a breaking change increments. */
  readonly apiVersion: number;
  /** The release floor this binary carries, never the effective floor (see the module header). */
  readonly releaseMinClientVersion: string;
}

/** The build's identity, as data, so the report has one shape for both renderings. */
export function versionReport(): VersionReport {
  return {
    version: BUILD_INFO.version,
    commit: BUILD_INFO.commit,
    node: BUILD_INFO.node,
    schemaHead: MIGRATION_NAMES.at(-1) ?? 'none',
    apiVersion: API_VERSION,
    releaseMinClientVersion: RELEASE_MIN_CLIENT_VERSION,
  };
}

/** Runs `iridium version`. */
export function runVersion(io: CliIo, json: boolean): number {
  const report = versionReport();
  io.out(
    json
      ? renderJson(report)
      : renderPairs(Object.entries(report).map(([key, value]) => [key, String(value)] as const)),
  );
  return EXIT.success;
}
