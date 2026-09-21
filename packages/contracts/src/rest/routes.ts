import type { z } from 'zod';
/**
 * `API_ROUTES` — the implemented M1/M2 route set as data (12-milestones.md §§5.2/6.2;
 * 09-api-reference.md sections 2.18 and 6).
 *
 * One table, three consumers, and that is the point. The `rest` plugin registers exactly these rows
 * (`applyXRoutes(app, deps)` per area reads the row for its own operation, so a route cannot be
 * registered with a schema the document does not describe); `openapi.coverage.contract` walks the same
 * rows to assert every documented `(operationId, status)` pair was exercised; and
 * `rest.route-index.contract` compares them with the two markdown tables of section 2.18. A route that
 * exists in one and not the others is a red lane rather than an undocumented endpoint.
 *
 * The rows carry the `config.auth` value verbatim, which is what the OpenAPI `x-iridium-auth`
 * extension publishes and what the boot assertion of 04-auth-and-access-control.md section 6.2 walks.
 * Nothing here is a second spelling of a policy: `auth` is a `RouteAuth`, `errors` are `ErrorCode`s and
 * every schema is the one its domain module exports.
 */

import type { RouteAuth } from '../authz.ts';
import type { ErrorCode, ProblemVariant } from '../errors.ts';
import {
  AdminUserCreated,
  AdminUserPasswordReset,
  AdminUserPage,
  CreateAdminUserBody,
  DisableUserBody,
  ListAdminUsersQuery,
} from './admin-users.ts';
import { M2_ATTACHMENT_ROUTES } from './attachment-routes.ts';
import {
  CollabTicketsCreated,
  CreateCollabTicketsBody,
  CreateSessionBody,
  ReauthenticateBody,
  Reauthenticated,
  SessionCreated,
  SetPasswordBody,
} from './auth.ts';
import {
  ClientHeaders,
  IfMatchHeaders,
  Me,
  Member,
  Node,
  NoteMeta,
  User,
  Vault,
} from './common.ts';
import { M2_JOB_ROUTES } from './job-routes.ts';
import { M2_LINK_ROUTES } from './link-routes.ts';
import { ChangePasswordBody, SessionList, UpdateMeBody } from './me.ts';
import { MemberList, PutMemberBody } from './members.ts';
import { Meta } from './meta.ts';
import { CreateNodeBody } from './nodes.ts';
import { GetMarkdownQuery, NoteParticipants } from './notes.ts';
import { HealthzBody, ReadyzBody } from './ops.ts';
import {
  NoteIdParams,
  SessionIdParams,
  UserIdParams,
  VaultIdParams,
  VaultMemberParams,
} from './params.ts';
import { M2_REVISION_ROUTES } from './revision-routes.ts';
import { REST_ROUTE_POLICIES } from './route-policies.ts';
import type { ApiOperationId } from './route-policies.ts';
import { M2_SEARCH_ROUTES } from './search-routes.ts';
import { M2_TREE_ROUTES } from './tree-routes.ts';
import { CreateVaultBody, ListVaultsQuery, VaultSummaryList } from './vaults.ts';

/** The HTTP methods the REST surface uses. */
export type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The OpenAPI tag a route carries: one per domain (09-api-reference.md section 6). */
export type RouteTag =
  | 'auth'
  | 'meta'
  | 'me'
  | 'vaults'
  | 'members'
  | 'nodes'
  | 'notes'
  | 'attachments'
  | 'search'
  | 'revisions'
  | 'jobs'
  | 'admin'
  | 'ops';

/** Which plugin registers a row: the `rest` plugin, or the `ops` plugin outside `/api/v1`. */
export type RoutePlugin = 'rest' | 'ops';

/** Where a row is mounted. Published URLs carry no path version and never will (D09-31). */
export type RouteMount = '/api/v1' | '';

/**
 * A rate-limit bucket of 09-api-reference.md section 1.8. An absent bucket means the default pair —
 * 600/min per principal when authenticated, 60/min per IP when not.
 */
export type RateLimitBucket = 'login' | 'collab-tickets' | 'fresh-markdown' | 'pat';

/** What a response body is. Not every route answers JSON, and `204` answers nothing at all. */
export type ResponseBody =
  | { readonly kind: 'json'; readonly schema: z.ZodType }
  | { readonly kind: 'empty' }
  | { readonly kind: 'markdown' }
  | { readonly kind: 'binary'; readonly contentTypes: readonly string[] }
  /** A non-JSON text body: the Swagger UI page, the Prometheus exposition format. */
  | { readonly kind: 'text'; readonly contentType: string }
  /**
   * A JSON body with no Iridium schema: the OpenAPI document, which is described by its own
   * meta-schema and would be a circular reference if this table tried to describe it.
   */
  | { readonly kind: 'opaque-json'; readonly description: string };

/**
 * The validator a response carries. `strong-version` is `"<version>"` — the value `If-Match` compares
 * against; `strong-revision-hash` is `"<revision>:<contentHash>"`; `weak-version-revision` is
 * `W/"<version>:<revision>"`, for cache validation only, which is why a client takes the `If-Match`
 * value from the body instead (section 1.2).
 */
export type ResponseEtag =
  | 'strong-version'
  | 'strong-revision-hash'
  | 'weak-version-revision'
  | 'strong-hash';

/** A response-to-operation relationship, with OpenAPI runtime expressions for known values. */
export interface RouteResponseLink {
  readonly operationId: string;
  readonly parameters?: Readonly<Record<string, string>> | undefined;
  /** Partial object bodies merge with generated fields in the pinned stateful runner. */
  readonly requestBody?: Readonly<Record<string, unknown>> | undefined;
}

/** One documented success response. */
export interface RouteResponse {
  readonly status: number;
  readonly body: ResponseBody;
  readonly etag?: ResponseEtag | undefined;
  /** The `Location` header a `201` carries, with `<id>` standing for the created row's id. */
  readonly location?: string | undefined;
  /** Shipped relationships from the REST link graph in 10-testing-and-quality.md. */
  readonly links?: Readonly<Record<string, RouteResponseLink>> | undefined;
}

/** The request schemas a route validates. An absent member means the route takes none. */
export interface RouteRequest {
  readonly params?: z.ZodType | undefined;
  readonly query?: z.ZodType | undefined;
  readonly body?: z.ZodType | undefined;
  readonly headers?: z.ZodType | undefined;
}

/** One route of the milestone. */
export interface RouteSpec {
  /** `<domain>.<verb>`, stable for the life of the route (section 6). */
  readonly operationId: ApiOperationId;
  readonly method: RouteMethod;
  /** The path as Fastify registers it, relative to `mount`, with `:params`. */
  readonly path: string;
  readonly mount: RouteMount;
  readonly plugin: RoutePlugin;
  readonly tag: RouteTag;
  /** The `config.auth` value the route declares, verbatim. */
  readonly auth: RouteAuth;
  readonly request: RouteRequest;
  readonly responses: readonly RouteResponse[];
  /** The route-specific `ProblemDetails` codes, beyond `GLOBAL_ERROR_CODES`. */
  readonly errors: readonly ErrorCode[];
  readonly problemVariants?: readonly ProblemVariant[];
  readonly ifMatch?: 'required' | 'conditional' | undefined;
  readonly rateLimit?: RateLimitBucket | undefined;
  /** One line of prose: what the route is for, and any narrowing this milestone applies. */
  readonly summary: string;
}

/**
 * The codes every `/api/v1` route can answer, so no row repeats them. `unauthenticated` is absent from
 * `public` rows and present everywhere else; the rest apply to every row alike.
 */
export const GLOBAL_ERROR_CODES: readonly ErrorCode[] = [
  'host_rejected',
  'client_outdated',
  'not_ready',
  'payload_too_large',
  // The request-line twin of `payload_too_large`: the parser refuses an oversized header block
  // (`HPE_HEADER_OVERFLOW`) before routing, so any row with a long query value can answer it and
  // no row can enumerate it for itself.
  'request_headers_too_large',
  'server_error',
];

const AUTH_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'auth.createSession',
    method: 'POST',
    path: '/auth/sessions',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'auth',
    auth: REST_ROUTE_POLICIES['auth.createSession'],
    request: { body: CreateSessionBody, headers: ClientHeaders },
    responses: [{ status: 201, body: { kind: 'json', schema: SessionCreated } }],
    errors: ['invalid_credentials', 'csrf_rejected', 'validation_failed', 'rate_limited'],
    rateLimit: 'login',
    summary: 'Sign in; issues a web cookie or a desktop bearer session.',
  },
  {
    operationId: 'auth.deleteCurrentSession',
    method: 'DELETE',
    path: '/auth/sessions/current',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'auth',
    auth: REST_ROUTE_POLICIES['auth.deleteCurrentSession'],
    request: { headers: ClientHeaders },
    responses: [{ status: 204, body: { kind: 'empty' } }],
    errors: ['unauthenticated', 'csrf_rejected'],
    summary: 'Sign out. Idempotent: an already-revoked credential also answers 204.',
  },
  {
    operationId: 'auth.reauthenticate',
    method: 'POST',
    path: '/auth/reauthenticate',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'auth',
    auth: REST_ROUTE_POLICIES['auth.reauthenticate'],
    request: { body: ReauthenticateBody, headers: ClientHeaders },
    responses: [{ status: 200, body: { kind: 'json', schema: Reauthenticated } }],
    errors: ['unauthenticated', 'invalid_credentials', 'csrf_rejected', 'rate_limited'],
    rateLimit: 'login',
    summary: 'Refresh the step-up window.',
  },
  {
    operationId: 'auth.setPassword',
    method: 'POST',
    path: '/auth/set-password',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'auth',
    auth: REST_ROUTE_POLICIES['auth.setPassword'],
    request: { body: SetPasswordBody, headers: ClientHeaders },
    responses: [{ status: 204, body: { kind: 'empty' } }],
    errors: ['invalid_link', 'csrf_rejected', 'validation_failed', 'rate_limited'],
    rateLimit: 'login',
    summary: 'Consume a one-time irid_spl_ link and set the credential.',
  },
  {
    operationId: 'auth.createCollabTickets',
    method: 'POST',
    path: '/auth/collab-tickets',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'auth',
    auth: REST_ROUTE_POLICIES['auth.createCollabTickets'],
    request: { body: CreateCollabTicketsBody, headers: ClientHeaders },
    responses: [{ status: 201, body: { kind: 'json', schema: CollabTicketsCreated } }],
    errors: ['unauthenticated', 'csrf_rejected', 'validation_failed', 'rate_limited'],
    rateLimit: 'collab-tickets',
    summary: 'Mint a batch of single-use /collab tickets bound to this session.',
  },
  {
    operationId: 'auth.me',
    method: 'GET',
    path: '/auth/me',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'auth',
    auth: REST_ROUTE_POLICIES['auth.me'],
    request: {},
    responses: [{ status: 200, body: { kind: 'json', schema: Me } }],
    errors: ['unauthenticated', 'token_expired'],
    summary: 'The current principal. For a token, isServerAdmin is false and token is populated.',
  },
];

const META_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'meta.get',
    method: 'GET',
    path: '/meta',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'meta',
    auth: REST_ROUTE_POLICIES['meta.get'],
    request: {},
    responses: [{ status: 200, body: { kind: 'json', schema: Meta } }],
    errors: [],
    summary: 'Compatibility and feature discovery; the one route exempt from client_outdated.',
  },
  {
    operationId: 'meta.openapi',
    method: 'GET',
    path: '/openapi.json',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'meta',
    auth: REST_ROUTE_POLICIES['meta.openapi'],
    request: {},
    responses: [
      {
        status: 200,
        body: { kind: 'opaque-json', description: 'the committed OpenAPI 3.1 document' },
      },
    ],
    errors: ['unauthenticated', 'forbidden'],
    summary:
      'The committed OpenAPI 3.1 document, served from @fastify/swagger; open to any principal under NODE_ENV=development.',
  },
  {
    operationId: 'meta.docs',
    method: 'GET',
    path: '/docs',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'meta',
    auth: REST_ROUTE_POLICIES['meta.docs'],
    request: {},
    responses: [{ status: 200, body: { kind: 'text', contentType: 'text/html' } }],
    errors: ['unauthenticated', 'forbidden'],
    summary: 'Swagger UI under a nonce CSP; "try it out" is disabled outside development.',
  },
];

const ME_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'me.sessions.list',
    method: 'GET',
    path: '/me/sessions',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'me',
    auth: REST_ROUTE_POLICIES['me.sessions.list'],
    request: {},
    responses: [{ status: 200, body: { kind: 'json', schema: SessionList } }],
    errors: ['unauthenticated', 'token_scope_insufficient'],
    summary: "The caller's own live sessions, current first.",
  },
  {
    operationId: 'me.sessions.revoke',
    method: 'DELETE',
    path: '/me/sessions/:sessionId',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'me',
    auth: REST_ROUTE_POLICIES['me.sessions.revoke'],
    request: { params: SessionIdParams, headers: ClientHeaders },
    responses: [{ status: 204, body: { kind: 'empty' } }],
    errors: ['unauthenticated', 'csrf_rejected', 'not_found'],
    summary: "Revoke one of the caller's own sessions; a foreign id is 404, never 403.",
  },
  {
    operationId: 'me.update',
    method: 'PATCH',
    path: '/me',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'me',
    auth: REST_ROUTE_POLICIES['me.update'],
    request: { body: UpdateMeBody, headers: IfMatchHeaders },
    responses: [{ status: 200, body: { kind: 'json', schema: User }, etag: 'strong-version' }],
    errors: [
      'unauthenticated',
      'csrf_rejected',
      'stale_version',
      'precondition_required',
      'validation_failed',
    ],
    ifMatch: 'required',
    summary: 'Change the display name.',
  },
  {
    operationId: 'me.changePassword',
    method: 'POST',
    path: '/me/password',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'me',
    auth: REST_ROUTE_POLICIES['me.changePassword'],
    request: { body: ChangePasswordBody, headers: ClientHeaders },
    responses: [{ status: 204, body: { kind: 'empty' } }],
    errors: [
      'unauthenticated',
      'rate_limited',
      'invalid_credentials',
      'step_up_required',
      'csrf_rejected',
      'validation_failed',
    ],
    summary: 'Change the password; revokes every other session and leaves tokens alone.',
  },
];

const VAULT_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'vaults.list',
    method: 'GET',
    path: '/vaults',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'vaults',
    auth: REST_ROUTE_POLICIES['vaults.list'],
    request: { query: ListVaultsQuery },
    responses: [
      {
        status: 200,
        body: { kind: 'json', schema: VaultSummaryList },
        links: {
          getVault: {
            operationId: 'vaults.get',
            parameters: { vaultId: '$response.body#/items/0/id' },
          },
        },
      },
    ],
    errors: ['unauthenticated', 'token_expired', 'validation_failed'],
    rateLimit: 'pat',
    summary: 'Vaults accessible to the principal, ordered by name.',
  },
  {
    operationId: 'vaults.create',
    method: 'POST',
    path: '/vaults',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'vaults',
    auth: REST_ROUTE_POLICIES['vaults.create'],
    request: { body: CreateVaultBody, headers: ClientHeaders },
    responses: [
      {
        status: 201,
        body: { kind: 'json', schema: Vault },
        location: '/api/v1/vaults/<id>',
        links: {
          getVault: { operationId: 'vaults.get', parameters: { vaultId: '$response.body#/id' } },
          putMember: {
            operationId: 'members.put',
            parameters: {
              vaultId: '$response.body#/id',
              userId: '$response.body#/createdBy/id',
            },
          },
        },
      },
    ],
    errors: [
      'unauthenticated',
      'forbidden',
      'csrf_rejected',
      'name_conflict',
      'not_found',
      'validation_failed',
    ],
    summary:
      'Create a vault, its root category row and any initial memberships in one transaction.',
  },
  {
    operationId: 'vaults.get',
    method: 'GET',
    path: '/vaults/:vaultId',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'vaults',
    auth: REST_ROUTE_POLICIES['vaults.get'],
    request: { params: VaultIdParams },
    responses: [
      {
        status: 200,
        body: { kind: 'json', schema: Vault },
        etag: 'strong-version',
        links: {
          createNote: {
            operationId: 'nodes.create',
            parameters: { vaultId: '$response.body#/id' },
            requestBody: { kind: 'note', parentId: '$response.body#/rootNodeId' },
          },
        },
      },
    ],
    errors: ['unauthenticated', 'token_expired', 'not_found'],
    rateLimit: 'pat',
    summary: "The full vault with its treeVersion and the caller's role; a non-member gets 404.",
  },
];

const MEMBER_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'members.list',
    method: 'GET',
    path: '/vaults/:vaultId/members',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'members',
    auth: REST_ROUTE_POLICIES['members.list'],
    request: { params: VaultIdParams },
    responses: [{ status: 200, body: { kind: 'json', schema: MemberList } }],
    errors: ['unauthenticated', 'not_found'],
    summary: 'Everyone who can read the vault can see who else can.',
  },
  {
    operationId: 'members.put',
    method: 'PUT',
    path: '/vaults/:vaultId/members/:userId',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'members',
    auth: REST_ROUTE_POLICIES['members.put'],
    request: { params: VaultMemberParams, body: PutMemberBody, headers: ClientHeaders },
    responses: [
      { status: 200, body: { kind: 'json', schema: Member } },
      { status: 201, body: { kind: 'json', schema: Member } },
    ],
    errors: [
      'unauthenticated',
      'forbidden',
      'csrf_rejected',
      'not_found',
      'stale_version',
      'vault_archived',
      'validation_failed',
      'precondition_required',
    ],
    ifMatch: 'conditional',
    summary: 'Add a membership (201) or change its role (200); If-Match only when the row exists.',
  },
  {
    operationId: 'members.delete',
    method: 'DELETE',
    path: '/vaults/:vaultId/members/:userId',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'members',
    auth: REST_ROUTE_POLICIES['members.delete'],
    request: { params: VaultMemberParams, headers: IfMatchHeaders },
    responses: [{ status: 204, body: { kind: 'empty' } }],
    errors: [
      'unauthenticated',
      'forbidden',
      'csrf_rejected',
      'not_found',
      'stale_version',
      'vault_archived',
      'validation_failed',
      'precondition_required',
    ],
    ifMatch: 'required',
    summary: 'Remove a membership; the last manager cannot be removed.',
  },
];

const NODE_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'nodes.create',
    method: 'POST',
    path: '/vaults/:vaultId/nodes',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'nodes',
    auth: REST_ROUTE_POLICIES['nodes.create'],
    request: { params: VaultIdParams, body: CreateNodeBody, headers: ClientHeaders },
    responses: [
      {
        status: 201,
        body: { kind: 'json', schema: Node },
        location: '/api/v1/nodes/<id>',
        links: {
          getNote: { operationId: 'notes.get', parameters: { noteId: '$response.body#/id' } },
          // The lifecycle chain of 10-testing-and-quality.md, "REST — OpenAPI contract":
          // createNode → patchNode → trashNode → restoreNode. Without it the stateful phase has
          // no live node id and fuzzes PATCH/trash/restore with generated ids that all 404.
          patchNode: { operationId: 'nodes.update', parameters: { nodeId: '$response.body#/id' } },
        },
      },
    ],
    errors: [
      'unauthenticated',
      'forbidden',
      'csrf_rejected',
      'not_found',
      'name_conflict',
      'invalid_move',
      'vault_archived',
      'note_oversized',
      'validation_failed',
    ],
    summary: 'Create a note inside a category.',
  },
];

const NOTE_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'notes.get',
    method: 'GET',
    path: '/notes/:noteId',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'notes',
    auth: REST_ROUTE_POLICIES['notes.get'],
    request: { params: NoteIdParams },
    responses: [
      {
        status: 200,
        body: { kind: 'json', schema: NoteMeta },
        etag: 'weak-version-revision',
        links: {
          getMarkdown: {
            operationId: 'notes.getMarkdown',
            parameters: { noteId: '$response.body#/id' },
          },
          getParticipants: {
            operationId: 'notes.participants',
            parameters: { noteId: '$response.body#/id' },
          },
        },
      },
    ],
    errors: ['unauthenticated', 'token_expired', 'not_found'],
    rateLimit: 'pat',
    summary: 'Full note metadata from the committed projection.',
  },
  {
    operationId: 'notes.getMarkdown',
    method: 'GET',
    path: '/notes/:noteId/markdown',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'notes',
    auth: REST_ROUTE_POLICIES['notes.getMarkdown'],
    request: { params: NoteIdParams, query: GetMarkdownQuery },
    responses: [
      {
        status: 200,
        body: { kind: 'markdown' },
        etag: 'strong-revision-hash',
        // getNoteMarkdown → listRevisions, the revision half of the declared link graph
        // (10-testing-and-quality.md, "REST — OpenAPI contract"). The representation is
        // text/markdown, so the note id comes from the request path rather than a JSON body.
        links: {
          listRevisions: {
            operationId: 'revisions.list',
            parameters: { noteId: '$request.path.noteId' },
          },
        },
      },
      { status: 304, body: { kind: 'empty' }, etag: 'strong-revision-hash' },
    ],
    errors: [
      'unauthenticated',
      'token_expired',
      'forbidden',
      'not_found',
      'content_invalid',
      'validation_failed',
      'rate_limited',
      'capacity',
    ],
    rateLimit: 'fresh-markdown',
    summary: 'The committed Markdown as text/markdown, optionally a line slice or a revision.',
  },
  {
    operationId: 'notes.participants',
    method: 'GET',
    path: '/notes/:noteId/participants',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'notes',
    auth: REST_ROUTE_POLICIES['notes.participants'],
    request: { params: NoteIdParams },
    responses: [{ status: 200, body: { kind: 'json', schema: NoteParticipants } }],
    errors: ['unauthenticated', 'not_found'],
    summary:
      'Server-authoritative presence, taken from connection contexts and never from awareness.',
  },
];

const ADMIN_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'admin.users.list',
    method: 'GET',
    path: '/admin/users',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'admin',
    auth: REST_ROUTE_POLICIES['admin.users.list'],
    request: { query: ListAdminUsersQuery },
    responses: [{ status: 200, body: { kind: 'json', schema: AdminUserPage } }],
    errors: ['unauthenticated', 'forbidden', 'validation_failed'],
    summary: 'Cursor listing with the console filters.',
  },
  {
    operationId: 'admin.users.create',
    method: 'POST',
    path: '/admin/users',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'admin',
    auth: REST_ROUTE_POLICIES['admin.users.create'],
    request: { body: CreateAdminUserBody, headers: ClientHeaders },
    responses: [
      {
        status: 201,
        body: { kind: 'json', schema: AdminUserCreated },
        location: '/api/v1/admin/users/<id>',
      },
    ],
    errors: [
      'unauthenticated',
      'forbidden',
      'step_up_required',
      'csrf_rejected',
      'email_conflict',
      'validation_failed',
    ],
    summary: 'Create a user without credentials and return the one-time set-password link.',
  },
  {
    operationId: 'admin.users.resetPassword',
    method: 'POST',
    path: '/admin/users/:userId/reset-password',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'admin',
    auth: REST_ROUTE_POLICIES['admin.users.resetPassword'],
    request: { params: UserIdParams, headers: ClientHeaders },
    responses: [{ status: 201, body: { kind: 'json', schema: AdminUserPasswordReset } }],
    errors: [
      'unauthenticated',
      'forbidden',
      'step_up_required',
      'csrf_rejected',
      'not_found',
      'validation_failed',
    ],
    summary: 'Issue a replacement password link and revoke sessions, preserving personal tokens.',
  },
  {
    operationId: 'admin.users.disable',
    method: 'POST',
    path: '/admin/users/:userId/disable',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'admin',
    auth: REST_ROUTE_POLICIES['admin.users.disable'],
    request: { params: UserIdParams, body: DisableUserBody, headers: ClientHeaders },
    responses: [{ status: 200, body: { kind: 'json', schema: User } }],
    errors: [
      'unauthenticated',
      'forbidden',
      'step_up_required',
      'csrf_rejected',
      'not_found',
      'validation_failed',
    ],
    summary: 'Block authentication, revoke every session and close every live connection.',
  },
  {
    operationId: 'admin.users.enable',
    method: 'POST',
    path: '/admin/users/:userId/enable',
    mount: '/api/v1',
    plugin: 'rest',
    tag: 'admin',
    auth: REST_ROUTE_POLICIES['admin.users.enable'],
    request: { params: UserIdParams, headers: ClientHeaders },
    responses: [{ status: 200, body: { kind: 'json', schema: User } }],
    errors: [
      'unauthenticated',
      'forbidden',
      'step_up_required',
      'csrf_rejected',
      'not_found',
      'validation_failed',
    ],
    summary: 'Allow authentication again.',
  },
];

/**
 * The three operations surfaces. They are rows of this table so the boot assertion, the route index
 * and the coverage check see them, but the `ops` plugin registers them and they answer while the
 * process is not ready. `/metrics` declares `public` and performs its own `METRICS_TOKEN` and
 * internal-CIDR check inside the handler, because neither is a principal the route policy knows.
 */
const OPS_ROUTES: readonly RouteSpec[] = [
  {
    operationId: 'ops.healthz',
    method: 'GET',
    path: '/healthz',
    mount: '',
    plugin: 'ops',
    tag: 'ops',
    auth: REST_ROUTE_POLICIES['ops.healthz'],
    request: {},
    responses: [{ status: 200, body: { kind: 'json', schema: HealthzBody } }],
    errors: ['unavailable'],
    summary: 'Liveness. The shutdown drain does not flip it; the process exiting does.',
  },
  {
    operationId: 'ops.readyz',
    method: 'GET',
    path: '/readyz',
    mount: '',
    plugin: 'ops',
    tag: 'ops',
    auth: REST_ROUTE_POLICIES['ops.readyz'],
    request: {},
    responses: [
      { status: 200, body: { kind: 'json', schema: ReadyzBody } },
      { status: 503, body: { kind: 'json', schema: ReadyzBody } },
    ],
    errors: [],
    summary:
      'The readiness checklist; the same body with 200 and 503, and the status is the signal.',
  },
  {
    operationId: 'ops.metrics',
    method: 'GET',
    path: '/metrics',
    mount: '',
    plugin: 'ops',
    tag: 'ops',
    auth: REST_ROUTE_POLICIES['ops.metrics'],
    request: {},
    responses: [
      { status: 200, body: { kind: 'text', contentType: 'text/plain' } },
      { status: 401, body: { kind: 'empty' } },
    ],
    errors: ['not_found'],
    summary:
      'Prometheus text format. A bad credential gets an empty 401; absent token/CIDR configuration hides the endpoint with 404.',
  },
];

/** Every route this milestone registers, in the order the domains are documented. */
const DECLARED_ROUTES: readonly RouteSpec[] = [
  ...AUTH_ROUTES,
  ...META_ROUTES,
  ...ME_ROUTES,
  ...VAULT_ROUTES,
  ...MEMBER_ROUTES,
  ...NODE_ROUTES,
  ...M2_TREE_ROUTES,
  ...NOTE_ROUTES,
  ...M2_ATTACHMENT_ROUTES,
  ...M2_SEARCH_ROUTES,
  ...M2_JOB_ROUTES,
  ...M2_REVISION_ROUTES,
  ...M2_LINK_ROUTES,
  ...ADMIN_ROUTES,
  ...OPS_ROUTES,
];

/** Every implemented operation, with uniform optional metadata and closed identifiers. */
export const API_ROUTES: readonly (RouteSpec & { readonly operationId: ApiOperationId })[] =
  DECLARED_ROUTES;

/** The key the boot assertion and the route index compare on: `<METHOD> <mount><path>`. */
export function routeKey(route: RouteSpec): string {
  return `${route.method} ${route.mount}${route.path}`;
}

/** The row for one operation id, or `undefined` when this milestone does not register it. */
export function routeByOperationId(operationId: string): RouteSpec | undefined {
  return API_ROUTES.find((route) => route.operationId === operationId);
}

/** Every `(operationId, status)` pair the document describes, which is what the coverage check walks. */
export function routeCoveragePairs(): readonly (readonly [string, number])[] {
  return API_ROUTES.flatMap((route) =>
    route.responses.map((response) => [route.operationId, response.status] as const),
  );
}
