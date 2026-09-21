/** Preview source may reach a structural renderer, never an HTML-string DOM sink (HP-4). */
import { describe, expect, it } from 'vitest';

import { isTestPath, sourceOf, sourcesUnder, type Source } from './source-scan.ts';

function htmlSinks(source: Source): string[] {
  return [
    ...source.noComments.matchAll(
      /\bdangerouslySetInnerHTML\b|\.\s*(?:innerHTML|outerHTML)\s*=|\.\s*insertAdjacentHTML\s*\(/g,
    ),
  ].map((match) => `${source.path}: ${match[0]}`);
}

describe('guards.no-inner-html.guard [area:security] [hp:HP-4]', () => {
  it('keeps every preview and shared UI source free of HTML-string sinks', () => {
    const sources = sourcesUnder(['packages/markdown-react/src', 'packages/ui/src']).filter(
      (source) => !isTestPath(source.path),
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.flatMap(htmlSinks)).toEqual([]);
  });

  it.each([
    '<div dangerouslySetInnerHTML={{ __html: note }} />',
    'preview.innerHTML = note;',
    'preview.outerHTML = note;',
    "preview.insertAdjacentHTML('beforeend', note);",
  ])('detects the unsafe sink %s', (code) => {
    expect(htmlSinks(sourceOf('packages/ui/src/preview.tsx', code))).toHaveLength(1);
  });

  it('permits structural children and comments documenting the forbidden API', () => {
    expect(
      htmlSinks(
        sourceOf(
          'packages/ui/src/preview.tsx',
          '// never use dangerouslySetInnerHTML\nconst preview = <div>{note}</div>;',
        ),
      ),
    ).toEqual([]);
  });
});
