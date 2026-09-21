/** Read-only retained-source scan executed by the shared bounded projection pool (03 §10.5). */
export interface AttachmentScanCandidate {
  readonly id: string;
  readonly pathHint: string;
}
/** One source chunk; null revision is a current projection. */
export interface AttachmentScanSource {
  readonly markdown: string;
  readonly revision: number | null;
}
/** A worker task is bounded in attachment count and source count by its database producer. */
export interface AttachmentScanTask {
  readonly candidates: readonly AttachmentScanCandidate[];
  readonly sources: readonly AttachmentScanSource[];
}
/** A file used anywhere in retained text cannot become a purge candidate. */
export interface AttachmentScanHit {
  readonly id: string;
  readonly revision: number | null;
}

function normalized(text: string): string {
  return text
    .replaceAll(/(?:%[\da-f]{2})+/gi, (encoded) => {
      try {
        return decodeURIComponent(encoded);
      } catch {
        return encoded;
      }
    })
    .normalize('NFC')
    .toLowerCase();
}

/**
 * Conservative basename matching also protects relative references after a note was moved or
 * renamed. The source path at each historical revision is not stored, so a basename false positive
 * must retain bytes; assuming the current note path could delete an old revision's image.
 */
export default function scanAttachmentReferences(
  task: AttachmentScanTask,
): readonly AttachmentScanHit[] {
  const sources = task.sources.map((source) => ({
    ...source,
    markdown: normalized(source.markdown),
  }));
  return task.candidates.flatMap((candidate) => {
    // Stored paths are literal names; decode only Markdown destinations. Decoding both sides
    // would miss a literal '%20' filename referenced as '%2520' in Markdown.
    const path = candidate.pathHint.normalize('NFC').toLowerCase();
    const basename = path.split('/').at(-1) ?? path;
    const matches = sources.filter(
      (source) => source.markdown.includes(path) || source.markdown.includes(basename),
    );
    if (matches.length === 0) return [];
    const revisions = matches.flatMap((source) =>
      source.revision === null ? [] : [source.revision],
    );
    return [{ id: candidate.id, revision: revisions.length === 0 ? null : Math.max(...revisions) }];
  });
}
