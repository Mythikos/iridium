# S13 — Argon2id parameter calibration

## Question

Do the settled argon2id parameters (`@node-rs/argon2` 2.2.1: `memoryCost 65536` KiB, `timeCost 3`, `parallelism 1`, `hashLength 32`, pepper via `secret`) land in the 150–300 ms window on the reference hardware, and does hashing stay off the event loop with `UV_THREADPOOL_SIZE=8`?

## Why it blocks

A29 settles the argon2id parameters, and R-T29 is the risk that they are wrong for the host: too cheap weakens the hash, too expensive turns every login into libuv-thread-pool pressure that surfaces as a `/readyz` event-loop-lag warning. M1 builds the login path against one set of numbers, so the numbers must be measured before it does. The harness below is the seed of `iridium doctor --argon2`, so the measurement ships rather than being thrown away.

## Pinned versions

| Item | Version | Role |
|---|---|---|
| `@node-rs/argon2` | 2.2.1 | Hashing library under test — already installed for `apps/server` (catalog-pinned). Platform binaries exercised: `@node-rs/argon2-win32-x64-msvc` 2.2.1 (host), `@node-rs/argon2-linux-x64-gnu` 2.2.1 (container), `@node-rs/argon2-linux-arm64-gnu` 2.2.1 (QEMU-emulated container) |
| `argon2` (npm) | 0.45.1 | Cross-verification target, installed into a scratch project outside the repository |
| `mysql2` | 3.24.4 | Driver for the concurrent `SELECT 1` probe — already installed for `apps/server` (catalog-pinned) |
| `mysql` (Docker image) | `8.4.11` | Scratch database for the probe — the compatibility-floor image per `docs/plan/03-data-model.md` |
| `node` (Docker image) | `24.21.0-bookworm-slim` | 4 vCPU / 4 GiB constrained container, per the register row |
| Node.js (host) | v24.11.0 | Windows measurement runtime |
| Node.js (container) | v24.21.0 | Container measurement runtime |
| Host OS | Windows 11 Home 10.0.26200, x64, 32 logical CPUs, 63.76 GiB RAM | "This Windows machine" leg of the method |
| Docker | 29.7.2 (Docker Desktop / WSL2 backend) | Container runtime for the 4 vCPU/4 GiB leg and the MySQL probe target |

The `ubuntu-latest` GitHub Actions runner leg from the register's general method is out of scope for this spike run — no CI runner is reachable from this machine; the two legs actually measured are the ones this spike's brief assigns (this Windows host, and the 4 vCPU/4 GiB container).

## Method

Harness: `apps/server/spikes/s13/` — the seed of `iridium doctor --argon2`.

- `lib.mjs` — percentile math (linear-interpolation p50/p95), option parsing from `ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST`/`ARGON2_PARALLELISM`/`ARGON2_HASH_LENGTH`/`ARGON2_PEPPER` env vars, JSON rounding.
- `measure.mjs` — imports `@node-rs/argon2` and (when a `--mysql-url` is given) `mysql2/promise` by walking up from its own directory, so on the host it resolves the versions already installed for `apps/server`, and inside the container it resolves whatever a scratch `npm install` provides there. For one run it: times 20 sequential `hash()` calls (p50/p95); `verify()`s the last PHC string; runs a `SELECT 1` probe every 10 ms through a `mysql2` pool while 8 `hash()` calls run concurrently, recording the probe's own p50/p95/max; hashes twice more with a bumped `timeCost` and compares `parseOptions()` output against the target policy to demonstrate a needs-rehash check (2.2.1 has no `needsRehash()` export — the real check is exactly this comparison, and `credentials.ts` must be written that way). One JSON object per run.
- `sweep.mjs` — throwaway parameter search: 5-sample median per `{memoryCost, timeCost}` candidate, used only to find the fallback pair.
- `results/*.json` and `results/*.txt` — the actual run output cited below.

Runs:

1. **Windows host, defaults, real MySQL probe.** A scratch `mysql:8.4.11` container (`docker run -d --name s13-mysql -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=iridium_spike -p 33061:3306 mysql:8.4.11`), then `UV_THREADPOOL_SIZE=8 node apps/server/spikes/s13/measure.mjs --label=windows-host --mysql-url=mysql://root@127.0.0.1:33061/iridium_spike`. Output: `results/windows-host.json`.
2. **4 vCPU / 4 GiB container, defaults.** `docker network create s13-net` and `docker network connect s13-net s13-mysql`, then `docker run --rm --cpus 4 --memory 4g --network s13-net -e UV_THREADPOOL_SIZE=8 -v <scratch>:/spike:ro node:24.21.0-bookworm-slim bash -c "cp /spike/*.mjs /work/ && npm install @node-rs/argon2@2.2.1 mysql2@3.24.4 && node measure.mjs --label=container-4cpu-4gb-defaults --mysql-url=mysql://root@s13-mysql:3306/iridium_spike"` — the scratch npm install runs entirely inside the container's own ephemeral filesystem (nothing touches the repository or the host); the actual repository install could not be reused because pnpm's Windows symlinks resolve to Windows-only paths that a Linux container cannot follow. Output: `results/container-4cpu-4gb-defaults.json`.
3. **Parameter sweep**, same container shape, to find a pair landing in 150–300 ms: `results/sweep-container.txt`.
4. **4 vCPU / 4 GiB container, fallback pair, real MySQL probe** (same command as run 2 with `ARGON2_MEMORY_KIB=131072 ARGON2_TIME_COST=6`). Output: `results/container-4cpu-4gb-fallback.json`.
5. **Cross-verification.** `argon2` 0.45.1 installed into a scratch npm project (`C:\Users\...\scratchpad\m0\s13-cross-verify-win`, not the repository) — it resolved prebuilt binaries from its own `prebuilds/` tree (`prebuild-install`-style), so the "may need a native build" concern in the brief did not materialize on Windows and the container fallback for this check was not needed. `argon2.verify()` checked PHC strings produced by `@node-rs/argon2` 2.2.1 under both parameter sets, and `@node-rs/argon2`'s own `verify()` checked a PHC string `argon2` 0.45.1 produced. Output: `results/cross-verify.txt`.
6. **Prebuilt-binary matrix.** `win32-x64` and `linux-x64` confirmed by runs 1–4 succeeding without a compile step (`npm install` reporting only "added N packages", no `node-gyp` output). `linux-arm64` confirmed separately via `docker run --platform linux/arm64 node:24.21.0-bookworm-slim` with a fresh scratch install (QEMU-emulated — timing from that run is not meaningful, only that the native addon loaded and produced a valid hash). `darwin-arm64` could not be checked: Docker Desktop on Windows has no macOS container runtime, and no Apple-silicon hardware was available.

## Result

**fail** (for the settled defaults on the reference container; the register's documented-pair fallback path is what actually lands in the window — see Decision and Fallback executed).

- **Sequential p50/p95, defaults (`memoryCost 65536`, `timeCost 3`), n=20:**
  - Windows host: p50 **49.30 ms**, p95 **54.31 ms** (`results/windows-host.json`).
  - 4 vCPU/4 GiB container: p50 **47.80 ms**, p95 **56.45 ms** (`results/container-4cpu-4gb-defaults.json`).
  - Both are far under the 150–300 ms window — roughly a third of the floor. **This is the fail**: the settled defaults do not land in window on this hardware.
- **Root cause, not a measurement error.** `docker run --cpus 4 --memory 4g` sets a CFS CPU quota and a memory cgroup limit, but does not change what `os.cpus()` (32) or `os.totalmem()` (31.22 GiB) report inside the container, and — more importantly — does not slow down a single thread's raw execution speed. A quota only throttles *aggregate* usage across a period; one sequential `hash()` call never approaches a 4-core quota, so it runs at this workstation's native per-core speed regardless of the `--cpus` flag. The constraint only bites under concurrency (see below). The settled defaults were sized for a slower reference core than this machine has; that is a genuine hardware-calibration mismatch, exactly the scenario R-T29 and this spike exist to catch.
- **Parameter sweep** (`results/sweep-container.txt`) found `memoryCost 131072` KiB (128 MiB) / `timeCost 6` centered in the window with headroom on both sides (`memoryCost 98304`/`timeCost 6` sits only ~5–8 ms above the 150 ms floor — too close to run-to-run variance to be a safe default).
- **Sequential p50/p95, fallback pair (`memoryCost 131072`, `timeCost 6`), n=20, container:** p50 **213.51 ms**, p95 **224.58 ms** — inside the 150–300 ms window (`results/container-4cpu-4gb-fallback.json`).
- **Event-loop isolation (`SELECT 1` probe, real `mysql:8.4.11`, 10 ms cadence, 8 concurrent hashes):**
  - Defaults, container: probe p95 **16.33 ms**, max 28.81 ms, over 10 samples; hash durations themselves p50 141.07 ms / p95 144.26 ms (concurrency contention on 4 vCPUs roughly triples the ~48 ms solo time, as expected — 8 single-threaded jobs sharing 4 execution slots).
  - Fallback pair, container: probe p95 **44.52 ms**, max 55.74 ms, over 42 samples — still under the register's 50 ms threshold, but with little headroom; hash durations p50 787.10 ms / p95 799.17 ms (up from 213 ms solo — an 8-wide login burst under the fallback parameters approaches, but stays under, the 1 s figure R-T29 names as the at-risk threshold). Both parameter sets keep the probe off the event loop; the fallback pair's margin against the 50 ms ceiling is worth re-confirming on the real production container shape at M8.
  - Windows host, defaults, real MySQL probe: p95 **2.60 ms** — comfortably clear, as expected on completely uncontended hardware.
- **`needsRehash`.** `@node-rs/argon2` 2.2.1 has no `needsRehash()` export; the check is `parseOptions(hash)` compared field-by-field against the current policy. Demonstrated on both host and container: hashing with the current policy and re-parsing matches it (`needsRehashBeforeChange: false`); hashing with `timeCost` bumped by one and re-parsing does not (`needsRehashAfterChange: true`). `apps/server/src/auth/credentials.ts` must implement the check this way, not by calling a function that does not exist in this version.
- **PHC interoperability.** `argon2` 0.45.1 verified PHC strings produced by `@node-rs/argon2` 2.2.1 under both the defaults and the fallback pair; `@node-rs/argon2` verified a PHC string `argon2` 0.45.1 produced. Both directions returned `true`. The two libraries order the PHC parameter fields differently (`m=…,t=…,p=…` vs `m=…,p=…,t=…`); this has no effect on interoperability (`results/cross-verify.txt`).
- **Prebuilt binaries.** Loaded without a build toolchain on `win32-x64` (host), `linux-x64` (container) and `linux-arm64` (QEMU-emulated container) for both `@node-rs/argon2` 2.2.1 and, for `win32-x64`, `argon2` 0.45.1 too. `darwin-arm64` was not reachable from this environment (no macOS container runtime, no Apple-silicon hardware) and is not confirmed by this spike.

## Decision

`apps/server/src/config`'s `EnvSchema` defaults for `ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST` stay the originally-settled `65536`/`3` — the key table in `11-operations-and-deployment.md`'s "Configuration and secrets" section fixes those as the schema defaults, because a schema default would apply to every developer machine and CI runner, not only the reference deployment container. The measured pair `131072`/`6` is instead carried into `infra/compose.prod.yaml`'s `server` service and documented in `docs/ops/configuration.md`, exactly as the register's recorded fallback states it ("the measured pair becomes the default in `infra/compose.prod.yaml` and `docs/ops/configuration.md`", `14-risks-and-open-questions.md`'s S13 row), with `parallelism` staying `1`. `iridium doctor --argon2` — an M1+ CLI deliverable, since the M0 CLI ships only `serve` and `migrate` — is specified to warn rather than hard-fail on a host that cannot reach the 150–300 ms window with these defaults.

## Fallback executed

The register's documented-pair fallback: `ARGON2_MEMORY_KIB=131072`, `ARGON2_TIME_COST=6` (parallelism 1,
`outputLen` 32 unchanged), which lands p50 213.51 ms / p95 224.58 ms on the 4 vCPU/4 GiB container. It is
executed exactly as the register words it — the pair becomes the **deployment** default, not the schema
default: `infra/compose.prod.yaml` sets both variables on the server service (with `UV_THREADPOOL_SIZE=8`,
which libuv reads before any code runs), and `docs/ops/configuration.md` records the pair, the schema
defaults `65536` / `3` that the server assumes when the variables are unset, the measurements, and the
thin headroom of the concurrency probe. `EnvSchema` is unchanged, because a schema default would apply to
every developer machine and CI runner where the settled defaults already hash in about 50 ms; the server's
configuration module accepts the pair without modification, verified by the server team. The
`iridium doctor --argon2` check that reads the same measurement is an M1+ deliverable (the M0 CLI carries
`serve` and `migrate` only); when it lands it warns rather than fails when a host is outside the window.

Pull request: the M0 milestone commit that lands the compose and configuration changes (recorded at the M0
exit).

## Follow-ups

- `iridium doctor --argon2` (M1+): report the measured p50 against the window and warn, never fail, when a host is outside it, reading the same pair `infra/compose.prod.yaml` sets.
- Re-run this harness's fallback-pair leg on the actual M8 production container shape (`docs/plan/12-milestones.md`'s load-and-tuning row already calls for re-confirming S13's argon2 parameters there) — this spike's "4 vCPU/4 GiB" container only reproduces *contention* behavior faithfully (confirmed by the ~3–4× slowdown between solo and 8-concurrent hashing), not raw per-core clock speed, since Docker's `--cpus` throttles aggregate CPU-quota rather than single-thread speed. A physically slower reference core could still miss the window even with the `131072`/`6` pair, or a faster one could sail past 300 ms; the admin-tunable `ARGON2_*` settings (A29) exist for exactly this reason.
- The fallback pair's concurrent `SELECT 1` p95 (44.52 ms) leaves only ~5.5 ms of headroom under the register's 50 ms threshold; watch this specifically during the M8 load harness's login-burst scenario rather than assuming the container measurement here generalizes.
- `credentials.ts`'s rehash check must be written as `parseOptions(hash)` compared against the live policy — `@node-rs/argon2` 2.2.1 exports no `needsRehash()` function, matching this spike's demonstration.
- The plan text names the hash-length parameter `hashLength`; `@node-rs/argon2` 2.2.1's actual `Options` field is `outputLen`. `credentials.ts` and any future `iridium doctor --argon2` output should use the real field name.
- `darwin-arm64` prebuilt-binary loading is unconfirmed by this spike (no macOS runtime available here); confirm it in CI or on real Apple-silicon hardware before relying on the full four-platform claim in the register's pass criterion.
- `linux-arm64` was confirmed only under QEMU emulation; its timing numbers are not evidence of anything and were not used for calibration.
