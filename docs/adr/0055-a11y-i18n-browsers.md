# A55 — Accessibility, internationalisation, and browser support

**Status:** Accepted (2026-09-11); **superseded in part by AG6 (2026-09-12)** (D13-14), the part being the supported-browsers clause. The accessibility and internationalisation clauses stand unchanged.

## Context

Enterprise procurement questionnaires ask about keyboard accessibility, WCAG conformance, and supported browsers, and none of the source plans except plan-product-dx addressed them. Deciding late is expensive: a tree, a tab strip, and a command palette that were not built keyboard-first cannot be retrofitted cheaply, and hard-coded English strings spread through every component. Digest §10.2 records that enterprise readiness checklists treat accessibility and browser-support statements as standard questionnaire items. Digest §4.2 also notes that the chosen primitives (Base UI, headless-tree with `hotkeysCoreFeature`, pragmatic-drag-and-drop with `keyboardDragAndDropFeature`) provide keyboard behaviour as a first-class feature rather than an add-on.

## Decision

Every tree node, tab, pane, dialog, and palette element is keyboard-reachable and operable, including drag-and-drop (headless-tree's keyboard drag feature). axe-core checks run inside the component tests (axe-core pinned at M0, A51). Themes are CSS-variable based — light, dark, and system, plus a high-contrast variant — and `prefers-reduced-motion` is respected. All user-visible strings live in `packages/ui/src/i18n/en.ts` with typed keys, so adding a locale is a new table and not a code sweep; no translation is shipped in the MVP. Supported browsers at MVP are current Chrome and Edge (Chromium-class); Firefox and WebKit get nightly smoke tests only and are best-effort. That is G6's default; if the user commits to Firefox and WebKit as supported targets, those lanes become PR-blocking and CodeMirror/WebSocket behaviour differences are fixed in M4.

> **Superseded in part by AG6 (2026-09-12).** The two closing sentences of the Decision above — the Chromium-class support statement and the clause that treats G6 as a lever — are the text as accepted and are kept as record (D13-2); they no longer describe the product. Since 2026-09-12 the desktop application is Iridium's supported client at 1.0, the web host is a development and internal surface running in current Chrome and Edge with no support commitment, and Firefox and WebKit are out of scope entirely: no lane, no best-effort claim, and no question left to answer. This marker covers the "Committing to Firefox and WebKit at 1.0 without lanes" row of the alternatives table below as well, whose reasoning rested on a nightly lane that no longer exists. The accessibility and internationalisation clauses of the Decision stand exactly as written.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Deferring accessibility to a post-MVP pass | Keyboard reachability is structural; retrofitting a virtualised tree and a tab strip costs more than building them correctly, and the chosen primitives already provide the behaviour. |
| Full WCAG 2.2 AA certification as an MVP gate | A formal audit is an external engagement; the plan commits to automated axe checks plus keyboard completeness, and states that clearly rather than implying certification. |
| Shipping localisation in the MVP | No target locale is known; the typed string table is the cheap seam that makes it additive later. |
| Hard-coding strings and extracting later | Guarantees a large mechanical change and missed strings; the table costs nothing now. |
| Committing to Firefox and WebKit at 1.0 without lanes | An unverified support claim; the nightly smoke lane makes the actual state visible and G6 is the lever to upgrade it. |

## Consequences

Positive: the plan can answer the standard questionnaire rows with named tests; a locale, a high-contrast theme, or a new browser lane are all additive; `prefers-reduced-motion` and the CSS-variable themes also serve the Electron renderer unchanged. Negative: axe-core checks add time to the component lane and will flag third-party primitive issues that must be triaged rather than ignored; Chromium-only support at MVP is a real limitation stated openly in `01-vision-scope-and-principles.md`; keyboard drag-and-drop for the tree is extra implementation surface (justified — it is also the accessible path for moving notes).

## Verification

`a11y.axe.component` (axe-core on the tree, tab strip, editor chrome, palette, dialogs, and admin tables); `a11y.keyboard-only.e2e` (create, rename, move, trash, and restore a note using only the keyboard, including a keyboard drag); `guards.i18n.guard` (a guard test asserting no literal user-visible strings outside `i18n/en.ts`); `ui.theme.component` (light, dark, system, and high-contrast render; reduced motion disables transitions); nightly cross-browser smoke (firefox, webkit) reported but non-blocking.

> **Superseded in part by AG6 (2026-09-12).** The nightly cross-browser smoke is gone: the `firefox-smoke` and `webkit-smoke` Playwright projects and the `nightly.yml › browser-smoke` job are deleted, and `guards.non-goals.guard` (case *Cross-browser support*) asserts their absence. The accessibility proofs above stand; the one that gates 1.0 is the supported client's, `desktop.a11y-keyboard-only.e2e`.

## References

Digest §10.2 (enterprise questionnaire expectations), §4.2 (primitive keyboard support); plan-product-dx graft; G6. Implemented in `07-client-applications.md` and `10-testing-and-quality.md`.

---

## Area 8 — Audit, backup, operations, and the threat model

---

Source: docs/plan/13-decision-log.md, decision A55. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
