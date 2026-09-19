/**
 * `repairContent` — the body of `iridium doctor --repair-content <note-id>`
 * (05-collaboration-and-durability.md, "The repair CLI"; 04-auth-and-access-control.md §6.9; A22).
 *
 * Repair is explicit, audited and operator-initiated, never automatic, because it changes content.
 * It runs inside the server process over the same coordinated-edit path as a version restore: a
 * `DirectConnection` opened through `CollabGateway.openServerEdit` (which loads the document if it is
 * not loaded), a `pre_restore` checkpoint labelled `pre-repair` so the invalid head stays
 * recoverable, one `prefixSuffixDiff` applied with origin `{source:'local', context:{reason:'repair'}}`
 * so the writer persists it with `note_updates.origin = 'repair'`, a forced compaction whose scan
 * now passes and clears `notes.content_invalid`, and the `note.content.repaired` audit row.
 *
 * `--dry-run` stops after the checkpoint and reports what would change. A rewrite the scan still
 * fails after is reported as impossible, the note stays locked and nothing is deleted.
 */
import { LIMITS, type NoteId, type Principal, type UserId } from '@iridium/contracts';
import {
  createNoteDoc,
  loadState,
  LOAD_ORIGIN,
  getContent,
  prefixSuffixDiff,
  projectMarkdown,
  scanHostileContent,
  sameDocumentState,
  type NoteDoc,
} from '@iridium/crdt';
import { normalizeSource } from '@iridium/markdown';
import type { Kysely } from 'kysely';

import type { AuditEventContext, AuditWriter } from '../audit/chain.ts';
import type { CollabGateway } from '../collab/gateway.ts';
import type { OwnerFence } from '../collab/owner-lease.ts';
import { NoteDocMissing } from '../collab/persistence/errors.ts';
import type { CollabPersistenceService } from '../collab/persistence/index.ts';
import type { Database } from '../db/schema.ts';
import type { Clock } from '../ops/clock.ts';
import { NoteOversizedError } from './errors.ts';

/** The label of the pre-repair checkpoint (05, "The repair CLI", step 3). */
export const PRE_REPAIR_LABEL = 'pre-repair';

/** What a repair takes. */
export interface RepairOptions {
  /** `{kind:'system', job:'cli:doctor'}` for the CLI, a user for `--actor`. */
  readonly actor: Principal;
  readonly dryRun?: boolean;
  /**
   * The caller's `audit_events.context`. The CLI supplies OPS-19's four members — `os_user`,
   * `host`, `request_id`, `argv_shape` — because only it knows them; absent, the row says `cli`.
   */
  readonly context?: AuditEventContext;
}

/** What a repair reports (05, "The repair CLI", steps 4 and 7). */
export interface RepairReport {
  readonly noteId: NoteId;
  /** `clean`: nothing to repair. `repaired`: committed. `dry-run`: reported only. `impossible`: still invalid. */
  readonly outcome: 'clean' | 'repaired' | 'dry-run' | 'impossible';
  readonly reason: 'cr' | 'attributes' | null;
  readonly droppedEmbeds: number;
  readonly attributeRuns: number;
  readonly charsBefore: number;
  readonly charsAfter: number;
  /** The one middle edit that turns the current text into the repaired one. */
  readonly diff: {
    readonly start: number;
    readonly deleteLength: number;
    readonly insert: string;
  } | null;
  readonly preRepairRevisionId: number | null;
}

/** What the repair needs. */
export interface RepairDeps {
  readonly gateway: Pick<CollabGateway, 'openServerEdit' | 'vaultOf'>;
  /** The immutable owner lifetime for checkpoint and audit transactions. */
  readonly captureOwner?: () => OwnerFence;
  readonly persistence: CollabPersistenceService;
  /** `dbApp`, for the audit row. */
  readonly db: () => Kysely<Database> | null;
  readonly audit: Pick<AuditWriter, 'record'>;
  readonly clock: Clock;
  readonly logger: {
    info(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
}

interface Flattened {
  readonly text: string;
  readonly droppedEmbeds: number;
  readonly attributeRuns: number;
}

/** A delta entry as `Y.Text.toDelta()` yields it: the members the flattening reads. */
interface DeltaEntry {
  readonly insert?: unknown;
  readonly attributes?: unknown;
}

/** Concatenates every string insert; an embed contributes nothing and formatting is discarded. */
function flattenDelta(delta: readonly DeltaEntry[]): Flattened {
  let text = '';
  let droppedEmbeds = 0;
  let attributeRuns = 0;
  for (const entry of delta) {
    if (typeof entry.insert === 'string') text += entry.insert;
    else droppedEmbeds += 1;
    if (entry.attributes !== undefined) attributeRuns += 1;
  }
  return { text, droppedEmbeds, attributeRuns };
}

function actorIdOf(principal: Principal): UserId | null {
  if (principal.kind === 'user' || principal.kind === 'token') return principal.userId;
  return principal.onBehalfOf ?? null;
}

/** A newer edit changed the repair target while the durable checkpoint was being written. */
export class RepairContentChanged extends Error {
  readonly code = 'notes.repair_changed';
  readonly revisionId: number;

  constructor(noteId: NoteId, revisionId: number) {
    super(
      'note ' +
        noteId +
        ' changed while pre-repair checkpoint ' +
        String(revisionId) +
        ' was written; no repair was applied',
    );
    this.name = 'RepairContentChanged';
    this.revisionId = revisionId;
  }
}

/** Runs the repair. */
export async function repairContent(
  deps: RepairDeps,
  noteId: NoteId,
  options: RepairOptions,
): Promise<RepairReport> {
  const owner = deps.captureOwner?.();
  const edit = await deps.gateway.openServerEdit(noteId, {
    principal: options.actor,
    permission: 'note:write',
    reason: 'repair',
  });
  const document: NoteDoc = edit.document;
  let committed: NoteDoc | null = null;
  try {
    // 1. Load and verify.
    const initialScan = scanHostileContent(document);
    const initialText = projectMarkdown(document);
    if (initialScan.ok) {
      return {
        noteId,
        outcome: 'clean',
        reason: null,
        droppedEmbeds: 0,
        attributeRuns: 0,
        charsBefore: initialText.length,
        charsAfter: initialText.length,
        diff: null,
        preRepairRevisionId: null,
      };
    }

    // 2-3. The writer serializes an exact committed prefix before writing its checkpoint. Live
    // state may include a later accepted tail, including deletions which do not advance a vector.
    const writer = deps.persistence.writerOf(noteId);
    if (writer === undefined) throw new NoteDocMissing(noteId);
    owner?.assertActive();
    const checkpoint = await writer.enqueueCheckpoint({
      kind: 'pre_restore',
      label: PRE_REPAIR_LABEL,
      actor: {
        userId: actorIdOf(options.actor),
        sessionId: null,
        actorType: options.actor.kind === 'user' ? 'user' : 'system',
      },
    });
    committed = createNoteDoc({ gc: true });
    loadState(committed, checkpoint.captured.stateV2, 2, LOAD_ORIGIN);
    owner?.assertActive();
    const scan = checkpoint.captured.scan;
    if (scan.ok || !sameDocumentState(document, committed)) {
      throw new RepairContentChanged(noteId, checkpoint.revision.id);
    }
    // No await separates this equality check, target capture and the first mutation. The report
    // and its target describe the very state retained in the recoverable revision.
    const current = checkpoint.captured.markdown;
    const delta: readonly DeltaEntry[] = getContent(committed).toDelta();
    const flattened = flattenDelta(delta);
    const repaired = normalizeSource(flattened.text).text;
    if (repaired.length > LIMITS.NOTE_HARD_MAX_UTF16) throw new NoteOversizedError(repaired.length);
    const diff = prefixSuffixDiff(current, repaired);
    const preRepair = checkpoint.revision;

    const base = {
      noteId,
      reason: scan.reason,
      droppedEmbeds: flattened.droppedEmbeds,
      attributeRuns: flattened.attributeRuns,
      charsBefore: current.length,
      charsAfter: repaired.length,
      diff,
      preRepairRevisionId: preRepair.id,
    };

    // 4. A dry run stops here.
    if (options.dryRun === true) return { ...base, outcome: 'dry-run' };

    // 5. Strip non-text content under the trusted repair origin. Each operation owns its
    // transaction; an outer DirectConnection transaction would absorb every insertion chunk.
    let offset = 0;
    for (const entry of delta) {
      if (typeof entry.insert !== 'string') {
        // eslint-disable-next-line no-await-in-loop -- each edit's offsets depend on the previous deletion
        await edit.transact((doc) => getContent(doc).delete(offset, 1));
        continue;
      }
      if (typeof entry.attributes === 'object' && entry.attributes !== null) {
        const length = entry.insert.length;
        for (const key of Object.keys(entry.attributes)) {
          // eslint-disable-next-line no-await-in-loop -- preserve operation order and avoid an outer transaction
          await edit.transact((doc) => getContent(doc).format(offset, length, { [key]: null }));
        }
      }
      offset += entry.insert.length;
    }
    const plainDiff = prefixSuffixDiff(projectMarkdown(document), repaired);
    if (plainDiff.deleteLength > 0) {
      await edit.transact((doc) => getContent(doc).delete(plainDiff.start, plainDiff.deleteLength));
    }
    edit.insertChunked(plainDiff.start, plainDiff.insert);

    // 6. Re-verify and clear: the forced compaction's scan now passes and clears the flag.
    const outcome = await deps.persistence.compactNow(noteId, { trigger: 'flush' });
    const stillInvalid = outcome !== null && outcome.contentInvalid !== null;
    if (stillInvalid || !scanHostileContent(document).ok) {
      return { ...base, outcome: 'impossible' };
    }

    // 7. Audit. The clients' write access came back with the compaction's role restore.

    const db = deps.db();
    if (db !== null) {
      await db.transaction().execute(async (trx) => {
        await owner?.assertCurrent(trx);
        await deps.audit.record(trx, {
          action: 'note.content.repaired',
          actorType: options.actor.kind === 'user' ? 'user' : 'system',
          actorId: actorIdOf(options.actor),
          credentialType: options.actor.kind === 'user' ? 'session' : 'cli',
          vaultId: deps.gateway.vaultOf(`note:${noteId}`) ?? null,
          targetType: 'note',
          targetId: noteId,
          outcome: 'success',
          reason: scan.reason,
          context: options.context ?? { client: 'cli' },
          metadata: {
            reason: scan.reason,
            dropped_embeds: flattened.droppedEmbeds,
            attribute_runs: flattened.attributeRuns,
            chars_before: current.length,
            chars_after: repaired.length,
            dry_run: false,
          },
        });
      });
    }
    deps.logger.info(
      {
        event: 'projection.completed',
        noteId,
        reason: scan.reason,
        charsBefore: current.length,
        charsAfter: repaired.length,
      },
      'the note content was repaired',
    );
    return { ...base, outcome: 'repaired' };
  } finally {
    committed?.destroy();
    await edit.disconnect();
  }
}
