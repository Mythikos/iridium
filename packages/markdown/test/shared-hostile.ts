/** The original security corpus is consumed as inert data, exactly as the Node testkit reads it. */
import attachment from '@iridium/testkit-fixtures/attachment-abuse.md?raw';
import css from '@iridium/testkit-fixtures/css-injection.md?raw';
import clobber from '@iridium/testkit-fixtures/dom-clobbering.md?raw';
import handlers from '@iridium/testkit-fixtures/event-handlers.md?raw';
import expectations from '@iridium/testkit-fixtures/expectations.json' with { type: 'json' };
import frontmatter from '@iridium/testkit-fixtures/frontmatter.md?raw';
import markdown from '@iridium/testkit-fixtures/markdown-specific.md?raw';
import script from '@iridium/testkit-fixtures/script-injection.md?raw';
import sinks from '@iridium/testkit-fixtures/sinks.md?raw';
import svg from '@iridium/testkit-fixtures/svg-mathml.md?raw';
import unicode from '@iridium/testkit-fixtures/unicode.md?raw';
import urls from '@iridium/testkit-fixtures/url-schemes.md?raw';

/** Pure-tree assertions consume the same per-file security and retention policy as the DOM suite. */
export interface HostileExpectation {
  readonly forbiddenTags: readonly string[];
  readonly forbiddenAttributes: readonly string[];
  readonly forbiddenUrlSchemes: readonly string[];
  readonly forbiddenIds?: readonly string[];
  readonly requiredIdPrefix?: string;
  readonly forbiddenClassPrefixes?: readonly string[];
  readonly mustContain: readonly string[];
}

/** Browser effects are tested by their owning renderer suite; no pure-tree test claims to observe them. */
export const SHARED_HOSTILE_EXPECTATIONS: Readonly<Record<string, HostileExpectation>> =
  expectations.files;

/** Shared original hostile files; expectations are imported separately by the assertion suite. */
export const SHARED_HOSTILE_SOURCES: Readonly<Record<string, string>> = {
  'attachment-abuse.md': attachment,
  'css-injection.md': css,
  'dom-clobbering.md': clobber,
  'event-handlers.md': handlers,
  'frontmatter.md': frontmatter,
  'markdown-specific.md': markdown,
  'script-injection.md': script,
  'sinks.md': sinks,
  'svg-mathml.md': svg,
  'unicode.md': unicode,
  'url-schemes.md': urls,
};
