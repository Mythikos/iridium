/** HTML exists only as a fixture/export artifact, never as the React render path. */
import type { Root } from 'hast';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';

function createHtmlProcessor() {
  return unified().use(rehypeStringify).freeze();
}

// Preview consumers never serialize HTML. Creating this lazily lets their bundle omit the
// export-only stringifier graph while golden/export callers still reuse one frozen processor.
let htmlProcessor: ReturnType<typeof createHtmlProcessor> | undefined;

/** Serializes the already-sanitized tree for golden artifacts and future HTML export. */
export function renderHtml(tree: Root): string {
  htmlProcessor ??= createHtmlProcessor();
  return htmlProcessor.stringify(tree);
}
