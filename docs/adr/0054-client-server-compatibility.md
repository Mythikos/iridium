# A54 — Client/server compatibility: integer `apiVersion`, `minClientVersion`, additive-only rule, N-1 window

**Status:** Accepted (2026-09-11); amended 2026-09-18 (implemented, "M1 independent-review amendments"); **amended 2026-09-25:** the gate's scope and the release floor ("A54 amendment: the gate's scope and the release floor", near the end of this file).

## Context

Desktop fleets update on the administrator's schedule (A53 update policy), so an older client will talk to a newer server. No source plan defined what "compatible" means; this ADR closes that gap.

## Decision

`GET /meta` returns `{apiVersion: int, minClientVersion, serverVersion, features: string[], publicOrigin}`; clients send `X-Iridium-Client-Version`. A **breaking** change is removing or renaming a field, endpoint, stateless message type, or IPC channel, changing semantics, or tightening validation; it increments `apiVersion` and raises `minClientVersion`. [**Amended 2026-09-25:** the effective `minClientVersion` is the SemVer maximum of the committed release floor `RELEASE_MIN_CLIENT_VERSION`, which a breaking release raises in the same change that increments `API_VERSION`, and the operator floor `schema_meta.min_client_version`, which can raise the effective floor but never lower it below the release's; no data migration carries a release floor ("A54 amendment: the gate's scope and the release floor").] **Non-breaking** changes are additive optional fields, endpoints, stateless messages, or `features` entries. The server supports `apiVersion` N and N-1 for one release cycle. Stateless collab messages carry `v: 1`. Desktop IPC has no skew (renderer and main ship in one installer). A desktop client below `minClientVersion` shows an "update required" screen and prompts according to the update policy. Changesets keeps one product version across server image, web bundle, installers, and bridge (A1).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Package-version negotiation (semver ranges) | Ties protocol compatibility to release numbering; an integer that only moves on breaking changes is simpler to reason about and to test. |
| No compatibility contract (web-only mindset) | The Electron fleet makes skew a certainty. |

## Consequences

Positive: an explicit definition of "breaking" that reviewers can apply; the `features[]` list lets clients light up capabilities without a version bump. Negative: N-1 support means the server keeps deprecated fields for one cycle and tests both shapes (`rest.route-index.contract` and the `toMatchOpenApi` matcher run against both `apiVersion` values during a transition).

## Verification

`meta.apiversion.integration` (shape and values), `desktop.update-required.e2e` (client below `minClientVersion`), and `rest.route-index.contract` during any transition; the release checklist in `11-operations-and-deployment.md` requires an `apiVersion` decision on every breaking change.

## References

Gap fix (no digest section; product expectations in digest §10.2). Implemented in `09-api-reference.md`, `07-client-applications.md`, `12-milestones.md`.

---

Source: docs/plan/13-decision-log.md, decision A54. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).

## M1 amendment (2026-09-18)

The live floor is the committed `schema_meta.min_client_version`, seeded without replacing an existing value by forward migration `0055_min_client_version`. Both discovery and enforcement use the same reader (amended 2026-09-25: the floor both read is the SemVer maximum of the committed release constant `RELEASE_MIN_CLIENT_VERSION` and that row, which remains the operator's lever; see "A54 amendment (2026-09-25)" below). A well-formed presented client version below the floor receives `426 client_outdated`, whose detail is the current floor, on reads and writes. Absent headers preserve existing non-Iridium callers; malformed explicit headers receive `422 validation_failed`. Authentication and CSRF run first, operational endpoints retain their liveness contracts, and `GET /api/v1/meta` and `GET /api/v1/desktop/update-policy` remain exempt (A54 amended 2026-09-25): the gate evaluates the header only on `/api/v1/*` outside those two reads and on the `/collab` upgrade. `X-Iridium-Api-Version` is sent on early refusals too. The real metadata integration suite observes a committed mid-session floor raise, refusal before a mutation, policy recovery, and the zero-query malformed-credential ordering.

Source: `docs/plan/13-decision-log.md`, M1 independent-review amendments, A54.

## A54 amendment (2026-09-25): the minClientVersion gate's scope and the release floor

**The gate's scope.** The gate evaluates `X-Iridium-Client-Version` — `422 validation_failed` for a malformed value and `426 client_outdated` for one below the floor — only on `/api/v1/*` routes, matched by the route's registered URL, other than `GET /api/v1/meta` and `GET /api/v1/desktop/update-policy`, and on the `/collab` upgrade. No other surface evaluates it: `/mcp`, `/mcp/connect`, `/oauth/*`, `/.well-known/*`, `/desktop/*`, `/app/*`, `/`, `/login`, `/set-password` and the operational paths never do, so every published URL is outside the gate by construction. The two exempt reads are what a client below the floor needs to learn that it is outdated and to obtain the upgrade; gating either would turn the blocking screen into a dead end. The clients that send the header are the two hosts, web and desktop; `iridium-mcp` and other MCP clients send neither it nor `X-Iridium-Client`, and the Decision's sentence "clients send `X-Iridium-Client-Version`" refers to those two hosts. The gate, and the header skip on `onSend`, live in `apps/server/src/rest/version.ts`.

**The release floor.** The client floor a release requires is a build artefact: `RELEASE_MIN_CLIENT_VERSION`, a SemVer string exported by `@iridium/contracts` (`rest/meta.ts`) beside `API_VERSION`, which moves there from `apps/server/src/rest/version.ts`; both keep their current values, `1` and `'0.0.0'`. The `minClientVersion` that `GET /meta` serves and the `426` gate enforces is the SemVer maximum of `RELEASE_MIN_CLIENT_VERSION` and `schema_meta.min_client_version`. `schema_meta` stays the operator's lever: it can raise the effective floor, never lower it below the release's. A breaking release raises `RELEASE_MIN_CLIENT_VERSION` in the same change that increments `API_VERSION`, and no data migration carries a release floor. `release.yml`'s bridge job compares `RELEASE_MIN_CLIENT_VERSION` with the previous tag (OPS-65), and `compat.n-minus-1.integration` compares the wire with the release baselines under D10-11.

Every restatement of the scope — `09-api-reference.md` §1.2, §1.5 (`client_outdated`) and §7.1, its `GET /meta` and `GET /desktop/update-policy` rows, 02's "Client identification" row and the `minClientVersion` TSDoc in `packages/contracts/src/rest/meta.ts` — says the same thing in the same words, because the scope governs every REST client and `/collab`, not only the bridge. Rejected: an exclusion list of published path prefixes, which missed `/desktop/tools/*`, `/app/*`, `/`, `/login` and `/set-password` and still gated `GET /desktop/update-policy`; restricting the gate to `/api/v1` alone, dropping `/collab`; gating `update-policy`; sending the header from the bridge with an exemption; recording the scope only under D06-13.

Verification: `rest.client-version.unit` (an outdated header, and a malformed one, on `/mcp`, `/mcp/connect`, `/oauth/token`, `/.well-known/…`, `/app/x`, `/desktop/tools/…`, `GET /api/v1/meta` and `GET /api/v1/desktop/update-policy` give no `426` and no `422`; the same headers on `GET /api/v1/vaults` and on the `/collab` upgrade give `426` and `422`); `meta.apiversion.integration` (the published-URL cases, and the served floor on a freshly migrated schema equal to `RELEASE_MIN_CLIENT_VERSION`).

Source: `docs/plan/13-decision-log.md`, the A54 amendment of 2026-09-25.
