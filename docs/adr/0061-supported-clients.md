# AG6 — Supported clients at 1.0: the desktop application; the web host is a development and internal surface

**Status:** Accepted (2026-09-12). Supersedes the supported-browsers clause of A55 and the cross-browser smoke lane of A52.

## Context

A55 committed to "current Chrome and Edge (Chromium-class); Firefox and WebKit get nightly smoke tests only and are best-effort", with open question G6 as the lever to upgrade that. On 2026-09-12 the project owner answered G6 with "We can ignore browser for now — the primary MVP is desktop." That answer is broader than the question: it does not choose browsers, it re-prioritises the product. The brief's item 2 still requires both a web UI and an Electron desktop app from **one** shared UI codebase, and the browser host is how that codebase is developed and how the component and web end-to-end suites run, so the answer cannot be implemented by deleting `apps/web`.

## Decision

The desktop application is Iridium's supported client at 1.0. The web host remains — built, served at `/app/*`, hardened under the nonce CSP, and covered by a merge-blocking `chromium` end-to-end lane and the Vitest Browser Mode component project — as a development and internal surface with no support commitment at 1.0; it runs in current Chrome and Edge. Firefox and WebKit are out of scope entirely: the `firefox-smoke` and `webkit-smoke` Playwright projects and the `nightly.yml › browser-smoke` job are removed, and their absence is asserted by `guards.non-goals.guard` (case *Cross-browser support*, non-goal id `cross-browser-support`). Where a spec §9 acceptance row is proven in both hosts, the Electron proof gates 1.0 and the browser proof is a development signal: `docs/acceptance-map.json` carries `gating: true` on that layer, rule 7 of `guards.acceptance-map.guard` requires the gating test to be selected by a merge-blocking lane, the Electron specs that discharge a row carry `@smoke`, and Concurrent editing, Viewer enforcement and Live revocation retire at M5 rather than M4. The single UI codebase, the `IridiumHost` seam, the three host implementations, `apps/web`'s place in the server image, every web-specific security control and the milestone order (M4 before M5) are unchanged.

**Assumption recorded with the decision.** The owner's answer named a priority, not a matrix. The plan reads it as a change of commitment rather than a deletion, for the two reasons above. If the owner meant that `apps/web` should not ship at all, that is a larger change and returns as a question.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Delete `apps/web` and the browser host | Contradicts brief item 2, removes the surface the component and web E2E suites run on, and would require re-building a browser host to develop the UI at all. It would also make the `IridiumHost` seam untestable against two real implementations, which is the mechanism that keeps one codebase honest. |
| Keep the Firefox and WebKit nightly smoke lanes as "free information" | A nightly lane nobody is accountable for is an implicit support claim and a source of failures that are triaged into silence. Out of scope means no lane, and the non-goal guard makes that checkable. |
| Keep retiring rows on the M4 browser proof and treat the desktop specs as renditions | Would let 1.0 be declared on evidence from a host the project does not support. The desktop host is also the one holding the session credential, so viewer enforcement, revocation and durability are exactly what has to be proven there. |
| Reorder the milestones so the desktop shell comes first | The shell mounts the shared UI bundle; there is nothing to wrap before M4 exists. Priority is not build order. |
| Demote the web `chromium` lane to nightly since the host is unsupported | It is how the shared UI is tested; demoting it would slow every UI regression's discovery to a day and would rot the very codebase the desktop client ships. |

## Consequences

Positive: the project's support claim is now true and testable; the acceptance rows are gated on the client people actually run; two CI lanes and a tag's second meaning disappear; the deployment documentation can answer "what do I install?" in one sentence. Negative: the merge-blocking `e2e-electron` job grows, because acceptance specs that used to be nightly now run on three operating systems per pull request — the answer to a critical-path problem is sharding the `electron` project, never demoting a gating proof; three spec §9 rows now retire one milestone later, which makes M4's exit record shorter and M5's longer; and the web host now ships with no support commitment, which must be stated plainly to operators rather than left to inference (`11-operations-and-deployment.md`, "Supported clients").

## Verification

`guards.non-goals.guard` (case *Cross-browser support*: exactly three Playwright projects, no Firefox/WebKit selector anywhere, no `browser-smoke` job, no `@smoke` tag under `apps/e2e/web/`); `guards.acceptance-map.guard` rule 7 (every gating proof selected by a merge-blocking lane); `desktop.three-instances.e2e`, `desktop.viewer-readonly.e2e`, `desktop.revocation-while-open.e2e`, `desktop.durable-save.e2e`, `desktop.hostile-markdown.e2e`, `desktop.open-note.e2e` (the gating proofs); `desktop.a11y-keyboard-only.e2e` (the accessibility commitment in the supported client); `ui.unsupported-browser.component` (the feature-floor page's copy); `host.contract.component`, `host.contract.e2e` and `desktop.host-contract.e2e` (unchanged — the one-codebase requirement is still proven in both hosts).

## References

Owner answer to open question G6, 2026-09-12; brief item 2; A55, A52, A53, A40; spec §10 (mobile clients). Implemented in `01-vision-scope-and-principles.md` §4.6, `07-client-applications.md` §9.3, `10-testing-and-quality.md`, `11-operations-and-deployment.md`, `12-milestones.md`.

---

Source: docs/plan/13-decision-log.md, decision AG6. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
