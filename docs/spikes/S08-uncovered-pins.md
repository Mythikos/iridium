# S08 — Pins and licences for dependencies the digest did not cover

## Question

Exact version, licence and single-copy status for every dependency the research digest did not cover: `@fastify/static`, `yauzl`/`yazl`, `prom-client`, `@codemirror/lang-yaml`, `axe-core` (+ `vitest-axe`), `comlink`, the MIME sniffer, `age` (binary), the `syft`/`grype` GitHub Actions, the licence scanner, the `caddy` image tag and the SeaweedFS image tag — plus the three items the bootstrap left deliberately unpinned: `@tailwindcss/vite`, `@types/react` + `@types/react-dom`, and `@types/ws`.

## Why it blocks

M0 exits with a complete catalog and a green licence scan (`docs.spikes.spec`, `12-milestones.md` §3 "License compliance"). None of the items above appear in `pnpm-workspace.yaml`'s `catalog:` as bootstrapped, so `pnpm install --frozen-lockfile` cannot resolve them and the `static` job's licence scan (`scripts/check-licenses.ts` over `pnpm licenses list --json`, allowlist MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / MPL-2.0 / 0BSD / Unlicense, denylist GPL / AGPL / LGPL / BSL / UNLICENSED) has nothing to check them against.

## Pinned versions

| Item | Exact version / image tag+digest / action tag+SHA | Declared licence | Licence verified from tarball or repo LICENSE | Single-copy status | Notes |
|---|---|---|---|---|---|
| `@fastify/static` | `10.1.3` | MIT | Yes | Pending install | No formal `peerDependencies` on `fastify` (normal for the plugin ecosystem); `devDependencies` pins `fastify: ^5.1.0`, compatible with the catalog's `fastify` 5.12.4 |
| `yauzl` | `3.4.0` | MIT | Yes | Pending install | Streaming ZIP reader for `apps/server/src/transfer` import; depends on `pend` (transitive, not catalogued) |
| `yazl` | `3.3.1` | MIT | Yes | Pending install | Streaming ZIP writer for export; depends on `buffer-crc32` (transitive, not catalogued) |
| `prom-client` | `15.1.3` | Apache-2.0 | Yes | Pending install | `/metrics` registry; `engines.node` is `^16 \|\| ^18 \|\| >=20`, satisfied by the Node 24 pin |
| `@codemirror/lang-yaml` | `6.1.3` | MIT | Yes | Pending install | Depends on `@lezer/yaml` and `@lezer/lr` (both `^1.0.0`, transitive, not catalogued) and on `@codemirror/state`/`language`/`autocomplete` `^6.0.0`, all satisfied by the existing catalog pins |
| `axe-core` | `4.13.0` | MPL-2.0 | Yes | Pending install | Published 2026-08-05; component-project (Browser Mode) accessibility scans |
| `vitest-axe` | `0.1.0` | MIT | Yes | Pending install | `peerDependencies.vitest` is `>=0.16.0`, loosely satisfying the catalog's `vitest` 5.0.0; depends on `axe-core: ^4.4.2`, satisfied by the pin above. See Follow-ups: this is the package's last stable release (2022); later work stalled at `1.0.0-pre.5` (2025-01-22) |
| `comlink` | `4.4.2` (already in the catalog; confirmed, not changed) | Apache-2.0 | Yes | Confirmed — `pnpm why comlink` shows exactly one resolved version, under `@iridium/markdown-react` | No action needed; the bootstrapped pin already matches the current latest stable release |
| MIME sniffer — `file-type` | `22.1.0` | MIT | Yes | Pending install | Magic-byte detector for `attachments/sniff.ts`. Pure ESM (`"type": "module"`), `engines.node >=22`, satisfied by Node 24. Published 2026-09-11, inside the 3-day `minimumReleaseAge` window as of this spike — added to `minimumReleaseAgeExclude` (matures 2026-09-14T10:28:53Z; see Follow-ups) rather than downgraded to an older release, consistent with how the bootstrap handled every other young pin |
| `@tailwindcss/vite` | `4.3.3` | MIT | Yes | Pending install | `peerDependencies.vite` is `^5.2.0 \|\| ^6 \|\| ^7 \|\| ^8`, satisfied by the catalog's `vite` 8.3.0; version matches the already-pinned `tailwindcss` 4.3.3 exactly (same release train) |
| `@types/react` | `19.3.0` | MIT | Yes | Pending install | Matches the catalog's `react` 19.3.0 exactly |
| `@types/react-dom` | `19.3.0` | MIT | Yes | Pending install | `peerDependencies['@types/react']` is `^19.3.0`, satisfied exactly by the pin above |
| `@types/ws` | `8.18.1` | MIT | Yes | Pending install | Types the catalog's `ws` 8.21.3 runtime dependency |
| `age` (binary, not npm) | `v1.3.2` | BSD-3-Clause | Yes (raw `LICENSE` at the release tag) | n/a — not an npm dependency, no lockfile entry | Encrypts the operator secrets bundle for `iridium backup`/`iridium restore`. Released 2026-08-29. Not added to `pnpm-workspace.yaml`; the version must be carried into whichever document or script pins the operator toolchain when that is written |
| `syft` GitHub Action (`anchore/sbom-action`) | `v0.24.2` → commit `3ad7283483fc7af8ff2b4ea19663c2d5ca935e26` | Apache-2.0 | Yes (raw `LICENSE` at the commit) | n/a | SBOM producer for `release.yml`; commit dated 2026-08-28 |
| `grype` GitHub Action (`anchore/scan-action`) | `v7.4.2` → commit `27805bf3b4e84b4a5c980df22ed233c00390a439` | MIT | Yes (raw `LICENSE` at the commit) | n/a | Vulnerability gate for `release.yml`; commit dated 2026-08-28 |
| Licence scanner | No separate tool. `scripts/check-licenses.ts` runs `pnpm licenses list --json --prod --filter …` (decision D10-12), riding entirely on the already-pinned `pnpm` 12.4.1 | MIT (pnpm) | n/a — not a new dependency | n/a | Confirmed the installed `pnpm` 12.4.1 exposes `licenses list --json` (`pnpm licenses --help`); no catalog entry needed |
| `caddy` image | tag `2.11.4` → index digest `sha256:13ba145cba2f3e28fa801994876e4c086d1b95d5aa2a520a734765ffb6b12017` | Apache-2.0 | Yes | n/a — container image, no lockfile entry | Reference reverse proxy for `infra/compose.prod.yaml`, not yet written in this repository; carry this tag+digest forward into `infra/.env`'s `CADDY_TAG`/`CADDY_DIGEST` when that file is authored |
| SeaweedFS image (`chrislusf/seaweedfs`) | tag `4.46` → index digest `sha256:08d516132314207d10c8e37cbffc1f32b147d870169688734cc61c6231625b62` | Apache-2.0 | Yes | n/a — container image, no lockfile entry | S3-compatible store for the compose `s3` profile, not yet written in this repository |

## Method

For every npm item: `npm view <pkg> version license dist-tags.latest time --json` for the exact latest stable version, its declared licence and publish timestamp; `npm pack <pkg>@<version>` into a scratch directory, extracted, and its `LICENSE`/`license` file (or, for the two `@types/*` packages with no top-level `LICENSE`, the DefinitelyTyped `LICENSE` shipped inside the package) read directly to confirm the declared licence; `npm view <pkg>@<version> peerDependencies dependencies engines --json` to check compatibility against the catalog's `react` 19.3.0, `vite` 8.3.0, `vitest` 5.0.0, `fastify` 5.12.4 and Node 24 pins; publish timestamps compared against `minimumReleaseAge: 4320` (three days) relative to 2026-09-13.

For `age`, `syft` and `grype`: `git ls-remote --tags` against the GitHub repository to find the current release tag and, for annotated tags, the peeled commit SHA (`refs/tags/<tag>^{}`); the GitHub API (`/repos/<owner>/<repo>`) for the declared licence; the raw `LICENSE` file fetched at that tag or commit to confirm it.

For the `caddy` and SeaweedFS images: the current numeric release resolved from the upstream GitHub releases API and cross-checked against the Docker Hub tags listing (`https://hub.docker.com/v2/repositories/<repo>/tags`), then `docker buildx imagetools inspect <image>:<tag>` for the exact multi-architecture index digest.

For the licence scanner: read `10-testing-and-quality.md` decision D10-12, which supersedes a separate third-party scanner with an in-repo script over `pnpm licenses list --json`; confirmed the subcommand exists in the installed `pnpm` 12.4.1 with `pnpm licenses --help`.

Single-copy status: `pnpm why <pkg>` for the one item already installed (`comlink`); every newly catalogued item is recorded "pending install" because this spike does not run `pnpm install`.

## Result

**pass.** Every npm item, the four non-npm tools/images, and the licence-scanner mechanism each resolve to an exact version (or image digest, or action commit SHA) with a licence inside the allowlist, verified against the actual published `LICENSE` text rather than only the registry's declared field. No item required a substitute.

## Decision

Every dependency the digest missed is pinned in `pnpm-workspace.yaml`'s `catalog:` (or, for the four items that are not npm packages, resolved and recorded here for the infra and workflow files that will consume them) at its exact current stable version with an allowlisted licence, so M0's catalog-completeness and licence-scan exit criteria are unblocked without any fallback.

## Fallback executed

n/a — every item passed the licence check at its natural latest version; no substitute from the fallback table was needed.

## Follow-ups

- `file-type@22.1.0` sits in `minimumReleaseAgeExclude` because it published inside the three-day window; remove the entry once it matures past 2026-09-14T10:28:53Z, per the same convention the bootstrap used for its own young pins.
- `vitest-axe` has not cut a stable release since 2022 (`0.1.0`); its only newer work is four `1.0.0-pre.*` prereleases, the last in January 2025. Watch its behaviour once the component-project accessibility tests are written against Vitest 5 Browser Mode, and revisit the pin if it misbehaves.
- `@lezer/yaml` and `@lezer/lr` arrive as transitive dependencies of `@codemirror/lang-yaml` and are not independently catalogued; confirm their single-copy status with `pnpm why` after install, alongside every row marked "pending install" above.
- The resolved `caddy` (`2.11.4` @ `sha256:13ba145c…`), SeaweedFS (`4.46` @ `sha256:08d51613…`), `age` (`v1.3.2`), `syft` (`v0.24.2` @ `3ad7283…`) and `grype` (`v7.4.2` @ `27805bf…`) values are not consumed anywhere yet, because `infra/compose*.yaml`, `infra/caddy/*` and `.github/workflows/*.yml` do not exist in this repository at the time of this spike; whoever authors those files must carry these exact values forward rather than re-resolving them.

## Amendment — prom-client replaced by its successor (2026-09-13)

`prom-client 15.1.3` is published with a deprecation notice ("prom-client has been replaced by
`@prometheus-io/client`"); the spike's first table pinned it before the notice was checked. The recorded
fallback of this spike — a named substitute per package — is executed: the catalog pins
`@prometheus-io/client 0.16.1` (Apache-2.0, published 2026-08-27 by the Prometheus organisation from
`github.com/prometheus/client_js`, engines `^22 || ^24 || >=26`) and `apps/server` depends on it.
The package is the same library under its new name; the CHANGELOG it ships records the breaking changes
of the rename, and the server's metrics module is written against the new package from the start. Every
plan passage that names `prom-client` refers to this package.
