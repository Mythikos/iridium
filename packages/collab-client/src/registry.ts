/**
 * `NoteSessionRegistry` — one session per note per client
 * (07-client-applications.md section 5.2 and section 4.5, D07-15, A41; 12-milestones.md section 5.2).
 *
 * Two tabs on the same note, or two panes in a split, share one `Y.Doc`, one provider and one
 * awareness state: a second attachment for the same document name would be refused by the shared
 * socket, and two awareness owners would fight over the caret field on every keystroke. The registry
 * is therefore a reference count, not a cache.
 *
 * Closing the last tab does **not** dispose the session immediately. A tab close followed by a
 * reopen is a routine gesture, and disposing on the spot would throw away pending local text that
 * the writer has not acknowledged; the session is released after `SESSION_RELEASE_DELAY_MS` instead,
 * which is the window A41 fixes.
 *
 * The registry deliberately owns no socket, no ticket source and no dormancy policy: it is handed a
 * factory, so the host decides how a session is built, and the workspace's live-session ceiling
 * (D07-15) is a workspace policy over `size` rather than a rule hidden in here.
 */

import { type CollabClock, type CollabTimer, systemCollabClock } from './clock.ts';
import type { NoteSession } from './note-session.ts';

/** How long a note with no tabs keeps its session, so closing and reopening loses nothing (A41). */
const SESSION_RELEASE_DELAY_MS = 60_000;

/** What the registry needs. */
export interface NoteSessionRegistryOptions {
  /** Builds a session for one note. The host owns the socket, the tickets and the clock it uses. */
  readonly create: (noteId: string) => NoteSession;
  readonly clock?: CollabClock;
}

interface Entry {
  readonly session: NoteSession;
  holders: number;
  release: CollabTimer | null;
}

/** The live note sessions of one client, reference-counted by their open tabs. */
export class NoteSessionRegistry {
  readonly #create: (noteId: string) => NoteSession;
  readonly #clock: CollabClock;
  readonly #entries = new Map<string, Entry>();
  #disposed = false;

  constructor(options: NoteSessionRegistryOptions) {
    this.#create = options.create;
    this.#clock = options.clock ?? systemCollabClock;
  }

  /** How many sessions are live, including those counting down to release. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * The session for this note, created and attached if there is none, with one more holder.
   *
   * Acquiring a session that was counting down to release cancels the countdown: the tab came back
   * before the window closed, and its document, undo history and unsent text are still here.
   */
  acquire(noteId: string): NoteSession {
    if (this.#disposed) {
      throw new Error(
        `NoteSessionRegistry.acquire("${noteId}") after dispose(). Build a new registry for a new window.`,
      );
    }
    const existing = this.#entries.get(noteId);
    if (existing !== undefined) {
      existing.release?.cancel();
      existing.release = null;
      existing.holders += 1;
      return existing.session;
    }

    const session = this.#create(noteId);
    this.#entries.set(noteId, { session, holders: 1, release: null });
    session.attach();
    return session;
  }

  /** One fewer holder; the last release starts the 60 s countdown to disposal. */
  release(noteId: string): void {
    const entry = this.#entries.get(noteId);
    if (entry === undefined) return;
    entry.holders -= 1;
    if (entry.holders > 0 || entry.release !== null) return;
    entry.release = this.#clock.after(SESSION_RELEASE_DELAY_MS, () => {
      entry.release = null;
      if (entry.holders > 0) return;
      this.#entries.delete(noteId);
      entry.session.dispose();
    });
  }

  /** The session for this note without acquiring it, for a subscriber that must not extend its life. */
  peek(noteId: string): NoteSession | undefined {
    return this.#entries.get(noteId)?.session;
  }

  /** Release every session now: the window is closing. */
  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries.values()) {
      entry.release?.cancel();
      entry.session.dispose();
    }
    this.#entries.clear();
  }
}
