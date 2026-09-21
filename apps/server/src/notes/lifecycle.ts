/**
 * The closing set — the transient "a trash or purge of this note is being coordinated" marker
 * (05-collaboration-and-durability.md, "Trash"; 09-api-reference.md §2.7 and §3.6 `note-closing`).
 *
 * A note id enters the set **before** the structural transaction that trashes it opens and leaves it
 * in that function's `finally`, on success and on failure alike, so a refused trash never leaves a
 * note unopenable. While the id is in the set, `onAuthenticate` refuses new connections and
 * `beforeHandleMessage` refuses inbound frames with the transient `note-closing` (4404), which the
 * client re-attaches after a backoff; from COMMIT on, `nodes.deleted_at` is the authoritative
 * refusal. The trash flow itself is M2's (`tree/trash.ts`); M1 ships the set, the gateway methods over
 * it and the hooks that read it, so the coordination path exists from the first version that opens
 * a document.
 *
 * It is a class rather than a module-level `Set` because module-level mutable state would be shared
 * between two `buildApp()` calls in one process, which is what the `in-process` test mode does.
 */
import type { NoteId } from '@iridium/contracts';

/** The set. One per Fastify instance, owned by the collab gateway. */
export class ClosingSet {
  readonly #ids = new Map<NoteId, number>();

  /** Acquires one operation's mark; overlapping mutations retain independent ownership. */
  mark(noteId: NoteId): void {
    this.#ids.set(noteId, (this.#ids.get(noteId) ?? 0) + 1);
  }

  /** Whether a trash or purge of this note is being coordinated right now. */
  has(noteId: NoteId): boolean {
    return this.#ids.has(noteId);
  }

  /** Releases one matching mark. Each operation balances only the marks it acquired. */
  clear(noteId: NoteId): void {
    const owners = this.#ids.get(noteId) ?? 0;
    if (owners <= 1) this.#ids.delete(noteId);
    else this.#ids.set(noteId, owners - 1);
  }

  /** Ids currently closing, for assertions. */
  get size(): number {
    return this.#ids.size;
  }
}
