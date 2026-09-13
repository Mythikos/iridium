# A22 — Hostile CRDT content detection at compaction, flag, and repair CLI

**Status:** Accepted (2026-09-11).

## Context

The Y.Text of record must be LF-only and attribute-free: CodeMirror treats `\r\n` as one position while Y.Text counts two UTF-16 units (y-codemirror.next #35), and `Y.Text.toString()` silently drops `ContentFormat`/`ContentEmbed` items, so a client that inserts formatting attributes or `\r` makes projections diverge from the CRDT without any error (digest §1.2, §1.4). A hostile or buggy client can do either through the ordinary sync protocol; decoding every incoming update server-side to check would be expensive (§1.6).

## Decision

At every compaction (A16) the compactor verifies that `ytext.toDelta()` contains only `{insert: string}` entries (no `attributes`, no embeds) and that `markdown.includes('\r')` is false. On violation: `note_projections.status = 'invalid_content'`, `notes.content_invalid = 1`, stateless `{t:'content-invalid', reason:'cr'|'attributes'}` (the editor becomes read-only for that note), audit event `note.content.invalid`, metric and alert. Repair is explicit and audited: `iridium doctor --repair-content <note>` rewrites the Y.Text through a `DirectConnection` with origin `{source:'local', context:{reason:'repair'}}` — removing `\r` and re-inserting formatted spans as plain text — and writes `note.content.repaired`. Entry points normalise at the boundary (A45, F1): import, create, restore and repair enforce LF; the client strips `\r` on paste and blocks its insertion (A41).

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Decode and validate every incoming update in `beforeHandleMessage` | CPU cost per keystroke for every connection; the compaction-time scan catches the same conditions before any projection is published. |
| Silently strip attributes in the projection | Hides data loss; the CRDT would still carry content the text does not. |
| Automatic server-side repair without an operator | A repair is a content mutation; it must be deliberate and audited. |

## Consequences

Positive: cheap (one `toDelta()` per compaction), catches both the CRLF desync class and silently dropped formatting before search, MCP or export diverge; the note is quarantined rather than corrupted further. Negative: an affected note is read-only until an operator repairs it (a visible incident, by design); the scan is at compaction cadence, so a hostile client's damage can be live for up to `maxDebounce` before detection.

## Verification

`collab.content-invalid.chaos` (a `ws` test client inserts `\r` and a formatted span; asserts the flag, the stateless message, the audit row and the read-only state; then runs `doctor --repair-content` and asserts the projection matches); `collab.lf-invariant.guard` (guard test on all entry points); `markdown.roundtrip.prop` (A45).

## References

Digest §1.2 (`toString()` drops attributes; #35), §1.4, §1.6 (server-side enforcement cost); skeleton F1; gap fix "hostile CRDT content". Implemented in `05-collaboration-and-durability.md` and `11-operations-and-deployment.md` (CLI).

---

Source: docs/plan/13-decision-log.md, decision A22. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
