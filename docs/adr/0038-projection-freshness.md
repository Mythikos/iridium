# A38 — Projection freshness and the search contract: bounded lag, human `flush`, rate-limited `?fresh=true`, explicit staleness

**Status:** Accepted (2026-09-11).

## Context

A37 reads committed projections, which trail the live document by the compaction debounce (A16: 2 000 ms debounce, 10 000 ms maximum). Three gaps existed across all four plans. First, **FULLTEXT visibility**: a search index built from projections can miss text that is already in the live document, and no plan said what the user or agent is told. Second, **title staleness after rename**: if a display title derived from the first H1 is stored, renaming a note leaves stale copies in the search index and in listings. Third, **snippets**: searching a plain-text projection finds matches whose positions do not correspond to Markdown source lines, so a `{line, text}` snippet built from the indexed text would point at the wrong place in the editor. Digest §11.27 also records four competing search-projection shapes that had to collapse into one (resolved in A39).

## Decision

Projections lag the live document by at most `maxDebounce`. Three freshness tools, each with an explicit cost:

- `GET /notes/:id/markdown?fresh=true` (requires `history:read`, limited to 6/min per principal per note, and a no-op when `projected_seq == head_seq`) runs the compaction job for a loaded document.
- `{t: 'flush'}` on the collaboration socket (A19) is the human path (Ctrl/Cmd+S), answered with `{t: 'projected', seq}` and the pill "Saved · up to date for agents".
- MCP has no freshness knob (A34); `instructions.md` states that `get_note` may return a newer `revision` than `search_notes` showed.

Staleness is signalled, never hidden: every search result carries `revision`, and the UI shows an "index updating" hint for open notes where `projected_seq < head_seq`.

Derived titles are **not stored**. `note_projections.heading_title` holds only the first H1 (NULL when the note has none). The display title is `COALESCE(heading_title, nodes.name)`, computed at read time. A structural rename updates `note_search.title` for that note inside the same transaction when `heading_title IS NULL`.

Snippets: FULLTEXT matches on `note_search.body_text` (plain text), but `{line, text}` snippets are located by a case-insensitive scan of `note_projections.markdown` source lines for the query terms (the first N matching lines), so the line numbers an agent or the UI receives refer to the **Markdown source** and can be used directly with `get_note({lines})` or to place a caret.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Unbounded or unauthenticated `?fresh=true` | Compaction is CPU- and write-amplifying; an automated caller could force it per request. The permission plus the 6/min cap plus the no-op fast path bound it. |
| Storing a derived display title (first H1) in `nodes` or `note_search` | Two sources of truth for the same string; renames and edits then need a fan-out, and any missed path shows a stale title (the exact gap this ADR closes). `COALESCE` at read time cannot go stale. |
| Building snippets from the plain-text projection | Line numbers would not map to the Markdown source, so "jump to match" and `get_note({lines})` would land in the wrong place. |
| Synchronous projection on every update | Makes every keystroke pay for a parse and destroys the durable-ack latency budget (A19). |
| Hiding staleness (always claiming fresh results) | Agents cannot reason about it, and the "index updating" case is real and bounded; stating it is strictly better than a silent lie. |
| Letting MCP force compaction | A CPU amplifier on an automated surface; the `revision` field plus the instructions text give agents what they actually need. |

## Consequences

Positive: a bounded, stated freshness contract that both humans and agents can rely on; no derived data can go stale because none is stored; snippet line numbers are directly actionable. Negative: a search immediately after a burst of typing can miss the newest words until the next compaction (mitigated by `flush`, by the "index updating" hint, and by the 10 s `maxDebounce` ceiling); the snippet scan reads `note_projections.markdown` for matched notes, which costs I/O proportional to the page size (bounded by the search limit of 100).

## Verification

`search.staleness-hint.integration` (results carry `revision`; an open note with `projected_seq < head_seq` is flagged); `content.fresh-flag.integration` (permission, 6/min limit, no-op fast path, and that it does compact a loaded document); `collab.flush.integration` (`flush` → `projected` with the expected seq); `projection.title-after-rename.integration` (rename updates `note_search.title` when `heading_title IS NULL`; display title follows `COALESCE`); `search.snippets.unit` (line numbers address Markdown source lines; verified by feeding them back into `readNoteMarkdown({lines})`); k6 SLO `projection_lag_ms p95 < 12 s`.

## References

Digest §7.5 (debounced projections in a worker pool; `pipeline_version`), §3.5 (MCP reads committed projections with `revision`), §11.27; spec §6, §7; plan-product-dx graft (`flush`); gap fixes (FULLTEXT visibility, title staleness, snippets). Implemented in `08-markdown-pipeline-import-export.md`, `05-collaboration-and-durability.md`, `09-api-reference.md`.

---

## Area 6 — Content pipeline, search, attachments, and portability

---

Source: docs/plan/13-decision-log.md, decision A38. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
