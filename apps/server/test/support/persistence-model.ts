/** The shared model's real MySQL adapter; all initial state comes from product routes and CLI. */
import { idFromBytes, NoteId, SessionId, UserId, VaultId } from '@iridium/contracts';
import type { SeededVault } from '@iridium/testkit';

import { idBytes } from '../../src/auth/ids.ts';
import { KyselyPersistenceStore } from '../../src/collab/persistence/kysely-store.ts';
import { pruneUpdateLog } from '../../src/collab/persistence/prune.ts';
import { recordingLogger } from '../../src/collab/persistence/testing/harness.ts';
import {
  createModelReal,
  type ModelActor,
  type ModelReal,
  type ModelStore,
} from '../../src/collab/persistence/testing/model.ts';
import { startAuthServer, type AuthTestServer, type StartAuthServerOptions } from './auth-app.ts';
import { ManualClock } from './manual-clock.ts';

export interface DatabaseModelFixture {
  readonly context: AuthTestServer;
  create(markdown: string, source?: string): Promise<ModelReal>;
  stop(): Promise<void>;
}

/** One real server/cast per property, one independently route-created note per generated run. */
export async function startDatabaseModel(
  options: StartAuthServerOptions = {},
): Promise<DatabaseModelFixture> {
  const context = await startAuthServer(options);
  try {
    let admin = await context.server.seed.admin();
    const editor = await context.server.seed.user({
      email: context.server.seed.email('model-editor'),
    });
    const signedIn = await context.server.seed.signIn(editor);
    let actors: readonly [ModelActor, ModelActor] = [
      { userId: UserId.parse(admin.id), sessionId: SessionId.parse(admin.sessionId) },
      { userId: UserId.parse(editor.id), sessionId: SessionId.parse(signedIn.session.id) },
    ];
    const vault: SeededVault = await context.server.seed.vault({
      name: 'Durability model',
      members: [[editor, 'editor']],
    });
    const dbPersist = context.app.database.dbPersist;
    if (dbPersist === null) throw new Error('DB property requires the actual persistence pool');
    const store = new KyselyPersistenceStore({ db: () => dbPersist, audit: context.app.audit });
    const modelStore: ModelStore = {
      store,
      async seedNote(input) {
        // createModelReal normally seeds a memory store. Here initialization already ran in the
        // actual node-create transaction; verify that anchor instead of inserting fixture rows.
        const row = await store.loadDoc(input.noteId);
        if (row === null || row.vaultId !== input.vaultId || row.headSeq !== 1) {
          throw new Error('route-created note is missing its initialized persistence anchor');
        }
      },
      async view(noteId) {
        return context.db.transaction().execute(async (trx) => {
          const row = await trx
            .selectFrom('note_docs as d')
            .innerJoin('nodes as n', 'n.id', 'd.note_id')
            .leftJoin('note_projections as p', 'p.note_id', 'd.note_id')
            .select([
              'd.head_seq',
              'd.snapshot_through_seq',
              'd.projected_seq',
              'n.deleted_at',
              'p.revision',
              'p.content_hash',
              'p.markdown',
            ])
            .where('d.note_id', '=', idBytes(noteId))
            .executeTakeFirstOrThrow();
          const updates = await trx
            .selectFrom('note_updates')
            .selectAll()
            .where('note_id', '=', idBytes(noteId))
            .orderBy('seq')
            .execute();
          return {
            headSeq: row.head_seq,
            snapshotThroughSeq: row.snapshot_through_seq,
            projectedSeq: row.projected_seq,
            projectionRevision: row.revision,
            projectionHash: row.content_hash?.toString('hex') ?? null,
            projectionMarkdown: row.markdown,
            deletedAt: row.deleted_at,
            updates: updates.map((update) => ({
              seq: update.seq,
              origin: update.origin,
              actorUserId: update.actor_id === null ? null : idFromBytes(update.actor_id),
              actorSessionId: update.session_id === null ? null : idFromBytes(update.session_id),
              svAfter: update.sv_after,
              updateV1: update.update_v1,
            })),
          };
        });
      },
      async trash(noteId, at) {
        // M1 models the concurrent lifecycle cut point: an already product-created node becomes
        // trashed. The M2 trash route is outside this model; writer/loader refusal is real SQL.
        await context.db
          .updateTable('nodes')
          .set({ deleted_at: at })
          .where('id', '=', idBytes(noteId))
          .execute();
      },
      prune: (noteId, olderThan) =>
        pruneUpdateLog({
          db: context.db,
          noteId,
          retentionDays: 7,
          now: new Date(olderThan.getTime() + 7 * 86_400_000),
          batchSize: 3,
        }),
    };
    let ordinal = 0;
    return {
      context,
      async create(markdown, source = markdown) {
        // Each property may create 5,000 notes. The product budget is per session, so retire the
        // used session and sign in again through the real routes before its 600-request budget.
        // No auth hook, rate limit or database initializer is bypassed for fixture creation.
        if (ordinal > 0 && ordinal % 500 === 0) {
          const signedOut = await admin.client.del('/auth/sessions/current');
          if (signedOut.status !== 204)
            throw new Error(`model session rotation refused: ${String(signedOut.status)}`);
          const session = await context.server.seed.signIn(admin);
          admin = { ...admin, client: session.client, sessionId: session.session.id };
          actors = [
            { userId: UserId.parse(admin.id), sessionId: SessionId.parse(admin.sessionId) },
            actors[1],
          ];
        }
        ordinal += 1;
        const note = await context.server.seed.note({
          vault,
          name: `Model ${String(ordinal)}`,
          admin,
          markdown: source,
        });
        return createModelReal({
          modelStore,
          identity: { noteId: NoteId.parse(note.id), vaultId: VaultId.parse(vault.id), actors },
          clock: new ManualClock(context.clock.now()),
          logger: recordingLogger(),
          markdown,
          random: () => 0.5,
        });
      },
      stop: () => context.stop(),
    };
  } catch (error) {
    await context.stop();
    throw error;
  }
}
