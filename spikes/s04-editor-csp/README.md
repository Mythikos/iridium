# Spike S04 — `EditorView.cspNonce` under a strict style policy

The throwaway harness of spike S4: one built page that mounts CodeMirror 6 with the
`EditorView.cspNonce` facet, `y-codemirror.next`'s remote selections, a `rehype-highlight` preview
and five Base UI parts, records every `securitypolicyviolation` event per phase, and publishes a
JSON report on `window.s04.report`. Three hosts serve the _same_ artefact, so the only variable
between them is how the `Content-Security-Policy` header and the nonce are produced.

**This is spike code, not product code.** Per `docs/plan/12-milestones.md` D12-5 spike code never
becomes product code: this package is a leaf tagged `spike` in `turbo.json`, nothing may depend on
it, and it is deleted when `@iridium/editor` is built at M4. Its one output that does travel forward
is the composition rule recorded in the note, whose reference implementation is
`src/remote-selections.ts`. The Vitest Browser Mode page may be reused as an M1 demo (D12-6), which
is why the harness stays in the tree.

## Build and run

```sh
node build.mjs                 # the one artefact, into ./dist (base './', target chrome152)
pnpm run spike                 # host 1: builds, then Vitest Browser Mode (chromium)
node run-fastify-host.mjs      # host 2: fastify + @fastify/helmet enableCSPNonces, driven by playwright
node ../../apps/desktop/spikes/s04/run.mjs   # host 3: the Electron shell, product main modules
```

Host 1 and host 3 both need `./dist`, so run `node build.mjs` first. The reports land next to the
sources — `report-vitest-browser.json`, `report-fastify-helmet.json` — and the Electron host writes
`apps/desktop/spikes/s04/report-electron.json`.

`spike` is deliberately not named `test`: the repository-wide `turbo run test` must never launch a
browser for a throwaway harness.

## Verdict

`docs/spikes/S04-editor-csp-nonce.md` — result, measurements from all three hosts, the executed
fallback and the follow-ups.
