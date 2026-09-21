/**
 * @iridium/markdown — the isomorphic unified pipeline (normalizeSource, restoreSource, parseNote, toPreviewTree, project, detectObsidianSyntax, resolveLink, sanitize schema)
 *
 * Pure worker entry points preserve source and return structured-cloneable trees and projections.
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
export { restoreSource } from './restore.ts';
export { prescan, type PrescanResult, type PrescanDetail } from './prescan.ts';
export { parseNote } from './parse.ts';
export { project, emptyProjection, ProjectionSourceMismatchError } from './project.ts';
export { toPreviewTree } from './preview.ts';
export { createProcessor, type MarkdownProcessor, type ProcessorOptions } from './processor.ts';
export { renderHtml } from './html.ts';
export { gfmFlavor, obsidianCompatFlavor, type FlavorPlugin } from './flavors.ts';
export {
  iridiumSanitizeSchema,
  mergeSanitizeSchema,
  UnsafeSanitizeExtensionError,
  PREVIEW_DATA_ATTRIBUTES,
} from './sanitize/schema.ts';
export { toBodyText, sourceOffsetOf, lineOf, lineStartsOf } from './body-text.ts';
export { detectObsidianSyntax } from './obsidian/detect.ts';
export { parseWikilinkTarget } from './obsidian/wikilink.ts';
export { OBSIDIAN_CATALOGUE } from './obsidian/catalogue.ts';
export { collectLinks } from './links/collect.ts';
export {
  createVaultIndex,
  resolveLink,
  linkResolutionSteps,
  normalizeLinkTarget,
  foldLinkPath,
  encodeAttachmentReference,
  type NoteContext,
  type VaultIndex,
  type LinkLookup,
  type VaultIndexSnapshot,
  type ResolvedLink,
  type NormalizedTarget,
} from './links/resolve.ts';
export type {
  ParsedNote,
  ParseOptions,
  NoteProjection,
  ProjectionTask,
  ProjectOptions,
  PreviewContext,
  PreviewTree,
  PreviewBlock,
  Heading,
  RawLink,
  TextRun,
  BodyTextResult,
  ObsidianFinding,
  ObsidianFindings,
  DetectContext,
  MarkdownFlavor,
  Frontmatter,
  FrontmatterDiagnostic,
} from './types.ts';
