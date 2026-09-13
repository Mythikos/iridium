# S04 — `EditorView.cspNonce` under a strict style policy

## Question

Does CodeMirror 6 (`@codemirror/view` 6.43.11) with the `EditorView.cspNonce` facet, the
`y-codemirror.next` remote-selection theme, `rehype-highlight` classes and Base UI positioning run
with **zero** `securitypolicyviolation` events under `style-src 'self' 'nonce-<n>'` with no
`'unsafe-inline'`, in both hosts — the web host, where the nonce is the per-response nonce from
`@fastify/helmet`'s `enableCSPNonces`, and the Electron shell, where it is the per-load nonce from
`protocol.handle`?

## Why it blocks

Both hosts serve a per-load nonce CSP (07-client-applications.md §6.2 and §7.3). CodeMirror injects
`<style>` elements at runtime and Base UI positions floating elements through the CSSOM, so if the
nonce plumbing does not work the only other way to make the editor render is `'unsafe-inline'` in
`style-src` — which would undo the hostile-Markdown defence that `security.hostile-markdown` exists
to prove (R-T26). M4's web host CSP and M5's Electron per-load CSP are both written from this
answer, and `@iridium/editor`'s extension stack wires the facet from its first commit
(12-milestones.md §4.4, line for S4; §11 "CSP strictness versus CodeMirror and the positioning
library").

## Pinned versions

Every version below is the exact installed version resolved from the workspace catalog
(`pnpm-workspace.yaml`, `catalogMode: strict`, `saveExact: true`); the harness manifest declares
everything it imports as `catalog:`, so the spike pins no version of its own.

| Item | Version | Role in the spike |
|---|---|---|
| `@codemirror/view` | 6.43.11 | the `EditorView.cspNonce` facet; `updateAttrs`/`setAttrs` apply decoration attributes |
| `@codemirror/state` | 6.7.4 | single instance, shared with `y-codemirror.next` |
| `@codemirror/language` | 6.12.4 | `syntaxHighlighting(defaultHighlightStyle)` — a generated `StyleModule` |
| `@codemirror/commands` | 6.11.0 | `defaultKeymap`, `indentWithTab` |
| `@codemirror/search` | 6.7.2 | `search()`, `highlightSelectionMatches()` |
| `@codemirror/lang-markdown` | 6.5.2 | `markdown()` |
| `@codemirror/autocomplete` | 6.20.3 | transitive of `lang-markdown` |
| `style-mod` | 4.1.3 | transitive of `@codemirror/view`: the module that actually creates the `<style>` element and sets its `nonce` attribute |
| `y-codemirror.next` | 0.3.6 | `yCollab`, `yRemoteSelectionsTheme`, `yUndoManagerKeymap`, `YRemoteCaretWidget` |
| `yjs` | 13.6.32 | two in-memory `Y.Doc`s |
| `y-protocols` | 1.0.7 | `Awareness`, `encodeAwarenessUpdate`, `applyAwarenessUpdate` |
| `lib0` | 0.2.117 | `dom.element` / `dom.setAttributes`, used by the remote caret widget |
| `@base-ui/react` | 1.8.0 | `Popover`, `Tooltip`, `Dialog`, `Autocomplete`, `Select`, `CSPProvider` |
| `@base-ui/utils` | 0.4.0 | transitive |
| `react` / `react-dom` | 19.3.0 / 19.3.0 | hoists Base UI's `<style nonce precedence>` |
| `unified` | 11.0.5 | preview pipeline |
| `remark-parse` | 11.0.0 | preview pipeline |
| `remark-rehype` | 11.1.2 | preview pipeline (no `allowDangerousHtml`) |
| `rehype-highlight` | 7.0.2 | `hljs-*` classes |
| `lowlight` | 3.3.0 | transitive of `rehype-highlight` |
| `highlight.js` | 11.12.0 | `styles/github-dark.min.css`, served as a same-origin stylesheet |
| `hast-util-to-jsx-runtime` | 2.3.6 | hast → React, never an HTML string |
| `vite` | 8.3.0 | builds the one harness artefact (`target: chrome152`) |
| `@vitejs/plugin-react` | 6.1.1 | JSX transform |
| `vitest` | 5.0.0 | Browser Mode host |
| `@vitest/browser` | 5.0.0 | Browser Mode host |
| `@vitest/browser-playwright` | 5.0.0 | provider, `launchOptions.channel: 'chromium'` |
| `playwright` | 1.63.0 | chromium build `chromium-1243` → `HeadlessChrome/153.0.0.0` |
| `fastify` | 5.12.4 | web host serving the built page |
| `@fastify/helmet` | 13.1.1 | `enableCSPNonces: true`, the per-response nonce named by the pass criterion |
| `electron` | 44.3.0 | Chromium 152.0.7977.78, Node 24.20.0, `UA … Chrome/152.0.7977.78 Electron/44.3.0` |
| Node (harness) | 24.11.0 | `module.stripTypeScriptTypes` for the product main modules |
| `pnpm` | 12.4.1 | installed tree the harness resolves against |
| Host OS | Windows 11 10.0.26200 | one machine, 32 CPUs, real display |

## Method

One built artefact, three hosts. `spikes/s04-editor-csp/build.mjs` builds
`spikes/s04-editor-csp/src/` into `spikes/s04-editor-csp/dist/` (`base: './'`,
`cssCodeSplit: false`, `assetsInlineLimit: 0`, `minify: false`, `target: chrome152`) so that every
stylesheet arrives as a same-origin `<link>` and no host can accidentally differ in anything but how
it produces the CSP header and the nonce. The page carries the product's own nonce placeholder,
`__IRIDIUM_CSP_NONCE__` (`apps/desktop/src/main/csp.ts`, `packages/ui/vite.renderer.config.ts`), in a
`<meta name="csp-nonce">`, and feeds it to `EditorView.cspNonce.of(...)` and to Base UI's
`<CSPProvider nonce={...}>`. The harness is a leaf workspace (`@iridium/spike-s04-editor-csp`) tagged
`spike`, whose own manifest declares every package it imports as `catalog:` — so it resolves the same
installed copies the product resolves, and `turbo boundaries` lets nothing depend on it; the built
bundle contains exactly one `Y.Doc` class and one `@codemirror/state`.

`spikes/s04-editor-csp/src/collector.ts` is imported before every other module and records every
`securitypolicyviolation` event (capture phase, on `window`) with its `effectiveDirective`,
`blockedURI`, `sourceFile`, `lineNumber`, `originalPolicy` and the phase that was running. The page
then runs, in order: `mount` (React root, `EditorView` with the A41 extension order —
`Prec.high(keymap.of(yUndoManagerKeymap))`, line numbers, `drawSelection`,
`highlightSelectionMatches`, `search`, `syntaxHighlighting(defaultHighlightStyle)`, `markdown()`,
`yCollab(ytext, awareness, { undoManager })`, `defaultKeymap` + `indentWithTab`, and an
application-owned `EditorView.theme`) → `type` (the page sets `window.s04.awaitInput` and waits; the
host types **real trusted keystrokes**, then sets `window.s04.inputDone`; twelve further programmatic
transactions follow) → `remote-cursor` (a second `Y.Doc` and a second `Awareness`, relayed with
`encodeAwarenessUpdate`/`applyAwarenessUpdate`, publishing a `user` and a `cursor` spanning
characters 4–30, so both the remote selection marks and the remote caret widget render) → `preview`
(remark → rehype → `rehype-highlight` → `hast-util-to-jsx-runtime` → React) → `popover` (a real
click on `Popover.Trigger`) → `tooltip` → `palette` (`Dialog` + `Autocomplete`, six commands) →
`select` (`Select`, the one Base UI part that injects its own `<style>`) → `measure` (computed
styles, `<style>` elements and their `nonce` IDL values, every element carrying a `style` attribute
and how many declarations it actually parsed to). The report is published on `window.s04.report`.

Three controls run after the measurement, because "zero violations" is only evidence if the policy
is provably enforcing and the facet is provably load-bearing:

- **`control`** — a `<style>` element and a `setAttribute('style', …)` are added deliberately, with
  no nonce. Both must be refused.
- **`facet-with-nonce` / `facet-without-nonce`** — two identical editors in two same-origin
  `about:blank` iframes, which inherit the document's policy and give `style-mod` a fresh `Document`
  root each; one with `EditorView.cspNonce`, one without.
- **`remedy`** — the same stack with upstream's remote selections switched off and Iridium's own
  replacement in their place (see **Fallback executed**).

Hosts and commands (run from `spikes/s04-editor-csp` and `apps/desktop/spikes/s04`):

| Host | Command | How the header and nonce are produced |
|---|---|---|
| Vitest Browser Mode (chromium) | `pnpm run spike` (`node build.mjs`, then Vitest against the harness's own `vitest.config.ts`) | `csp-host.mjs`'s Vite plugin (`enforce: 'pre'`) serves `dist/` under `/s04` with a fresh 16-byte base64 nonce per response; the spec loads it in a same-origin iframe (so the Vitest tester document's own inline `<style>` reset is not counted) and types with `userEvent.keyboard`, which is Playwright's real keyboard |
| Fastify + helmet | `node run-fastify-host.mjs` | `fastify` 5.12.4 + `@fastify/helmet` 13.1.1 with `enableCSPNonces: true`; `reply.cspNonce.style` is substituted into the HTML; driven by `playwright` chromium |
| Electron shell | `node run.mjs` | the **product's own** `installAppProtocolHandler` and `packagedCsp` — `generate.mjs` copies `apps/desktop/src/main/{csp,scheme,web-preferences}.ts` with their types erased (`module.stripTypeScriptTypes`, whitespace-preserving, so line numbers still match the product source) and `main.mjs` mounts them with `rendererRoot` pointed at the spike's `dist/` and `isPackaged: true`; typed with `webContents.sendInputEvent` |

The Electron harness differs from `apps/desktop/src/main/main.ts` in exactly three harness-only ways:
`rendererRoot`, the explicit `isPackaged: true` (so the *packaged* policy is the one measured from an
unpackaged run), and `backgroundThrottling: false` plus
`--disable-features=CalculateNativeWinOcclusion`, `--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding` — without those, Chromium's Windows native occlusion detection
parks the harness window at `document.visibilityState === 'hidden'` and `requestAnimationFrame` never
fires, so CodeMirror never measures and no phase completes. Nothing under `apps/desktop/src` or
`packages/ui/src` was modified or is read at runtime by the product.

Outputs: `spikes/s04-editor-csp/report-vitest-browser.json`,
`spikes/s04-editor-csp/report-fastify-helmet.json`,
`apps/desktop/spikes/s04/report-electron.json`. The committed reproduction is
`spikes/s04-editor-csp/s04.csp.spec.ts`, which asserts the failure shape and the remedy and passes.

## Result

**fail.** All three hosts agree to the event: **exactly one** `securitypolicyviolation`, and it is
not CodeMirror's and not Base UI's.

| Measurement | Vitest Browser Mode (Chromium 153) | Fastify + helmet (Chromium 153) | Electron 44.3.0 (Chromium 152) |
|---|---|---|---|
| Policy actually received by the document (`originalPolicy`) | `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'; …` | `default-src 'none';script-src 'self' 'nonce-…';style-src 'self' 'nonce-…';…` | `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'; img-src 'self' data: blob: https: iridium-attachment:; font-src 'self'; connect-src 'none'; …` |
| Nonce source / length | Vite middleware, 24 chars (16 bytes base64) | `reply.cspNonce.style`, 32 chars (16 bytes hex) | `protocol.handle` → `randomBytes(16).toString('base64')`, 24 chars |
| Nonce differs between two loads of the same URL | yes | yes | yes |
| **Violations during the measured phases** | **1** | **1** | **1** |
| The one violation | `style-src-attr`, `blockedURI: inline`, phase `remote-cursor` | same | same |
| `<style>` elements at measurement | 2 (CodeMirror 116 rules, Base UI 2 rules) | 2 (116, 2) | 2 (116, 2) |
| Every `<style>` carries the page nonce and applied | yes / yes | yes / yes | yes / yes |
| Elements carrying a `style` attribute | 55 | 55 | 55 |
| …of those, refused (parsed to 0 declarations) | **1** (`span.cm-ySelectionCaret`) | 1 | 1 |
| Editor styling | `.cm-content` `white-space: pre`, font-family from the application theme, gutters `rgb(23, 23, 26)` | identical | identical |
| `rehype-highlight` | 11 `hljs-*` spans, 1 code block, **0** elements with a `style` attribute, keyword colour `rgb(255, 123, 114)` | identical | identical |
| Popover / tooltip / palette / select positioned | 324×127 / 170×39 / 115×144 (6 items) / 115×162 (6 items) | identical | 324×127 / 170×39 / 115×144 / 115×162 |
| Base UI `styleDisableScrollbar` `<style>` | nonce present, matches, applied | same | same |
| Real typed input observed; both docs converged | yes; yes (517 chars) | yes; yes | yes; yes |

What passes, measured rather than assumed:

- **`EditorView.cspNonce` works.** `style-mod` 4.1.3 sets the `nonce` attribute on the single
  `<style>` element it creates per `Document` root, and the facet's value reaches it: the element's
  `nonce` IDL value equals the page nonce, its sheet parses 116 rules, and the computed styles of
  `.cm-content` and `.cm-gutters` come from both CodeMirror's `baseTheme` and the application's own
  `EditorView.theme`. The A/B control is unambiguous — the same editor **without** the facet produces
  a `<style>` with no nonce, `element.sheet === null`, zero rules, a `style-src-elem` violation, and
  `.cm-content` falling back to `"Times New Roman"`.
- **Base UI 1.8.0 survives the policy.** Its positioners write through the CSSOM (9–12 parsed inline
  declarations each, correct geometry), and the one `<style>` it does inject
  (`styleDisableScrollbar`, used by `Select` and `ScrollArea`) carries the nonce supplied through
  `<CSPProvider nonce={…}>` and applies. No Base UI part needed an inline style *attribute*.
- **`rehype-highlight` is inert with respect to CSP.** The rendered preview contains zero elements
  with a `style` attribute; the colours come from the same-origin `highlight.js` stylesheet allowed
  by `style-src 'self'`.
- **The policy is enforcing.** The deliberate control both blocks a nonce-less `<style>`
  (`style-src-elem`) and blocks a `setAttribute('style', …)` (`style-src-attr`), in all three hosts.

What fails, and why:

`y-codemirror.next` 0.3.6 renders the remote caret with lib0's `dom.element`, which sets the
colour with `element.setAttribute('style', …)`
(`y-codemirror.next/src/y-remote-selections.js`, `YRemoteCaretWidget.toDOM`; `lib0/dom.js`,
`setAttributes`). A `style` **content attribute** is governed by `style-src-attr`, and **a nonce can
never whitelist an attribute** — nonces apply to elements only. With `style-src 'self' 'nonce-…'` and
no `style-src-attr` of its own, the attribute case falls back to `style-src`, finds no
`'unsafe-inline'`, and is refused. Chromium's message is explicit: *"Note that hashes do not apply to
event handlers, style attributes and javascript: navigations unless the `'unsafe-hashes'` keyword is
present. The action has been blocked."*

The functional consequence is silent, which is why it has to be recorded: the attribute stays in the
DOM (`background-color: #ee6352; border-color: #ee6352`) but parses to **zero** declarations
(`element.style.length === 0`), so `getComputedStyle(caret).backgroundColor` is
`rgba(0, 0, 0, 0)` and `borderLeftColor` is `rgb(0, 0, 0)`. The remote user's caret renders in
black-on-nothing instead of their presence colour, with no error surfaced to the user.

The neighbouring cases are fine, and the distinction is the whole finding: the *selection* marks use
the same colour string but arrive as a decoration attribute, and `@codemirror/view`'s `updateAttrs`
applies `style` with `dom.style.cssText = value` — a **CSSOM write**, which CSP does not govern at
all. Hence 55 elements with a `style` attribute in the measured DOM — 28 CodeMirror gutter elements, the
cursor and selection layers, the remote selection marks, and Base UI's positioners and
visually-hidden elements — and exactly one of them refused. CSP's inline-style directives cover the *attribute-setting* path only; `element.style.x = …`
and `element.style.cssText = …` are outside CSP in every host measured.

## Decision

The plan keeps `style-src 'self' 'nonce-…'` with no `'unsafe-inline'` in both hosts and wires
`EditorView.cspNonce` from `@iridium/editor`'s first commit — the facet is proven to work — and
`@iridium/editor` renders remote selections with its own CSSOM-only plugin instead of
`y-codemirror.next`'s, because that package's caret widget is the single thing the policy refuses.

## Fallback executed

The register's recorded fallback for S4 (build-time extraction of CodeMirror's generated theme rules
into a static stylesheet) does **not** apply: CodeMirror's generated `<style>` is accepted, so there
is nothing to extract. The clause that does apply is the second half of the same row — *"If a Base UI
part genuinely needs inline style attributes, `style-src-attr` is evaluated on its own and
`style-src-elem` is never relaxed"* — read for the part that actually needs one, which turned out to
be `y-codemirror.next` rather than Base UI. It is executed as a code change, not a policy change:
`style-src` gains nothing, and `'unsafe-inline'` appears nowhere.

The executed fallback is a three-line composition change plus one module:

```ts
// instead of yCollab(ytext, awareness, { undoManager })
yCollab(ytext, null, { undoManager }),          // sync + undo; a null awareness switches
                                               // upstream's yRemoteSelections off entirely
yRemoteSelectionsTheme,                         // unchanged: a baseTheme, no style attributes
iridiumRemoteSelections(ytext, awareness),      // Iridium's own plugin
```

`iridiumRemoteSelections` is a drop-in replacement built only from the package's public exports: the
same decorations, the same `cm-ySelection` / `cm-ySelectionCaret` / `cm-ySelectionCaretDot` /
`cm-ySelectionInfo` class names, the same awareness contract
(`{ user: { name, color, colorLight }, cursor: { anchor, head } }`) and the same local-cursor
publishing, differing in one place — the caret widget builds its element with `createElement` and
writes the colour through the CSSOM (`caret.style.backgroundColor = color`) instead of
`setAttribute('style', …)`. `ySync` never reads the awareness it is handed (`YSyncConfig` only stores
it), so passing `null` costs nothing.

The verified reference implementation is `spikes/s04-editor-csp/src/remote-selections.ts`, measured
in the `remedy` phase of the same page, under the same policy, in all three hosts: **zero
violations**, caret `background-color` and `border-color` computed as `rgb(238, 99, 82)` from 5 parsed
inline declarations, and the selection mark unchanged at `rgba(238, 99, 82, 0.2)`. Its destination in
the product is `packages/editor/src/remote-selections.ts`, composed as above in `@iridium/editor`'s
extension stack, which 12-milestones.md builds at M4; the composition rule is what this spike hands
forward, and `@iridium/editor` must never call `yCollab` with a non-null awareness.

Executed by commit 71915f5, the M0 milestone commit on `main`, which lands this note, the reference
implementation and the composition rule it hands forward.

## Follow-ups

- **Register row.** `docs/plan/12-milestones.md` §4.4 and `docs/plan/14-risks-and-open-questions.md`
  ("Spikes", and the S4 detail section) record a fallback aimed at CodeMirror's generated theme and
  at Base UI's inline style attributes. Both were measured clean; the failure is
  `y-codemirror.next`'s caret widget. Amend the S4 row's recorded fallback to the composition change
  above, so a later reader does not go looking for a stylesheet extraction that this spike showed is
  unnecessary.
- **Upstream.** File an issue against `y-codemirror.next` (0.3.6) with the reproduction: the caret
  widget cannot be used under a nonce-based `style-src`, and the one-line fix is a CSSOM write.
  `@codemirror/view` already does exactly that for decoration attributes, so the two halves of the
  same feature currently behave differently under CSP.
- **`@fastify/helmet` emits two nonces.** With `enableCSPNonces: true` the plugin puts a *different*
  nonce in `script-src` and in `style-src` and exposes both as `reply.cspNonce.script` /
  `reply.cspNonce.style`. The web host must substitute `reply.cspNonce.style` into
  `__IRIDIUM_CSP_NONCE__`; substituting `reply.cspNonce.script` would refuse every CodeMirror style
  with a policy that looks correct. Worth a server unit test when `apps/web`'s HTML route is written.
- **`@base-ui/react` needs `CSPProvider`.** `Select` and `ScrollArea` render
  `styleDisableScrollbar.getElement(nonce)`, a React 19 hoisted `<style nonce precedence>`; without
  `<CSPProvider nonce={…}>` at the root of `@iridium/ui` that element has no nonce and is refused
  (and `disableStyleElements` is the alternative, at the cost of the scrollbar rule). Wire the
  provider in `mountIridium` at M4 and cover it with a component test.
- **Shadow roots bypass the whole mechanism.** `style-mod` uses `adoptedStyleSheets` when the root is
  a `ShadowRoot` (`!root.head && root.adoptedStyleSheets`), and constructed stylesheets are not
  governed by CSP — so inside a shadow root `EditorView.cspNonce` has no effect and no nonce is
  needed. Recorded so that nobody "fixes" a future CSP problem by moving the editor into a shadow
  root and quietly loses the check.
- **CSSOM is outside CSP.** `style-src` / `style-src-attr` govern the `style` attribute's parsing
  only; `element.style.x = …` and `element.style.cssText = …` are never checked, in any of the three
  hosts. The hostile-Markdown defence must therefore keep resting on the sanitizer and on
  `hast-util-to-jsx-runtime` with `tableCellAlignToStyle: false` (A42) rather than on `style-src`;
  the useful thing `style-src` buys is that untrusted *markup* can never carry a `style` attribute.
  Consider stating `style-src-attr 'none'` explicitly in both policies once the fallback lands — the
  product then needs no inline style attribute at all, and the explicit directive makes a regression
  a diff rather than a behaviour change.
- **Windows occlusion stalls `requestAnimationFrame` in Electron.** With the harness window occluded,
  `document.visibilityState` is `hidden` and rAF never fires, so CodeMirror never measures and Base
  UI never positions. `apps/e2e`'s `electron` project will need the same
  `--disable-features=CalculateNativeWinOcclusion` (or an equivalent) for any test that depends on
  layout; record it when `desktop.launch.e2e` grows beyond the boot assertions.
- **Committed reproduction.** `spikes/s04-editor-csp/s04.csp.spec.ts` passes today and asserts the
  exact failure shape, the enforcing control, the facet A/B and the remedy. It lives in the throwaway
  harness; when `@iridium/editor` is built at M4, the assertions about the remedy belong in a
  component spec of that package, and the harness
  (`spikes/s04-editor-csp/`, `apps/desktop/spikes/s04/`, including the generated
  `apps/desktop/spikes/s04/generated/` copies) is deleted with it — the workspace entry and the
  `spike` tag go with it.
- **This section's pull-request reference.** Fill in the number of the pull request that lands this
  note, as `docs.spikes.spec` requires for a `fail` result.
