/** The authorized committed-content boundary shared by REST, MCP and exports (A37). */
import {
  LIMITS,
  NoteId,
  type VaultId,
  type ListAttachmentsQuery,
  type ListNodesQuery,
  type ListRevisionsQuery,
  type AttachmentPage,
  type ListChildrenQuery,
  type Node,
  type NodePage,
  type NoteHeading,
  type NoteMeta,
  type Permission,
  type Principal,
  type ProjectionStatus,
  type RevisionContent,
  type RevisionPage,
  type SearchPage,
  type SearchQuery,
  type TreePage,
  type Vault,
  type VaultSummary,
  type ListTrashQuery,
  type TrashPage,
  type ListInboundLinksQuery,
  type InboundLinksPage,
  type RenameImpactQuery,
  type RenameImpactResult,
  type NoteLinks,
  type LinkPage,
} from '@iridium/contracts';
import { sql, type Kysely } from 'kysely';

import type { AttachmentService } from '../../attachments/service.ts';
import { idBytes, vaultIdFromBytes } from '../../auth/ids.ts';
import { principalKeyOf } from '../../auth/principal-key.ts';
import type { AccessibleVaultIds } from '../../authz/accessible-vaults.ts';
import type { Authorizer } from '../../authz/authorize.ts';
import type { Database } from '../../db/schema.ts';
import {
  readNoteLinks as queryNoteLinks,
  readBacklinks as queryBacklinks,
} from '../../links/read.ts';
import type { CursorCodec } from '../../mcp/cursor.ts';
import { readNoteMeta, readRetainedRevision } from '../../notes-rest/read.ts';
import { readCommittedMarkdown } from '../../projection/read.ts';
import {
  listRevisions as queryRevisions,
  readRevision as queryRevision,
  revisionNotFound,
} from '../../revisions/read.ts';
import { ProblemError } from '../../security/problem.ts';
import {
  listChildren as queryChildren,
  listNodes as queryNodes,
  listTrash as queryTrash,
  listInboundLinks as queryInbound,
} from '../../tree/listing.ts';
import { readNodeRows } from '../../tree/queries.ts';
import { previewRename } from '../../tree/rename-preview.ts';
import { listVaults as queryVaults, readVault as queryVault } from '../../vaults/service.ts';
import { selectSource, type SourceSelection, type SourceSlice } from './slices.ts';

/** SQL search accepts only the already-authorized vault set. */
export interface CommittedSearch {
  search(
    vaultIds: readonly VaultId[],
    query: SearchQuery,
    codec: CursorCodec,
    principalKey: string,
  ): Promise<SearchPage>;
}
/** Every dependency is a committed read or authorization decision, never a live document. */
export interface ContentReadCoreOptions {
  readonly database: () => Kysely<Database>;
  readonly authorize: Authorizer['authorize'];
  readonly accessibleVaultIds: AccessibleVaultIds;
  readonly cursors: () => Promise<CursorCodec>;
  readonly attachments: Pick<AttachmentService, 'list' | 'metadata' | 'content'>;
  readonly search: CommittedSearch;
  readonly outline: (markdown: string) => Promise<readonly NoteHeading[]>;
  readonly surface?: 'rest' | 'mcp';
}
/** Stable content identity accompanies every source slice. */
export interface NoteMarkdown extends SourceSlice {
  readonly revision: number;
  readonly headRevision: number;
  readonly contentHash: string;
  readonly projectionStatus: ProjectionStatus;
  readonly stale: boolean;
  readonly meta: NoteMeta;
}
/** A path lookup never chooses among ambiguous candidates. */
export type ResolvedNote =
  | { readonly resolved: true; readonly note: Node }
  | { readonly ambiguous: readonly Node[] }
  | { readonly notFound: true; readonly suggestions: readonly string[] };

/** One instance per surface; principals are supplied on every call and never cached. */
export class ContentReadCore {
  readonly #options: ContentReadCoreOptions;
  constructor(options: ContentReadCoreOptions) {
    this.#options = options;
  }
  #db(): Kysely<Database> {
    return this.#options.database();
  }
  #key(principal: Principal): string {
    const key = principalKeyOf(principal);
    if (key === null) throw new ProblemError('not_found');
    return key;
  }
  async #vault(principal: Principal, vaultId: VaultId, permission: Permission): Promise<void> {
    const result = await this.#options.authorize(principal, permission, {
      vaultId,
      surface: this.#options.surface ?? 'rest',
    });
    if (result !== 'allow') throw new ProblemError('not_found');
  }
  async #note(
    principal: Principal,
    noteId: NoteId,
    permission: Permission = 'note:read',
  ): Promise<VaultId> {
    const row = await this.#db()
      .selectFrom('nodes as n')
      .innerJoin('vaults as v', 'v.id', 'n.vault_id')
      .select('n.vault_id')
      .where('n.id', '=', idBytes(noteId))
      .where('n.kind', '=', 'note')
      .where('n.deleted_at', 'is', null)
      .where('v.status', 'in', ['active', 'archived'])
      .executeTakeFirst();
    if (row === undefined) throw new ProblemError('not_found');
    const vaultId = vaultIdFromBytes(row.vault_id);
    await this.#vault(principal, vaultId, permission);
    return vaultId;
  }
  async #accessible(principal: Principal, permission: Permission): Promise<readonly VaultId[]> {
    const ids = await this.#options.accessibleVaultIds(principal, {
      permission,
      surface: this.#options.surface ?? 'rest',
    });
    // The collection helper applies SQL membership/scopes. Recheck before exposing any result,
    // including the MCP switch, through the same authorizer every addressed read uses.
    const allowed = await Promise.all(
      ids.map(async (id) =>
        (await this.#options.authorize(principal, permission, {
          vaultId: id,
          surface: this.#options.surface ?? 'rest',
        })) === 'allow'
          ? id
          : null,
      ),
    );
    return allowed.filter((id) => id !== null);
  }
  /** The token's membership and scope intersection decides its list; no ambient admin widening. */
  async listVaults(
    principal: Principal,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly VaultSummary[]> {
    if (principal.kind === 'system') throw new ProblemError('not_found');
    const ids = await this.#accessible(principal, 'vault:read');
    return queryVaults(this.#db(), {
      vaultIds: ids,
      userId: principal.userId,
      isServerAdmin: principal.kind === 'user' && principal.isServerAdmin,
      includeArchived: options.includeArchived ?? true,
    });
  }
  /** One visible vault, with permissions derived from the authenticated membership. */
  async getVault(principal: Principal, vaultId: VaultId): Promise<Vault> {
    await this.#vault(principal, vaultId, 'vault:read');
    const membership =
      principal.kind === 'system'
        ? undefined
        : await this.#db()
            .selectFrom('vault_members')
            .select('role')
            .where('vault_id', '=', idBytes(vaultId))
            .where('user_id', '=', idBytes(principal.userId))
            .executeTakeFirst();
    const result = await queryVault(this.#db(), vaultId, {
      role: membership?.role ?? null,
      isServerAdmin: principal.kind === 'user' && principal.isServerAdmin,
    });
    if (result === null) throw new ProblemError('not_found');
    return result;
  }
  /** One SQL-keyset node page. */
  async listNodes(
    principal: Principal,
    vaultId: VaultId,
    options: Partial<ListNodesQuery> = {},
  ): Promise<NodePage> {
    await this.#vault(principal, vaultId, 'vault:read');
    return queryNodes(
      this.#db(),
      await this.#options.cursors(),
      { vaultId, principalKey: this.#key(principal) },
      {
        ...options,
        kinds: options.kinds ?? ['category', 'note'],
        recursive: options.recursive ?? true,
        includeTrashed: options.includeTrashed ?? false,
        limit: options.limit ?? 200,
      },
    );
  }
  /** One visible category and its children. */
  async listChildren(
    principal: Principal,
    vaultId: VaultId,
    options: ListChildrenQuery,
  ): Promise<TreePage> {
    await this.#vault(principal, vaultId, 'vault:read');
    return queryChildren(
      this.#db(),
      await this.#options.cursors(),
      { vaultId, principalKey: this.#key(principal) },
      options,
    );
  }
  /** One live node of any kind, looked up without leaking a foreign vault. */
  async getNode(principal: Principal, nodeId: string): Promise<Node> {
    const row = await this.#db()
      .selectFrom('nodes')
      .select('vault_id')
      .where('id', '=', idBytes(nodeId))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) throw new ProblemError('not_found');
    const vaultId = vaultIdFromBytes(row.vault_id);
    await this.#vault(principal, vaultId, 'vault:read');
    const node = (
      await readNodeRows(this.#db(), row.vault_id, {
        where: sql`tree_paths.id = ${idBytes(nodeId)}`,
      })
    )[0];
    if (node === undefined) throw new ProblemError('not_found');
    return node;
  }
  /** Trash metadata is a vault read; mutation permissions remain separate. */
  async listTrash(
    principal: Principal,
    vaultId: VaultId,
    query: ListTrashQuery,
  ): Promise<TrashPage> {
    await this.#vault(principal, vaultId, 'vault:read');
    return queryTrash(
      this.#db(),
      await this.#options.cursors(),
      { vaultId, principalKey: this.#key(principal) },
      query,
    );
  }
  /** Incoming references are limited to the authorized target's own vault. */
  async listInboundLinks(
    principal: Principal,
    nodeId: string,
    query: ListInboundLinksQuery,
  ): Promise<InboundLinksPage> {
    const node = await this.getNode(principal, nodeId);
    return queryInbound(
      this.#db(),
      await this.#options.cursors(),
      { vaultId: node.vaultId, principalKey: this.#key(principal) },
      nodeId,
      query,
    );
  }
  /** A link-impact preview can expose only an authorized note. */
  async readNoteLinks(principal: Principal, noteId: NoteId): Promise<NoteLinks> {
    const vaultId = await this.#note(principal, noteId, 'vault:read');
    return queryNoteLinks(this.#db(), vaultId, noteId);
  }
  /** Incoming references use SQL keyset pagination within the authorized vault. */
  async readBacklinks(
    principal: Principal,
    noteId: NoteId,
    query: ListInboundLinksQuery,
  ): Promise<LinkPage> {
    const vaultId = await this.#note(principal, noteId, 'vault:read');
    return queryBacklinks(
      this.#db(),
      await this.#options.cursors(),
      { vaultId, noteId, principalKey: this.#key(principal) },
      query,
    );
  }
  /** A link-impact preview can expose only an authorized note. */
  async renameImpact(
    principal: Principal,
    noteId: string,
    query: RenameImpactQuery,
  ): Promise<RenameImpactResult> {
    const vaultId = await this.#note(principal, NoteId.parse(noteId));
    if (query.parentId !== undefined) await this.getNode(principal, query.parentId);
    return previewRename(this.#db(), vaultId, noteId, query);
  }
  /** Exact path first, then the database's case-insensitive path match; nearby names are suggestions. */
  async resolveNote(
    principal: Principal,
    ref: { readonly noteId: NoteId } | { readonly vaultId: VaultId; readonly path: string },
  ): Promise<ResolvedNote> {
    if ('noteId' in ref) {
      await this.#note(principal, ref.noteId);
      return { resolved: true, note: await this.getNode(principal, ref.noteId) };
    }
    await this.#vault(principal, ref.vaultId, 'note:read');
    const path = '/' + ref.path.normalize('NFC').replace(/^\/+/, '').replace(/\.md$/i, '');
    const matches = await readNodeRows(this.#db(), idBytes(ref.vaultId), {
      where: sql`tree_paths.kind = 'note' AND tree_paths.path = ${path}`,
    });
    const exact = matches.find((note) => note.path === path);
    if (exact !== undefined) return { resolved: true, note: exact };
    if (matches.length === 1 && matches[0] !== undefined)
      return { resolved: true, note: matches[0] };
    if (matches.length > 1) return { ambiguous: matches };
    const name = path.split('/').at(-1) ?? '';
    const suggestions = await readNodeRows(this.#db(), idBytes(ref.vaultId), {
      where: sql`tree_paths.kind = 'note' AND tree_paths.name = ${name}`,
      limit: LIMITS.LINK_CANDIDATES_MAX,
    });
    return { notFound: true, suggestions: suggestions.map((note) => note.path) };
  }
  /** The metadata and source identity are read from durable rows. */
  async readNoteMeta(principal: Principal, noteId: NoteId): Promise<NoteMeta> {
    await this.#note(principal, noteId);
    const meta = await readNoteMeta(this.#db(), noteId);
    if (meta === null) throw new ProblemError('not_found');
    return meta;
  }
  /** No freshness wait or live-document callback exists on the read core. */
  async readNoteMarkdown(
    principal: Principal,
    noteId: NoteId,
    options: SourceSelection & { readonly revision?: number } = {},
  ): Promise<NoteMarkdown> {
    const vaultId = await this.#note(principal, noteId);
    if (options.revision !== undefined) await this.#vault(principal, vaultId, 'history:read');
    const captured = await this.#db()
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (trx) => {
        const meta = await readNoteMeta(trx, noteId);
        const content =
          options.revision === undefined
            ? await readCommittedMarkdown(trx, idBytes(noteId))
            : await readRetainedRevision(trx, noteId, options.revision);
        if (meta === null || content === null) throw new ProblemError('not_found');
        return { meta, content };
      });
    const { meta, content } = captured;
    const headings =
      options.revision === undefined
        ? meta.headings
        : options.heading === undefined
          ? []
          : await this.#options.outline(content.markdown);
    const slice = selectSource(content.markdown, headings, options);
    const status = options.revision === undefined ? meta.projectionStatus : 'ok';
    return {
      ...slice,
      revision: content.revision,
      headRevision: meta.headRevision,
      contentHash: content.contentHash,
      projectionStatus: status,
      stale: options.revision === undefined && content.revision < meta.headRevision,
      meta,
    };
  }
  /** History pages share the live permission check even when their cursors predate revocation. */
  async listRevisions(
    principal: Principal,
    noteId: NoteId,
    options: Partial<ListRevisionsQuery> = {},
  ): Promise<RevisionPage> {
    await this.#note(principal, noteId, 'history:read');
    return queryRevisions(
      this.#db(),
      await this.#options.cursors(),
      { noteId, principalKey: this.#key(principal) },
      { ...options, limit: options.limit ?? LIMITS.REVISION_LIST_DEFAULT },
    );
  }
  /** An immutable retained revision can still become unreadable after membership removal. */
  async readRevision(
    principal: Principal,
    noteId: NoteId,
    revisionId: number,
  ): Promise<RevisionContent> {
    await this.#note(principal, noteId, 'history:read');
    const result = await queryRevision(this.#db(), noteId, revisionId);
    if (result === null) throw await revisionNotFound(this.#db(), noteId, revisionId);
    return result;
  }
  /** ACL vaults enter the ranking SQL before filtering, scoring, ordering or LIMIT. */
  async search(principal: Principal, query: SearchQuery, vaultId?: VaultId): Promise<SearchPage> {
    const allowed = await this.#accessible(principal, 'search:read');
    if (vaultId !== undefined) await this.#vault(principal, vaultId, 'search:read');
    const requested = query.vaultIds;
    const ids = allowed.filter(
      (id) =>
        (vaultId === undefined || id === vaultId) &&
        (requested === undefined || requested.includes(id)),
    );
    return this.#options.search.search(
      ids,
      query,
      await this.#options.cursors(),
      this.#key(principal),
    );
  }
  /** Attachment metadata uses the same authorization boundary as its bytes. */
  async listAttachments(
    principal: Principal,
    vaultId: VaultId,
    options: Partial<ListAttachmentsQuery> = {},
  ): Promise<AttachmentPage> {
    await this.#vault(principal, vaultId, 'attachment:read');
    return this.#options.attachments.list(
      principal,
      vaultId,
      {
        ...options,
        includeDeleted: options.includeDeleted ?? false,
        includeReferences: options.includeReferences ?? false,
        limit: options.limit ?? LIMITS.ATTACHMENT_LIST_DEFAULT,
      },
      await this.#options.cursors(),
      this.#key(principal),
    );
  }
  /** Metadata and reference expansion remain subject to live vault access. */
  async readAttachmentMeta(
    principal: Principal,
    vaultId: VaultId,
    attachmentId: string,
  ): ReturnType<AttachmentService['metadata']> {
    await this.#vault(principal, vaultId, 'attachment:read');
    return this.#options.attachments.metadata(principal, vaultId, attachmentId);
  }
  /** The authorized handle opens immutable stored bytes, never note runtime state. */
  async readAttachmentContent(
    principal: Principal,
    vaultId: VaultId,
    attachmentId: string,
  ): ReturnType<AttachmentService['content']> {
    await this.#vault(principal, vaultId, 'attachment:read');
    return this.#options.attachments.content(principal, vaultId, attachmentId);
  }
}
