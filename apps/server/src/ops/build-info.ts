/**
 * What `iridium_build_info{version,node,commit}`, `GET /healthz.version` and the pino `base` object
 * report (ARCH-15, 11-operations-and-deployment.md "Metrics").
 *
 * The version is the product version of the single Changesets `fixed` group, read from the package
 * manifest so the server image, the web bundle, the desktop bundles and the bridge can never
 * disagree about it. The commit is a build-time value: `release.yml` passes it to tsdown as a
 * `define`, and a development build reports `unknown` rather than shelling out to git — a boot path
 * that spawns a process to learn its own identity is a boot path that fails in a scratch container.
 */
import manifest from '../../package.json' with { type: 'json' };

/**
 * Replaced at build time by the release pipeline's tsdown `define`; `unknown` in a development build.
 * Spelled without leading underscores because the repository's lint rules reserve that shape for the
 * browser bundles' `__IRIDIUM_VERSION__`, and one build-time global with two spellings is one too many.
 */
declare const IRIDIUM_BUILD_COMMIT: string | undefined;

function resolveCommit(): string {
  return typeof IRIDIUM_BUILD_COMMIT === 'string' && IRIDIUM_BUILD_COMMIT !== ''
    ? IRIDIUM_BUILD_COMMIT
    : 'unknown';
}

/** The running build's identity. Frozen: it is a label set, and label sets do not change. */
export const BUILD_INFO: Readonly<{ version: string; commit: string; node: string }> =
  Object.freeze({
    version: manifest.version,
    commit: resolveCommit(),
    node: process.versions.node,
  });

/** The `service` field on every log line. */
export const SERVICE_NAME = 'iridium-server';
