# A34 — MCP tools and resources: six read-only tools over `ContentReadCore`, a note template, and a per-vault index resource

**Status:** Accepted (2026-09-11).

## Context

Digest §3.2 verifies the constraints that shape a tool surface: client tool caps are shared across all configured servers (Cursor ~40 active tools, Windsurf 100, VS Code 128 per request); Claude Code truncates tool descriptions and server instructions at 2 KB, warns at 10 000 output tokens, and persists results above 25 000 tokens to a file; tool names SHOULD be 1–128 characters from `[A-Za-z0-9_.-]` and `tools/list` SHOULD be deterministically ordered; declaring an `outputSchema` makes the SDK throw `InvalidParams` if a handler omits `structuredContent`, and the specification SHOULD also return the serialized JSON as a text block; `McpServer`'s high-level `resources/list` **ignores `request.params.cursor`** and merges every template's full `list()` result, so enumerating notes as resources would blow up large vaults and `@`-mention autocomplete menus; a resource-not-found MUST be `-32602` with `data.uri`, never an empty `contents` array; and `Mcp-Name` mirrors `params.uri`, so non-ASCII resource URIs arrive base64-sentinel encoded — which is why note URIs must use IDs, not titles. Anthropic's own tool-writing guidance (digest §3.2) argues for fewer, consolidated tools. Digest §11.16 records the disagreement on tool names and on whether templates register a `list` callback.

## Decision

Six read-only tools, snake_case, registered in a deterministic order, each with `title`, `outputSchema`, `structuredContent`, a description ≤ 2 KB, names and parameters within `[A-Za-z0-9_.-]`, and `annotations {readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false}`:

| Tool | Purpose |
|---|---|
| `list_vaults` | Vaults this token may read, with each vault's `ai_guidance` appended. |
| `list_notes` | Enumerate nodes by `path_prefix`, `kinds`, `recursive`, `include_trashed`, with cursor paging. |
| `get_note` | Markdown by `note_id` or `{vault_id, path}`, with `revision`, `lines`, or `heading` selection. |
| `search_notes` | Full-text search within accessible vaults, returning snippets with line numbers. |
| `list_note_revisions` | Revision history for a note. |
| `list_attachments` | Attachment **metadata only**. |

`get_note` returns the Markdown as the text block and **metadata-only** `structuredContent` — a documented deviation from the specification's SHOULD (F7), because duplicating the body doubles token cost. Not-found and forbidden return the **same** `isError` text: "No note with that id or path is available to this token." Resources: `ResourceTemplate('iridium://vault/{vault_id}/note/{note_id}', {list: undefined, complete: {vault_id, note_id (title prefix, ≤ 20 results)}})` with mimeType `text/markdown`, where `?rev=<seq>` pins a revision; plus a static `iridium://vault/{vault_id}` Markdown index (top-level categories and the 50 most recently updated notes, capped at 2 000 entries, with the footer "use list_notes"). A resource not found is `-32602` with `data.uri`. List and search results include `resource_link` blocks. There is **no `fresh` flag on MCP**. `access_log.note_ids JSON` records every note id returned by every call. Tools live in `apps/server/src/mcp/tools/*`, are implemented over `ContentReadCore` (A37), and are unit-tested over an in-memory repository.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| A `get_vault_tree` tool (plan-risk-first, plan-enterprise) | Fully covered by `list_notes(path_prefix, kinds, recursive)`; a seventh tool spends a scarce client tool slot on a narrower view of the same data. |
| A resources-first surface (notes as enumerable resources) | `McpServer`'s `resources/list` ignores cursors and merges every template `list()`, so a 20 000-note vault produces one unbounded response and an unusable autocomplete menu; the Messages API connector supports only tools. |
| Registering the note template **with** a `list` callback (digest Topics 5, 10) | Same unbounded enumeration; `list: undefined` plus completions gives `@`-mention ergonomics without it. |
| Duplicating the note body in `structuredContent` (the spec SHOULD) | Doubles token cost on the single most-called tool; F7 documents the deviation. |
| Distinct error text for forbidden versus missing | Confirms existence to a token that guessed an id, failing the "Vault isolation" acceptance row (A30, F13). |
| An MCP `fresh: true` knob (compaction on demand) | A CPU amplifier reachable by an automated caller; humans get `flush` (A19) and REST gets a rate-limited `?fresh=true` (A38), while MCP instructions state that `get_note` may return a newer `revision` than `search_notes` showed. |
| Attachment bytes over MCP | Binary blobs blow the token budget and the MVP is read-only metadata; deferred with the write-scope work. |

## Consequences

Positive: six tools fit comfortably inside every client's cap and leave room for other servers; the surface is token-economical; identical not-found and forbidden responses close the ID-probing vector; `resource_link` blocks let agents pivot from a search hit into a resource read without a second tool call. Negative: no note enumeration through `resources/list`, so `@`-mention discovery relies on completions plus the per-vault index resource (documented in `instructions.md`); agents must learn the `search_notes → get_note` workflow, which is why it is stated explicitly in the instructions; annotations are advisory, so `readOnlyHint` does not guarantee auto-approval in any client (digest §3.4) and the plan promises no frictionless approval UX.

## Verification

`mcp.tools-schema.contract` (deterministic `tools/list` order, name and parameter character set, description size, `outputSchema` conformance on every tool, and the live `tools/list` equal to `packages/contracts/mcp/tools.schema.json`, A3); `mcp.tools.unit` (all six tools over an in-memory `ContentReadCore`: every authorization branch, the Markdown text block, metadata-only `structuredContent`, and `lines`/`heading`/`revision` selection); `mcp.error-texts.unit` (not-found and forbidden share one byte-identical text); `mcp.resources.mcp` (template completions, `?rev=` pinning, `-32602` with `data.uri`, index resource caps); `access-log.integration` (note ids recorded).

## References

Digest §3.2 (client caps, tool spec, `resources/list` pagination, Anthropic tool guidance, Obsidian/Notion MCP conventions), §3.4, §3.5, §11.16; spec §7; plan-risk-first ADR-13; judges; F7, F13, F14. Implemented in `06-mcp-and-agent-access.md` and `09-api-reference.md` (§D.3).

---

Source: docs/plan/13-decision-log.md, decision A34. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
