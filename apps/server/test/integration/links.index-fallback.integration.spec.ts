/** Actual capacity boundary: product note writes populate more than 100000 lookup memberships. */
import {
  AttachmentUploaded,
  idFromBytes,
  LIMITS,
  NoteLinks,
  SessionId,
  UserId,
  VaultId,
} from '@iridium/contracts';
import { attachmentClient, inspectQueryPlan } from '@iridium/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { idBytes } from '../../src/auth/ids.ts';
import { projectionIndex } from '../../src/projection/index-snapshot.ts';
import { aliasCandidateQuery } from '../../src/projection/indexed-lookups.ts';
import { appDb } from '../../src/rest/handler-context.ts';
import { createNode } from '../../src/tree/service.ts';
import { startCollab } from '../support/collab-harness.ts';

function chosenIndexes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(chosenIndexes);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]: [string, unknown]) =>
    (key === 'key' || key === 'index_name') && typeof item === 'string'
      ? [item]
      : chosenIndexes(item),
  );
}

function withoutIds(page: NoteLinks) {
  return page.items.map(({ id: _id, ...link }) => link);
}

describe('links.index-fallback.integration [area:links]', () => {
  it('crosses the real index cap, logs indexed fallback, and preserves every committed link classification', async () => {
    const harness = await startCollab({ extraEnv: { JOBS_ENABLED: 'false' } });
    try {
      const cast = await harness.server.seed.kernel(),
        app = harness.application(),
        db = appDb(app);
      const admin = await harness.server.loginAs(cast.admin);
      const installed = await harness.sql.rows(
        `SHOW INDEX FROM \`${harness.server.schema}\`.note_projections`,
      );
      expect(installed.map((row) => row[2])).not.toContain('ix_proj_fm_aliases');
      const session = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', idBytes(cast.admin.id))
        .executeTakeFirstOrThrow();
      const actor = {
        userId: UserId.parse(cast.admin.id),
        sessionId: SessionId.parse(idFromBytes(session.id)),
        displayName: cast.admin.displayName,
      };
      const deps = {
        db,
        clock: app.clock,
        audit: app.audit,
        notes: app.notes,
        searchIndex: app.searchIndex,
        ownerFence: app.collab.ownerLease.captureFence(),
      };
      const create = async (
        name: string,
        markdown?: string,
        parentId: string = cast.vault.rootNodeId,
      ) =>
        (
          await createNode(deps, {
            vaultId: VaultId.parse(cast.vault.id),
            parentId,
            name,
            kind: markdown === undefined ? 'category' : 'note',
            markdown,
            actor,
            context: { client: 'link-index-capacity-fixture' },
          }).catch((error: unknown) => {
            throw new Error(
              `Could not create capacity fixture note ${name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
        ).node;
      const folder = await create('Folder'),
        another = await create('Another');
      const expandingAlias = 'İ'.repeat(LIMITS.FM_ALIAS_MAX_LEN);
      const target = await create(
        'Résumé',
        `---\naliases: ["ÉCHO", "${expandingAlias}"]\n---\n# Destination\n`,
        folder.id,
      );
      const maxTags = Array.from(
        { length: LIMITS.FM_TAGS_MAX },
        (_, index) => String(index).padStart(3, '0') + '𝓣'.repeat(LIMITS.FM_TAG_MAX_LEN - 3),
      );
      const maxAliases = Array.from(
        { length: LIMITS.FM_ALIASES_MAX },
        (_, index) => String(index).padStart(3, '0') + '𐐀'.repeat(LIMITS.FM_ALIAS_MAX_LEN - 3),
      );
      await create(
        'Maximum Unicode tags',
        `---\ntags: ${JSON.stringify(maxTags)}\n---\nAll legal tag limits.`,
      );
      await create(
        'Maximum Unicode aliases',
        `---\naliases: ${JSON.stringify(maxAliases)}\n---\nAll legal alias limits.`,
      );
      const maximumMetadata = await create(
        'Maximum Unicode metadata',
        `---\ntags: ${JSON.stringify(maxTags)}\naliases: ${JSON.stringify(maxAliases)}\n---\nAll legal metadata limits together.`,
      );
      const indexedMetadata = await db
        .selectFrom('note_projections')
        .select(['fm_tags', 'fm_aliases', 'frontmatter_raw'])
        .where('note_id', '=', idBytes(maximumMetadata.id))
        .executeTakeFirstOrThrow();
      expect(indexedMetadata.fm_tags).toHaveLength(LIMITS.FM_TAGS_MAX);
      expect(indexedMetadata.fm_aliases).toEqual(maxAliases);
      const terms = await db
        .selectFrom('note_projection_terms')
        .select('kind')
        .where('note_id', '=', idBytes(maximumMetadata.id))
        .execute();
      expect(terms.filter((row) => row.kind === 'alias')).toHaveLength(LIMITS.FM_ALIASES_MAX);
      expect(terms.filter((row) => row.kind === 'tag')).toHaveLength(LIMITS.FM_TAGS_MAX);
      expect(indexedMetadata.frontmatter_raw).toContain(JSON.stringify(maxAliases));
      await create('Résumé', 'Another basename match', another.id);
      const hidden = await harness.server.seed.vault({ name: 'Other link index scope' });
      await harness.server.seed.note({
        vault: hidden,
        name: 'Hidden',
        markdown: '---\naliases: [PRIVATEALIAS]\n---\nprivate',
      });
      const uploaded = AttachmentUploaded.parse(
        (
          await attachmentClient(admin).upload({
            vaultId: cast.vault.id,
            filename: 'chart.txt',
            bytes: Buffer.from('capacity attachment'),
          })
        ).body,
      ).attachment;
      const markdown = [
        '# Section',
        '[path](Folder/Re%CC%81sume%CC%81.md#destination)',
        '[[Résumé]]',
        '[[écho]]',
        `[[${expandingAlias}]]`,
        `![asset](${uploaded.pathHint})`,
        '[valid](#section)',
        '[invalid](#absent)',
        '[missing](missing.md)',
        '[[PRIVATEALIAS]]',
        '[external](https://example.test/)',
        '[blocked](javascript:alert)',
      ].join('\n');
      const source = await create('Source', markdown);
      const before = NoteLinks.parse((await admin.get(`/notes/${source.id}/links`)).body);
      expect(before.items.find((link) => link.rawTarget === 'écho')).toMatchObject({
        status: 'resolved',
        resolvedNodeId: target.id,
      });
      expect(before.items.find((link) => link.rawTarget === expandingAlias)).toMatchObject({
        status: 'resolved',
        resolvedNodeId: target.id,
      });
      expect(before.items.find((link) => link.rawTarget === 'Résumé')).toMatchObject({
        status: 'ambiguous',
      });
      expect(before.items.find((link) => link.rawTarget === 'PRIVATEALIAS')).toMatchObject({
        status: 'broken',
      });
      expect(new Set(before.items.map((link) => link.status))).toEqual(
        new Set(['resolved', 'ambiguous', 'broken', 'external']),
      );
      const small = await projectionIndex(db, idBytes(source.id));
      expect(small?.mode).toBe('snapshot');
      expect(small?.snapshot).not.toBeNull();
      const fillNotes = Math.ceil(LIMITS.VAULT_INDEX_MAX_ENTRIES / (LIMITS.FM_ALIASES_MAX + 2));
      for (let index = 0; index < fillNotes; index += 1) {
        const aliases = Array.from(
          { length: LIMITS.FM_ALIASES_MAX },
          (_, alias) => `capacity-${String(index)}-${String(alias)}`,
        );
        // eslint-disable-next-line no-await-in-loop -- each real structural transaction commits its note, projection, aliases and audit
        await create(
          `Capacity ${String(index)}`,
          `---\naliases: ${JSON.stringify(aliases)}\n---\nFixture without references.`,
        );
      }
      const large = await projectionIndex(db, idBytes(source.id));
      expect(large?.mode).toBe('indexed');
      expect(large?.snapshot).toBeNull();
      expect(large?.entries).toBeGreaterThan(LIMITS.VAULT_INDEX_MAX_ENTRIES);
      const plan = (await inspectQueryPlan(db, aliasCandidateQuery(idBytes(cast.vault.id), 'écho')))
        .rows[0]?.EXPLAIN;
      expect(
        chosenIndexes(typeof plan === 'string' ? JSON.parse(plan) : plan),
        JSON.stringify(plan),
      ).toContain('ix_projection_terms_lookup');
      expect(await large?.resolve('écho', { wikilink: true })).toEqual({
        kind: 'vault',
        nodeId: target.id,
        fragment: null,
        via: 'alias',
      });
      expect(await large?.resolve(expandingAlias, { wikilink: true })).toEqual({
        kind: 'vault',
        nodeId: target.id,
        fragment: null,
        via: 'alias',
      });
      const durable = await harness.committed(source.id);
      const job = await app.jobs.scheduler.enqueue(
        'reindex',
        { noteIds: [source.id] },
        { ownerFence: app.collab.ownerLease.captureFence() },
      );
      expect((await app.jobs.scheduler.runUntilSettled(job.id)).status).toBe('succeeded');
      const after = NoteLinks.parse((await admin.get(`/notes/${source.id}/links`)).body);
      expect(after.revision).toBe(before.revision);
      expect(withoutIds(after)).toEqual(withoutIds(before));
      expect(await harness.committed(source.id)).toEqual(durable);
      const messages = harness.logs.map((line) =>
        z.record(z.string(), z.unknown()).parse(JSON.parse(line)),
      );
      expect(
        messages.some(
          (line) =>
            line['event'] === 'links.index_capacity' &&
            line['vaultId'] === cast.vault.id &&
            line['limit'] === LIMITS.VAULT_INDEX_MAX_ENTRIES,
        ),
      ).toBe(true);
    } finally {
      await harness.close();
    }
  }, 180_000);
});
