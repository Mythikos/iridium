/**
 * @iridium/markdown — the isomorphic unified pipeline (normalizeSource, restoreSource, parseNote, toPreviewTree, project, detectObsidianSyntax, resolveLink, sanitize schema)
 *
 * What exists at M1 is the entry of the pipeline — `normalizeSource` and `detectEol`, the one
 * normalisation of note text (08-markdown-pipeline-import-export.md §4) — and `PIPELINE_VERSION`,
 * the value the projection writer records. The parser, the preview tree, the projection and
 * `restoreSource` arrive with the package work item of 12-milestones.md (M2 and the transfer
 * milestone); the header's list is the package's contract and stays as it is.
 */
export {
  InvalidUtf8Error,
  detectEol,
  normalizeSource,
  type Eol,
  type NormalizeOptions,
  type NormalizeWarning,
  type NormalizeWarningCode,
  type NormalizedSource,
  type SourceEncoding,
} from './normalize.ts';
export { PIPELINE_VERSION } from './version.ts';
