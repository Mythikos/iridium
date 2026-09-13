# A40 — UI framework and state: React 19.3 + TanStack Router/Query + Zustand + Base UI/shadcn v4 + Tailwind 4

**Status:** Accepted (2026-09-11).

## Context

The brief requires **one** shared TypeScript UI that runs in a browser and inside a thin Electron shell — not two UIs. That single constraint disqualifies several otherwise reasonable choices, because the same router, the same storage access, and the same networking layer must work under `https://server` and under `app://iridium`. Digest §4.2 verified the relevant facts: React 19.3.0 (2026-09-09) adds stable `<ViewTransition>`, Fragment refs, and Trusted Types support with no breaking changes; React Router 8.3.1 is ESM-only and "deliberately boring" but TanStack Router 1.170.35 offers fully typed routes and search params with **explicit history types**, where `createMemoryHistory` is the documented choice for non-browser environments — exactly the Electron case; shadcn/ui made Base UI the default primitive library in July 2026 (`@base-ui/react` 1.8.0, MIT, monthly releases by the MUI team that built Radix) while Radix's cadence slowed; shadcn's own `Command` component still wraps `cmdk@1.1.1` (last published 2025-03-14), which **drags Radix into a Base UI application**, whereas Base UI's Autocomplete natively supports `inline` + `open`, a custom `filter`, grouped items, and virtualisation via `@tanstack/react-virtual`; `@headless-tree/core` + `/react` 1.7.0 is the official successor to react-complex-tree and virtualises 100k+ items with any virtualizer; `@dnd-kit/react` is still 0.5.0 pre-1.0 and legacy `@dnd-kit/core` was last published in 2024, while `@atlaskit/pragmatic-drag-and-drop` 3.1.0 is actively maintained and Apache-2.0.

## Decision

react 19.3.0 and react-dom 19.3.0 with `@vitejs/plugin-react` 6.1.1 and the React Compiler enabled; `@tanstack/react-router` 1.170.35 using `createBrowserHistory` on the web and `createMemoryHistory` in Electron, with typed routes `/login`, `/set-password`, `/` (vault selector), `/v/$vaultId?tab&mode&rev`, `/v/$vaultId/n/$noteId`, `/v/$vaultId/trash`, `/v/$vaultId/settings`, `/settings/{profile,sessions,integrations,appearance}`, `/admin/{users,vaults,tokens,audit,settings,releases,system}`, plus a `toShareUrl()` mapper; `@tanstack/react-query` 5.102.8 with keys `[origin, 'vault', vaultId, …]` invalidated by vault-channel events (A18); zustand 5.0.15 for workspace layout per profile and vault, persisted through `host.storage`; `@base-ui/react` 1.8.0 installed via shadcn 4.21.0 `-b base-ui`; tailwindcss 4.3.3; lucide-react 1.45.0; `@headless-tree/core` + `@headless-tree/react` 1.7.0 with `@tanstack/react-virtual` 3.14.12; `@atlaskit/pragmatic-drag-and-drop` 3.1.0; react-resizable-panels 4.12.4; `@tanstack/react-form` 1.33.5.

The command palette is built on a Base UI Dialog plus Autocomplete over `packages/ui/src/commands/registry.ts` (entries of `{id, title, defaultKeys, scope, when, run}`). That one registry also drives the CodeMirror keymaps, the Electron native menu, and the end-to-end tests, so a command exists in exactly one place.

Product grafts adopted: quick switcher (Mod-O by name, path, or alias; `Shift+Enter` creates), preview versus pinned tabs, `Ctrl+Tab` cycling, split right, the rename-impact dialog driven by `note_links`, backlinks and unresolved-link panes, hover page preview, `host.files.saveText` ("Export my text"), and presence colours from `users.color_hue`.

Performance budgets measured in CI (the table in `10-testing-and-quality.md` §"Client budgets" is authoritative for the values): note open under 300 ms for a 100 KB note, the 10 000-node tree scrolling at 55 fps or better, preview p95 under 100 ms for a 100 KB note, and a renderer bundle of at most 900 KB gzip in total with at most 350 KB gzip in the initial route chunk.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| React Router 8.3.1 | No typed routes or typed search params, and its history handling is browser-centric; TanStack's explicit `createMemoryHistory` is the documented pattern for the Electron renderer, and typed search params matter because `?tab&mode&rev` is real application state. |
| Radix primitives | Still supported by shadcn (`-b radix`) but on a slowed cadence under new maintenance; Base UI is shadcn's default as of July 2026 and is released monthly by the team that originally built Radix. |
| `cmdk` / `cmdk-base` for the palette | `cmdk@1.1.1` pulls four Radix packages into a Base UI application (two primitive libraries in one bundle); `cmdk-base@1.0.0` is a third-party fork. Base UI's Autocomplete covers the requirement natively, including virtualisation. |
| react-arborist 3.16.0 | Bundles its own virtualisation and drag-and-drop, which conflicts with the chosen virtualizer and DnD library; headless-tree leaves both to the application. |
| `@dnd-kit` (0.5.0 or legacy 6.3.1) | Pre-1.0 or unmaintained since 2024; pragmatic-drag-and-drop is maintained and framework-agnostic. |
| Redux Toolkit | Server state is TanStack Query's job and the remaining client state is small (layout, tabs, panes); Zustand is the right size for it. |
| Two separate UIs (web and desktop) | Explicitly forbidden by the brief; also doubles the surface for every authorization, editor, and preview behaviour. |

## Consequences

Positive: one UI codebase with one router, differing only in the injected history and the `IridiumHost` implementation (skeleton §B.3); typed routes make the deep-link contract (`iridium://open?server=&note=&rev=`) checkable at compile time; one command registry means the palette, keymaps, native menu, and E2E selectors cannot drift. Negative: TanStack Router's typed-route generation is a build step the CI must run (folded into `pnpm gen`, A3); Base UI is a 1.x library on a monthly cadence, so upgrades need review (Renovate plus the component test suite); the 900 KB gzip renderer budget constrains what may be added to the main bundle and forces the preview pipeline into a worker chunk (A42).

## Verification

`palette.registry.component` (every command has a unique id and a `when` guard; the Electron menu and CodeMirror keymap are generated from it); `gen.drift.guard` (the generated route tree compiles and `toShareUrl()` round-trips); component tests in Vitest Browser Mode with axe-core checks (A55); the client budgets of `perf.workspace.e2e` — note open under 300 ms for a 100 KB note, preview p95 under 100 ms, tree scroll at or above 55 fps on the 10 000-node fixture — plus the deterministic renderer-bundle gate (`scripts/check-bundle-budget.ts` against `bundle-budget.json`), which is the one client budget that blocks a pull request; Playwright web and Electron suites drive the same selectors from the command registry.

## References

Digest §4.2 (React 19.3, TanStack Router history types, Base UI/shadcn v4, cmdk's Radix dependency, headless-tree, pragmatic-drag-and-drop, library pins), §10.2 (product expectations); brief requirement 2; plan-risk-first ADR-19; plan-product-dx grafts. Implemented in `07-client-applications.md`.

---

Source: docs/plan/13-decision-log.md, decision A40. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
