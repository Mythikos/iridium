/** Connected content reads remain tied to the durable projection, including validators and search. */
import { createHash } from 'node:crypto';

import { RESPONSE_HEADERS } from '@iridium/contracts';
import { describe, expect, it } from 'vitest';

import { startCollab } from '../support/collab-harness.ts';

describe('content.etag.integration [area:content]', () => {
  it('carries whole-source identity and head on complete, sliced, and 304 responses', async () => {
    const harness = await startCollab();
    try {
      const admin = await harness.server.seed.admin();
      const vault = await harness.server.seed.vault({ name: 'Content headers' });
      const note = await harness.server.seed.note({
        vault,
        name: 'Header Note',
        markdown: '# Title\nfirst\nsecond\n',
      });
      const rest = admin.client;
      const whole = await rest.get<string>(`/notes/${note.id}/markdown`);
      const hash = createHash('sha256').update(whole.body).digest('hex');
      expect(whole.headers.get('content-type')).toContain('text/markdown');
      expect(whole.headers.get('etag')).toBe(`"1:${hash}"`);
      const sliced = await rest.get<string>(`/notes/${note.id}/markdown?lines=2-3`);
      expect(sliced.body).toBe('first\nsecond');
      expect(sliced.headers.get('etag')).toBe(whole.headers.get('etag'));
      const unchanged = await rest.get(`/notes/${note.id}/markdown`, {
        headers: { 'if-none-match': whole.headers.get('etag') ?? '' },
      });
      expect(unchanged.status).toBe(304);
      for (const response of [whole, sliced, unchanged]) {
        expect(response.headers.get(RESPONSE_HEADERS.revision)).toBe('1');
        expect(response.headers.get(RESPONSE_HEADERS.headRevision)).toBe('1');
        expect(response.headers.get(RESPONSE_HEADERS.contentHash)).toBe(hash);
        expect(response.headers.get(RESPONSE_HEADERS.projectionStatus)).toBe('ok');
        expect(response.headers.get(RESPONSE_HEADERS.lineCount)).toBe('4');
      }
      expect(sliced.headers.get(RESPONSE_HEADERS.returnedLines)).toBe('2-3');
      const clamped = await rest.get<string>(`/notes/${note.id}/markdown?lines=50-60`);
      expect(clamped.status).toBe(200);
      expect(clamped.headers.get(RESPONSE_HEADERS.returnedLines)).toBe('4-4');
      const retained = await rest.get<string>(`/notes/${note.id}/markdown?revision=1`);
      expect(retained.body).toBe(whole.body);
      expect(retained.headers.get('etag')).toBe(whole.headers.get('etag'));
    } finally {
      await harness.close();
    }
  });
});
