/**
 * `contentHash` — `SHA-256(markdown)` over the LF-normalised text, the one definition behind
 * `note_projections.content_hash`, `note_revisions.content_hash`, the checkpoint policy's comparison
 * and the `markdownEtag(revision, hash)` validator (03-data-model.md §8.7, §9.3).
 *
 * One function, so the compactor, the initialiser and every reader hash the same bytes the same way;
 * the hex form exists because the ETag and the export manifest publish it as text.
 */
import { createHash } from 'node:crypto';

/** The 32 raw bytes, for a `BINARY(32)` column. */
export function contentHash(markdown: string): Buffer {
  return createHash('sha256').update(markdown, 'utf8').digest();
}

/** The lowercase hex of a stored hash, as `markdownEtag` takes it. */
export function contentHashHex(hash: Uint8Array): string {
  return Buffer.from(hash).toString('hex');
}
