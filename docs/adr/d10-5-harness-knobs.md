# D10-5: the standard harness knobs

Status: accepted; amended 2026-09-25: five knobs join the standard set, each with one meaning, inside the reserved `IRIDIUM_TEST_*` namespace.

**As accepted.** Standard environment knobs: `IRIDIUM_TEST_SEED`, `IRIDIUM_TEST_HOST_CONTRACT_REPORTS`, `IRIDIUM_PROP_RUNS`, `IRIDIUM_PROP_DB_RUNS`, `IRIDIUM_PROP_DB_COMMANDS`, `IRIDIUM_PROP_SIZE`, `IRIDIUM_CHAOS_ITERATIONS`, `IRIDIUM_E2E_ORIGIN`, `IRIDIUM_E2E_EXTERNAL_SERVER`, `IRIDIUM_E2E_CLIENT_VERSION`, `IRIDIUM_MYSQL_IMAGE`, `IRIDIUM_FIXTURE_VERSION`, `IRIDIUM_COVERAGE_RATCHET`, plus the client-owned `IRIDIUM_SERVER_URL` and `IRIDIUM_USER_DATA` the Electron launch sets. Every one of them sits inside a reserved harness namespace — the prefixes `IRIDIUM_TEST_*`, `IRIDIUM_PROP_*`, `IRIDIUM_CHAOS_*`, `IRIDIUM_E2E_*`, `IRIDIUM_FIXTURE_*`, `IRIDIUM_COVERAGE_*` and the exact names `IRIDIUM_MYSQL_IMAGE`, `IRIDIUM_USER_DATA`, `IRIDIUM_SERVER_URL`, `IRIDIUM_MCP_TOKEN` that `EnvSchema` lists as known-and-ignored — and a new knob is never given a name outside them. One set of names makes the PR lane, the nightly lane and a developer's laptop the same suite at different intensities. The namespace rule is what makes the suite runnable at all: an unknown `IRIDIUM_*` variable is a fatal configuration error, and the `child` and `container` modes spawn the production `main.mjs serve` with the whole job environment.

**Amended 2026-09-25.** The standard knobs gain five, all inside `IRIDIUM_TEST_*`:

- `IRIDIUM_TEST_SERVER_MODE` — `in-process` or `container`; unset means `in-process`, any other value is a usage error when the suite starts, and only suites that opt in read it (`bridge.parity.contract`).
- `IRIDIUM_TEST_SERVER_IMAGE` — the image container mode runs; it never selects the mode.
- `IRIDIUM_TEST_BRIDGE_BUNDLE` — default `packages/mcp-bridge/dist/iridium-mcp.mjs`; a missing file is `BridgeBundleMissingError`, naming the path and the build command (`pnpm turbo run build --filter=@iridium/mcp-bridge`), so the suite never passes vacuously.
- `IRIDIUM_TEST_MCP_CONFORMANCE_SUITE` — `active` or `all`, default `active`; the nightly `conformance-all` job sets `all`.
- `IRIDIUM_TEST_MCP_CLIENTS_DIR` — the directory the nightly job installed the pinned third-party clients into (AG11).

One knob, one meaning: `ci.yml` sets neither server-target knob, so `bridge.parity.contract` runs in-process against the bundle its integration job builds; `release.yml` sets `IRIDIUM_TEST_SERVER_MODE=container`, `IRIDIUM_TEST_SERVER_IMAGE` to the release digest and `IRIDIUM_TEST_BRIDGE_BUNDLE` to the file it extracted from the image and asserted byte-identical across both platform variants, and runs the file by path without `--passWithNoTests`; nightly's job-wide image variable does not change a suite's mode.

Verification: `bridge.parity.contract` (in-process on pull requests, container on release, the bundle taken from the knob) and `mcp.conformance.mcp`.

Source: the D10-5 amendment in [the decision log](../plan/13-decision-log.md), and D10-5 in [10-testing-and-quality.md](../plan/10-testing-and-quality.md), "Decisions made in this section".
