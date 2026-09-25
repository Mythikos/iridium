# Configuration

*Stub seeded at M0. Not yet written — content lands with the milestone named below, drawn
from `docs/plan/11-operations-and-deployment.md`, not invented ahead of it.*

## What this document will contain

Every environment key the server reads, with its default, its range and its effect. For a key that is the baseline of a server-settings member (`docs/plan/03-data-model.md` §13.1), the environment value is also that member's floor: the laxest value the effective policy can take, which a `server_settings` row can only tighten. The precedence rule between an env value and a `server_settings` row is the stricter of the two, member by member, in the direction `SERVER_SETTING_RULES` declares, as enforced in `apps/server/src/settings/merge.ts`. A change made to `server_settings` outside `PUT /admin/settings` takes effect only after the `schema_meta` row `server_settings_version` is raised above the version the running server has installed (make both changes in one transaction); the next readiness evaluation observes it. That value is never set below `MAX(server_settings.version)`, and the server itself never re-creates or lowers it.

## Source

- docs/plan/11-operations-and-deployment.md, "Configuration and secrets"
- docs/plan/03-data-model.md §13.1 (the server-settings members, their spellings and baselines)
- docs/plan/12-milestones.md §12 (M8 scope)

## Argon2id parameters (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`)

Written early, ahead of the rest of this document, because `docs/spikes/S13-argon2-calibration.md`
measured these values before M1 built the login path against them.

The `EnvSchema` defaults for `ARGON2_MEMORY_KIB` and `ARGON2_TIME_COST` are `65536` and `3`. Those
are what the server assumes when the variables are unset, on any host — a developer machine, a CI
runner, or a production deployment that has not set them. They are not changed by this section: a
schema default applies to every one of those hosts, and only one of them is the calibration target.

The production default is set at the deployment layer instead, in `infra/compose.prod.yaml`'s
`server` service: `ARGON2_MEMORY_KIB=131072` (128 MiB), `ARGON2_TIME_COST=6`. S13 measured the
`65536`/`3` defaults at p50 47.80 ms / p95 56.45 ms on the 4 vCPU / 4 GiB reference container — well
under the 150–300 ms window `ARGON2_*` is calibrated against — and found `131072`/`6` centered in
that window: p50 **213.51 ms**, p95 **224.58 ms**.

The concurrency check matters as much as the latency: with eight logins hashing concurrently, a
`SELECT 1` probe run every 10 ms against the same MySQL host measures how much the hashing work
disturbs the event loop. At the `131072`/`6` pair, that probe's p95 was **44.52 ms** against the
50 ms threshold this project treats as the ceiling — **11 percent headroom** below it. A security
lead evaluating a heavier pair (a higher `ARGON2_MEMORY_KIB` or `ARGON2_TIME_COST` than the measured
default) should re-run S13's concurrency probe rather than assume the margin holds, because 11
percent is not a wide margin and the pair was chosen to land in the target window, not to maximise
headroom on the probe.

Both variables may be raised for a specific deployment without a code change; `iridium doctor
--argon2` (an M1+ CLI deliverable — the M0 CLI ships only `serve` and `migrate`) will warn rather
than fail when the measured latency on a given host falls outside the 150–300 ms window, since the
right pair is host-dependent (`docs/spikes/S13-argon2-calibration.md`, "Follow-ups").

## Database query deadlines (`DB_QUERY_TIMEOUT_MS`)

The M1 serving pools bound both connection acquisition and each SQL command to 10 000 ms by default. Set `DB_QUERY_TIMEOUT_MS` to a positive integer no greater than `2147483647`; `iridium config check` reports the effective value. `DB_CONNECT_TIMEOUT_MS` controls the separate initial TCP/MySQL connection timeout.

A timed-out SQL command destroys its connection before propagating the failure, freeing the pool slot and preventing another request from inheriting an unfinished command. This does not expire idle collaboration-owner reservations or impose a deadline on migration and backup operations. A COMMIT timeout has an unknown outcome: the failed attempt emits no Saved acknowledgement, and durable replay resolves the committed state on recovery.

## Projection rebuild admission (`REINDEX_RATE_PER_SECOND`)

M2 maintenance jobs and `iridium reindex` share a limit of 20 note admissions per second by default. Set `REINDEX_RATE_PER_SECOND` to a positive integer to change that rate; `iridium config check` reports the effective value. This throttles rebuild work entering the bounded projection worker pool. It does not change the worker timeout or the durability of live note updates. Rebuild jobs retain their cursor and continue after restart; see [projection-backlog.md](../runbooks/projection-backlog.md).

## `IRIDIUM_*` keys and rejected keys

Written at M3, ahead of the rest of this document, because M3 adds `IRIDIUM_TOOLS_DIR` and refuses `PUBLIC_HOST`.

The server reads exactly six `IRIDIUM_*` keys: `IRIDIUM_MIGRATE_ON_BOOT`, `IRIDIUM_ALLOW_NEWER_SCHEMA`, `IRIDIUM_ALLOW_UNTESTED_MYSQL`, `IRIDIUM_WEB_DIR`, `IRIDIUM_TOOLS_DIR` (from M3, below) and `IRIDIUM_FAULT`, which is accepted only under `NODE_ENV=test`. The test harness's reserved names and prefixes are ignored and listed by `iridium config check` under "ignored harness keys"; any other `IRIDIUM_*` key exits 2 with `config.unknown_key`.

Three names are refused by name, whatever their prefix, with exit 2, `config.rejected_key` and the reason:

- `IRIDIUM_E2E`: only the desktop main process reads it, so setting it on the server is a copied-configuration mistake.
- `IRIDIUM_ALLOW_NO_ORIGIN_WS`: there is no bypass for the absent-`Origin` rule on `/collab` (A24).
- `PUBLIC_HOST`, from M3: the public host is derived from `PUBLIC_ORIGIN` (its hostname plus any explicit port, ARCH-03), and the Host guard compares every request with that derived value. Set `PUBLIC_ORIGIN` and let the proxy forward the public `Host`, as the reference Caddy and nginx configurations do. `iridium config check` prints the derived value as `(derived)`. A deployment that set `PUBLIC_HOST` before M3 unsets it before upgrading; the M3 release's `[config]` operator flag (OPS-29) says so.

## Bridge download (`IRIDIUM_TOOLS_DIR`)

Written at M3, ahead of the rest of this document, because M3 adds the key (OPS-65).

`IRIDIUM_TOOLS_DIR` is an optional absolute path. Unset, the server serves no bridge download. The server image sets it to `/app/tools`, where the image build places `iridium-mcp.mjs`, the `iridium-mcp` stdio bridge of the image's own version, as a root-owned read-only file (mode `0444` in a `0555` directory) that the server's own user cannot rewrite.

When the key is set, configuration loading requires a non-empty regular file named `iridium-mcp.mjs` in that directory whose second line reads `// iridium-mcp <version>`, with `<version>` equal to the server's own version. Otherwise the server exits 2 with a message naming the path, the version found and the remedy:

- `config.tools_bundle_missing`: the file is missing, empty or not a regular file;
- `config.tools_bundle_version_mismatch`: the version line is absent or names another version.

`iridium config check` applies the same check. Unlike `IRIDIUM_WEB_DIR`, which warns and serves nothing, this key fails closed: the image always carries the file, so its absence is a build defect; a file of another version would be published under a version it is not; and unset already means no download.

The server reads the file once at boot, holds it in memory and serves exactly three names under `/desktop/tools/`, public and absent from the OpenAPI document:

| Name | Answer |
|---|---|
| `iridium-mcp-<version>.mjs` | the file as an `application/octet-stream` attachment, with a strong `ETag` equal to its SHA-256 and `Cache-Control: public, max-age=60`; a matching `If-None-Match` answers `304`. It is never marked immutable, because a rebuilt image of the same version serves different bytes |
| `iridium-mcp-latest.mjs` | `302` to the versioned name, with `Cache-Control: no-store` |
| `SHA256SUMS` | one `sha256sum`-format line for the versioned name, with `Cache-Control: public, max-age=60` |

Any other name answers `404` with an empty body.

## Token, MCP and OAuth policy baselines (`PAT_*`, `MCP_ENABLED`, `OAUTH_*`)

Written at M3, ahead of the rest of this document, because M3's stored settings make these keys the baselines of the `patPolicy`, `mcpEnabled` and `oauthPolicy` groups (AG12, D03-28), and because M3 narrows ranges that earlier releases accepted.

Each member of the three groups has exactly one environment key, one range and one merge direction, declared once as `SERVER_SETTING_RULES` in `@iridium/contracts`; `docs/plan/03-data-model.md` §13.1 is the spelling authority. A value stored through `PUT /admin/settings` can only make the effective policy stricter than the key: a *lower* member takes the smaller of the two values, and an *and* flag is on only while both are on. `GET /admin/settings` reports the environment values as the document's floors.

| Key | Member | Range | Default | Direction |
|---|---|---|---|---|
| `PAT_DEFAULT_LIFETIME_DAYS` | `patPolicy.defaultLifetimeDays` | 1–366 | 90 | lower, and never above the effective `maxLifetimeDays` |
| `PAT_MAX_LIFETIME_DAYS` | `patPolicy.maxLifetimeDays` | 1–366 | 366 | lower |
| `PAT_ALLOW_NO_EXPIRY` | `patPolicy.allowNoExpiry` | boolean | `false` | and |
| `PAT_ROTATION_OVERLAP_MAX_HOURS` | `patPolicy.rotationOverlapMaxHours` | 0–24 | 24 | lower |
| `PAT_DEFAULT_RATE_LIMIT_PER_HOUR` | `patPolicy.defaultRateLimitPerHour` | 60–100 000 | 3 000 | lower |
| `PAT_ALLOW_ALL_VAULTS_FOR_NON_ADMINS` | `patPolicy.allowAllVaultsForNonAdmins` | boolean | `true` | and |
| `MCP_ENABLED` | `mcpEnabled.enabled` | boolean | `true` | and |
| `OAUTH_ACCESS_TOKEN_TTL_MINUTES` | `oauthPolicy.accessTokenTtlMinutes` | 5–1 440 | 60 | lower |
| `OAUTH_REFRESH_IDLE_DAYS` | `oauthPolicy.refreshIdleDays` | 1–366 | 30 | lower, and never above the effective `refreshAbsoluteDays` |
| `OAUTH_REFRESH_ABSOLUTE_DAYS` | `oauthPolicy.refreshAbsoluteDays` | 1–366 | 90 | lower |
| `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR` | `oauthPolicy.defaultRateLimitPerHour` | 60–100 000 | 3 000 | lower |
| `OAUTH_ALLOW_DYNAMIC_CLIENT_REGISTRATION` | `oauthPolicy.allowDynamicClientRegistration` | boolean | `true` | and |
| `OAUTH_ALLOW_CLIENT_ID_METADATA_DOCUMENTS` | `oauthPolicy.allowClientIdMetadataDocuments` | boolean | `true` | and |
| `OAUTH_ALLOW_CONSENT_WITHOUT_STEP_UP` | `oauthPolicy.allowConsentWithoutStepUp` | boolean | `false` | and |

The session, password, retention and desktop-update keys are not stored settings at M3: the server reads them from the environment alone until M7 adds each group (AG12).

**Rate limits.** `PAT_DEFAULT_RATE_LIMIT_PER_HOUR` is the hourly budget of a personal access token whose row sets none, and `OAUTH_DEFAULT_RATE_LIMIT_PER_HOUR` is the same for an OAuth access token. Before M3 the personal-access-token key was named `MCP_RATE_LIMIT_PER_HOUR`. That name is still accepted, with a warning naming the new key, and it now governs personal access tokens only; setting both spellings exits 2. `MCP_RATE_LIMIT_BURST_PER_MIN` and `MCP_PROCESS_CEILING_PER_MIN` apply to both MCP mounts alike.

**All vaults.** While the effective `allowAllVaultsForNonAdmins` is false, a user who is not a server administrator cannot create or rotate a token for all vaults (`422 validation_failed`, `all_vaults_disabled`), and the consent page offers them no all-vaults choice; tokens and grants that already cover all vaults keep working. `GET /meta` publishes the effective value as `policies.patAllowAllVaultsForNonAdmins`.

**Related keys.** Two pairs are ordered: `PAT_DEFAULT_LIFETIME_DAYS` is at most `PAT_MAX_LIFETIME_DAYS`, and `OAUTH_REFRESH_IDLE_DAYS` is at most `OAUTH_REFRESH_ABSOLUTE_DAYS`. A pair is refused (exit 2, naming both keys) only when both keys are set, directly or through an accepted alias, and contradict each other. When either key is left at its default and the pair is out of order, the server gives the dependent key the bound's value and logs a configuration warning naming both keys and the value used, so tightening one key never stops a boot. In stored settings, a `PUT /admin/settings` that writes a member of a pair and leaves both stored out of order is `422 validation_failed` (`exceeds_related_field`); with only one of them stored, the effective value is clamped the same way.

**Upgrading from v0.2.0.** M3 narrows ranges that v0.1.0 and v0.2.0 accepted: `OAUTH_ACCESS_TOKEN_TTL_MINUTES` below 5; `PAT_DEFAULT_LIFETIME_DAYS`, `PAT_MAX_LIFETIME_DAYS`, `OAUTH_REFRESH_IDLE_DAYS` and `OAUTH_REFRESH_ABSOLUTE_DAYS` above 366; `PAT_ROTATION_OVERLAP_MAX_HOURS` above 24; and `MCP_RATE_LIMIT_PER_HOUR`, through its alias, below 60 or above 100 000. An out-of-range value exits 2 with an error naming the key, the value and the range. It is never clamped, because clamping a TTL below its minimum would silently lengthen it. Run `iridium config check` from the new image against the deployment's environment before pulling it: it reports every out-of-range key, the renamed key and a set `PUBLIC_HOST`. The M3 release notes carry the `[config]` operator flag (OPS-29) listing each narrowed key with its range, the rename and the `PUBLIC_HOST` refusal.

## Client ID Metadata Document deny list (`OAUTH_CIMD_DENY_CIDR`)

Written at M3, ahead of the rest of this document, because M3 adds the key (D06-41).

`OAUTH_CIMD_DENY_CIDR` is a comma-separated list of IPv4 and IPv6 CIDRs, empty by default. When the server fetches a connector's Client ID Metadata Document, every address the document's host resolves to must first pass the built-in rule (globally reachable under the IANA special-purpose address registries; see [oauth.md](./oauth.md)), and an address inside a listed range is then refused as well. The list also applies to the IPv4 address embedded in an IPv4-mapped (`::ffff:0:0/96`), NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`) address. It is tighten-only: nothing relaxes the built-in rule, and the list can only refuse more.

List the deployment's own routable internal space: internal global-unicast IPv6 prefixes, any internally routed public IPv4 ranges, and any network-specific NAT64 prefix, as its IPv6 CIDR. Block the same ranges at the network egress layer as well, because egress policy remains the primary control for address space the server cannot classify.

Each entry is validated when configuration loads: an invalid entry fails `iridium config check` and boot with exit 2, naming the entry. `iridium config check` prints the effective list.
