/**
 * The package's single typed error.
 *
 * Every guard and every total decoder in `@iridium/crdt` fails with a `CrdtError` carrying a
 * machine-readable `code`, so a call site branches on the reason instead of parsing a message.
 */
export type CrdtErrorCode =
  /** A carriage return reached note text; positions would desynchronise (y-codemirror.next #35). */
  | 'cr'
  /** A byte order mark reached note text; the content of record is BOM-free. */
  | 'bom'
  /** A `ContentFormat` (formatting attribute) or `ContentEmbed` reached the note's `Y.Text`. */
  | 'attributes'
  /** An encoded update above `LIMITS.YJS_UPDATE_MAX_BYTES`. */
  | 'update-too-large'
  /** A single insertion above `LIMITS.INSERT_CHUNK_MAX_BYTES` of UTF-8. */
  | 'insert-too-large'
  /** Bytes that are not a canonical `Y.encodeStateVector` output. */
  | 'malformed-state-vector'
  /** A `snapshot_format` value that is neither 1 (V1) nor 2 (V2). */
  | 'unknown-snapshot-format'
  /** A `Y.Text` that is not integrated into a `Y.Doc`, so no transaction can carry an origin. */
  | 'detached-text'
  /** An outer transaction would coalesce bounded insertions into one unbounded update. */
  | 'nested-transaction';

/**
 * A refusal from `@iridium/crdt`, carrying the `code` a call site branches on.
 *
 * The `code` is also the message prefix, so a log line or a stack trace identifies the invariant
 * without the reader holding this enum in their head. `name` is fixed rather than inherited so that
 * an error crossing a worker or a structured-clone boundary is still recognisable by name.
 */
export class CrdtError extends Error {
  override readonly name = 'CrdtError' as const;
  readonly code: CrdtErrorCode;

  constructor(code: CrdtErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.code = code;
  }
}
