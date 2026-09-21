/** Real M2 content and exhaustive request drivers shared by the two authorization matrices. */
import {
  API_ROUTES,
  AttachmentUploaded,
  HISTORY_GATED_SURFACES,
  Job,
  Node,
  NoteId,
  NoteRevision,
  REST_ROUTE_POLICIES,
  RestoredRevision,
  Vault,
  newId,
  routePermission,
  type ApiOperationId,
  type HistoryGatedSurface,
  type Permission,
  type PermissionOperationId,
  type RouteSpec,
} from '@iridium/contracts';
import { attachmentClient, waitFor, type RestClient, type RestResponse } from '@iridium/testkit';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { z } from 'zod';

import type { Database } from '../../src/db/index.ts';
import { webClient, type AuthTestServer } from './auth-app.ts';
import { documentedApiRoutes, servedApiRoutes } from './route-sources.ts';
import { seedUser, signInWeb, type SeededUser } from './seed.ts';

/** Existing resources, or syntactically identical identifiers that name nothing. */
export interface AuthorizationTarget {
  readonly vaultId: string;
  readonly rootNodeId: string;
  readonly nodeId: string;
  readonly noteId: string;
  readonly trashedId: string;
  readonly archivedVaultId: string;
  readonly userId: string;
  readonly attachmentId: string;
  readonly revisionId: number;
  readonly revisionSeq: number;
  readonly jobId: string;
}

/** Every request uses the authenticated transport, including CSRF and multipart framing. */
export interface AuthorizationCase {
  request(client: RestClient, target: AuthorizationTarget): Promise<RestResponse>;
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);

/** The type comes from the production policy registry; adding a permission route requires a case. */
export const AUTHORIZATION_CASES = {
  'vaults.create': {
    request: (client) => client.post('/vaults', { json: { name: 'Refused vault' } }),
  },
  'vaults.get': { request: (client, target) => client.get(`/vaults/${target.vaultId}`) },
  'members.list': { request: (client, target) => client.get(`/vaults/${target.vaultId}/members`) },
  'members.put': {
    request: (client, target) =>
      client.put(`/vaults/${target.vaultId}/members/${target.userId}`, {
        json: { role: 'editor' },
      }),
  },
  'members.delete': {
    request: (client, target) =>
      client.del(`/vaults/${target.vaultId}/members/${target.userId}`, { ifMatch: 1 }),
  },
  'nodes.create': {
    request: (client, target) =>
      client.post(`/vaults/${target.vaultId}/nodes`, {
        json: {
          kind: 'note',
          parentId: target.rootNodeId,
          name: 'Refused note',
          markdown: '# Refused\n',
        },
      }),
  },
  'notes.renameImpact': {
    request: (client, target) =>
      client.get(`/notes/${target.noteId}/rename-impact`, { query: { name: 'Renamed' } }),
  },
  'tree.listChildren': {
    request: (client, target) =>
      client.get(`/vaults/${target.vaultId}/tree`, { query: { parent: target.rootNodeId } }),
  },
  'nodes.list': { request: (client, target) => client.get(`/vaults/${target.vaultId}/nodes`) },
  'nodes.get': { request: (client, target) => client.get(`/nodes/${target.nodeId}`) },
  'nodes.update': {
    request: (client, target) =>
      client.patch(`/nodes/${target.nodeId}`, { ifMatch: 1, json: { name: 'Refused rename' } }),
  },
  'nodes.trash': {
    request: (client, target) =>
      client.post(`/nodes/${target.nodeId}/trash`, { ifMatch: 1, json: { recursive: true } }),
  },
  'nodes.restore': {
    request: (client, target) =>
      client.post(`/nodes/${target.trashedId}/restore`, { ifMatch: 2, json: {} }),
  },
  'nodes.purge': {
    request: (client, target) =>
      client.del(`/nodes/${target.trashedId}`, { ifMatch: 2, query: { purge: 'true' } }),
  },
  'nodes.inboundLinks': {
    request: (client, target) => client.get(`/nodes/${target.nodeId}/inbound-links`),
  },
  'trash.list': { request: (client, target) => client.get(`/vaults/${target.vaultId}/trash`) },
  'vaults.update': {
    request: (client, target) =>
      client.patch(`/vaults/${target.vaultId}`, {
        ifMatch: 1,
        json: { name: 'Refused metadata', softBreaks: true },
      }),
  },
  'vaults.archive': {
    request: (client, target) =>
      client.post(`/vaults/${target.vaultId}/archive`, { ifMatch: 1, json: { confirm: true } }),
  },
  'vaults.unarchive': {
    request: (client, target) =>
      client.post(`/vaults/${target.archivedVaultId}/unarchive`, {
        ifMatch: 2,
        json: { confirm: true },
      }),
  },
  'notes.get': { request: (client, target) => client.get(`/notes/${target.noteId}`) },
  'notes.getMarkdown': {
    request: (client, target) => client.get(`/notes/${target.noteId}/markdown`),
  },
  'notes.participants': {
    request: (client, target) => client.get(`/notes/${target.noteId}/participants`),
  },
  'attachments.list': {
    request: (client, target) => client.get(`/vaults/${target.vaultId}/attachments`),
  },
  'attachments.upload': {
    request: (client, target) =>
      attachmentClient(client).upload({
        vaultId: target.vaultId,
        filename: 'refused.png',
        bytes: PNG,
        declaredMime: 'image/png',
      }),
  },
  'attachments.download': {
    request: (client, target) =>
      client.get(`/vaults/${target.vaultId}/attachments/${target.attachmentId}`),
  },
  'attachments.getMeta': {
    request: (client, target) =>
      client.get(`/vaults/${target.vaultId}/attachments/${target.attachmentId}/meta`),
  },
  'attachments.delete': {
    request: (client, target) =>
      client.del(`/vaults/${target.vaultId}/attachments/${target.attachmentId}`, { ifMatch: 1 }),
  },
  'admin.attachments.unreferenced': {
    request: (client, target) =>
      client.get('/admin/attachments/unreferenced', { query: { vaultId: target.vaultId } }),
  },
  'search.vault': {
    request: (client, target) =>
      client.get(`/vaults/${target.vaultId}/search`, { query: { q: 'needle' } }),
  },
  'admin.jobs.list': {
    request: (client, target) => client.get('/admin/jobs', { query: { vaultId: target.vaultId } }),
  },
  'admin.jobs.get': { request: (client, target) => client.get(`/admin/jobs/${target.jobId}`) },
  'admin.jobs.run': {
    request: (client, target) =>
      client.post('/admin/jobs/reindex/run', { json: { payload: { vaultId: target.vaultId } } }),
  },
  'admin.jobs.cancel': {
    request: (client, target) => client.post(`/admin/jobs/${target.jobId}/cancel`),
  },
  'revisions.list': {
    request: (client, target) => client.get(`/notes/${target.noteId}/revisions`),
  },
  'revisions.get': {
    request: (client, target) =>
      client.get(`/notes/${target.noteId}/revisions/${target.revisionId}`),
  },
  'revisions.create': {
    request: (client, target) =>
      client.post(`/notes/${target.noteId}/revisions`, { json: { label: 'Refused checkpoint' } }),
  },
  'revisions.restore': {
    request: (client, target) =>
      client.post(`/notes/${target.noteId}/revisions/${target.revisionId}/restore`, {
        json: { confirm: true },
      }),
  },
  'notes.links': { request: (client, target) => client.get(`/notes/${target.noteId}/links`) },
  'notes.backlinks': {
    request: (client, target) => client.get(`/notes/${target.noteId}/backlinks`),
  },
  'admin.users.list': { request: (client) => client.get('/admin/users') },
  'admin.users.create': {
    request: (client) =>
      client.post('/admin/users', {
        json: { email: 'refused@example.test', displayName: 'Refused' },
      }),
  },
  'admin.users.resetPassword': {
    request: (client, target) => client.post(`/admin/users/${target.userId}/reset-password`),
  },
  'admin.users.disable': {
    request: (client, target) =>
      client.post(`/admin/users/${target.userId}/disable`, { json: { reason: 'Refused' } }),
  },
  'admin.users.enable': {
    request: (client, target) => client.post(`/admin/users/${target.userId}/enable`),
  },
} satisfies Record<PermissionOperationId, AuthorizationCase>;

type AdminFlagOperation = {
  [Id in ApiOperationId]: (typeof REST_ROUTE_POLICIES)[Id] extends { readonly serverAdmin: true }
    ? (typeof REST_ROUTE_POLICIES)[Id] extends { readonly permission: string }
      ? never
      : Id
    : never;
}[ApiOperationId];

/** Administrative documentation is protected by the server-admin flag, not a vault role. */
export const ADMIN_FLAG_CASES = {
  'meta.openapi': { request: (client) => client.get('/openapi.json') },
  'meta.docs': { request: (client) => client.get('/docs') },
} satisfies Record<AdminFlagOperation, AuthorizationCase>;

/** Session-only filters intersect the accessible set instead of resolving a single vault. */
export const SESSION_RESOURCE_CASES = {
  'search.all': {
    request: (client, target) =>
      client.get('/search', { query: { q: 'needle', vaultIds: target.vaultId } }),
  },
} satisfies Record<Extract<ApiOperationId, 'search.all'>, AuthorizationCase>;

/** Extra authorization on a query parameter must be covered as explicitly as a separate route. */
export interface HistoryCase extends AuthorizationCase {
  readonly operationId: PermissionOperationId;
  readonly permission: Permission;
}

/** D10-39's closed union is shared with the product and both test matrices. */
export const HISTORY_CASES = {
  'revisions.list': {
    ...AUTHORIZATION_CASES['revisions.list'],
    operationId: 'revisions.list',
    permission: 'history:read',
  },
  'revisions.get': {
    ...AUTHORIZATION_CASES['revisions.get'],
    operationId: 'revisions.get',
    permission: 'history:read',
  },
  'revisions.create': {
    ...AUTHORIZATION_CASES['revisions.create'],
    operationId: 'revisions.create',
    permission: 'revision:name',
  },
  'revisions.restore': {
    ...AUTHORIZATION_CASES['revisions.restore'],
    operationId: 'revisions.restore',
    permission: 'history:restore',
  },
  'notes.markdown.revision': {
    operationId: 'notes.getMarkdown',
    permission: 'history:read',
    request: (client, target) =>
      client.get(`/notes/${target.noteId}/markdown`, { query: { revision: target.revisionSeq } }),
  },
  'nodes.list.includeTrashed': {
    operationId: 'nodes.list',
    permission: 'history:read',
    request: (client, target) =>
      client.get(`/vaults/${target.vaultId}/nodes`, { query: { includeTrashed: true } }),
  },
  'trash.list': {
    ...AUTHORIZATION_CASES['trash.list'],
    operationId: 'trash.list',
    permission: 'history:read',
  },
} satisfies Record<HistoryGatedSurface, HistoryCase>;

/** All fixture state reaches the real REST, worker, collaboration and SQL paths. */
export interface AuthorizationFixture {
  readonly target: AuthorizationTarget;
  readonly admin: SeededUser;
  readonly viewer: SeededUser;
  readonly outsider: SeededUser;
  readonly adminClient: RestClient;
  readonly viewerClient: RestClient;
  readonly outsiderClient: RestClient;
}

function requireStatus(response: RestResponse, expected: number): void {
  if (response.status !== expected)
    throw new Error(
      `Authorization fixture ${response.url}: expected ${expected}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
}

/** Seed fresh identities and real active/archived content for any authorization case. */
export async function seedAuthorization(context: AuthTestServer): Promise<AuthorizationFixture> {
  const identity = newId();
  const admin = await seedUser(context, {
    email: `authorization-admin-${identity}@example.test`,
    isServerAdmin: true,
  });
  const viewer = await seedUser(context, {
    email: `authorization-viewer-${identity}@example.test`,
  });
  const outsider = await seedUser(context, {
    email: `authorization-outsider-${identity}@example.test`,
  });
  const spare = await seedUser(context, { email: `authorization-spare-${identity}@example.test` });
  const adminClient = webClient(context, await signInWeb(context, admin));
  const viewerClient = webClient(context, await signInWeb(context, viewer));
  const outsiderClient = webClient(context, await signInWeb(context, outsider));
  const created = await adminClient.post('/vaults', {
    json: {
      name: 'Authorization Vault',
      members: [
        { userId: viewer.id, role: 'viewer' },
        { userId: spare.id, role: 'editor' },
      ],
    },
  });
  requireStatus(created, 201);
  const vault = Vault.parse(created.body);
  const categoryResponse = await adminClient.post(`/vaults/${vault.id}/nodes`, {
    json: { kind: 'category', parentId: vault.rootNodeId, name: 'Category' },
  });
  requireStatus(categoryResponse, 201);
  const category = Node.parse(categoryResponse.body);
  const noteResponse = await adminClient.post(`/vaults/${vault.id}/nodes`, {
    json: {
      kind: 'note',
      parentId: category.id,
      name: 'Secret',
      markdown: '# Private needle\n\n[Self](Secret.md)\n',
    },
  });
  requireStatus(noteResponse, 201);
  const note = Node.parse(noteResponse.body);
  const sourceResponse = await adminClient.post(`/vaults/${vault.id}/nodes`, {
    json: {
      kind: 'note',
      parentId: vault.rootNodeId,
      name: 'Source',
      markdown: '[Reference](Category/Secret.md)\n',
    },
  });
  requireStatus(sourceResponse, 201);
  const trashResponse = await adminClient.post(`/vaults/${vault.id}/nodes`, {
    json: {
      kind: 'note',
      parentId: vault.rootNodeId,
      name: 'Trashed',
      markdown: '# Retained trash\n',
    },
  });
  requireStatus(trashResponse, 201);
  const trashed = Node.parse(trashResponse.body);
  requireStatus(
    await adminClient.post(`/nodes/${trashed.id}/trash`, {
      ifMatch: trashed.version,
      json: { recursive: false },
    }),
    200,
  );
  const named = await adminClient.post(`/notes/${note.id}/revisions`, {
    json: { label: 'Secret checkpoint' },
  });
  requireStatus(named, 201);
  const revision = NoteRevision.parse(named.body);
  const uploaded = await attachmentClient(adminClient).upload({
    vaultId: vault.id,
    filename: 'private.png',
    bytes: PNG,
    declaredMime: 'image/png',
  });
  requireStatus(uploaded, 201);
  const attachment = AttachmentUploaded.parse(uploaded.body).attachment;
  const scheduled = await adminClient.post('/admin/jobs/reindex/run', {
    json: { payload: { vaultId: vault.id } },
  });
  requireStatus(scheduled, 202);
  const job = Job.parse(scheduled.body);
  const archiveCreated = await adminClient.post('/vaults', {
    json: {
      name: 'Archived Authorization Vault',
      members: [{ userId: viewer.id, role: 'viewer' }],
    },
  });
  requireStatus(archiveCreated, 201);
  const archived = Vault.parse(archiveCreated.body);
  requireStatus(
    await adminClient.post(`/vaults/${archived.id}/archive`, {
      ifMatch: archived.version,
      json: { confirm: true },
    }),
    200,
  );
  return {
    admin,
    viewer,
    outsider,
    adminClient,
    viewerClient,
    outsiderClient,
    target: {
      vaultId: vault.id,
      rootNodeId: vault.rootNodeId,
      nodeId: category.id,
      noteId: note.id,
      trashedId: trashed.id,
      archivedVaultId: archived.id,
      userId: spare.id,
      attachmentId: attachment.id,
      revisionId: revision.id,
      revisionSeq: revision.revision,
      jobId: job.id,
    },
  };
}

/** Produce both a named and a changed restore revision through normal product writes. */
export async function seedRestoredHistory(
  context: AuthTestServer,
  fixture: AuthorizationFixture,
): Promise<void> {
  const writer = await context.server.client(
    { ...fixture.admin, displayName: 'Authorization administrator', isServerAdmin: true },
    fixture.target.noteId,
  );
  try {
    await writer.waitFor('saved');
    writer.typeAt(writer.text.length, 'Changed after the checkpoint.\n');
    await writer.waitForAck();
    const response = await fixture.adminClient.post(
      `/notes/${fixture.target.noteId}/revisions/${fixture.target.revisionId}/restore`,
      { json: { confirm: true } },
    );
    requireStatus(response, 200);
    const restored = RestoredRevision.parse(response.body);
    if (!restored.changed) throw new Error('History fixture did not produce a changed restore.');
    await writer.waitFor('saved');
  } finally {
    await writer.close();
    await waitFor(
      () =>
        context.app.collab.persistence.writerOf(NoteId.parse(fixture.target.noteId)) === undefined,
      { timeoutMs: 15_000, description: 'the restored fixture note to complete its real unload' },
    );
  }
}

/** Random valid ids, with numeric revision ids and sequences beyond the small fixture's range. */
export function absentAuthorizationTarget(): AuthorizationTarget {
  return {
    vaultId: newId(),
    rootNodeId: newId(),
    nodeId: newId(),
    noteId: newId(),
    trashedId: newId(),
    archivedVaultId: newId(),
    userId: newId(),
    attachmentId: newId(),
    revisionId: 9_000_000_001,
    revisionSeq: 9_000_000_001,
    jobId: newId(),
  };
}

/** Complete schema inventory: observability is the one explicit denial-write exception (D10-39). */
const TABLE_COUNT_POLICY = {
  access_log: 'observability',
  access_token_vaults: 'immutable',
  access_tokens: 'immutable',
  attachments: 'immutable',
  audit_chain_heads: 'immutable',
  audit_events: 'immutable',
  audit_events_archive: 'immutable',
  collab_owner_fence: 'immutable',
  desktop_releases: 'immutable',
  export_jobs: 'immutable',
  import_jobs: 'immutable',
  jobs: 'immutable',
  kysely_migration: 'immutable',
  kysely_migration_lock: 'immutable',
  login_throttle: 'immutable',
  nodes: 'immutable',
  note_docs: 'immutable',
  note_links: 'immutable',
  note_projection_terms: 'immutable',
  note_projections: 'immutable',
  note_revisions: 'immutable',
  note_search: 'immutable',
  note_updates: 'immutable',
  notes: 'immutable',
  oauth_authorization_codes: 'immutable',
  oauth_clients: 'immutable',
  oauth_consent_vaults: 'immutable',
  oauth_consents: 'immutable',
  oauth_refresh_tokens: 'immutable',
  password_setup_tokens: 'immutable',
  schema_meta: 'immutable',
  server_settings: 'immutable',
  sessions: 'immutable',
  session_revocation_commands: 'immutable',
  trash_entries: 'immutable',
  user_credentials: 'immutable',
  users: 'immutable',
  vault_members: 'immutable',
  vaults: 'immutable',
} satisfies Record<keyof Database, 'immutable' | 'observability'>;

/** One read-only transaction observes every business/audit count from the same committed snapshot. */
export async function authorizationRowCounts(
  context: AuthTestServer,
): Promise<Readonly<Record<string, number>>> {
  return context.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (transaction) => {
      const counts: Record<string, number> = {};
      for (const table of Object.keys(TABLE_COUNT_POLICY).filter(isDatabaseTable)) {
        if (TABLE_COUNT_POLICY[table] === 'observability') continue;
        // eslint-disable-next-line no-await-in-loop -- sequential reads share one transaction snapshot and one connection
        const row = await transaction
          .selectFrom(table)
          .select((builder) => builder.fn.countAll().as('rows'))
          .executeTakeFirstOrThrow();
        counts[table] = Number(row.rows);
      }
      return counts;
    });
}

function isDatabaseTable(table: string): table is keyof Database {
  return Object.hasOwn(TABLE_COUNT_POLICY, table);
}

/** The manifest binds the request driver to the production policy and documented responses. */
export interface PermissionCaseEntry {
  readonly operationId: PermissionOperationId;
  readonly route: RouteSpec;
  readonly permission: Permission;
  readonly testCase: AuthorizationCase;
}

/** Throws at collection if a typed request case has no actual manifest entry. */
export function permissionCaseEntries(): readonly PermissionCaseEntry[] {
  return Object.keys(AUTHORIZATION_CASES)
    .filter(isPermissionOperationId)
    .map((operationId) => {
      const route = API_ROUTES.find((entry) => entry.operationId === operationId);
      if (route === undefined) throw new Error(`Missing manifest route ${operationId}.`);
      const permission = routePermission(route.auth);
      if (permission === null) throw new Error(`Missing permission for ${operationId}.`);
      return { operationId, route, permission, testCase: AUTHORIZATION_CASES[operationId] };
    });
}

function isPermissionOperationId(operationId: string): operationId is PermissionOperationId {
  return Object.hasOwn(AUTHORIZATION_CASES, operationId);
}

function containsResourceIdProperty(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return value.some(containsResourceIdProperty);
  const properties: unknown = Reflect.get(value, 'properties');
  if (
    typeof properties === 'object' &&
    properties !== null &&
    Object.keys(properties).some((key) => /^(?:vault|node|note|attachment|job)Ids?$/.test(key))
  )
    return true;
  return Object.values(value).some(containsResourceIdProperty);
}

/** Path, body and query identifiers come from the same schemas the live routes validate. */
export function isResourceIdRoute(route: RouteSpec): boolean {
  return (
    (typeof route.auth === 'object' && 'vaultFrom' in route.auth) ||
    /:(?:vault|node|note|attachment|job)Id\b/.test(route.path) ||
    [route.request?.query, route.request?.body].some(
      (schema) =>
        schema !== undefined &&
        containsResourceIdProperty(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })),
    ) ||
    // This route validates type-specific persisted inputs after the generic record boundary.
    route.operationId === 'admin.jobs.run'
  );
}

/** Check all independently maintained inventories, including each actual registered auth policy. */
export function expectAuthorizationInventory(app: FastifyInstance): void {
  expect(servedApiRoutes(app)).toStrictEqual(documentedApiRoutes());
  expect(API_ROUTES.map((route) => route.operationId).toSorted()).toEqual(
    Object.keys(REST_ROUTE_POLICIES).toSorted(),
  );
  expect(
    API_ROUTES.filter((route) => routePermission(route.auth) !== null)
      .map((route) => route.operationId)
      .toSorted(),
  ).toEqual(Object.keys(AUTHORIZATION_CASES).toSorted());
  expect(Object.keys(HISTORY_CASES).toSorted()).toEqual([...HISTORY_GATED_SURFACES].toSorted());
  const manifest = API_ROUTES.filter((route) => route.mount === '/api/v1')
    .map((route) => `${route.method} ${route.mount}${route.path.replaceAll(/:([^/]+)/g, '{$1}')}`)
    .toSorted((left, right) => left.localeCompare(right));
  expect(manifest).toStrictEqual(servedApiRoutes(app));
  for (const route of API_ROUTES) {
    const registered = app
      .routes()
      .find(
        (candidate) =>
          candidate.method === route.method &&
          candidate.url.replace(/\/$/, '') === `${route.mount}${route.path}`,
      );
    expect(registered).toBeDefined();
    expect({ operationId: route.operationId, auth: registered?.auth }).toEqual({
      operationId: route.operationId,
      auth: route.auth,
    });
  }
}
