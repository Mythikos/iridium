# A43 — Obsidian syntax in the MVP: detect, report, and index; render as literal text; keep the seam ready

**Status:** Accepted (2026-09-11); **confirmed by the owner's answer to G2 on 2026-09-12** — no read-only rendering of Obsidian syntax at MVP. The Decision stands unchanged, and its closing clause changes meaning without changing wording: the renderer plugin seam ships as the first post-MVP flag *because that is now the decision*, not "unless G2 pulls it forward". Detect, report and index is the whole of the 1.0 commitment on Obsidian syntax.

## Context

Spec §3 says "Obsidian-specific syntax is addressed explicitly during import rather than assumed compatible"; spec §7 says wikilinks, transclusions, callouts, Dataview queries, canvas files, and plugin behaviour "are not presumed equivalent"; spec §10 defers "full Obsidian syntax compatibility". Against that, digest §11.12 records plan-product-dx's argument that wikilinks, callouts, `==highlights==` and `%%comments%%` must render read-only in the first release for the product to feel like an Obsidian successor. Digest §7.2 supplies the facts that make the difference concrete: `[[Note]]` whose inner text matches a reference definition is parsed by remark as text + `linkReference` + text, so detection must scan the **source string** with code spans masked by mdast positions rather than walking text nodes; Obsidian's "shortest path when possible" resolves an unqualified `[[Note]]` by unique basename anywhere in the vault, so an importer that only resolves relative paths reports false broken links; Obsidian's "Strict line breaks" is off by default, so single newlines render as `<br>` and importing with strict CommonMark silently reflows poems and address blocks; Obsidian task syntax treats any character in the brackets as done while GFM accepts only ` ` and `x`; and `remark-obsidian` 1.12.1 is **GPL-3.0**, unusable in a proprietary product (MIT/Apache alternatives exist: `remark-wiki-link` 2.0.1, `@flowershow/remark-wiki-link` 4.0.0, `remark-obsidian-callout` 1.5.1).

## Decision

Detect, report, and index now; render later. `detectObsidianSyntax()` produces import findings and per-note `obsidian_findings`. `note_links.kind ∈ {markdown, image, wikilink, embed, definition}` with `status ∈ {resolved, ambiguous, broken, external}` exists **from day one**, so backlinks, unresolved-link panes, and rename-impact warnings work over wikilinks even while wikilinks render as literal text. `vaults.markdown_flavor ENUM('gfm','obsidian-compat')`, `vaults.soft_breaks` (remark-breaks 4.0.0, preview only), and `vaults.attachment_folder` (read from `.obsidian/app.json` `attachmentFolderPath` at import) all exist now. The renderer plugin seam — `remarkWikiLink`, `remarkCallout`, `remarkHighlight`, `remarkComment`, written first-party and MIT-clean, with GPL `remark-obsidian` banned by the A52 license scan — is designed but **ships as the first post-MVP flag** unless G2 pulls it forward.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Render wikilinks, callouts, highlights, and comments read-only in the MVP (plan-product-dx D1) | Four new parsers plus sanitizer schema additions (`details`/`summary`, `mark`) plus basename resolution in the preview worker plus `[[` autocomplete, landing inside the kernel milestones. Spec §10's deferral stands; G2 is the explicit lever if the user wants it. |
| Adopting `remark-obsidian` | GPL-3.0; the license scan in A52 exists partly because of this package. |
| Skipping detection as well | The import report is the product's honesty mechanism (spec §7: "identify unsupported constructs before migration is accepted"), and `note_links` over wikilinks is what makes the rename-impact dialog useful on imported vaults. |
| Rewriting wikilinks into Markdown links at import | A silent content rewrite, forbidden by spec §7 ("Do not silently normalize or discard note content"). |
| Text-node scanning for detection | Misses `[[Note]]` forms that remark parses as `linkReference`, and mis-detects inside code spans; source scanning with mdast-position masking is the verified approach. |
| Defaulting soft breaks on for all vaults | Changes CommonMark semantics for non-imported vaults; it is a per-vault flag set at import and reported. |

## Consequences

Positive: the kernel milestones stay free of four new parsers; the data model needed for the eventual renderer (link kinds, statuses, flavour, soft breaks, attachment folder) exists from the first migration, so enabling rendering is a renderer change and not a migration; imported vaults get accurate compatibility reports immediately. Negative: an Obsidian user sees `[[Note]]` as literal text in the MVP, which is the most visible product gap and is called out in `01-vision-scope-and-principles.md` and in the import report; `note_links` carries wikilink rows whose targets the renderer does not yet link, so the backlinks pane can reference links the preview does not render (documented behaviour, and it is the correct data).

## Verification

`obsidian.detect.unit` (wikilink forms including `[[Note|alias]]`, `[[Note#Heading]]`, `[[Note#^blockid]]`, embeds with sizes, callouts with all documented type aliases, tags, block ids, highlights, comments, inline footnotes, math, and mermaid/dataview/dataviewjs/query fences; code-span masking; the `linkReference` case); `obsidian.basename-resolution.unit` (unique basename resolves, duplicates flag `ambiguous`); `transfer.fixtures.integration` (the `@iridium/testkit` Obsidian sample vault with `.obsidian/`, `.trash/`, `.canvas`, CRLF and BOM produces the expected report codes); `links.index.integration` (wikilink rows created with the right kind and status); the `static` job's license-scan step, `scripts/check-licenses.ts` (GPL denylist).

## References

Digest §7.2 (Obsidian syntax facts, GPL plugin, basename resolution, strict line breaks, task states), §7.5, §11.12; spec §3, §7, §10; judges 1, 2, 3; **G2, answered "no" on 2026-09-12**, confirming this ADR's stated default without changing it — `markdown.flavor-parity.unit` is what holds the seam inert for the whole of 1.0. Implemented in `08-markdown-pipeline-import-export.md` and `07-client-applications.md`.

---

Source: docs/plan/13-decision-log.md, decision A43. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
