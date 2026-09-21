/** Real MySQL query compilation over the scripted driver: missing rows, byte boundaries and rollback. */
import { newId, NoteId, SessionId, UserId, VaultId } from '@iridium/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  fakeDatabase,
  type FakeDatabase,
  type QueryScript,
} from '../../../test/support/fake-driver.ts';
import { ManualClock } from '../../../test/support/manual-clock.ts';
import { AuditKeyMissingError, AuditWriter } from '../../audit/chain.ts';
import { idBytes } from '../../auth/ids.ts';
import type { OwnerFence } from '../owner-lease.ts';
import {
  KyselyPersistenceStore,
  PersistenceUnavailable,
  REVISION_MARKDOWN_COLUMN_BYTES,
  RevisionTooLarge,
} from './kysely-store.ts';
import type { RevisionInsert, UpdateActor } from './types.ts';

const noteId = NoteId.parse(newId());
const vaultId = VaultId.parse(newId());
const userId = UserId.parse(newId());
const sessionId = SessionId.parse(newId());
const now = new Date('2026-09-17T12:00:00Z');
const system: UpdateActor = { actorType: 'system', userId: null, sessionId: null };
const user: UpdateActor = { actorType: 'user', userId, sessionId };
const opened: FakeDatabase[] = [];
const audit = (): AuditWriter =>
  new AuditWriter({
    clock: new ManualClock(now.getTime()),
    keys: { signingVersion: 1, keyFor: () => undefined },
  });
function fixture(
  script: QueryScript,
  timeout: unknown = 50,
  ownership?: OwnerFence,
): { db: FakeDatabase; store: KyselyPersistenceStore } {
  const db = fakeDatabase({
    script: (query, ordinal) => {
      if (query.sql.startsWith('SELECT @@SESSION'))
        return { rows: timeout === null ? [] : [{ value: timeout }] };
      if (query.sql.startsWith('SET SESSION')) return { numAffectedRows: 0n };
      if (query.sql === 'select `id` from `vaults` where `id` = ? for share')
        return { rows: [{ id: idBytes(vaultId) }] };
      return script(query, ordinal);
    },
  });
  opened.push(db);
  return {
    db,
    store: new KyselyPersistenceStore({
      db: () => db.db,
      audit: audit(),
      ...(ownership === undefined ? {} : { ownership }),
    }),
  };
}
afterEach(async () => {
  await Promise.all(opened.splice(0).map((database) => database.db.destroy()));
});
const absent: QueryScript = () => ({ rows: [] });
function revision(overrides: Partial<RevisionInsert> = {}): RevisionInsert {
  return {
    seq: 3,
    kind: 'unload',
    label: null,
    markdown: 'retained',
    contentHash: Buffer.alloc(32, 1),
    sizeChars: 8,
    snapshot: null,
    snapshotSv: null,
    actor: system,
    createdAt: now,
    ...overrides,
  };
}
function documentRow(snapshotFormat: number, snapshot: Buffer | null): Record<string, unknown> {
  return {
    head_seq: 3,
    snapshot,
    snapshot_format: snapshotFormat,
    snapshot_sv: snapshot,
    snapshot_through_seq: 2,
    snapshot_size: snapshot?.byteLength ?? 0,
    projected_seq: 2,
    yjs_major: 13,
    vault_id: idBytes(vaultId),
    deleted_at: null,
    initialized_at: now,
    content_invalid: false,
    oversize: false,
  };
}

describe('collab.kysely-store.unit [area:collab]', () => {
  it.each([
    'exact',
    'missing',
    'seq',
    'bytes',
    'vector',
    'major',
    'actor-type',
    'actor-id',
    'session',
    'origin',
    'created',
  ] as const)('reconciles only the exact durable attempted rows: %s', async (variant) => {
    const actual = {
      seq: 3,
      update_v1: Buffer.from([1]),
      sv_after: Buffer.from([2]),
      yjs_major: 13,
      actor_type: 'user',
      actor_id: idBytes(userId),
      session_id: idBytes(sessionId),
      origin: 'repair',
      created_at: now,
      ...(variant === 'seq' ? { seq: 4 } : {}),
      ...(variant === 'bytes' ? { update_v1: Buffer.from([9]) } : {}),
      ...(variant === 'vector' ? { sv_after: Buffer.alloc(0) } : {}),
      ...(variant === 'major' ? { yjs_major: 14 } : {}),
      ...(variant === 'actor-type' ? { actor_type: 'system' } : {}),
      ...(variant === 'actor-id' ? { actor_id: null } : {}),
      ...(variant === 'session' ? { session_id: null } : {}),
      ...(variant === 'origin' ? { origin: 'connection' } : {}),
      ...(variant === 'created' ? { created_at: new Date(now.getTime() + 1) } : {}),
    };
    const { store, db } = fixture((query) => ({
      rows: query.sql.includes('note_updates')
        ? variant === 'missing'
          ? []
          : [actual]
        : [{ head_seq: 3, deleted_at: null }],
    }));
    await store.runWrite(noteId, async (tx) => {
      expect(await tx.lockHead()).toEqual({ headSeq: 3, deletedAt: null });
      expect(
        await tx.matchesUpdates([
          {
            seq: 3,
            updateV1: Uint8Array.of(1),
            svAfter: Uint8Array.of(2),
            actor: user,
            origin: 'repair',
            createdAt: now,
          },
        ]),
      ).toBe(variant === 'exact');
    });
    const read = db.executed.find((query) => query.sql.includes('note_updates'));
    expect(read?.parameters).toEqual([idBytes(noteId), 3, 3]);
    expect(read?.sql).toContain('order by');
    expect(db.executed.some((query) => query.sql.startsWith('insert'))).toBe(false);
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
  });

  it('refuses an unavailable persistence pool before invoking transactional work', async () => {
    const store = new KyselyPersistenceStore({ db: () => null, audit: audit() });
    let entered = false;
    await expect(store.loadDoc(noteId)).rejects.toBeInstanceOf(PersistenceUnavailable);
    await expect(
      store.runWrite(noteId, async () => {
        entered = true;
      }),
    ).rejects.toBeInstanceOf(PersistenceUnavailable);
    expect(entered).toBe(false);
  });
  it('returns absent documents and accepts only the two documented snapshot formats', async () => {
    expect(await fixture(absent).store.loadDoc(noteId)).toBeNull();
    const empty = fixture(() => ({ rows: [documentRow(1, null)] }));
    expect(await empty.store.loadDoc(noteId)).toMatchObject({
      snapshot: null,
      snapshotSv: null,
      snapshotFormat: 1,
      vaultId,
      initializedAt: now,
    });
    const invalid = fixture(() => ({ rows: [documentRow(3, null)] }));
    await expect(invalid.store.loadDoc(noteId)).rejects.toThrow('neither 1 (V1) nor 2 (V2)');
  });
  it('preserves byte-view offsets and empty-vector sentinels while loading snapshots and ordered tails', async () => {
    const backing = Buffer.from([99, 1, 2, 77]);
    const slice = backing.subarray(1, 3);
    const { store, db } = fixture((query) => ({
      rows: query.sql.includes('note_updates')
        ? [{ seq: 3, update_v1: slice, sv_after: Buffer.alloc(0) }]
        : [documentRow(2, slice)],
    }));
    expect(await store.loadDoc(noteId)).toMatchObject({
      snapshot: Uint8Array.of(1, 2),
      snapshotSv: Uint8Array.of(1, 2),
      snapshotFormat: 2,
    });
    expect(await store.loadUpdatesAfter(noteId, 2)).toEqual([
      { seq: 3, updateV1: Uint8Array.of(1, 2), svAfter: new Uint8Array() },
    ]);
    expect(db.executed[1]?.sql).toContain('`seq` > ? order by `seq` asc');
    expect(db.executed[1]?.parameters).toEqual([idBytes(noteId), 2]);
  });

  it('does not insert an empty write batch and reports missing heads and unmatched CAS without success', async () => {
    const { store, db } = fixture((query) =>
      query.sql.startsWith('update') ? { numAffectedRows: 0n } : { rows: [] },
    );
    await store.runWrite(noteId, async (tx) => {
      expect(await tx.lockHead()).toBeNull();
      await tx.insertUpdates([]);
      expect(await tx.casHead(2, 3, now)).toBe(false);
    });
    expect(db.executed.some((query) => query.sql.startsWith('insert'))).toBe(false);
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
  });
  it('writes authenticated and system attribution as binary ids or SQL null, on the locked connection', async () => {
    const { store, db } = fixture((query) =>
      query.sql.startsWith('select')
        ? { rows: [{ head_seq: 2, deleted_at: now }] }
        : { numAffectedRows: 1n },
    );
    await store.runWrite(noteId, async (tx) => {
      expect(await tx.lockHead()).toEqual({ headSeq: 2, deletedAt: now });
      await tx.insertUpdates(
        [system, user].map((actor, index) => ({
          seq: index + 3,
          updateV1: Uint8Array.of(3),
          svAfter: Uint8Array.of(4),
          actor,
          origin: 'connection',
          createdAt: now,
        })),
      );
      expect(await tx.casHead(2, 4, now)).toBe(true);
    });
    const insert = db.executed.find((query) => query.sql.startsWith('insert'));
    expect(insert?.parameters).toContain(null);
    expect(insert?.parameters).toContainEqual(idBytes(userId));
    expect(insert?.parameters).toContainEqual(idBytes(sessionId));
    expect(
      db.executed.filter((query) => query.sql.startsWith('select')).map((query) => query.sql),
    ).toEqual([
      'select `deleted_at` from `nodes` where `id` = ? for share',
      'select `node_id` from `notes` where `node_id` = ? for update',
      'select `head_seq` from `note_docs` where `note_id` = ? for update',
    ]);
    expect(db.executed.some((query) => query.sql.includes('from `vaults`'))).toBe(false);
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
  });
  for (const [value, restored] of [
    [1, 1],
    [5, 5],
    [37, 37],
    ['41', 41],
    [null, 50],
    ['unusable', 50],
    [-1, 50],
  ] as const) {
    it(`restores the connection lock timeout after a transaction (${String(value)})`, async () => {
      const { store, db } = fixture(absent, value);
      await store.runWrite(noteId, async () => undefined);
      expect(
        db.executed
          .filter((query) => query.sql.startsWith('SET SESSION'))
          .map((query) => query.sql),
      ).toEqual([
        `SET SESSION innodb_lock_wait_timeout = ${String(Math.min(10, restored))}`,
        `SET SESSION innodb_lock_wait_timeout = ${String(restored)}`,
      ]);
    });
  }
  it('preserves the original transaction error when restoring the connection timeout also fails', async () => {
    const original = new Error('lost COMMIT acknowledgement');
    const reset = new Error('connection closed');
    const db = fakeDatabase({
      script: (query) => {
        if (query.sql.startsWith('SELECT @@SESSION')) return { rows: [{ value: 37 }] };
        if (query.sql.endsWith('= 37')) return { throws: reset };
        return { numAffectedRows: 0n };
      },
    });
    opened.push(db);
    const store = new KyselyPersistenceStore({ db: () => db.db, audit: audit() });
    await expect(
      store.runWrite(noteId, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'rollback', 'release']);
    expect(db.executed.at(-1)?.sql).toBe('SET SESSION innodb_lock_wait_timeout = 37');
  });
  it('reuses an existing revision id without issuing another insert', async () => {
    const { store, db } = fixture(() => ({ rows: [{ id: 73 }] }));
    expect(await store.revisionExistsAt(noteId, 3)).toBe(true);
    expect(await fixture(absent).store.revisionExistsAt(noteId, 3)).toBe(false);
    expect(await store.insertRevision(noteId, revision())).toEqual({ id: 73, inserted: false });
    expect(db.executed.some((query) => query.sql.startsWith('insert'))).toBe(false);
    expect(db.lifecycle).toContain('commit');
  });
  for (const snapshot of [false, true]) {
    it(`inserts one revision and reads its id independently of the driver insert result (snapshot=${String(snapshot)})`, async () => {
      let reads = 0;
      const { store, db } = fixture((query) => {
        if (query.sql.startsWith('select')) {
          reads += 1;
          return { rows: reads === 1 ? [] : [{ id: 88 }] };
        }
        return { numAffectedRows: 1n };
      });
      expect(
        await store.insertRevision(
          noteId,
          revision(
            snapshot
              ? {
                  snapshot: Uint8Array.of(7),
                  snapshotSv: Uint8Array.of(8),
                  actor: user,
                }
              : {},
          ),
        ),
      ).toEqual({ id: 88, inserted: true });
      const insert = db.executed.find((query) => query.sql.startsWith('insert'));
      expect(insert?.sql).toContain('on duplicate key update `id` = id');
      expect(insert?.parameters).toContainEqual(snapshot ? idBytes(userId) : null);
    });
  }
  it('measures the MEDIUMTEXT bound in UTF-8 bytes before attempting any SQL', async () => {
    const { store, db } = fixture(absent);
    const text = '𐀀'.repeat(Math.ceil(REVISION_MARKDOWN_COLUMN_BYTES / 4));
    expect(text.length).toBeLessThan(REVISION_MARKDOWN_COLUMN_BYTES);
    await expect(store.insertRevision(noteId, revision({ markdown: text }))).rejects.toBeInstanceOf(
      RevisionTooLarge,
    );
    expect(db.executed).toEqual([]);
  });
  it('loads present or absent compaction policy/revision inputs without inventing a checkpoint', async () => {
    const empty = fixture(absent);
    await empty.store.runCompaction(noteId, vaultId, async (tx) => {
      expect(await tx.newestRevision()).toBeNull();
      expect(await tx.revisionExistsAt(2)).toBe(false);
      await expect(tx.checkpointPolicyInputs()).rejects.toThrow('no result');
    });
    const { store } = fixture((query) => ({
      rows: query.sql.includes('vaults')
        ? [{ last_checkpoint_at: now, auto_checkpoint_interval_min: 7 }]
        : [{ seq: 3, content_hash: Buffer.from([2]), id: 9 }],
    }));
    await store.runCompaction(noteId, vaultId, async (tx) => {
      expect(await tx.newestRevision()).toEqual({ seq: 3, contentHash: Uint8Array.of(2) });
      expect(await tx.revisionExistsAt(3)).toBe(true);
      expect(await tx.checkpointPolicyInputs()).toEqual({
        lastCheckpointAt: now,
        intervalMinutes: 7,
      });
      expect(await tx.insertRevision(revision())).toEqual({ id: 9, inserted: false });
    });
  });
  it('compacts through real projection SQL and preserves metadata when no newer actor/checkpoint is supplied', async () => {
    let snapshotWrites = 0;
    const { store, db } = fixture((query) => {
      if (query.sql.startsWith('select')) return { rows: [{ head_seq: 3, deleted_at: null }] };
      if (query.sql.includes('`snapshot` =')) {
        snapshotWrites += 1;
        return { numAffectedRows: snapshotWrites === 1 ? 1n : 0n };
      }
      return { numAffectedRows: 1n };
    });
    await store.runCompaction(noteId, vaultId, async (tx) => {
      expect(await tx.lockHead()).toEqual({ headSeq: 3, deletedAt: null });
      const snapshot = {
        snapshot: Uint8Array.of(1),
        snapshotSv: Uint8Array.of(2),
        snapshotSize: 1,
        throughSeq: 3,
        now,
      };
      expect(await tx.updateSnapshot(snapshot)).toBe(true);
      expect(await tx.updateSnapshot(snapshot)).toBe(false);
      await tx.writeProjection({
        revision: 3,
        markdown: 'retained',
        contentHash: Buffer.alloc(32),
        now,
      });
      await tx.markProjectionInvalid(now);
      for (const lastEditor of [null, { userId, at: now }, { userId: null, at: now }]) {
        // eslint-disable-next-line no-await-in-loop -- ordered mutations share one transaction connection
        await tx.updateNoteMetadata({
          sizeChars: 8,
          contentInvalid: true,
          oversize: false,
          lastEditor,
          lastCheckpointAt: null,
          now,
        });
      }
      await tx.advanceProjectedSeq(3, now);
    });
    const metadata = db.executed.filter((query) => query.sql.startsWith('update `notes`'));
    expect(metadata).toHaveLength(3);
    expect(metadata[0]?.sql).toContain('COALESCE(?, last_edited_by)');
    expect(metadata[0]?.parameters).toContain(null);
    expect(metadata[1]?.parameters).toContainEqual(idBytes(userId));
    expect(
      db.executed.find((query) => query.sql.includes('INSERT INTO note_projections'))?.sql,
    ).toContain('new.revision > note_projections.revision');
    expect(db.executed.at(-2)?.sql).toContain('`projected_seq` < ?');
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
  });
  it('keeps audit failure inside the same compaction transaction and rolls its mutations back', async () => {
    const { store, db } = fixture(() => ({ numAffectedRows: 1n }));
    await expect(
      store.runCompaction(noteId, vaultId, async (tx) => {
        await tx.markProjectionInvalid(now);
        await tx.recordAudit({
          action: 'note.content.invalid',
          actorType: 'system',
          credentialType: 'system',
          context: {},
          outcome: 'success',
          vaultId,
        });
      }),
    ).rejects.toBeInstanceOf(AuditKeyMissingError);
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'rollback', 'release']);
    expect(db.executed.some((query) => query.sql.startsWith('update `note_projections`'))).toBe(
      true,
    );
  });

  it('takes the publication gate after its owner fence and before every note parent lock', async () => {
    let fenceAt = -1;
    const { store, db } = fixture(() => ({ rows: [{ head_seq: 3, deleted_at: null }] }), 50, {
      assertActive(): void {},
      assertCurrent: async () => {
        fenceAt = db.executed.length;
      },
    });
    await store.runCompaction(noteId, vaultId, async (tx) => {
      expect(await tx.lockHead()).toEqual({ headSeq: 3, deletedAt: null });
    });
    const gateAt = db.executed.findIndex((query) => query.sql.includes('from `vaults`'));
    expect(gateAt).toBe(fenceAt);
    expect(db.executed.slice(gateAt, -1).map((query) => query.sql)).toEqual([
      'select `id` from `vaults` where `id` = ? for share',
      'select `deleted_at` from `nodes` where `id` = ? for share',
      'select `node_id` from `notes` where `node_id` = ? for update',
      'select `head_seq` from `note_docs` where `note_id` = ? for update',
    ]);
    expect(db.executed[gateAt]?.parameters).toEqual([idBytes(vaultId)]);
  });

  it('keeps an explicit checkpoint per-note and exposes no projection publication methods', async () => {
    const { store, db } = fixture(() => ({ rows: [{ head_seq: 3, deleted_at: null, id: 71 }] }));
    await store.runCheckpoint(noteId, async (tx) => {
      expect(Object.keys(tx).toSorted()).toEqual(['insertRevision', 'lockHead', 'recordAudit']);
      expect(await tx.lockHead()).toEqual({ headSeq: 3, deletedAt: null });
      expect(await tx.insertRevision(revision({ kind: 'named', label: 'Retained' }))).toEqual({
        id: 71,
        inserted: false,
      });
    });
    expect(db.executed.some((query) => query.sql.includes('from `vaults`'))).toBe(false);
    expect(db.lifecycle).toEqual(['acquire', 'begin', 'commit', 'release']);
  });
});
