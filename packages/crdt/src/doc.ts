/**
 * The note document model: one `Y.Doc` per note, one `Y.Text` under the fixed key `content`.
 *
 * 05-collaboration-and-durability.md, "Document model": never a `Y.XmlFragment`, never a `Y.Map` of
 * metadata (metadata lives in MySQL), never formatting attributes or embeds — `Y.Text.toString()`
 * drops `ContentFormat`/`ContentEmbed` silently, which would make projections, search and export
 * diverge from the CRDT.
 */
import * as Y from 'yjs';

/** The single `Y.Text` key of a note document. */
export const CONTENT_KEY = 'content' as const;

/** Transaction origin used while applying persisted state; the writer never persists it again. */
export const LOAD_ORIGIN: unique symbol = Symbol('iridium.crdt.load');

/** Transaction origin used inside `initialNoteState()`, on a throwaway document. */
export const INIT_ORIGIN: { readonly source: 'init' } = { source: 'init' };

/** What `createNoteDoc` accepts. */
export interface CreateNoteDocOptions {
  /**
   * Garbage collection, `true` by default. Deleted content becomes GC structs, which keeps
   * snapshots small; history is therefore never based on `Y.snapshot` (which requires `gc: false`)
   * but on `note_revisions` Markdown checkpoints.
   */
  readonly gc?: boolean;
}

/**
 * Create a note document: exactly one of these exists per note, and this is the only constructor.
 *
 * `collab.initial-state-only-path.guard` greps for `new Y.Doc(` and fails outside this package, the
 * server's initial-state module and test files, so a second construction path cannot appear by
 * accident — a note whose document is rebuilt from text has a disjoint identity set and concatenates
 * on merge instead of converging (see `initialNoteState`).
 */
export function createNoteDoc(opts?: CreateNoteDocOptions): Y.Doc {
  return new Y.Doc({ gc: opts?.gc ?? true });
}

/** The note body. The only `Y.Text` a note document ever has. */
export function getContent(doc: Y.Doc): Y.Text {
  return doc.getText(CONTENT_KEY);
}

/**
 * The Markdown projection of a note document: Markdown is a projection *out of* the CRDT, never a
 * source that is rebuilt back into one.
 *
 * This is the only place the package reads a `Y.Text` back as a string, which is why the one
 * suppression below is here and nowhere else: yjs 13.6.32 ships no `toString(): string` declaration
 * for `Y.Text` (its generated `.d.ts` declares only `toJSON()`), so the type checker sees
 * `Object.prototype.toString` and the rule reports the `[object Object]` it would produce. The
 * runtime method returns the unformatted text, and `toJSON()` is implemented as `this.toString()`.
 */
export function projectMarkdown(doc: Y.Doc): string {
  // oxlint-disable-next-line typescript/no-base-to-string -- see above: a yjs typings gap.
  return getContent(doc).toString();
}
