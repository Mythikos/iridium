/** Transactional search boundary and its MySQL FULLTEXT implementation (ARCH-19). */
import {
  idFromBytes,
  LIMITS,
  type NoteId,
  type ParsedSearchQuery,
  type SearchPage,
  type SearchSnippet,
  type VaultId,
} from '@iridium/contracts';
import { queryTitleTerms, toBooleanQuery } from '@iridium/markdown/search';
import { sql, type Kysely, type Transaction } from 'kysely';

import { idBytes } from '../auth/ids.ts';
import type { Database } from '../db/schema.ts';
import { cursorInvalid, type CursorCodec } from '../mcp/cursor.ts';
import type { ReindexContext, ReindexSelection } from '../projection/reindex.ts';

/** Content indexing follows the exact projection revision inside its committing transaction. */
export interface SearchDocument {
  readonly noteId: NoteId;
  readonly vaultId: VaultId;
  readonly title: string;
  readonly bodyText: string;
  readonly revision: number;
  readonly updatedAt: Date;
}
/** A structural rename changes only a filename-derived title, preserving a projected H1. */
export interface SearchFilenameUpdate {
  readonly noteId: NoteId;
  readonly title: string;
  readonly source: 'filename';
}
export interface SearchScope {
  readonly vaultIds: readonly VaultId[];
  readonly pathPrefix?: string | undefined;
}
export interface SearchIndexPage {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly snippetChars: number;
  readonly cursors: CursorCodec;
  readonly principalKey: string;
}
/** A future external engine writes its outbox in trx and applies the same authorized-vault predicate. */
export interface SearchIndex {
  index(document: SearchDocument | SearchFilenameUpdate, trx: Transaction<Database>): Promise<void>;
  remove(noteIds: NoteId | readonly NoteId[], trx: Transaction<Database>): Promise<void>;
  query(query: ParsedSearchQuery, scope: SearchScope, page: SearchIndexPage): Promise<SearchPage>;
  rebuild(selection: ReindexSelection, context: ReindexContext): Promise<Record<string, unknown>>;
}
export type SearchIndexWrites = Pick<SearchIndex, 'index' | 'remove'>;
export interface MysqlFulltextSearchOptions {
  readonly database: () => Kysely<Database>;
  readonly snippets: SearchSnippetSource;
  readonly rebuild: SearchIndex['rebuild'];
}

/** The CPU adapter can only receive the authorized rows returned by SQL. */
export interface SearchSnippetSource {
  buildForRevision(input: {
    readonly noteId: string;
    readonly revision: number;
    readonly markdown: string;
    readonly contentHash: string;
    readonly query: ParsedSearchQuery;
    readonly snippetChars?: number;
    readonly frontmatterRaw?: string | null;
  }): Promise<readonly SearchSnippet[]>;
}
interface RankedRow {
  readonly note_id: Buffer;
  readonly vault_id: Buffer;
  readonly vault_name: string;
  readonly path: string;
  readonly title: string;
  readonly revision: number;
  readonly head_seq: number;
  readonly score: number;
  readonly updated_at: Date;
  readonly markdown: string;
  readonly content_hash: Buffer;
  readonly frontmatter_raw: string | null;
}
function escapeLike(value: string): string {
  return value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}
function pathPrefix(value: string): string {
  return '/' + value.normalize('NFC').replace(/^\/+|\/+$/g, '');
}

/** The caller supplies the live ACL; it is repeated in both branches of the candidate union. */
export class MysqlFulltextSearch implements SearchIndex {
  readonly #database: () => Kysely<Database>;
  readonly #snippets: SearchSnippetSource;
  readonly #rebuild: SearchIndex['rebuild'];
  constructor(options: MysqlFulltextSearchOptions) {
    this.#database = options.database;
    this.#snippets = options.snippets;
    this.#rebuild = options.rebuild;
  }
  async index(
    document: SearchDocument | SearchFilenameUpdate,
    trx: Transaction<Database>,
  ): Promise<void> {
    const noteId = idBytes(document.noteId);
    if ('source' in document) {
      await sql`UPDATE note_search search JOIN note_projections projection ON projection.note_id=search.note_id
        JOIN nodes source ON source.id=search.note_id
        SET search.title=${document.title},search.updated_at=source.updated_at
        WHERE search.note_id=${noteId} AND projection.heading_title IS NULL`.execute(trx);
      return;
    }
    // Guard independently of the projection caller so every binding must reject delayed writes.
    // Revision is last because MySQL evaluates duplicate-key assignments from left to right.
    const newer = sql`new.revision >= note_search.revision`;
    await sql`INSERT INTO note_search (note_id,vault_id,title,body_text,revision,updated_at)
      VALUES (${noteId},${idBytes(document.vaultId)},${document.title},${document.bodyText},${document.revision},${document.updatedAt}) AS new
      ON DUPLICATE KEY UPDATE
        title=IF(${newer},new.title,note_search.title),body_text=IF(${newer},new.body_text,note_search.body_text),
        updated_at=IF(new.revision > note_search.revision,new.updated_at,note_search.updated_at),revision=IF(${newer},new.revision,note_search.revision)`.execute(
      trx,
    );
  }
  async remove(noteIds: NoteId | readonly NoteId[], trx: Transaction<Database>): Promise<void> {
    const ids = typeof noteIds === 'string' ? [noteIds] : noteIds;
    if (ids.length === 0) return;
    await trx.deleteFrom('note_search').where('note_id', 'in', ids.map(idBytes)).execute();
  }
  rebuild(selection: ReindexSelection, context: ReindexContext): Promise<Record<string, unknown>> {
    return this.#rebuild(selection, context);
  }
  async query(
    parsedQuery: ParsedSearchQuery,
    scope: SearchScope,
    page: SearchIndexPage,
  ): Promise<SearchPage> {
    const parsed = {
      query: parsedQuery,
      booleanQuery: toBooleanQuery(parsedQuery),
      titleTerms: queryTitleTerms(parsedQuery),
    };
    const vaultIds = scope.vaultIds,
      codec = page.cursors,
      principalKey = page.principalKey;
    const query = {
      q: parsedQuery.raw,
      pathPrefix: scope.pathPrefix,
      cursor: page.cursor,
      limit: page.limit,
      snippetChars: page.snippetChars,
    };
    const { booleanQuery, titleTerms } = parsed;
    const ids = [...new Set(vaultIds)].toSorted();
    const filter = {
      q: query.q,
      pathPrefix: query.pathPrefix ?? null,
      vaultIds: ids,
      snippetChars: query.snippetChars,
    };
    const after =
      query.cursor === undefined
        ? null
        : codec.parse(query.cursor, { kind: 'search', filter, principalKey }).a;
    if (
      after !== null &&
      (after.length !== 2 ||
        typeof after[0] !== 'number' ||
        !Number.isFinite(after[0]) ||
        after[0] < 0 ||
        typeof after[1] !== 'string' ||
        !/^[0-9a-f]{32}$/.test(after[1]))
    )
      throw cursorInvalid('Invalid search keyset.');
    if (ids.length === 0) return { results: [], query: parsed.query };
    const acl = sql.join(ids.map(idBytes));
    const common = [
      sql`s.vault_id IN (${acl})`,
      sql`n.deleted_at IS NULL`,
      sql`v.status IN ('active','archived')`,
    ];
    for (const prefix of [query.pathPrefix, parsed.query.operators['path']]) {
      if (prefix !== undefined) {
        const path = pathPrefix(prefix);
        if (path !== '/')
          common.push(sql`(n.path = ${path} OR n.path LIKE ${escapeLike(path) + '/%'} ESCAPE '!')`);
      }
    }
    const filename = parsed.query.operators['file'];
    if (filename !== undefined)
      common.push(
        sql`n.name LIKE ${'%' + escapeLike(filename.replace(/\.md$/i, '')) + '%'} ESCAPE '!'`,
      );
    for (const term of titleTerms)
      common.push(sql`s.title LIKE ${'%' + escapeLike(term) + '%'} ESCAPE '!'`);
    // A one-character negative is also absent from the FULLTEXT index; the explicit predicate
    // keeps it meaningful on title fallback and filter-only searches.
    for (const term of parsed.query.negations)
      common.push(
        sql`CONCAT(s.title, '\n', s.body_text) NOT LIKE ${'%' + escapeLike(term) + '%'} ESCAPE '!'`,
      );
    const hasFullTextPositive =
      parsed.query.phrases.length > 0 ||
      parsed.query.terms.some((term) => Array.from(term).length > 1);
    const match = sql<number>`MATCH(s.title,s.body_text) AGAINST (${booleanQuery} IN BOOLEAN MODE)`;
    const score = hasFullTextPositive ? match : sql<number>`0`;
    const columns = sql`s.note_id,s.vault_id,v.name AS vault_name,n.path,s.title,s.revision,d.head_seq,s.updated_at,p.markdown,p.content_hash,p.frontmatter_raw`;
    const joins = sql`FROM note_search s JOIN tree_paths n ON n.id=s.note_id JOIN vaults v ON v.id=s.vault_id
      JOIN note_projections p ON p.note_id=s.note_id AND p.revision=s.revision JOIN note_docs d ON d.note_id=s.note_id`;
    const conditions = sql.join(common, sql` AND `);
    const boundary =
      after !== null && typeof after[0] === 'number' && typeof after[1] === 'string'
        ? sql`(score < ${after[0]} OR (score = ${after[0]} AND note_id > ${Buffer.from(after[1], 'hex')}))`
        : sql`TRUE`;
    const found = await sql<RankedRow>`WITH RECURSIVE tree_paths AS (
      SELECT n.id,n.parent_id,n.name,n.vault_id,n.deleted_at,CAST('' AS CHAR(${sql.lit(LIMITS.NODE_PATH_MAX_CHARS)})) AS path,0 AS depth
      FROM nodes n JOIN vaults v ON v.root_node_id=n.id WHERE v.id IN (${acl}) AND v.status IN ('active','archived')
      UNION ALL
      SELECT n.id,n.parent_id,n.name,n.vault_id,n.deleted_at,CONCAT(p.path,'/',n.name),p.depth+1
      FROM nodes n JOIN tree_paths p ON n.parent_id=p.id AND n.vault_id=p.vault_id
      WHERE n.id<>n.parent_id AND n.deleted_at IS NULL AND p.depth<${sql.lit(LIMITS.TREE_MAX_DEPTH)}
    ), ranked AS (
      SELECT ${columns},${score} AS score ${joins} WHERE ${conditions} AND ${hasFullTextPositive ? sql`${match}>0` : sql`FALSE`}
      UNION ALL
      SELECT ${columns},0 AS score ${joins} WHERE ${conditions} AND ${hasFullTextPositive ? sql`FALSE` : sql`TRUE`}
    ) SELECT * FROM ranked WHERE ${boundary} ORDER BY score DESC,note_id ASC LIMIT ${query.limit + 1}`.execute(
      this.#database(),
    );
    const selected = found.rows.slice(0, query.limit);
    const results = await Promise.all(
      selected.map(async (row) => ({
        noteId: idFromBytes(row.note_id),
        vaultId: idFromBytes(row.vault_id),
        vaultName: row.vault_name,
        path: row.path,
        title: row.title,
        revision: row.revision,
        score: row.score,
        updatedAt: row.updated_at.toISOString(),
        stale: row.revision < row.head_seq,
        snippets: await this.#snippets.buildForRevision({
          noteId: idFromBytes(row.note_id),
          revision: row.revision,
          markdown: row.markdown,
          contentHash: row.content_hash.toString('hex'),
          query: parsed.query,
          snippetChars: query.snippetChars,
          frontmatterRaw: row.frontmatter_raw,
        }),
      })),
    );
    const last = selected.at(-1);
    return {
      results,
      query: parsed.query,
      ...(found.rows.length > query.limit && last !== undefined
        ? {
            nextCursor: codec.issue({
              kind: 'search',
              filter,
              principalKey,
              after: [last.score, last.note_id.toString('hex')],
            }),
          }
        : {}),
    };
  }
}
