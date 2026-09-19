/** Real MySQL assignment-order and monotonicity proof for the M1 text projection. */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { markProjectionInvalid, upsertProjection } from '../../src/projection/write.ts';
import { startAuthServer, type AuthTestServer } from '../support/auth-app.ts';

let context: AuthTestServer;
beforeAll(async () => {
  context = await startAuthServer();
});
afterAll(async () => {
  await context.stop();
});

describe('projection.text-monotonic.integration [area:projection]', () => {
  it('updates text and metadata together, refuses stale/strict-equal writes, and permits an equal-revision rebuild', async () => {
    await context.server.seed.admin();
    const vault = await context.server.seed.vault({ name: 'Projection ordering' });
    const note = await context.server.seed.note({ vault, name: 'Projection', markdown: 'seed' });
    const noteId = idBytes(note.id);
    await context.db.deleteFrom('note_projections').where('note_id', '=', noteId).execute();
    const read = () =>
      context.db
        .selectFrom('note_projections')
        .select([
          'revision',
          'markdown',
          'content_hash',
          'pipeline_version',
          'projected_at',
          'status',
        ])
        .where('note_id', '=', noteId)
        .executeTakeFirstOrThrow();
    const write = async (revision: number, markdown: string, version: number, strict: boolean) => {
      const contentHash = createHash('sha256').update(markdown).digest();
      const now = new Date(context.clock.now() + version * 1_000);
      await upsertProjection(context.db, {
        noteId,
        revision,
        markdown,
        contentHash,
        pipelineVersion: version,
        now,
        strict,
      });
      return {
        revision,
        markdown,
        content_hash: contentHash,
        pipeline_version: version,
        projected_at: now,
        status: 'ok',
      };
    };
    const initial = await write(1, 'initial text', 1, true);
    expect(await read()).toEqual(initial);
    await markProjectionInvalid(context.db, noteId, context.clock.date());
    const current = await write(2, 'new committed text', 2, true);
    expect(await read()).toEqual(current);
    await write(1, 'late old job', 3, true);
    expect(await read()).toEqual(current);
    await write(1, 'late old rebuild', 4, false);
    expect(await read()).toEqual(current);
    await write(2, 'equal live compaction', 5, true);
    expect(await read()).toEqual(current);
    const rebuilt = await write(2, 'same revision, new pipeline', 6, false);
    expect(await read()).toEqual(rebuilt);
  });
});
