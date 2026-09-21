# A42 — Markdown preview and sanitisation pipeline: shared token-to-mdast parser, sanitize-last hast, workers

**Status:** Accepted (2026-09-11); amended 2026-09-20 after S11 executed the recorded markdown-it fallback. The original remark engine failed the representative preview criterion; the replacement passes the declared local gates. Actual pilot measurements remain unavailable.

## Context

One isomorphic pipeline must serve preview, projection, links and import findings without changing Markdown source. The original decision chose remark/micromark for mdast positions and a DOM-free hast sanitizer. S11 measured the complete production pipeline in real Node and Chromium workers, including highlighting, sanitization and the required result transfer. The original engine measured 115.1 ms browser preview p95 at the declared 64 KiB representative p95 size; duplicate-pass and transfer mitigations still measured 109.2 ms. Its 100 KiB Node projection p95 of 206.311 ms met the separate 400 ms target, but did not satisfy the preview switch criterion. The fallback therefore executed. The recorded workload is synthetic and explicitly pilot-representative; no actual pilot corpus was supplied.

The original rejection of markdown-it assumed its HTML renderer was the integration point. M2 instead consumes its token engine and maps tokens directly to mdast with UTF-16 source positions. No HTML reparse, DOM sanitizer or innerHTML sink is required. The same mdast tree continues to feed every projection and the existing hast pipeline.

## Decision

Keep one DOM-free, Node-free product package, `@iridium/markdown`, running in browser workers and a bounded Piscina 5.3.2 server pool. Normalize line endings and BOM metadata at ingestion; parsing, preview and projection preserve the resulting source string and never serialize Markdown.

The pipeline is admission prescan and source-preserving frontmatter masking → markdown-it 15.0.2 shared token engine → the position-aware adapter in `src/markdown-it/` → mdast with GFM tables, tasks, strikethrough (`singleTilde: false`), footnotes and the linear mdast autolink transform → remark-rehype 11.1.2 → Iridium id, position and link transforms → fixed-registry lowlight 3.3.0 highlighting with highlight.js 11.12.0 → **rehype-sanitize 6.0.0 last**. All 21 specified grammars remain registered; auto-detection is disabled and dataview/query/mermaid/math remain plain text. Raw HTML becomes literal text, never executable elements. The two MVP flavors have identical empty extension hooks.

The pinned `patches/markdown-it@15.0.2.patch` exposes a shared token-only entry, preserving upstream grammar sources and the original root API. It removes unused renderer, URL recoder and linkifier capabilities from the token entry dependency graph; it does not split required payload into uncounted chunks. The AST-based patch generator and upstream API/token differential checks live in the isolated S11 leaf (A2). Retire the patch when an equivalent upstream token entry passes the semantic matrix and complete-worker size gate.

`iridiumSanitizeSchema` retains the explicit tag, attribute and protocol policy, single `user-content-` prefix, position/link data attributes and highlight classes. It permits no inline style or event handlers. YAML uses yaml 2.9.1 core-schema parsing with bounded aliases and unique keys; the raw block is retained and never re-serialized. A future React renderer consumes sanitized hast with `tableCellAlignToStyle: false`; browser-only HTML export/print sinks apply their separate DOMPurify policy. No product preview path uses `dangerouslySetInnerHTML`.

Admission caps and worker termination remain mandatory: the browser deadline is 2 seconds and the server deadline is 10 seconds. The source remains available when derived work fails or is refused. `PIPELINE_VERSION` is **2**, because M1 already persisted version 1. Reindex advances the global marker only after the full rebuild completes; a boot write must never conceal unfinished work.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Keep remark/micromark after measured mitigations | The complete representative preview remained above 100 ms; favorable repeats did not supersede the retained failure. |
| Use markdown-it HTML output or maintain a second projection parser | Adds an HTML-string sink or a second semantic implementation. Direct token-to-mdast conversion preserves one tree and sanitizer. |
| Copy upstream grammar algorithms into Iridium | Creates a grammar fork and obscures upgrades. The packaging patch shares unchanged upstream rules and verifies the root API and token stream independently. |
| Remove required highlight grammars or hide chunks outside the size total | Changes the feature contract or misstates the payload. The final gate counts every emitted worker and broker script. |
| Safe Terser minification alone | The equivalent compact output still exceeded the 120,000-byte gate; final production measurement uses Vite/Oxc. |
| shiki or a DOM sanitizer as the primary boundary | Larger payload or browser-only capabilities and HTML sinks; sanitize-last hast already serves both worker environments. |
| Any AST-to-Markdown serializer, gray-matter, or parser on the main thread | Serializers rewrite source; gray-matter has unsuitable cache/coercion behavior; untrusted parsing must remain bounded in workers. |

## Consequences

One positioned mdast tree still serves all derived consumers, and sanitizer behavior and committed output goldens are preserved. The adapter and the narrow upstream packaging patch add explicit maintenance obligations, covered by independent differential checks. A new adversarial case, `**😀**m`, intentionally differs from remark: the fallback follows CommonMark Unicode code-point punctuation rules, leaving that input literal, whereas the old UTF-16 surrogate classification produced emphasis. This exception is recorded and independently tested; equivalence is not claimed for every conceivable input.

The final version-2 run measured preview round-trip p95 **28.8 ms** at 64 KiB, Node projection compute p95 **37.127 ms** at 100 KiB, prescan **389.371 MB/s**, and the complete browser payload **119,566 gzip bytes** (118,794 worker plus 772 broker). The complete curve, unsuccessful runs, stress cases, source provenance and environment are retained. The actual-pilot predicate remains unmeasured, and these local results alone do not establish a milestone exit.

## Verification

`markdown.commonmark.unit` covers all 652 CommonMark examples; `markdown.golden.unit` fixes mdast, hast, HTML and projection output; `markdown.offsets.prop` and `markdown.body-text-map.prop` verify source coordinates; `markdown.no-rewrite.prop` checks source preservation; `markdown.frontmatter.unit`, `markdown.xss-corpus.unit`, `markdown.sanitize.prop` and `markdown.pathological.unit` exercise frontmatter, hostile input and admission. `markdown.pipeline-version.guard` requires output-affecting changes to advance the persisted version, including the M1-to-M2 1→2 boundary.

The parser patch comparison passed 1,971 root API cases and 657 token/environment cases against the unchanged upstream entry. The final emitted Chromium payload passed 1,464 exact comparisons over 732 sources and both flavors. S11 used warmed real Piscina and Chromium module workers with the production payload and deadlines. The full protocol, samples, retained failures and bounded-sample interpretation are in [S11](../spikes/S11-markdown-engine-cost.md). Future Chromium component, web and Electron preview tests remain required by their owning milestones.

## References

Original digest §7.1–§7.5 and §11.9–§11.11; spec §3, §7, §8; `08-markdown-pipeline-import-export.md`; [S11 — Markdown engine cost](../spikes/S11-markdown-engine-cost.md); `spikes/s11-markdown/PARSER-PATCH.md`; CommonMark 0.31.2 Unicode punctuation rules.

---

Source: docs/plan/13-decision-log.md, decision A42. The decision log is authoritative; this file mirrors its current decision and measured amendment.
