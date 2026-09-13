# A41 — Editor stack: CodeMirror 6 with y-codemirror.next and disposable views

**Status:** Accepted (2026-09-11); amended 2026-09-13 by spike S4 (`docs/spikes/S04-editor-csp-nonce.md`): `y-codemirror.next`'s remote-caret widget writes its colour as a `style` attribute and is the one component a nonce-based `style-src` refuses, so the extension order below calls `yCollab` with a **null** awareness — which switches upstream's `yRemoteSelections` off entirely — and renders remote selections from `packages/editor/src/remote-selections.ts`, a drop-in plugin with the same decorations, class names and awareness contract whose caret writes through the CSSOM. Everything else in this decision stands.

## Context

Spec §3 requires Markdown **source** editing with a separate rendered preview and explicitly rejects "a rich-text editor that repeatedly converts Markdown to an editor-specific document format and back"; spec §5 requires that undo and redo target the current user's operations. Digest §1.2 verified the binding facts: `y-codemirror.next` 0.3.6 provides `yCollab(ytext, awareness, {undoManager})` with remote cursors and a per-client `Y.UndoManager`, and CodeMirror's own `history()` must **not** be installed alongside it (it would undo remote changes); `yUndoManagerKeymap` must be given `Prec.high` so it wins over `defaultKeymap`; y-codemirror.next issue #36 records that rebuilding a view loses the caret unless it is restored from a relative position; and issue #35 is the CRLF desynchronisation that F1 and A22 address. Digest §4.2 adds that CodeMirror injects styles dynamically through style-mod, so a CSP without `style-src 'unsafe-inline'` requires the `EditorView.cspNonce` facet to carry the page nonce.

## Decision

Exact pins: `@codemirror/state` 6.7.4, `view` 6.43.11, `language` 6.12.4, `commands` 6.11.0, `search` 6.7.2, `autocomplete` 6.20.3, `lang-markdown` 6.5.2, `@lezer/markdown` 1.7.2, `@lezer/common` 1.5.2, `@lezer/highlight` 1.2.3, and `@codemirror/lang-yaml` (pinned at M0, for nested frontmatter highlighting).

Extension order is normative:

```
Prec.high(keymap.of(yUndoManagerKeymap)),
keymap.of(iridiumFormattingKeymap),
markdown({ base: commonmarkLanguage, extensions: [GFM, iridiumFrontmatter], codeLanguages, addKeymap: true, completeHTMLTags: false }),
yCollab(ytext, null, { undoManager }),              // sync + undo only; null awareness
yRemoteSelectionsTheme,                            //   switches upstream's carets off
iridiumRemoteSelections(ytext, provider.awareness), // Iridium's CSSOM caret (S4)
readOnlyCompartment,
keymap.of([...defaultKeymap, indentWithTab]),
search(), highlighting, theme        // EditorView.cspNonce from the page nonce
```

`history()` and `historyKeymap` are **never** installed. `NoteSession {ydoc, ytext, provider, undoManager (captureTimeout 500), lastSelection: YRange | null, saveState}` comes from `@iridium/collab-client` through `NoteSessionRegistry.acquire(noteId)` — one provider per note per window, `sessionAwareness: false`, released 60 s after the last tab closes. There is one `EditorView` per **visible** note; hidden views are destroyed and rebuilt from `ytext.toString()` with the caret restored from a stored relative position (issue #36). A paste guard caps insertions at 1 000 000 UTF-16 units and strips `\r` on paste. Formatting commands are `StateCommand`s implemented with `changeByRange` plus `syntaxTree`, tagged `input.format`: bold, italic, strikethrough, inline code, fenced code, link, headings 1–6, bullet/ordered/task list, toggle checkbox, blockquote, and table.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| A WYSIWYG editor over a document model (Tiptap/ProseMirror, Lexical) | Spec §3 rejects repeated conversion between Markdown and an editor document format; it would also make the Y.Text-of-record design impossible, since the CRDT would hold a rich-text model rather than the Markdown source. |
| CodeMirror's `history()` alongside `yCollab` | Undoes remote participants' edits, violating spec §5. |
| Keeping hidden `EditorState`s alive for every open tab | Memory grows with tab count and every hidden view keeps a live binding; destroying and rebuilding from `ytext` with a restored relative caret is exact and bounded. |
| One provider per tab (`sessionAwareness: true`, digest Topic 5) | Duplicate document names per window and duplicated traffic; the registry shares one provider per note per window (A25). |
| Absolute caret offsets across a rebuild | Remote edits shift absolute positions; a Yjs relative position is the correct anchor (issue #36). |
| Storing formatted spans or attributes in the Y.Text | A22 treats any delta with attributes or embeds as invalid content; the CRDT holds plain Markdown source only. |

## Consequences

Positive: undo and redo are per-client by construction; the source text is the single model, so no conversion can rewrite it; formatting commands operate on Markdown source and are therefore testable as pure state transformations; the CSP nonce keeps `style-src 'self'` intact, and after the 2026-09-13 amendment the editor owns its caret rendering, so an upstream change to that widget cannot reintroduce a style attribute. Negative: view rebuilds on tab switches must restore selection and scroll correctly, which is a named test rather than an assumption; `Prec.high` ordering and the absence of `history()` are easy to break during refactoring, so a guard test greps for `history(` in the editor package; formatting commands must handle every selection shape, which is where the property tests concentrate.

## Verification

`editor.undo-isolation.component` (client A's undo never reverts client B's edits, across a reconnect — which is also the behavioural proof that CodeMirror's own `history()` is absent; a `no-restricted-imports` rule in the `static` job keeps `history`/`historyKeymap` out of `packages/editor/**`); `editor.view-lifecycle.component` (hide and show a tab under concurrent remote edits; caret and scroll restored via the relative position); `editor.paste-guard.unit` (1 000 000-unit cap, `\r` stripped); `editor.formatting.prop` (every command on random selections produces valid Markdown and is idempotent where it should be); `editor.csp-nonce.e2e` (no `style-src 'unsafe-inline'` in web or Electron); `collab.lf-invariant.guard` (A51 guard test).

## References

Digest §1.2, §1.4 (binding pitfalls, issues #35 and #36), §4.2 (`EditorView.cspNonce`), §11.22; spec §3, §5; all four plans agree; F1. Implemented in `07-client-applications.md` and `05-collaboration-and-durability.md`.

---

Source: docs/plan/13-decision-log.md, decision A41. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
