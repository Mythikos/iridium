/** Retains every completed S11 report, including failures, without vendoring generated bundles. */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const shared = {};
function retain(value) {
  const key = sha(JSON.stringify(value));
  shared[key] = value;
  return { sha256: key };
}

const reports = [];
for (const name of (await readdir(join(here, 'results')))
  .filter((entry) => entry.endsWith('.json'))
  .toSorted()) {
  // oxlint-disable-next-line no-await-in-loop -- deterministic evidence traversal, independent of product code.
  const bytes = await readFile(join(here, 'results', name));
  const original = JSON.parse(bytes.toString('utf8'));
  if (original.measuredAt === undefined) continue;
  const report = { name, rawReportSha256: sha(bytes), ...original };
  for (const key of ['pipelineBuild', 'fixtureManifest', 'browserModules', 'fixtureCorpus']) {
    if (report[key] !== undefined) report[key] = retain(report[key]);
  }
  if (report.emittedBrowserParity?.digests !== undefined)
    report.emittedBrowserParity.digests = retain(report.emittedBrowserParity.digests);
  reports.push(report);
}
const evidence = {
  evidenceVersion: 1,
  scope: 'Local Windows measurements; no actual pilot corpus and no formal milestone exit claim.',
  representation:
    'All measured reports are retained. Arrays shared across reports are stored once under their SHA-256; references have exactly one sha256 field. Case samples and unsuccessful outcomes are never filtered.',
  reportRoles: {
    originalComplete: 'windows-final.json',
    favorableRepeatNotUsedToOverrideFailure: 'isolated-before.json',
    profileDiagnostic: 'corpus-profile.json',
    originalAfterMitigation: 'post-mitigation.json',
    fallbackInitialSizeFailure: 'markdown-it-fallback.json',
    fallbackCompleteV1: 'markdown-it-final.json',
    releaseAdmissionFailure: 'markdown-it-release-v2.json',
    releaseComplete: 'markdown-it-release-v2-final.json',
    finalDependencyBoundaryVerification: 'markdown-it-spike-boundaries.json',
    relocatedWorkspaceVerification: 'workspace-relocation.json',
  },
  caveats: [
    'Historical reports retain the original apps/server/spikes/s11 paths and source hashes; the independent workspace now lives at spikes/s11-markdown so production pruning excludes it completely.',
    'workspace-relocation-including-package-metadata.json additionally checked release-generated CHANGELOG.md. The canonical workspace-relocation.json selects the original hostile expectations manifest and verifies the unchanged 732-source corpus.',
    'windows-host.json prescan timing accidentally included hashing; subsequent admission measurements remove it.',
    'Profiling builds are unminified and are not budget measurements.',
    'Early size reports may state the superseded 122880-byte interpretation. The declared final production budget is 120000 bytes, and final reports use that exact bound.',
    'Three-sample pathological and 1MiB p95/p99 are empirical maxima, not stable population estimates.',
    'The favorable original-engine repeat does not supersede the failed complete and post-mitigation representative measurements. No external CPU-contention cause was established.',
    'Browser p95 at the declared synthetic 64KiB representative size is observed; the actual pilot p95 and its latency are unmeasured.',
    'Release version 2 ensures existing M1 version 1 projections are reindexed. The version-only correction does not change parser behavior.',
  ],
  reports,
  shared,
};
const output = `${JSON.stringify(evidence, null, 2)}\n`;
await writeFile(join(here, 'evidence.json'), output);
process.stdout.write(
  `${reports.length} reports; ${Object.keys(shared).length} shared records; ${Buffer.byteLength(output)} bytes\n`,
);
