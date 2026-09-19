/**
 * The bounded audit path of the collaboration server (04-auth-and-access-control.md §11.4;
 * 12-milestones.md §5.2, the `audit` row: `collab.connection.rejected`, `collab.write.rejected`).
 *
 * A refused connection or a refused write happens outside any mutating transaction, so the row is
 * written in a transaction of its own on `dbApp` through the chain writer — and it is **bounded**:
 * one row per `(action, reason, subject)` per window, exactly like the login and token denial gates
 * of the auth plugin, because a reconnect loop or a viewer's keystrokes must not become one audit row
 * per attempt. A failure to write is logged and swallowed: the refusal has already happened, and an
 * audit row must never be the reason a hook rejects.
 */
import type { AuditAction } from '@iridium/contracts';
import type { Kysely } from 'kysely';

import type { AuditEventInput, AuditWriter } from '../audit/chain.ts';
import { FailureAuditGate } from '../auth/audit.ts';
import type { Database } from '../db/schema.ts';

/** One row per key per this window (04 §11.4's dedupe, applied to the two collab actions). */
export const COLLAB_AUDIT_WINDOW_MS = 60_000;

/** What the sink needs. */
export interface CollabAuditOptions {
  readonly db: () => Kysely<Database> | null;
  readonly audit: AuditWriter;
  readonly now: () => number;
  readonly logger: {
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
}

/** What a caller records: the row minus what the sink fills. */
export interface CollabAuditEvent {
  readonly action: Extract<AuditAction, 'collab.connection.rejected' | 'collab.write.rejected'>;
  readonly vaultId: string;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly noteId: string | null;
  readonly reason: string;
  readonly ip: string | null;
  readonly requestId: string | null;
  /** What the window is keyed on beside action and reason: a session, a connection, a document. */
  readonly subject: string;
}

/** The sink. One per process, owned by the collab plugin. */
export class CollabAuditSink {
  readonly #options: CollabAuditOptions;
  readonly #gate: FailureAuditGate;

  constructor(options: CollabAuditOptions) {
    this.#options = options;
    this.#gate = new FailureAuditGate(COLLAB_AUDIT_WINDOW_MS, options.now);
  }

  /** Records one bounded event. Resolves `true` when a row was written. Never throws. */
  async record(event: CollabAuditEvent): Promise<boolean> {
    const key = `${event.action}|${event.reason}|${event.subject}`;
    if (!this.#gate.shouldWrite(key)) return false;
    const db = this.#options.db();
    if (db === null) return false;
    const input: AuditEventInput = {
      action: event.action,
      actorType: event.userId === null ? 'system' : 'user',
      actorId: event.userId,
      credentialType: event.sessionId === null ? 'none' : 'ticket',
      credentialId: event.sessionId,
      vaultId: event.vaultId,
      targetType: event.noteId === null ? 'vault' : 'note',
      targetId: event.noteId ?? event.vaultId,
      outcome: 'failure',
      reason: event.reason,
      context: { ip: event.ip, request_id: event.requestId, client: 'collab' },
    };
    try {
      await db.transaction().execute((trx) => this.#options.audit.record(trx, input));
      return true;
    } catch (error) {
      this.#options.logger.warn(
        { err: error, action: event.action, reason: event.reason },
        'a collaboration audit row could not be written',
      );
      return false;
    }
  }
}
