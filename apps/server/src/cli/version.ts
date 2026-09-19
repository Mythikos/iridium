/**
 * `iridium version [--json]` (11-operations-and-deployment.md, "Serving and diagnostics").
 *
 * A pure function of the build: it opens no database, parses no environment and is therefore the one
 * command that answers inside a broken deployment. The schema head is the **binary's** — the last
 * name in its bundled migration list — and not the database's, which is what makes "the schema head
 * the binary expects" answerable without a connection; `iridium migrate status` is the command that
 * compares the two.
 *
 * `apiVersion` and `minClientVersion`, which 11's row also names, are deliberately absent: neither
 * has a constant anywhere in the workspace yet (`GET /meta` publishes them from M1's route set), and
 * a version command that invented its own copy would be a second source for two numbers a client
 * compares itself against.
 */
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
}

/** The build's identity, as data, so the report has one shape for both renderings. */
export function versionReport(): VersionReport {
  return {
    version: BUILD_INFO.version,
    commit: BUILD_INFO.commit,
    node: BUILD_INFO.node,
    schemaHead: MIGRATION_NAMES.at(-1) ?? 'none',
  };
}

/** Runs `iridium version`. */
export function runVersion(io: CliIo, json: boolean): number {
  const report = versionReport();
  io.out(
    json
      ? renderJson(report)
      : renderPairs(Object.entries(report).map(([key, value]) => [key, value] as const)),
  );
  return EXIT.success;
}
