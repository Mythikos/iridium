/** Hostile source crosses the real worker/SQL/REST path without replacing its durable bytes. */
import { mkdirSync, writeFileSync } from 'node:fs';

import { LIMITS, type NoteMeta } from '@iridium/contracts';
import { normalizeSource } from '@iridium/markdown';
import {
  readHostileCorpus,
  readHostileFixture,
  readMarkdownHostileFixtures,
  readMarkdownPathologicalFixtures,
} from '@iridium/testkit';
import { describe, expect, it } from 'vitest';

import { idBytes } from '../../src/auth/ids.ts';
import { startCollab } from '../support/collab-harness.ts';

describe('projection.hostile.integration [area:projection] [hp:HP-4] [spec:portability-and-safety]', () => {
  it('stores complete detector counts and only the first twenty source-ordered findings', async () => {
    const harness = await startCollab();
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Bounded diagnostics' });
      const markdown = Array.from({ length: 250 }, (_, index) => `==sample${index}==`).join('\n\n');
      const note = await harness.server.seed.note({ vault, name: 'Diagnostics', markdown });
      const db = harness.application().database.dbApp;
      if (db === null) throw new Error('Expected the real database');
      const projection = await db
        .selectFrom('note_projections')
        .select(['markdown', 'obsidian_findings'])
        .where('note_id', '=', idBytes(note.id))
        .executeTakeFirstOrThrow();
      expect(projection.markdown).toBe(markdown);
      expect(projection.obsidian_findings?.counts.highlight).toBe(250);
      expect(projection.obsidian_findings?.sample).toHaveLength(20);
      expect(
        projection.obsidian_findings?.sample.map((finding) => [
          finding.code,
          finding.line,
          finding.text,
        ]),
      ).toEqual(
        Array.from({ length: 20 }, (_, index) => [
          'highlight',
          index * 2 + 1,
          `==sample${index}==`,
        ]),
      );
      expect((await admin.client.get<string>(`/notes/${note.id}/markdown`)).body).toBe(markdown);
    } finally {
      await harness.close();
    }
  });
  it('keeps the full hostile and pathological corpora readable and publishes only inert derived data', async () => {
    const harness = await startCollab();
    let current = 'setup';
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Hostile projections' });
      const db = harness.application().database.dbApp;
      if (db === null) throw new Error('Expected the real database');
      const ordinary = [
        ...Object.keys(readHostileCorpus().files).map((id) => ({
          id,
          markdown: readHostileFixture(id),
        })),
        ...readMarkdownHostileFixtures(),
      ];
      const corpus = [
        ...ordinary.map((fixture) => ({
          id: fixture.id,
          markdown: fixture.markdown,
          status: 'ok',
        })),
        ...readMarkdownPathologicalFixtures(),
      ];
      for (const [index, fixture] of corpus.entries()) {
        current = `${fixture.id}: create`;
        const expected = normalizeSource(fixture.markdown).text;
        const overJsonBudget =
          Buffer.byteLength(JSON.stringify({ markdown: fixture.markdown })) >
          LIMITS.BODY_MAX_BYTES_JSON;
        // eslint-disable-next-line no-await-in-loop -- each fixture completes the real mutation, worker and publication before its oracle
        const note = await harness.server.seed.note({
          vault,
          name: `Hostile ${String(index)}`,
          markdown: overJsonBudget ? '' : fixture.markdown,
        });
        if (overJsonBudget) {
          // Newline escaping can exceed the REST JSON budget while the source remains a valid
          // note. Exercise the actual collaboration ingress, then explicitly publish its head.
          current = `${fixture.id}: collaboration`;
          // eslint-disable-next-line no-await-in-loop -- this fixture owns one actual client
          const client = await harness.open(admin, note.id);
          // eslint-disable-next-line no-await-in-loop -- complete synchronization before editing
          await client.waitFor('saved');
          client.typeAt(0, expected);
          // eslint-disable-next-line no-await-in-loop -- observe the persisted acknowledgement
          await client.waitFor('saved');
          // eslint-disable-next-line no-await-in-loop, vitest/no-conditional-expect -- oversized JSON fixtures publish through their real collaboration path
          expect((await admin.client.get(`/notes/${note.id}/markdown?fresh=true`)).status).toBe(
            200,
          );
        }
        current = `${fixture.id}: read`;
        // eslint-disable-next-line no-await-in-loop -- inspect the rows published for this exact source revision
        const [projection, search, links, response, metadata] = await Promise.all([
          db
            .selectFrom('note_projections')
            .select(['markdown', 'status', 'revision'])
            .where('note_id', '=', idBytes(note.id))
            .executeTakeFirstOrThrow(),
          db
            .selectFrom('note_search')
            .select(['body_text', 'revision'])
            .where('note_id', '=', idBytes(note.id))
            .executeTakeFirstOrThrow(),
          db
            .selectFrom('note_links')
            .select(['raw_target', 'status', 'resolved_node_id'])
            .where('from_note_id', '=', idBytes(note.id))
            .execute(),
          admin.client.get<string>(`/notes/${note.id}/markdown`),
          admin.client.get<NoteMeta>(`/notes/${note.id}`),
        ]);
        expect(['ok', 'too_large', 'too_complex', 'timeout'], fixture.id).toContain(
          projection.status,
        );
        if (fixture.status === 'too_complex') {
          // eslint-disable-next-line vitest/no-conditional-expect -- only pre-scan rejection fixtures declare too_complex
          expect(projection.status, fixture.id).toBe('too_complex');
        }
        expect(projection.markdown, fixture.id).toBe(expected);
        expect(response.status, fixture.id).toBe(200);
        expect(response.body, fixture.id).toBe(expected);
        expect(metadata.body.projectionStatus, fixture.id).toBe(projection.status);
        expect(search.revision, fixture.id).toBe(projection.revision);
        for (const link of links.filter((row) => !row.raw_target.startsWith('#'))) {
          expect(['external', 'broken'], `${fixture.id}: ${link.raw_target}`).toContain(
            link.status,
          );
          expect(link.resolved_node_id, fixture.id).toBeNull();
        }
        if (fixture.id === 'html-elements') {
          // eslint-disable-next-line vitest/no-conditional-expect -- this corpus entry owns raw HTML removal
          expect(search.body_text).not.toMatch(/alert\(1\)|onerror|<script|<iframe|<svg|<math/);
        }
        // Code is searchable source data. Removing tag-looking text inside code would silently
        // discard legitimate notes, while raw HTML nodes above are excluded from search prose.
        if (fixture.id === 'code-is-data') {
          // eslint-disable-next-line vitest/no-conditional-expect -- this corpus entry owns code-content retention
          expect(search.body_text).toContain('window.iridium.eraseEverything()');
        }
      }
      const healthy = await harness.server.seed.note({
        vault,
        name: 'After hostile corpus',
        markdown: '# Still healthy\nsearchable quasar\n',
      });
      expect((await admin.client.get<string>(`/notes/${healthy.id}/markdown`)).body).toContain(
        'searchable quasar',
      );
      expect(harness.application().projectionPool.pending).toBe(0);
    } catch (error) {
      throw new Error(`Projection corpus failed at ${current}`, { cause: error });
    } finally {
      mkdirSync('reports/hostile', { recursive: true });
      writeFileSync(
        `reports/hostile/runtime-${String(process.pid)}.jsonl`,
        harness.logs.join('\n') + '\n',
      );
      await harness.close();
    }
  });
});
