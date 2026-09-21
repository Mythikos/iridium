/** Two-stage snippet locator and bounded revision/query LRU (08 §3.6). */
import { createHash } from 'node:crypto';

import { LIMITS, type ParsedSearchQuery, type SearchSnippet } from '@iridium/contracts';

import type { Clock } from '../ops/clock.ts';
import {
  ProjectionQueueFull,
  ProjectionTimedOut,
  type ProjectionPool,
} from '../projection/pool.ts';
import type { MappedSnippetTask } from './mapped-snippet.worker.ts';
import { sourceSnippets } from './snippet-text.ts';

/** Identity prevents snippets from crossing revisions, even when a caller reuses a query. */
export interface SnippetRequest {
  readonly noteId: string;
  readonly revision: number;
  readonly markdown: string;
  readonly contentHash: string;
  readonly query: ParsedSearchQuery;
  readonly snippetChars?: number;
  readonly frontmatterRaw?: string | null;
}

/** The cache owns no timer; deterministic expiry is checked through the injected clock. */
export interface SnippetBuilderOptions {
  readonly pool: Pick<ProjectionPool, 'run'>;
  readonly clock: Clock;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly snippets: SearchSnippet[];
}

/** Source scan is cheap; only misses enter the worker and the bounded LRU. */
export class SnippetBuilder {
  readonly #options: SnippetBuilderOptions;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: SnippetBuilderOptions) {
    this.#options = options;
  }

  /** Resolves excerpts only from the requested committed revision's source. */
  async buildForRevision(request: SnippetRequest): Promise<SearchSnippet[]> {
    const snippetChars = request.snippetChars ?? LIMITS.SNIPPET_MAX_CHARS;
    const source = sourceSnippets(request.markdown, request.query, snippetChars);
    if (source.length > 0) return source;
    const queryHash = createHash('sha256').update(request.query.raw).digest('hex');
    const key = JSON.stringify([
      request.noteId,
      request.revision,
      request.contentHash,
      queryHash,
      snippetChars,
    ]);
    const cached = this.#cache.get(key);
    const now = this.#options.clock.monotonic();
    if (cached !== undefined) {
      this.#cache.delete(key);
      if (cached.expiresAt > now) {
        this.#cache.set(key, cached);
        return structuredClone(cached.snippets);
      }
    }
    const task: MappedSnippetTask = {
      markdown: request.markdown,
      query: request.query,
      snippetChars,
    };
    let snippets: SearchSnippet[] = [];
    try {
      snippets = await this.#options.pool.run<SearchSnippet[]>(task, {
        filename: new URL(
          import.meta.url.endsWith('.ts')
            ? './mapped-snippet.worker.ts'
            : './search.mapped-snippet.worker.mjs',
          import.meta.url,
        ).href,
      });
    } catch (error) {
      if (error instanceof ProjectionQueueFull || error instanceof ProjectionTimedOut) return [];
      throw error;
    }
    while (this.#cache.size >= LIMITS.SNIPPET_CACHE_MAX) {
      const oldest = this.#cache.keys().next();
      if (oldest.done) break;
      this.#cache.delete(oldest.value);
    }
    this.#cache.set(key, {
      expiresAt: this.#options.clock.monotonic() + LIMITS.SNIPPET_CACHE_TTL_MS,
      snippets: structuredClone(snippets),
    });
    return snippets;
  }
}
