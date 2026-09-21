import { LIMITS } from '@iridium/contracts/limits';
import { describe, expect, it } from 'vitest';

import { PATHOLOGICAL_FIXTURES } from '../test/fixtures.ts';
import { parseNote, project, prescan } from './index.ts';

describe('markdown.pathological.unit [area:markdown] [spec:portability-and-safety] [hp:HP-4] [hp:HP-5]', () => {
  it('refuses excessive quote depth even when the same line opens a code fence', () => {
    const source = `${'>'.repeat(LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH + 1)}\`\`\`\ncode\n\`\`\``;
    const parsed = parseNote(source);
    expect(parsed.prescan).toMatchObject({
      status: 'too_complex',
      detail: 'blockquote_depth',
      line: 1,
    });
    expect(parsed.mdast.children).toEqual([]);
    expect(parsed.source).toBe(source);
  });
  it.each(PATHOLOGICAL_FIXTURES.filter((fixture) => fixture.status !== 'worker-bounded'))(
    '$id is refused before parsing',
    (fixture) => {
      const source = fixture.repeat.repeat(fixture.count) + (fixture.suffix ?? '');
      const start = Date.now();
      const parsed = parseNote(source);
      expect(parsed.prescan).toMatchObject({ status: fixture.status, detail: fixture.detail });
      expect(parsed.mdast.children).toEqual([]);
      expect(project(parsed, source, { contentHash: 'hash' }).status).toBe(fixture.status);
      expect(Date.now() - start).toBeLessThan(LIMITS.PROJECTION_TIMEOUT_CLIENT_MS);
    },
  );
  it('counts UTF-8 separately from UTF-16 and applies each exact boundary', () => {
    expect(prescan('é'.repeat(LIMITS.MARKDOWN_SOURCE_MAX_BYTES / 2)).status).toBe('ok');
    expect(prescan('é'.repeat(LIMITS.MARKDOWN_SOURCE_MAX_BYTES / 2) + 'a')).toMatchObject({
      status: 'too_large',
      detail: 'source_bytes',
    });
    expect(prescan('a'.repeat(LIMITS.NOTE_HARD_MAX_UTF16 + 1))).toMatchObject({
      status: 'too_large',
      detail: 'source_chars',
    });
    expect(prescan('😀')).toMatchObject({ bytes: 4, status: 'ok' });
    expect(prescan('ascii\u0000\u007f')).toMatchObject({ bytes: 7, status: 'ok' });
    expect(prescan('a\ud800b')).toMatchObject({ bytes: 5, status: 'ok' });
    expect(prescan('é\n😀\n')).toMatchObject({ bytes: 8, lineCount: 3, status: 'ok' });
  });
  it('does not mistake fenced source for nested prose and accepts the stated exact caps', () => {
    expect(prescan('>'.repeat(LIMITS.MARKDOWN_BLOCKQUOTE_MAX_DEPTH) + ' text').status).toBe('ok');
    expect(prescan(' '.repeat(LIMITS.MARKDOWN_LIST_INDENT_MAX_COLS) + '- text').status).toBe('ok');
    expect(prescan('text\n'.repeat(LIMITS.MARKDOWN_LINES_PER_PARAGRAPH_MAX)).status).toBe('ok');
    expect(prescan('```\n' + '>'.repeat(100) + '\n```').status).toBe('ok');
    expect(prescan('~~~\n' + ' '.repeat(100) + '- list\n~~~').status).toBe('ok');
  });
  it('counts complete Unicode scalars across scratch-buffer boundaries without retaining prior bytes', () => {
    const encoder = new TextEncoder();
    const boundary = 64 * 1024;
    for (const source of [
      '',
      'a'.repeat(boundary - 1) + '😀é\ud800',
      'é'.repeat(boundary) + '😀'.repeat(boundary),
      '\ud800'.repeat(boundary) + '\udfff',
      'a',
    ]) {
      expect(prescan(source).bytes).toBe(encoder.encode(source).length);
    }
  });
});
