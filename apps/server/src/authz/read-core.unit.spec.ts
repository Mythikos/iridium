/** ContentReadCore invokes the real authorization policy for every addressed and collection read. */
import {
  NoteId,
  SessionId,
  TokenId,
  UserId,
  VaultId,
  type Attachment,
  type Principal,
  type Role,
  type SearchQuery,
  type TokenPrincipal,
  type UserPrincipal,
} from '@iridium/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeDatabase, type FakeDatabase } from '../../test/support/fake-driver.ts';
import { idBytes } from '../auth/ids.ts';
import { ContentReadCore, type ContentReadCoreOptions } from '../content/read/index.ts';
import { CursorCodec } from '../mcp/cursor.ts';
import type { VaultRow } from '../vaults/dto.ts';
import { createAccessibleVaultIds } from './accessible-vaults.ts';
import { createAuthorizer, type MembershipLookup } from './authorize.ts';

const OWNER = UserId.parse('019948c4-0000-7000-8000-000000000001');
const VAULT_A = VaultId.parse('019948c4-0000-7000-8000-0000000000a0');
const VAULT_B = VaultId.parse('019948c4-0000-7000-8000-0000000000b0');
const NOTE = NoteId.parse('019948c4-0000-7000-8000-000000000010');
const ATTACHMENT_ID = '019948c4-0000-7000-8000-000000000020';
const QUERY: SearchQuery = { q: 'term', limit: 20, snippetChars: 240 };
const ADMIN: UserPrincipal = {
  kind: 'user',
  userId: OWNER,
  sessionId: SessionId.parse('019948c4-0000-7000-8000-0000000000aa'),
  sessionKind: 'web',
  isServerAdmin: true,
  authzVersion: 1,
  lastAuthenticatedAt: new Date(0),
};
const ATTACHMENT: Attachment = {
  id: ATTACHMENT_ID,
  vaultId: VAULT_A,
  sha256: 'a'.repeat(64),
  sizeBytes: 4,
  mime: 'text/plain',
  originalName: 'note.txt',
  pathHint: 'attachments/note.txt',
  inlineable: false,
  uploadedBy: { id: OWNER, displayName: 'Reader', colorHue: 42 },
  createdAt: '2026-09-20T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

function token(kind: 'pat' | 'oauth', overrides: Partial<TokenPrincipal> = {}): TokenPrincipal {
  return {
    kind: 'token',
    tokenKind: kind,
    tokenId: TokenId.parse('019948c4-0000-7000-8000-00000000f001'),
    publicTokenId: 'ABCDEFGHIJKLMNOP',
    userId: OWNER,
    clientId: kind === 'oauth' ? 'client' : null,
    consentId: kind === 'oauth' ? 'consent' : null,
    resource: kind === 'oauth' ? 'https://iridium.example/mcp/connect' : null,
    scopes: ['vault:read', 'note:read', 'history:read', 'attachment:read', 'search:read'],
    vaultScope: { all: true },
    isServerAdmin: false,
    adminOwned: true,
    surface: 'mcp',
    rateLimitPerHour: 3000,
    expiresAt: new Date(1),
    ...overrides,
  };
}

function vaultRow(id: VaultId): VaultRow {
  return {
    id: idBytes(id),
    name: id === VAULT_A ? 'Alpha' : 'Beta',
    slug: id === VAULT_A ? 'alpha' : 'beta',
    description: null,
    root_node_id: idBytes(NOTE),
    status: 'active',
    archived_at: null,
    markdown_flavor: 'gfm',
    soft_breaks: false,
    attachment_folder: 'attachments',
    load_external_images: 'click',
    mcp_enabled: true,
    ai_guidance: null,
    trash_retention_days: 30,
    auto_checkpoint_interval_min: 30,
    tree_version: 1,
    version: 1,
    created_by: idBytes(OWNER),
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

class UnexpectedReadAdapterCall extends Error {
  constructor(detail: string) {
    super(`Unexpected read-core fixture I/O: ${detail}`);
    this.name = 'UnexpectedReadAdapterCall';
  }
}

const OPEN_DATABASES: FakeDatabase[] = [];
afterEach(async () => {
  await Promise.all(OPEN_DATABASES.splice(0).map((database) => database.db.destroy()));
});

function harness(surface: 'rest' | 'mcp' = 'rest') {
  const state = {
    roles: new Map<VaultId, Role>([[VAULT_A, 'viewer']]),
    mcpServer: true,
    mcpVaults: new Map<VaultId, boolean>([
      [VAULT_A, true],
      [VAULT_B, true],
    ]),
    membershipReads: [] as { vaultId: VaultId; userId: string }[],
    attachmentCalls: [] as string[],
    searchCalls: [] as { vaultIds: readonly VaultId[]; principalKey: string; query: SearchQuery }[],
  };
  const lookup: MembershipLookup = async (vaultId, userId) => {
    state.membershipReads.push({ vaultId, userId });
    const role = state.roles.get(vaultId);
    return {
      vault: { id: vaultId, status: 'active', mcp_enabled: state.mcpVaults.get(vaultId) ?? true },
      member: role === undefined ? null : { role, version: 1 },
    };
  };
  const authorizer = createAuthorizer({
    lookup,
    now: () => 0,
    stepUpWindowMs: 600_000,
    mcpServerEnabled: () => state.mcpServer,
  });
  const fake = fakeDatabase({
    script: (query) => {
      // These are adapter rows, not a second authorization policy. Real Kysely still compiles
      // every ACL predicate; the deliberately stale candidate set exercises the core recheck.
      if (query.sql.startsWith('select `v`.`id` from `vaults` as `v`')) {
        return { rows: [{ id: idBytes(VAULT_A) }, { id: idBytes(VAULT_B) }] };
      }
      if (
        query.sql.startsWith('select `n`.`vault_id`') ||
        query.sql.startsWith('select `vault_id` from `nodes`')
      ) {
        return { rows: [{ vault_id: idBytes(VAULT_A) }] };
      }
      if (query.sql.startsWith('select `vaults`.`id`') && query.sql.includes('`note_count`')) {
        return {
          rows: [VAULT_A, VAULT_B]
            .filter((id) =>
              query.parameters.some((value) => Buffer.isBuffer(value) && value.equals(idBytes(id))),
            )
            .map((id) =>
              Object.assign(vaultRow(id), {
                caller_role: state.roles.get(id) ?? null,
                note_count: 1,
              }),
            ),
        };
      }
      throw new UnexpectedReadAdapterCall(query.sql);
    },
  });
  OPEN_DATABASES.push(fake);
  const codec = new CursorCodec({
    keyring: {
      versions: new Map([[1, new Uint8Array(32).fill(1)]]),
      highest: 1,
      sources: new Map(),
    },
    signingVersion: 1,
    now: () => 0,
  });
  const attachments: ContentReadCoreOptions['attachments'] = {
    list: async () => {
      state.attachmentCalls.push('list');
      return { items: [ATTACHMENT] };
    },
    metadata: async () => {
      state.attachmentCalls.push('metadata');
      return ATTACHMENT;
    },
    content: async () => {
      state.attachmentCalls.push('content');
      return {
        attachment: ATTACHMENT,
        open: () => {
          throw new UnexpectedReadAdapterCall('opening immutable bytes');
        },
      };
    },
  };
  const core = new ContentReadCore({
    database: () => fake.db,
    authorize: authorizer.authorize,
    accessibleVaultIds: createAccessibleVaultIds({
      db: () => fake.db,
      mcpServerEnabled: () => state.mcpServer,
    }),
    cursors: async () => codec,
    attachments,
    surface,
    outline: async () => [],
    search: {
      search: async (vaultIds, query, _codec, principalKey) => {
        state.searchCalls.push({ vaultIds, query, principalKey });
        return {
          results: [],
          query: { raw: query.q, terms: [query.q], phrases: [], negations: [], operators: {} },
        };
      },
    },
  });
  return { core, state, fake };
}

const ADDRESSED_READS: readonly {
  name: string;
  read: (core: ContentReadCore, principal: Principal) => Promise<unknown>;
}[] = [
  { name: 'vault', read: (core, principal) => core.getVault(principal, VAULT_A) },
  { name: 'nodes', read: (core, principal) => core.listNodes(principal, VAULT_A) },
  {
    name: 'children',
    read: (core, principal) => core.listChildren(principal, VAULT_A, { limit: 20 }),
  },
  { name: 'node', read: (core, principal) => core.getNode(principal, NOTE) },
  { name: 'trash', read: (core, principal) => core.listTrash(principal, VAULT_A, { limit: 20 }) },
  {
    name: 'inbound links',
    read: (core, principal) => core.listInboundLinks(principal, NOTE, { limit: 20 }),
  },
  {
    name: 'rename impact',
    read: (core, principal) => core.renameImpact(principal, NOTE, { name: 'Next' }),
  },
  { name: 'outgoing note links', read: (core, principal) => core.readNoteLinks(principal, NOTE) },
  {
    name: 'backlinks',
    read: (core, principal) => core.readBacklinks(principal, NOTE, { limit: 20 }),
  },
  {
    name: 'note id lookup',
    read: (core, principal) => core.resolveNote(principal, { noteId: NOTE }),
  },
  {
    name: 'note path lookup',
    read: (core, principal) => core.resolveNote(principal, { vaultId: VAULT_A, path: 'Target' }),
  },
  { name: 'note metadata', read: (core, principal) => core.readNoteMeta(principal, NOTE) },
  { name: 'committed Markdown', read: (core, principal) => core.readNoteMarkdown(principal, NOTE) },
  {
    name: 'retained Markdown',
    read: (core, principal) => core.readNoteMarkdown(principal, NOTE, { revision: 7 }),
  },
  { name: 'revision list', read: (core, principal) => core.listRevisions(principal, NOTE) },
  { name: 'revision', read: (core, principal) => core.readRevision(principal, NOTE, 7) },
  { name: 'attachment list', read: (core, principal) => core.listAttachments(principal, VAULT_A) },
  {
    name: 'attachment metadata',
    read: (core, principal) => core.readAttachmentMeta(principal, VAULT_A, ATTACHMENT_ID),
  },
  {
    name: 'attachment content',
    read: (core, principal) => core.readAttachmentContent(principal, VAULT_A, ATTACHMENT_ID),
  },
  { name: 'addressed search', read: (core, principal) => core.search(principal, QUERY, VAULT_A) },
];

describe('authz.read-core.unit [area:authz] [hp:HP-3]', () => {
  it.each(ADDRESSED_READS)(
    'enforces membership inside the $name core call for both administrator-owned token kinds',
    async ({ read }) => {
      const fixture = harness();
      fixture.state.roles.clear();
      await expect(read(fixture.core, token('pat'))).rejects.toMatchObject({
        code: 'not_found',
        status: 404,
      });
      await expect(read(fixture.core, token('oauth'))).rejects.toMatchObject({
        code: 'not_found',
        status: 404,
      });
      expect(fixture.state.attachmentCalls).toEqual([]);
      expect(fixture.state.searchCalls).toEqual([]);
      expect(
        fixture.fake.executed.filter((query) =>
          /note_projections|note_revisions|attachment_refs/.test(query.sql),
        ),
      ).toEqual([]);
      expect(fixture.state.membershipReads.every((lookup) => lookup.userId === OWNER)).toBe(true);
    },
  );

  it.each(['pat', 'oauth'] as const)(
    '%s checks current membership and scope again when an authorized attachment is read later',
    async (kind) => {
      const fixture = harness();
      const principal = token(kind);
      await expect(
        fixture.core.readAttachmentMeta(principal, VAULT_A, ATTACHMENT_ID),
      ).resolves.toEqual(ATTACHMENT);
      fixture.state.roles.delete(VAULT_A);
      await expect(
        fixture.core.readAttachmentMeta(principal, VAULT_A, ATTACHMENT_ID),
      ).rejects.toMatchObject({ code: 'not_found' });
      fixture.state.roles.set(VAULT_A, 'viewer');
      await expect(
        fixture.core.readAttachmentMeta(
          { ...principal, scopes: ['note:read'] },
          VAULT_A,
          ATTACHMENT_ID,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        fixture.core.readAttachmentMeta(
          { ...principal, vaultScope: { vaultIds: [VAULT_B] } },
          VAULT_A,
          ATTACHMENT_ID,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(fixture.state.attachmentCalls).toEqual(['metadata']);
    },
  );

  it('distinguishes an administrator session from its tokens without creating implied token membership', async () => {
    const fixture = harness();
    fixture.state.roles.clear();
    await expect(fixture.core.readAttachmentMeta(ADMIN, VAULT_A, ATTACHMENT_ID)).resolves.toEqual(
      ATTACHMENT,
    );
    await expect(
      fixture.core.readAttachmentMeta(token('pat'), VAULT_A, ATTACHMENT_ID),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      fixture.core.readAttachmentMeta(token('oauth'), VAULT_A, ATTACHMENT_ID),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(fixture.state.attachmentCalls).toEqual(['metadata']);
  });

  it.each(['pat', 'oauth'] as const)(
    '%s applies collection membership, token allowlist and requested filters before handing ids to search',
    async (kind) => {
      const fixture = harness();
      fixture.state.roles.set(VAULT_B, 'viewer');
      const principal = token(kind, { vaultScope: { vaultIds: [VAULT_A] } });
      await fixture.core.search(principal, { ...QUERY, vaultIds: [VAULT_A, VAULT_B] });
      expect(fixture.state.searchCalls[0]).toMatchObject({
        vaultIds: [VAULT_A],
        principalKey: `${kind === 'pat' ? 'pat' : 'oat'}:${principal.tokenId}`,
      });
      const acl = fixture.fake.executed[0];
      expect(acl?.sql).toContain('inner join `vault_members`');
      expect(acl?.sql).toContain('`vm`.`role` in (?, ?, ?)');
      expect(acl?.sql).toContain('`v`.`id` in (?)');
      expect(acl?.parameters).toContainEqual(idBytes(OWNER));
      expect(acl?.parameters).toContainEqual(idBytes(VAULT_A));
      expect(acl?.parameters).not.toContainEqual(idBytes(VAULT_B));
      await fixture.core.search(principal, {
        ...QUERY,
        vaultIds: [VAULT_B],
        cursor: 'opaque-prior-page',
      });
      expect(fixture.state.searchCalls[1]?.vaultIds).toEqual([]);
      fixture.state.roles.delete(VAULT_A);
      await fixture.core.search(principal, QUERY);
      expect(fixture.state.searchCalls[2]?.vaultIds).toEqual([]);
      await expect(fixture.core.search(principal, QUERY, VAULT_A)).rejects.toMatchObject({
        code: 'not_found',
      });
    },
  );

  it('keeps collection revocation and scope loss effective even when the adapter returns stale candidate ids', async () => {
    const fixture = harness();
    const principal = token('pat');
    expect(
      (await fixture.core.listVaults(principal)).map((vault) => [vault.id, vault.effectiveRole]),
    ).toEqual([[VAULT_A, 'viewer']]);
    const listing = fixture.fake.executed.find((query) => query.sql.includes('`note_count`'));
    expect(listing?.sql).toContain('`vaults`.`id` in (?)');
    expect(listing?.parameters).toContainEqual(idBytes(VAULT_A));
    expect(listing?.parameters).not.toContainEqual(idBytes(VAULT_B));
    fixture.state.roles.clear();
    await expect(fixture.core.listVaults(principal)).resolves.toEqual([]);
    const before = fixture.fake.executed.length;
    await expect(fixture.core.listVaults({ ...principal, scopes: ['note:read'] })).resolves.toEqual(
      [],
    );
    expect(fixture.fake.executed).toHaveLength(before);
  });

  it('requires history permission before reading a retained Markdown revision', async () => {
    const fixture = harness();
    const principal = token('pat', { scopes: ['note:read'] });
    await expect(
      fixture.core.readNoteMarkdown(principal, NOTE, { revision: 7 }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(fixture.fake.executed).toHaveLength(1);
    expect(fixture.fake.executed[0]?.sql).toContain('`n`.`vault_id`');
    expect(fixture.state.membershipReads).toHaveLength(2);
  });

  it('applies both live MCP switches without affecting REST reads of the same membership', async () => {
    const fixture = harness('mcp');
    const principal = token('oauth');
    await expect(
      fixture.core.readAttachmentMeta(principal, VAULT_A, ATTACHMENT_ID),
    ).resolves.toEqual(ATTACHMENT);
    fixture.state.mcpVaults.set(VAULT_A, false);
    await expect(
      fixture.core.readAttachmentMeta(principal, VAULT_A, ATTACHMENT_ID),
    ).rejects.toMatchObject({ code: 'not_found' });
    await fixture.core.search(principal, QUERY);
    expect(fixture.state.searchCalls.at(-1)?.vaultIds).toEqual([]);
    expect(fixture.fake.executed[0]?.sql).toContain('`v`.`mcp_enabled` = ?');
    fixture.state.mcpServer = false;
    const before = fixture.fake.executed.length;
    await fixture.core.search(principal, QUERY);
    expect(fixture.fake.executed).toHaveLength(before);
    const rest = harness('rest');
    rest.state.mcpServer = false;
    rest.state.mcpVaults.set(VAULT_A, false);
    await expect(rest.core.readAttachmentMeta(principal, VAULT_A, ATTACHMENT_ID)).resolves.toEqual(
      ATTACHMENT,
    );
  });
});
