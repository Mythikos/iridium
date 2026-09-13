# Security policy

## Reporting a vulnerability

Report a suspected vulnerability in Iridium privately, never in a public issue, discussion, or pull
request:

1. Preferred: open a private **GitHub Security Advisory** on this repository (Security tab → "Report
   a vulnerability"). This reaches maintainers directly and keeps the report out of public view
   until a fix ships.
2. If GitHub Security Advisories are not reachable, email the security contact named in this
   repository's root `CODEOWNERS` (or, until one exists, the address the maintainers publish
   alongside the release you are reporting against).

Include what you found, the affected version or commit, reproduction steps, and — where relevant —
the request/response, log lines, or test case that demonstrates it. Do not include another user's
data beyond what is strictly necessary to reproduce the issue.

We acknowledge a report within 5 business days, confirm or refute it with a timeline within 14 days,
and credit the reporter in the eventual advisory unless anonymity is requested. A confirmed
vulnerability is fixed under the emergency-patch exception the release process names (an accelerated
review, not a bypass): the fix package is added to `minimumReleaseAgeExclude`, the pull request title
carries the advisory id, the full `ci.yml` plus the `chaos-core` job must still pass, and the
exclusion is removed again in a follow-up pull request once the release ships
(`docs/plan/11-operations-and-deployment.md`, "Update cadence"; the operational side of that
procedure — who runs it and how — is `docs/ops/security.md`).

## Supported versions

Iridium is pre-1.0: everything before the `v1.0.0` tag is development software with no support
commitment, and vulnerabilities are fixed on `main` only. From `v1.0.0` onward, Iridium follows the
client/server compatibility window the plan defines: the server supports its current `apiVersion`
and the immediately preceding one (**N and N-1**) for one release cycle
(`docs/adr/0054-client-server-compatibility.md`, decision A54). Security fixes are backported to the
N-1 line for the duration of that overlap; once a release cycle ends, only the current line receives
fixes. There is no separate long-term-support line at 1.0.

## Threat model

The definitive threat model — the enumerated threats (T1–T17), the control that mitigates each one,
its implementation, and the evidence that proves it — is
[`docs/plan/04-auth-and-access-control.md`](docs/plan/04-auth-and-access-control.md) §12, settled by
[`docs/adr/0057-threat-model.md`](docs/adr/0057-threat-model.md) (A57). That document, not this one,
is authoritative on what Iridium defends against and how; this file only routes a report to the
people who act on it. The compliance-facing summary an external reviewer works from is
`docs/compliance-checklist.md` (stubbed alongside the operations documentation, per
`docs/plan/11-operations-and-deployment.md`).

## Scope

In scope: the server (`apps/server`), the shared packages it depends on (`packages/*`), the web and
Electron clients (`apps/web`, `apps/desktop`), the MCP surface (both mounts), and the deployment
artifacts under `infra/`. Out of scope: findings that require an already-compromised MySQL instance,
denial of service against a deliberately misconfigured deployment (for example a site that disabled
`READYZ_STRICT_DURABILITY` against the runbooks' explicit warning), and third-party dependencies —
report those upstream, but tell us too if Iridium's use of one is what makes it exploitable.
