/**
 * In-memory admission barrier for an owner-executed session command. It starts before the mutation
 * transaction and remains held until a locking database read proves its outcome. A command whose
 * COMMIT response was lost cannot reopen an old session while the database outcome is uncertain.
 * Waiting does not close a connection: a proved rollback resumes the same authorized connection.
 */
import type { UserId } from '@iridium/contracts';

interface PendingCommand {
  readonly userId: UserId | null;
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

/** One per serving process. The normal message path reads only this object and the epoch table. */
export class SessionCommandFence {
  readonly #pending = new Map<string, PendingCommand>();
  #revision = 0;
  readonly #listeners = new Set<(userId: UserId | null, blocked: boolean) => void>();

  /** Changes at both edges, detecting an entire command that raced an asynchronous identity read. */
  get revision(): number {
    return this.#revision;
  }

  /** Fence one user, or every user for a global command; replaying the same command is idempotent. */
  begin(commandId: string, userId: UserId | null): void {
    if (this.#pending.has(commandId)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#pending.set(commandId, { userId, settled: promise, resolve });
    this.#revision += 1;
    for (const listener of this.#listeners) listener(userId, true);
  }

  /** Synchronous latch updates run before a transaction can start or a waiting hook can resume. */
  subscribe(listener: (userId: UserId | null, blocked: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** True while any unfinished command covers this principal. No database lookup or timer. */
  blocked(userId: UserId): boolean {
    return [...this.#pending.values()].some(
      (item) => item.userId === null || item.userId === userId,
    );
  }

  /** A shared outcome barrier, or null for the zero-I/O steady path. Recheck after awaiting it. */
  wait(userId: UserId): Promise<void> | null {
    const pending = [...this.#pending.values()]
      .filter((item) => item.userId === null || item.userId === userId)
      .map((item) => item.settled);
    if (pending.length === 0) return null;
    return Promise.all(pending).then(() => undefined);
  }

  /** Call only after known rollback, or confirmed committed revocations have reached subscribers. */
  finish(commandId: string): void {
    const pending = this.#pending.get(commandId);
    if (pending === undefined) return;
    this.#pending.delete(commandId);
    this.#revision += 1;
    for (const listener of this.#listeners) listener(pending.userId, false);
    pending.resolve();
  }
}
