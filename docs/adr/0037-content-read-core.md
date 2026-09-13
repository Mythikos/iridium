# A37 — One read model for humans and agents: `ContentReadCore` over committed projections

**Status:** Accepted (2026-09-11).

## Context

Spec §7 requires that "search and export use the same access rules as the application", and spec §4 requires enforcement on REST, collaboration, attachments, search, history, and exports. The failure mode to avoid is three read paths — one for the UI, one for REST, one for MCP — that slowly diverge in what text they return, what authorization they apply, and what revision they claim. Spec §6 also settles where text comes from: the persisted Yjs state is authoritative and Markdown is "the readable text within that state", with cached text recording its source revision and never overwriting newer state.

## Decision

One module, `apps/server/src/content/read/*`, exporting `listVaults(p)`, `listNodes(p, vaultId, {pathPrefix, kinds, recursive, includeTrashed, cursor, limit})`, `resolveNote(p, {noteId} | {vaultId, path})`, `readNoteMarkdown(p, noteId, {revision?, lines?, heading?})`, `listRevisions`, `search(p, …)`, and `listAttachments(p, vaultId, noteId?)`. `authorize()` (A30) runs **inside every method**, not in the callers. The REST read routes, the MCP tools (A34), and the UI reads all consume it; none of them ever touches the live `Y.Doc`. Every read carries `revision` (the projected seq) and `content_hash`. REST sets `ETag: "<revision>:<hash>"` and honours `If-None-Match` with a 304. `GET /notes/:id/markdown` returns `text/markdown`.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| A separate query path per surface | Guarantees divergence in text, authorization, and revision semantics; the spec's "same access rules" requirement would become a review promise instead of a type. |
| Reading the live `Y.Doc` for "freshness" | Returns uncommitted state, so an agent could read text the server has not durably persisted — contradicting the Saved definition (F2) and spec §6's "must not overwrite newer state" discipline. It also forces every reader to load documents into memory (A50's budget). |
| Rendering Markdown from the Yjs state on demand per read | Duplicates the compaction work on the request path; `note_projections.markdown` already exists and records its revision. |
| Authorization in the route layer only | MCP tools and UI reads would each need their own correct copy; putting it inside the methods makes omission impossible. |

## Consequences

Positive: byte-identical text under identical authorization across REST, MCP, and export, which is a property test rather than an aspiration; `ETag`/`If-None-Match` gives agents and browsers cheap revalidation; one place to optimise (and one place to cache) for all read traffic. Negative: reads are as fresh as the projection, which is bounded but not instantaneous — A38 defines exactly how fresh and how that is signalled; `ContentReadCore` becomes a wide interface that every read surface depends on, so changes to it are contract changes (A3 regenerates the OpenAPI and MCP schemas).

## Verification

`content.read-parity.integration` (REST, MCP, and export return byte-identical Markdown and the same `revision`/`content_hash` for the same note and token); `authz.read-core.unit` (every method denies for non-members with `not_found` and for members lacking the permission with `forbidden`); `content.etag.integration` (`If-None-Match` → 304; `ETag` changes exactly when the revision or hash changes); `content.lines-and-heading.unit` (selection semantics and line numbering against the Markdown source).

## References

Digest §3.5 (MCP reads the committed projection; same ACL filter for UI and agent search), §7.5; spec §4, §6, §7, §9; plan-agent-first graft; judges 2, 3. Implemented in `06-mcp-and-agent-access.md`, `08-markdown-pipeline-import-export.md`, `09-api-reference.md`.

---

Source: docs/plan/13-decision-log.md, decision A37. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
