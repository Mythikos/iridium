# A45 — Import and export: a two-phase import job, a streaming export job with a manifest and EOL/BOM restoration

**Status:** Accepted (2026-09-11).

## Context

Spec §7 requires importing a Markdown directory or ZIP as a new vault while preserving hierarchy and supported attachments, showing a report for filename collisions, unsafe paths, broken references, unsupported files, and Obsidian-specific features, and never silently normalising or discarding note content; and exporting a vault as a folder tree or ZIP of ordinary `.md` files plus attachments with a manifest of note ids, paths, and committed revisions, never overwriting an existing external directory without an explicit decision. Spec §9's "Portability and safety" row requires that Markdown, frontmatter, and code survive a round trip "without unintended changes". F1 explains the tension: the Y.Text of record is LF-only and BOM-free (CodeMirror treats `\r\n` as one position while Y.Text counts two — y-codemirror.next #35 — and micromark mis-offsets after a BOM), so byte fidelity is achieved by **recording** `original_eol` and `had_bom` and **restoring** them on export, not by storing the original bytes. Digest §11.9 records that one source plan wanted literal byte-exact storage instead. The other hazard is archive extraction: zip-slip via absolute paths, `..` segments, symlinks, NUL bytes, reserved Windows names, and over-long path segments.

## Decision

**Import** is a job with four explicit phases and a commit gate:

1. `POST /imports {target: {newVault: {name}} | {vaultId, parentNodeId}}` — `server:vaults:create` for a new vault, `import:commit` for an existing category (F8).
2. `PUT /imports/:id/upload` — a multipart stream of files from `<input webkitdirectory>` or a user-provided ZIP on the web; the Electron main process zips the chosen folder and uploads it. Caps: 2 GiB, 50 000 files, depth 64 (A.1); staged under `STAGING_DIR/<jobId>`.
3. `POST /imports/:id/scan` — a worker walks the staging area with yauzl streaming and zip-slip guards (absolute paths, `..`, symlinks, NUL, reserved names, segments over 255 bytes → `unsafe_path`; invalid UTF-8 → a finding), then runs `normalizeSource`, `parseNote`, `detectObsidianSyntax`, and `resolveLink`; collisions are detected case-insensitively under `utf8mb4_0900_as_ci`; `.obsidian/**`, `.trash/`, `.canvas`, and `.base` are listed and skipped. The result is a report JSON typed by `@iridium/contracts/import-report.ts` with the closed code set: `filename_collision`, `unsafe_path`, `invalid_utf8`, `broken_link`, `ambiguous_wikilink`, `unsupported_file`, `obsidian_config_skipped`, `obsidian_trash_skipped`, `canvas`, `bases`, `embed`, `block_ref`, `callout`, `tag_invalid`, `math`, `mermaid`, `dataview`, `dataviewjs`, `query_block`, `non_gfm_task_state`, `image_size_syntax`, `inline_footnote`, `deprecated_frontmatter_key`, `soft_break_reliance`, `bom_stripped`, `crlf_normalized`, `too_large`, `too_complex`.
4. `POST /imports/:id/commit {options: {collisions: 'suffix'|'skip'|'abort', softBreaks, attachmentFolder, markdownFlavor}}` — a new vault is created with `status='importing'` and is invisible until flipped to `active`; one transaction per note (node rows, `NoteService.initialize`, `note_revisions(kind='import')`, and the initial projection); attachments are de-duplicated by SHA-256 with `path_hint`; links are re-resolved after all notes exist; the job audits `import.committed` with the report hash. The job is idempotent and resumable. `POST /imports/:id/abort` deletes the staging directory.

**Export** is a job: `POST /vaults/:id/exports {format: 'zip', scope: {vault} | {nodeId}, restoreLineEndings: true, includeAttachments: true}` (requires `export:read`, is audited, and writes an `access_log` row per note). A worker flushes loaded documents, then streams a yazl ZIP built from `note_projections.markdown` at derived paths with EOL and BOM restored, attachments at their `path_hint`, a `manifest.json` (`{format: 'iridium-export/1', vault: {id, name, flavor}, exported_at, notes: [{note_id, path, revision, content_hash, updated_at}], attachments: [{attachment_id, path, sha256, size}], warnings: []}`), and a `README-IRIDIUM.md` listing unsupported constructs. No `.obsidian` directory is produced. `GET /exports/:id/download` expires after 24 h. The Electron main process streams to `showSaveDialog` and never overwrites a non-empty directory without explicit confirmation. A single-note export is just `GET /notes/:id/markdown`. An optional read-only mirror, `iridium mirror --vault --dir`, is driven by `projected_seq`, is never watched, and is never written back.

## Alternatives Considered

| Alternative | Why rejected |
|---|---|
| Client-side in-memory ZIP with fflate | Does not scale to a 2 GiB, 50 000-file vault, and puts archive parsing (the zip-slip surface) in the renderer. |
| Import as a new vault only (spec §7 literal) | Managers legitimately need to bring a folder into an existing vault; F8 documents the widening, gated on `import:commit`. |
| Committing into a visible vault and cleaning up on failure | A half-imported vault would be browsable, searchable, and MCP-readable mid-import; `status='importing'` makes it invisible until complete. |
| Byte-exact source storage (digest Topic 8, §11.9) | CRLF in Y.Text desynchronises CodeMirror positions (#35) and a BOM breaks micromark offsets and frontmatter detection; metadata-plus-restoration keeps the acceptance row true and is property-tested. |
| Silently normalising without reporting | Spec §7 forbids it; `bom_stripped` and `crlf_normalized` are report codes precisely so the change is visible. |
| Non-streaming ZIP handling (read the archive into memory) | A 2 GiB archive would exhaust the process; yauzl and yazl both stream. |
| A continuously synchronised filesystem mirror | Spec §6 allows only a read-only mirror; bidirectional sync is deferred by spec §10, and `iridium mirror` is explicitly one-way and never watched. |

## Consequences

Positive: half-imported vaults are never visible; the byte-exact round trip is proven by a property test rather than asserted; the report's closed code set is a typed contract the UI renders and tests assert; export manifests make an export verifiable and diffable. Negative: import is four HTTP steps plus a commit, which is more client work than a single upload (justified by the report gate, which is a product feature); staging storage must be provisioned and cleaned (`staging-data` volume, abort path, and a maintenance job); export reads projections, so it inherits A38's freshness contract and therefore flushes loaded documents first.

## Verification

`import.unsafe-paths.unit` (absolute paths, `..`, symlinks, NUL, reserved names, over-long segments each produce `unsafe_path` and extract nothing); `import.report.integration` (the Obsidian sample fixture yields the expected code set); `import.commit.integration` (a resumed commit does not duplicate notes, and an `importing` vault is absent from REST, search, and MCP); `markdown.roundtrip.prop` (`export(import(bytes)) === bytes` with CRLF, BOM, tabs, and frontmatter preserved — the "Portability and safety" acceptance row); `export.manifest.integration` (manifest schema and revision accuracy); `export.no-overwrite.e2e` (Electron refuses a non-empty directory without confirmation); `access-log.integration` (per-note export rows).

## References

Digest §7.2 (BOM and CRLF facts, Obsidian storage layout), §7.4, §7.5, §11.9; spec §7, §9, §10; plan-enterprise and plan-product-dx grafts; judge weakness fixes; F1, F8. Implemented in `08-markdown-pipeline-import-export.md` and `09-api-reference.md`.

---

## Area 7 — Client applications

---

Source: docs/plan/13-decision-log.md, decision A45. This file is a faithful copy of that entry's Status, Context, Decision, Alternatives considered, Consequences, Verification and References fields; the decision log remains the authoritative, continuously-maintained record (status supersessions are recorded there first).
