/** Resolve a large vault through bounded indexed reads, retaining only this note's requested keys. */
import { idFromBytes, LIMITS } from '@iridium/contracts';
import {
  foldLinkPath,
  linkResolutionSteps,
  type LinkLookup,
  type NoteContext,
  type ResolvedLink,
} from '@iridium/markdown';
import { sql, type Kysely, type RawBuilder } from 'kysely';

import type { Database } from '../db/schema.ts';
import { projectionTermHash } from './terms.ts';

interface CandidateRow {
  readonly id: Buffer;
  readonly name: string;
  readonly fm_aliases?: string[] | null;
}
/** Shared with plan inspection so the contract observes the exact statement used by production. */
export function aliasCandidateQuery(
  vault: Buffer,
  key: string,
  cursor: Buffer | null = null,
): RawBuilder<CandidateRow> {
  return sql<CandidateRow>`SELECT n.id,n.name,p.fm_aliases FROM note_projection_terms t FORCE INDEX (ix_projection_terms_lookup)
    STRAIGHT_JOIN nodes n ON n.id=t.note_id
    STRAIGHT_JOIN note_projections p ON p.note_id=t.note_id
    WHERE t.vault_id=${vault} AND t.kind='alias' AND t.term_hash=${projectionTermHash(key)}
      AND n.vault_id=${vault} AND n.live=1 AND n.kind='note'
      ${cursor === null ? sql`` : sql`AND t.note_id > ${cursor}`}
    ORDER BY t.note_id LIMIT ${LIMITS.LINK_CANDIDATES_MAX}`;
}
/** Every query has both the vault predicate and a bounded result set before it reaches the resolver. */
export class IndexedVaultIndex {
  readonly vaultId: string;
  readonly #db: Kysely<Database>;
  readonly #vault: Buffer;
  readonly #root: Buffer;
  readonly #cache = new Map<LinkLookup['kind'], Map<string, readonly string[]>>();
  constructor(db: Kysely<Database>, vaultId: Buffer, rootId: Buffer) {
    this.#db = db;
    this.#vault = vaultId;
    this.#root = rootId;
    this.vaultId = idFromBytes(vaultId);
  }
  async resolve(
    raw: string,
    note: NoteContext,
    options: { wikilink?: boolean } = {},
  ): Promise<ResolvedLink> {
    const steps = linkResolutionSteps(raw, note, this.vaultId, options);
    let step = steps.next();
    while (!step.done) {
      const request = step.value;
      let cache = this.#cache.get(request.kind);
      if (cache === undefined) {
        cache = new Map();
        this.#cache.set(request.kind, cache);
      }
      let found = cache.get(request.key);
      if (found === undefined) {
        // eslint-disable-next-line no-await-in-loop -- the shared resolver admits only its next required lookup
        found = await this.#lookup(request);
        cache.set(request.key, found);
      }
      step = steps.next(found);
    }
    return step.value;
  }
  async #lookup(request: LinkLookup): Promise<readonly string[]> {
    switch (request.kind) {
      case 'path': {
        const id = await this.#path(request.key);
        return id === null ? [] : [id];
      }
      case 'attachment': {
        const row = await this.#db
          .selectFrom('attachments')
          .select(['id', 'path_hint'])
          .where('vault_id', '=', this.#vault)
          .where('path_hint', '=', request.key)
          .where('live', '=', 1)
          .limit(1)
          .executeTakeFirst();
        return row?.path_hint != null && foldLinkPath(row.path_hint) === request.key
          ? [idFromBytes(row.id)]
          : [];
      }
      case 'basename':
        return this.#candidates(request.key, false);
      case 'alias':
        return this.#candidates(request.key, true);
      default: {
        const unexpected: never = request.kind;
        throw new Error(`Unknown indexed link lookup kind: ${String(unexpected)}`);
      }
    }
  }
  async #path(folded: string): Promise<string | null> {
    const parts = folded.split('/').filter(Boolean);
    if (parts.length === 0 || parts.length > LIMITS.TREE_MAX_DEPTH) return null;
    let parent = this.#root;
    for (const [position, part] of parts.entries()) {
      // The live sibling unique index includes parent/name; no root-down full-tree CTE is needed.
      // eslint-disable-next-line no-await-in-loop -- a path component determines the next indexed parent lookup
      const row = await this.#db
        .selectFrom('nodes')
        .select(['id', 'name'])
        .where('vault_id', '=', this.#vault)
        .where('parent_id', '=', parent)
        .where('live', '=', 1)
        .where('name', '=', part)
        .where('kind', '=', position === parts.length - 1 ? 'note' : 'category')
        .limit(1)
        .executeTakeFirst();
      // The DB collation can equate more Unicode spellings than NFC/lowercase. Preserve snapshot parity.
      if (row === undefined || foldLinkPath(row.name) !== part) return null;
      parent = row.id;
    }
    return idFromBytes(parent);
  }
  async #candidates(key: string, alias: boolean): Promise<string[]> {
    const found: string[] = [];
    let cursor: Buffer | null = null;
    while (found.length < LIMITS.LINK_CANDIDATES_MAX) {
      // Hash candidates are still verified against original aliases. A collation-equivalent filename
      // also requires exact folded equality, so keyset pages skip mismatches without retaining them.
      // eslint-disable-next-line no-await-in-loop -- candidate pages depend on the last committed id
      const rows: readonly CandidateRow[] = alias
        ? // eslint-disable-next-line no-await-in-loop -- one indexed keyset page at a time
          (await aliasCandidateQuery(this.#vault, key, cursor).execute(this.#db)).rows
        : // eslint-disable-next-line no-await-in-loop -- one indexed keyset page at a time
          await this.#db
            .selectFrom('nodes')
            .select(['id', 'name'])
            .where('vault_id', '=', this.#vault)
            .where('name', '=', key)
            .where('live', '=', 1)
            .where('kind', '=', 'note')
            .$if(cursor !== null, (query) => query.where('id', '>', cursor ?? this.#root))
            .orderBy('id')
            .limit(LIMITS.LINK_CANDIDATES_MAX)
            .execute();
      for (const row of rows) {
        cursor = row.id;
        const matches =
          'fm_aliases' in row
            ? row.fm_aliases?.some((value) => foldLinkPath(value) === key) === true
            : foldLinkPath(row.name) === key;
        if (matches) found.push(idFromBytes(row.id));
        if (found.length === LIMITS.LINK_CANDIDATES_MAX) break;
      }
      if (rows.length < LIMITS.LINK_CANDIDATES_MAX) return found;
    }
    return found;
  }
}
