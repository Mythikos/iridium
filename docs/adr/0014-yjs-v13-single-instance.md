# A14 — Yjs v13 stable set, one module instance, one first-party import point

**Status:** Accepted (2026-09-11).

## Context

The spec mandates Yjs (spec §5). The digest verified (§1.2) that the stable line is yjs 13.6.32 with y-protocols 1.0.7, lib0 0.2.117 and y-codemirror.next 0.3.6, that Hocuspocus 4.7.0 peers on `yjs ^13.6.8`, and that every Yjs v14 package (`@y/y` 14.0.0-rc.26, `@y/codemirror` 0.0.0-3, `@y/protocols` 1.0.6-rc.1, lib0 1.0.0-rc.32) is a pre-release whose v13↔v14 state and wire compatibility is undocumented (53-bit client IDs suggest a wire change; §11.17). The y-codemirror.next README tells users to stay on v13. Two copies of `yjs` (two versions, or ESM+CJS of one version) break `instanceof` checks and log `Yjs was already imported`; two copies of `@codemirror/state` throw `Unrecognized extension value`; a duplicated `@codemirror/view` makes the binding stop syncing silently (§1.2, §1.4).

## Decision

Exact pins in the pnpm catalog: yjs 13.6.32, y-protocols 1.0.7, lib0 0.2.117, y-codemirror.next 0.3.6, @hocuspocus/server, @hocuspocus/provider and @hocuspocus/common 4.7.0. Single-instance enforcement in four layers: (1) pnpm `overrides` plus catalog entries for `yjs`, `lib0`, `y-protocols`, `@codemirror/state`, `@codemirror/view`; (2) Vite `resolve.dedupe` for the same five packages in the shared browser config; (3) a CI step (`deps.single-instance.guard`) that runs `pnpm why` for each and fails on more than one resolved version, plus a bundle-analysis assertion that the renderer bundle contains one copy; (4) a server startup guard that fails the process if the `Yjs was already imported` console error fires during boot. `@iridium/crdt` is the **only** first-party package that imports `yjs` or `y-protocols`; it exports `createNoteDoc`, `getContent(doc)` (the single `Y.Text 'content'`), `loadState`/`encodeState` (the V1/V2 codec with branded `V1Update`/`V2State`/`StateVector` types), `dominates()`, `prefixSuffixDiff()`, `projectMarkdown()`, the LF/no-attributes guards and `initialNoteState(markdown)`. Server persistence, `@iridium/collab-client` and `@iridium/editor` consume it. The document model is one `Y.Doc` per note with the body in `doc.getText('content')`; no `Y.XmlFragment`, no formatting attributes, no embeds; note metadata lives in MySQL. Yjs v14 is a deliberate post-MVP evaluation gated on a v13↔v14 compatibility spike.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| `@y/y` 14 RC with `@y/codemirror` | Every package is a release candidate; the binding is at 0.0.0-3; v13↔v14 compatibility is undocumented; Hocuspocus and y-codemirror.next peer on v13. |
| Two isolation points (`@iridium/collab-client` for clients, `apps/server/src/collab/persistence` for the server), as in plan-risk-first ADR-01 | Two codecs and two places to migrate; the isomorphic `@iridium/crdt` package gives one codec, one set of branded types and one migration point. |
| Carets on the Yjs set | A lib0 1.0.0-rc could leak in through any transitive range and break the single-instance invariant. |
| `Y.XmlFragment` document model | y-codemirror.next binds only `Y.Text`; the spec forbids rich-text round-tripping (spec §3). |

## Consequences

Positive: `instanceof`-based failures are structurally impossible in a green build; a v14 migration touches one package plus a schema marker (`note_docs.yjs_major`); the codec's branded types make V1/V2 mixing (A15) a type error. Negative: the pins must be bumped deliberately (Renovate groups the five packages into one PR that must pass `deps.single-instance.guard`); the guard test is grep-based (`new Y.Doc(` only inside `@iridium/crdt`, `collab/persistence/initial-state.ts` and tests) because oxlint JS plugins are alpha (A1).

## Verification

`deps.single-instance.guard` (M0 exit, first step of the CI `static` job: one resolved version per package in `pnpm-lock.yaml`, and the built web and desktop bundles scanned for a second `Yjs was already imported` sentinel); a startup-guard unit test that fires the console error and asserts boot fails; `collab.initial-state-only-path.guard` and `collab.no-reinit.guard` (M1); `crdt.dominates.prop` and the codec property tests in `@iridium/crdt` (M0).

## References

Digest §1.1–§1.5, §2.2 (peer ranges), §11.17; plan-risk-first ADR-01; plan-agent-first ADR-25; plan-product-dx 006 (isolation in `@iridium/crdt`). Implemented in `02-system-architecture.md` and `05-collaboration-and-durability.md`.

---

Source: docs/plan/13-decision-log.md, decision A14. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
