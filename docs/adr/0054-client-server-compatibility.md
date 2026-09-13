# A54 — Client/server compatibility: integer `apiVersion`, `minClientVersion`, additive-only rule, N-1 window

**Status:** Accepted (2026-09-11).

## Context

Desktop fleets update on the administrator's schedule (A53 update policy), so an older client will talk to a newer server. No source plan defined what "compatible" means; this ADR closes that gap.

## Decision

`GET /meta` returns `{apiVersion: int, minClientVersion, serverVersion, features: string[], publicOrigin}`; clients send `X-Iridium-Client-Version`. A **breaking** change is removing or renaming a field, endpoint, stateless message type, or IPC channel, changing semantics, or tightening validation; it increments `apiVersion` and raises `minClientVersion`. **Non-breaking** changes are additive optional fields, endpoints, stateless messages, or `features` entries. The server supports `apiVersion` N and N-1 for one release cycle. Stateless collab messages carry `v: 1`. Desktop IPC has no skew (renderer and main ship in one installer). A desktop client below `minClientVersion` shows an "update required" screen and prompts according to the update policy. Changesets keeps one product version across server image, web bundle, installers, and bridge (A1).

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
