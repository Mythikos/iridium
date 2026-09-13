/**
 * `scripts/check-release-feed.ts` — run by ``release.yml › release-feed › `Assert the published
 * digests equal the built ones` `` as `node scripts/check-release-feed.ts release`, after
 * `iridium desktop-updates verify release` and `iridium desktop-updates publish release`.
 *
 * The rule is 07-client-applications.md §7.14 (skeleton A53) and 11-operations-and-deployment.md
 * OPS-60, with the release procedure of that section's "rolling a desktop fleet forward" runbook.
 *
 * At 1.0 the desktop bundles are **unsigned** — no Authenticode, no Developer ID, no notarisation
 * (gate G8 defers all of it to a post-1.0 epic). The integrity of a download therefore rests on
 * exactly three things, and one of them is the SHA-256 the site publishes beside the artefact. That
 * makes this script's comparison the load-bearing one in the release: it proves that the digest a
 * user is told to check is the digest of the file that was built, across every place the release
 * publishes it.
 *
 * The chain it closes, end to end:
 *
 * ```
 * the bytes in <dir>            recomputed SHA-256 and SHA-512
 *   → <dir>/bundles.json        [{platform, arch, name, sizeBytes, sha256, sha512}]
 *   → <dir>/SHA256SUMS          GNU `sha256sum` format
 *   → <PUBLIC_ORIGIN>/desktop/updates/<channel>/SHA256SUMS
 *   → <PUBLIC_ORIGIN>/api/v1/desktop/update-policy  latest.artifacts[].sha256
 * ```
 *
 * Every link is asserted, in both directions where both sides are a set: a digest present in one
 * place and absent from the next is a finding, and so is an extra entry. A chain checked only in one
 * direction would pass a release that published a seventh artefact nobody built.
 *
 * **There are exactly six bundles** (07-client-applications.md §7.14.1): `zip` for Windows and macOS,
 * `tar.gz` for Linux, each on `x64` and `arm64`. The set is asserted by name rather than counted, so
 * a target-set change in `electron-builder.yml` cannot quietly publish five.
 *
 * What this script deliberately does **not** do: read Electron fuses, check for the deliberate
 * absence of a code signature, or verify the `.app` ad-hoc signature. Those are per-runner assertions
 * against the artefacts as they are built, and they belong to `release.bundle-integrity`
 * (``release.yml › desktop``), which runs on each of the three runners where the evidence exists.
 *
 * ## `PUBLIC_ORIGIN`
 *
 * The origin of the site the release was published to, read from the environment — the same variable
 * the server itself is configured with (11-operations-and-deployment.md, the environment table).
 * `release.yml`'s `release-feed` job does not currently set it, so the check exits `2` naming the
 * variable rather than guessing an origin; a release verified against the wrong host is worse than
 * one not verified.
 *
 * Usage: `node scripts/check-release-feed.ts <dir> [--channel stable|beta]`. The channel defaults to
 * `stable`, which is what `iridium desktop-updates publish <dir>` defaults to in the step above.
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  EnvironmentError,
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { isDirectory, isFile } from './lib/files.ts';
import { arrayMember, isRecord, parseJson, stringMember } from './lib/json.ts';
import { REPO_ROOT } from './lib/paths.ts';

/** The six artefacts of 07-client-applications.md §7.14.1, as `(platform, arch, extension)`. */
const EXPECTED: readonly { platform: string; arch: string; extension: string }[] = [
  { platform: 'darwin', arch: 'arm64', extension: 'zip' },
  { platform: 'darwin', arch: 'x64', extension: 'zip' },
  { platform: 'linux', arch: 'arm64', extension: 'tar.gz' },
  { platform: 'linux', arch: 'x64', extension: 'tar.gz' },
  { platform: 'win32', arch: 'arm64', extension: 'zip' },
  { platform: 'win32', arch: 'x64', extension: 'zip' },
];

/** One entry of `<dir>/bundles.json`. */
interface Bundle {
  readonly platform: string;
  readonly arch: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sha512: string;
}

interface Options {
  readonly directory: string;
  readonly channel: string;
  readonly origin: string;
}

function parseOptions(argv: readonly string[]): Options {
  // Walked rather than filtered, so `--channel beta release` and `release --channel beta` mean the
  // same thing: a flag's value is consumed by the flag and is never mistaken for the directory.
  let directory: string | undefined;
  let channel = 'stable';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--channel') {
      channel = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (argument.startsWith('--')) continue;
    directory ??= argument;
  }
  if (directory === undefined) {
    throw new EnvironmentError(
      'no directory given.\n' +
        'Usage: node scripts/check-release-feed.ts <dir> [--channel stable|beta]\n' +
        'Remedy: pass the directory holding the built bundles, `bundles.json` and `SHA256SUMS` — ' +
        '`release` in release.yml › release-feed.',
    );
  }
  if (channel !== 'stable' && channel !== 'beta') {
    throw new EnvironmentError(
      `\`--channel ${channel}\` is not a release channel.\n` +
        'Remedy: the channels are `stable` and `beta`; omit the flag for `stable`, which is what ' +
        '`iridium desktop-updates publish` defaults to.',
    );
  }
  const origin = process.env['PUBLIC_ORIGIN']?.trim() ?? '';
  if (origin === '') {
    throw new EnvironmentError(
      'PUBLIC_ORIGIN is not set, so there is no published feed to compare against.\n' +
        'It is the origin the release was published to — the same variable the server is configured ' +
        'with (11-operations-and-deployment.md, the environment table).\n' +
        'Remedy: set `PUBLIC_ORIGIN` on the `release-feed` job, from a repository variable; the job ' +
        'does not set it today.',
    );
  }
  return {
    directory: isAbsolute(directory) ? directory : join(REPO_ROOT, directory),
    channel,
    origin: origin.replace(/\/+$/, ''),
  };
}

function readBundles(directory: string): Bundle[] {
  const path = join(directory, 'bundles.json');
  if (!isFile(path)) {
    throw new EnvironmentError(
      `${repoPath(path)} does not exist.\n` +
        'It is written by `tooling/release/write-bundle-manifest.ts` on each build runner and is the ' +
        'publish-time input (07-client-applications.md §7.14.3).\n' +
        'Remedy: download the `desktop-bundles-*` artifacts into the directory before this step.',
    );
  }
  const parsed = parseJson(readFileSync(path, 'utf8'));
  const list = Array.isArray(parsed) ? parsed : arrayMember(parsed, 'bundles');
  if (list === undefined) {
    throw new EnvironmentError(
      `${repoPath(path)} is not an array of bundles.\n` +
        'Remedy: the manifest is `[{platform, arch, name, sizeBytes, sha256, sha512}]`.',
    );
  }
  const bundles: Bundle[] = [];
  for (const entry of list) {
    const platform = stringMember(entry, 'platform');
    const arch = stringMember(entry, 'arch');
    const name = stringMember(entry, 'name');
    const sha256 = stringMember(entry, 'sha256');
    const sha512 = stringMember(entry, 'sha512');
    const sizeBytes = isRecord(entry) ? entry['sizeBytes'] : undefined;
    if (
      platform === undefined ||
      arch === undefined ||
      name === undefined ||
      sha256 === undefined ||
      sha512 === undefined ||
      typeof sizeBytes !== 'number'
    ) {
      throw new EnvironmentError(
        `${repoPath(path)} has an entry missing one of platform, arch, name, sizeBytes, sha256, sha512.\n` +
          'Remedy: the manifest is `[{platform, arch, name, sizeBytes, sha256, sha512}]`; regenerate it ' +
          'with `tooling/release/write-bundle-manifest.ts`.',
      );
    }
    bundles.push({ platform, arch, name, sizeBytes, sha256, sha512 });
  }
  return bundles.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** `<sha256>  <name>` lines, GNU coreutils `sha256sum` format. */
function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.replaceAll('\r\n', '\n').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match === null) continue;
    sums.set((match[2] ?? '').trim(), match[1] ?? '');
  }
  return sums;
}

async function digests(path: string): Promise<{ sha256: string; sha512: string }> {
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  await pipeline(createReadStream(path), async (source) => {
    for await (const chunk of source) {
      sha256.update(chunk);
      sha512.update(chunk);
    }
  });
  return { sha256: sha256.digest('hex'), sha512: sha512.digest('hex') };
}

/** A fetch whose transport failure is an environment error and whose status is a finding. */
async function get(url: string): Promise<{ status: number; body: string }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { 'user-agent': 'iridium-release-check' } });
  } catch (error) {
    throw new EnvironmentError(
      `${url} could not be reached: ${error instanceof Error ? error.message : String(error)}\n` +
        'Remedy: check that `PUBLIC_ORIGIN` names the site the release was published to and that the ' +
        'runner can reach it. The comparison was not performed.',
    );
  }
  return { status: response.status, body: await response.text() };
}

/** The version every bundle name carries, or `null` when they disagree. */
function versionOf(bundles: readonly Bundle[]): string | null {
  const versions = new Set<string>();
  for (const bundle of bundles) {
    const match = /^Iridium-(.+)-(?:win32|darwin|linux)-(?:x64|arm64)\.(?:zip|tar\.gz)$/.exec(
      bundle.name,
    );
    if (match?.[1] === undefined) return null;
    versions.add(match[1]);
  }
  return versions.size === 1 ? ([...versions][0] ?? null) : null;
}

export const check: Check = {
  name: 'check-release-feed',
  workflow: 'release.yml › release-feed › `Assert the published digests equal the built ones`',
  owns: '07-client-applications.md §7.14 (A53); 11-operations-and-deployment.md OPS-60 (G8)',
  async run(argv: readonly string[]): Promise<CheckResult> {
    const options = parseOptions(argv);
    if (!isDirectory(options.directory)) {
      throw new EnvironmentError(
        `${repoPath(options.directory)} does not exist.\n` +
          'Remedy: download the `desktop-bundles-*` artifacts into it first, as release.yml › ' +
          'release-feed does.',
      );
    }

    const bundles = readBundles(options.directory);
    const sumsPath = join(options.directory, 'SHA256SUMS');
    if (!isFile(sumsPath)) {
      throw new EnvironmentError(
        `${repoPath(sumsPath)} does not exist.\n` +
          'It is generated beside `bundles.json` by `tooling/release/write-bundle-manifest.ts`.\n' +
          'Remedy: download the build artifacts complete, or regenerate the manifest.',
      );
    }

    const findings: Finding[] = [];
    const details: string[] = [];
    const built = new Map(bundles.map((bundle) => [bundle.name, bundle]));

    // 1. The six names, asserted as a set rather than counted.
    const version = versionOf(bundles);
    if (version === null) {
      findings.push(
        finding(
          join(options.directory, 'bundles.json'),
          `the ${String(bundles.length)} bundle name(s) do not all carry one version: ` +
            `${bundles.map((bundle) => bundle.name).join(', ')}.`,
          'every name is `Iridium-<version>-<platform>-<arch>.<zip|tar.gz>` with the same version ' +
            '(07-client-applications.md §7.14.1); a mixed set means two builds were merged.',
        ),
      );
    } else {
      details.push(`Version ${version}, channel ${options.channel}, origin ${options.origin}.`);
      const tag = process.env['GITHUB_REF_NAME'];
      if (tag !== undefined && tag.startsWith('v') && tag.slice(1) !== version) {
        findings.push(
          finding(
            join(options.directory, 'bundles.json'),
            `the bundles are version ${version} but the tag being released is ${tag}.`,
            'build the tagged tree; a release whose artefacts carry another version cannot be traced ' +
              'back to a commit.',
          ),
        );
      }
      for (const expected of EXPECTED) {
        const name = `Iridium-${version}-${expected.platform}-${expected.arch}.${expected.extension}`;
        const bundle = built.get(name);
        if (bundle === undefined) {
          findings.push(
            finding(
              join(options.directory, 'bundles.json'),
              `${name} is missing: the release publishes exactly six bundles.`,
              'check the electron-builder target set — `zip` on win32 and darwin, `tar.gz` on linux, ' +
                'each on x64 and arm64 (07-client-applications.md §7.14.1) — and that all three runners ' +
                'uploaded.',
            ),
          );
          continue;
        }
        if (bundle.platform !== expected.platform || bundle.arch !== expected.arch) {
          findings.push(
            finding(
              join(options.directory, 'bundles.json'),
              `${name} is recorded as ${bundle.platform}/${bundle.arch}.`,
              'the platform is the `process.platform` spelling — `win32`, `darwin`, `linux`, never ' +
                '`win` or `mac` (09-api-reference.md, `Platform`).',
            ),
          );
        }
      }
      for (const bundle of bundles) {
        const matches = EXPECTED.some(
          (expected) =>
            bundle.name ===
            `Iridium-${version}-${expected.platform}-${expected.arch}.${expected.extension}`,
        );
        if (!matches) {
          findings.push(
            finding(
              join(options.directory, 'bundles.json'),
              `${bundle.name} is not one of the six artefacts the release publishes.`,
              'remove the extra target; `SHA256SUMS` and `latest*.yml` are generated by the server and ' +
                'are never uploaded as bundles.',
            ),
          );
        }
      }
    }

    // 2. The bytes on disk against the manifest.
    for (const bundle of bundles) {
      const path = join(options.directory, bundle.name);
      if (!isFile(path)) {
        findings.push(
          finding(
            path,
            `${bundle.name} is named by bundles.json but is not in the directory.`,
            'download the build artifacts complete; a manifest entry without its file cannot be ' +
              'published.',
          ),
        );
        continue;
      }
      const size = statSync(path).size;
      if (size !== bundle.sizeBytes) {
        findings.push(
          finding(
            path,
            `${bundle.name} is ${String(size)} bytes on disk and ${String(bundle.sizeBytes)} in ` +
              'bundles.json.',
            'regenerate the manifest from the artefacts actually built; a size mismatch means the file ' +
              'was replaced after the manifest was written.',
          ),
        );
      }
      // Six large files, hashed one at a time: doing them in parallel would multiply peak memory on
      // the runner for no wall-clock gain, since the cost is a sequential disk read either way.
      // eslint-disable-next-line no-await-in-loop -- see above
      const computed = await digests(path);
      if (computed.sha256 !== bundle.sha256.toLowerCase()) {
        findings.push(
          finding(
            path,
            `${bundle.name} hashes to SHA-256 ${computed.sha256}, and bundles.json records ` +
              `${bundle.sha256}.`,
            'the digest is the only integrity value an unsigned bundle has (G8, OPS-60) — regenerate the ' +
              'manifest and do not publish until they agree.',
          ),
        );
      }
      if (computed.sha512 !== bundle.sha512.toLowerCase()) {
        findings.push(
          finding(
            path,
            `${bundle.name} hashes to SHA-512 ${computed.sha512}, and bundles.json records ` +
              `${bundle.sha512}.`,
            'both digests are verified server-side while the artefact streams (OPS-60); regenerate the ' +
              'manifest.',
          ),
        );
      }
    }

    // 3. The local SHA256SUMS against the manifest, both directions.
    const localSums = parseSums(readFileSync(sumsPath, 'utf8'));
    for (const bundle of bundles) {
      const published = localSums.get(bundle.name);
      if (published === undefined) {
        findings.push(
          finding(
            sumsPath,
            `${bundle.name} has no line in SHA256SUMS.`,
            'regenerate `SHA256SUMS` from the same computation as `bundles.json`; OPS-60 requires the ' +
              'three published places to come from one computation.',
          ),
        );
      } else if (published !== bundle.sha256.toLowerCase()) {
        findings.push(
          finding(
            sumsPath,
            `${bundle.name} is ${published} in SHA256SUMS and ${bundle.sha256} in bundles.json.`,
            'regenerate both from one computation; a human verifying a download reads SHA256SUMS, so a ' +
              'divergence here is the failure a user would see.',
          ),
        );
      }
    }
    for (const name of localSums.keys()) {
      if (!built.has(name)) {
        findings.push(
          finding(
            sumsPath,
            `SHA256SUMS names ${name}, which bundles.json does not.`,
            'remove the line; a published digest for an artefact nobody built is a digest nobody can ' +
              'verify.',
          ),
        );
      }
    }

    // 4. The published SHA256SUMS.
    const feedUrl = `${options.origin}/desktop/updates/${options.channel}/SHA256SUMS`;
    const feed = await get(feedUrl);
    if (feed.status !== 200) {
      findings.push(
        finding(
          sumsPath,
          `GET ${feedUrl} returned ${String(feed.status)}, so the published feed cannot be compared.`,
          'check that `iridium desktop-updates publish` succeeded and that `DESKTOP_UPDATES_DIR` is ' +
            'served at `/desktop/updates/`.',
        ),
      );
    } else {
      const remote = parseSums(feed.body);
      details.push(`${feedUrl}: ${String(remote.size)} line(s).`);
      for (const bundle of bundles) {
        const value = remote.get(bundle.name);
        if (value === undefined) {
          findings.push(
            finding(
              sumsPath,
              `${bundle.name} is absent from the published ${feedUrl}.`,
              're-run `iridium desktop-updates publish <dir>`; the feed is regenerated from the ' +
                '`desktop_releases` row, so a missing line means the row is incomplete.',
            ),
          );
        } else if (value !== bundle.sha256.toLowerCase()) {
          findings.push(
            finding(
              sumsPath,
              `${bundle.name} is published as ${value} and was built as ${bundle.sha256}.`,
              'the published digest must equal the built one. Withdraw the release ' +
                '(`DELETE /admin/releases/:channel/:version`) and republish from the built artefacts.',
            ),
          );
        }
      }
      for (const name of remote.keys()) {
        if (!built.has(name)) {
          findings.push(
            finding(
              sumsPath,
              `the published ${feedUrl} names ${name}, which this release did not build.`,
              'a superseded bundle is removed from `updates-data` only after the release is withdrawn ' +
                '(11-operations-and-deployment.md); check that the correct version was published.',
            ),
          );
        }
      }
    }

    // 5. The update policy.
    const policyUrl = `${options.origin}/api/v1/desktop/update-policy`;
    const policy = await get(policyUrl);
    if (policy.status !== 200) {
      findings.push(
        finding(
          join(options.directory, 'bundles.json'),
          `GET ${policyUrl} returned ${String(policy.status)}, so the offered artefacts cannot be ` +
            'compared.',
          'the route is public and cached for 300 s; check the deployment is serving the new release.',
        ),
      );
      return {
        summary: `${String(bundles.length)} built bundle(s); the published feed could not be read.`,
        details,
        findings,
      };
    }

    const parsed = parseJson(policy.body);
    const latest = isRecord(parsed) ? parsed['latest'] : undefined;
    const channel = stringMember(parsed, 'channel');
    if (channel !== undefined && channel !== options.channel) {
      details.push(
        `${policyUrl} offers the \`${channel}\` channel; this release was published to ` +
          `\`${options.channel}\`, so the policy's default channel is not the one just published.`,
      );
    }
    if (!isRecord(latest)) {
      findings.push(
        finding(
          join(options.directory, 'bundles.json'),
          `${policyUrl} reports no \`latest\` release.`,
          're-run `iridium desktop-updates publish <dir> --channel ' +
            `${options.channel}\`; the policy reads the \`desktop_releases\` row.`,
        ),
      );
    } else {
      const offeredVersion = stringMember(latest, 'version');
      if (version !== null && offeredVersion !== version) {
        findings.push(
          finding(
            join(options.directory, 'bundles.json'),
            `${policyUrl} offers version ${offeredVersion ?? '(none)'}, and ${version} was built.`,
            'publish the built version, or withdraw the wrong one; the About card and the ' +
              '`client-too-old` screen both render this value.',
          ),
        );
      }
      const artifacts = arrayMember(latest, 'artifacts') ?? [];
      details.push(
        `${policyUrl}: version ${offeredVersion ?? '(none)'}, ${String(artifacts.length)} artefact(s).`,
      );
      const offered = new Map<string, { sha256: string | undefined; sizeBytes: unknown }>();
      for (const artifact of artifacts) {
        const name = stringMember(artifact, 'name');
        if (name === undefined) continue;
        offered.set(name, {
          sha256: stringMember(artifact, 'sha256'),
          sizeBytes: isRecord(artifact) ? artifact['sizeBytes'] : undefined,
        });
      }
      if (artifacts.length !== EXPECTED.length) {
        findings.push(
          finding(
            join(options.directory, 'bundles.json'),
            `${policyUrl} offers ${String(artifacts.length)} artefact(s); a release is six.`,
            'republish the complete set; `latest.artifacts[]` is what the download page and the About ' +
              'card render, so a short list strands a platform.',
          ),
        );
      }
      for (const bundle of bundles) {
        const entry = offered.get(bundle.name);
        if (entry === undefined) {
          findings.push(
            finding(
              join(options.directory, 'bundles.json'),
              `${bundle.name} is absent from \`latest.artifacts[]\` at ${policyUrl}.`,
              'republish; a platform with no artefact entry has no download link and no digest.',
            ),
          );
          continue;
        }
        if (entry.sha256?.toLowerCase() !== bundle.sha256.toLowerCase()) {
          findings.push(
            finding(
              join(options.directory, 'bundles.json'),
              `${bundle.name} is offered with SHA-256 ${entry.sha256 ?? '(none)'} and was built as ` +
                `${bundle.sha256}.`,
              'OPS-60: the three published places come from one computation. Withdraw and republish ' +
                'rather than editing one of them.',
            ),
          );
        }
        if (typeof entry.sizeBytes === 'number' && entry.sizeBytes !== bundle.sizeBytes) {
          findings.push(
            finding(
              join(options.directory, 'bundles.json'),
              `${bundle.name} is offered as ${String(entry.sizeBytes)} bytes and was built as ` +
                `${String(bundle.sizeBytes)}.`,
              'republish from the built artefacts; the size is rendered beside the digest a user checks.',
            ),
          );
        }
      }
    }

    return {
      summary:
        findings.length === 0
          ? `${String(bundles.length)} bundle(s): the bytes, bundles.json, SHA256SUMS, the published ` +
            'feed and the update policy all agree.'
          : `${String(bundles.length)} built bundle(s); the published feed does not match what was built.`,
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
