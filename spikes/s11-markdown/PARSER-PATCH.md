# Pinned markdown-it parser entry

`patches/markdown-it@15.0.2.patch` exposes a token-only ESM entry while preserving
the upstream root API. It addresses a packaging cost in the executed A42 fallback:
Iridium needs Markdown tokens, while the ordinary entry imports an HTML renderer,
linkifier and URL recoder that the mdast adapter does not use.

The patch does not copy or change a grammar algorithm. The original inline and
block parsers and rule functions remain shared. The root constructor and token
engine share the same configuration, rule and parsing methods. The token core
registers the original CommonMark normalization, block, reference-stripping,
inline and text-joining rules and shares the original core executor. The root ESM
wrapper retains its full renderer, linkifier, URL handling and core registry;
CommonJS and the upstream browser distribution remain unchanged.

The additional `markdown-it/parser` entry accepts only the capabilities actually
implemented by the token engine. It refuses rendering, linkification and
typography options. Its declarations describe the real narrow engine and state
classes; the adapter does not cast a partial object to the full parser type.
Iridium's later transforms implement GFM literal autolinks, while the unchanged
sanitizer and resolver classify unsafe URLs. Source URL bytes remain available to
projection rather than being recoded by the renderer.

The exact upstream ESM input is pinned by SHA-256:

```text
499649c0b497ed031bf21b1f29e5a53b9a49101d6f432eb13e68050ba754f860
```

Regenerate only after reviewing the new upstream source:

```sh
pnpm exec node spikes/s11-markdown/make-parser-patch.mjs
pnpm install
pnpm install --frozen-lockfile
pnpm exec node spikes/s11-markdown/verify-parser-patch.mjs
pnpm --filter @iridium/markdown build
pnpm exec vitest --run --project unit packages/markdown
pnpm exec node spikes/s11-markdown/measure.mjs --only='^$' --label=patch-review --verify-bundle
```

After an intentional patch change, the first install updates its lockfile hash
before the frozen install is verified. The generator uses the lockfile-pinned
`npm:@typescript/typescript6@6.0.2` compiler API alias and diff 8.0.4 solely as
maintenance tools; neither is part of the browser payload. Regeneration with
these declared dependencies reproduced the original TypeScript 6.0.3-generated
patch byte for byte. The generator reverses the installed patch to recover its
input and verifies the upstream SHA-256, so it never relies on a leftover
unpatched virtual-store directory. Identical regeneration does not rewrite the
patch file or invalidate pnpm's dependency-verification cache. An input hash
mismatch fails closed on an upstream change.

The independent root-API oracle is the unchanged upstream CommonJS build: 1,971
render, inline, preset, linkifier, typography, URL and plugin cases. A further 657
cases compare token-engine tokens and environment values against the full engine
configured identically. The mdast differential suite, independent coordinate
properties, byte goldens and 1,464 emitted-browser preview comparisons cover the
consumer seam. All must pass after an upgrade, followed by a new complete payload
measurement with production targets and minifier options.

Remove this patch when upstream supplies an equivalent shared token-only entry,
or an equivalent unpatched entry passes those checks within the same complete
120,000-byte gzip budget. Do not remove grammars, defer required payload to another
chunk, weaken the sanitizer or silently change URL/source semantics to meet it.
No upstream issue or pull request has been filed in this task.
