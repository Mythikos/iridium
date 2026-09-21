/**
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/generate-msw-handlers.ts` from packages/contracts/openapi/openapi.json.
 * Run `pnpm gen` to regenerate; `gen.drift.guard` fails the `static` job on any difference.
 */

import type { OperationStub } from '../handlers.ts';

/**
 * Every REST operation the committed OpenAPI document declares, in document order.
 *
 * Pass it to `notImplementedHandlers` to get one `501 not_implemented` stub per operation, then
 * override the handful a suite cares about with `server.use(...)`. Anything the suite forgot then
 * fails naming the operation, instead of reaching a real socket.
 */
export const GENERATED_OPERATIONS: readonly OperationStub[] = [
  { method: 'get', path: '/meta', operationId: 'meta.get' },
  { method: 'get', path: '/openapi.json', operationId: 'meta.openapi' },
  { method: 'post', path: '/auth/sessions', operationId: 'auth.createSession' },
  { method: 'delete', path: '/auth/sessions/current', operationId: 'auth.deleteCurrentSession' },
  { method: 'post', path: '/auth/reauthenticate', operationId: 'auth.reauthenticate' },
  { method: 'post', path: '/auth/set-password', operationId: 'auth.setPassword' },
  { method: 'post', path: '/auth/collab-tickets', operationId: 'auth.createCollabTickets' },
  { method: 'get', path: '/auth/me', operationId: 'auth.me' },
  { method: 'get', path: '/me/sessions', operationId: 'me.sessions.list' },
  { method: 'delete', path: '/me/sessions/:sessionId', operationId: 'me.sessions.revoke' },
  { method: 'patch', path: '/me', operationId: 'me.update' },
  { method: 'post', path: '/me/password', operationId: 'me.changePassword' },
  { method: 'get', path: '/admin/users', operationId: 'admin.users.list' },
  { method: 'post', path: '/admin/users', operationId: 'admin.users.create' },
  { method: 'post', path: '/admin/users/:userId/disable', operationId: 'admin.users.disable' },
  { method: 'post', path: '/admin/users/:userId/enable', operationId: 'admin.users.enable' },
  { method: 'post', path: '/admin/users/:userId/reset-password', operationId: 'admin.users.resetPassword' },
  { method: 'get', path: '/vaults', operationId: 'vaults.list' },
  { method: 'post', path: '/vaults', operationId: 'vaults.create' },
  { method: 'get', path: '/vaults/:vaultId', operationId: 'vaults.get' },
  { method: 'patch', path: '/vaults/:vaultId', operationId: 'vaults.update' },
  { method: 'post', path: '/vaults/:vaultId/archive', operationId: 'vaults.archive' },
  { method: 'post', path: '/vaults/:vaultId/unarchive', operationId: 'vaults.unarchive' },
  { method: 'get', path: '/vaults/:vaultId/members', operationId: 'members.list' },
  { method: 'put', path: '/vaults/:vaultId/members/:userId', operationId: 'members.put' },
  { method: 'delete', path: '/vaults/:vaultId/members/:userId', operationId: 'members.delete' },
  { method: 'get', path: '/vaults/:vaultId/nodes', operationId: 'nodes.list' },
  { method: 'post', path: '/vaults/:vaultId/nodes', operationId: 'nodes.create' },
  { method: 'get', path: '/vaults/:vaultId/tree', operationId: 'tree.listChildren' },
  { method: 'get', path: '/nodes/:nodeId', operationId: 'nodes.get' },
  { method: 'patch', path: '/nodes/:nodeId', operationId: 'nodes.update' },
  { method: 'delete', path: '/nodes/:nodeId', operationId: 'nodes.purge' },
  { method: 'post', path: '/nodes/:nodeId/trash', operationId: 'nodes.trash' },
  { method: 'post', path: '/nodes/:nodeId/restore', operationId: 'nodes.restore' },
  { method: 'get', path: '/nodes/:nodeId/inbound-links', operationId: 'nodes.inboundLinks' },
  { method: 'get', path: '/vaults/:vaultId/trash', operationId: 'trash.list' },
  { method: 'get', path: '/notes/:noteId/rename-impact', operationId: 'notes.renameImpact' },
  { method: 'get', path: '/search', operationId: 'search.all' },
  { method: 'get', path: '/vaults/:vaultId/search', operationId: 'search.vault' },
  { method: 'get', path: '/notes/:noteId/links', operationId: 'notes.links' },
  { method: 'get', path: '/notes/:noteId/backlinks', operationId: 'notes.backlinks' },
  { method: 'get', path: '/admin/jobs', operationId: 'admin.jobs.list' },
  { method: 'get', path: '/admin/jobs/:jobId', operationId: 'admin.jobs.get' },
  { method: 'post', path: '/admin/jobs/:type/run', operationId: 'admin.jobs.run' },
  { method: 'post', path: '/admin/jobs/:jobId/cancel', operationId: 'admin.jobs.cancel' },
  { method: 'get', path: '/notes/:noteId/revisions', operationId: 'revisions.list' },
  { method: 'post', path: '/notes/:noteId/revisions', operationId: 'revisions.create' },
  { method: 'get', path: '/notes/:noteId/revisions/:revisionId', operationId: 'revisions.get' },
  { method: 'post', path: '/notes/:noteId/revisions/:revisionId/restore', operationId: 'revisions.restore' },
  { method: 'get', path: '/vaults/:vaultId/attachments', operationId: 'attachments.list' },
  { method: 'post', path: '/vaults/:vaultId/attachments', operationId: 'attachments.upload' },
  { method: 'get', path: '/vaults/:vaultId/attachments/:attachmentId', operationId: 'attachments.download' },
  { method: 'delete', path: '/vaults/:vaultId/attachments/:attachmentId', operationId: 'attachments.delete' },
  { method: 'get', path: '/vaults/:vaultId/attachments/:attachmentId/meta', operationId: 'attachments.getMeta' },
  { method: 'get', path: '/admin/attachments/unreferenced', operationId: 'admin.attachments.unreferenced' },
  { method: 'get', path: '/notes/:noteId', operationId: 'notes.get' },
  { method: 'get', path: '/notes/:noteId/markdown', operationId: 'notes.getMarkdown' },
  { method: 'get', path: '/notes/:noteId/participants', operationId: 'notes.participants' },
  { method: 'get', path: '/docs', operationId: 'meta.docs' },
  { method: 'get', path: '/healthz', operationId: 'ops.healthz' },
  { method: 'get', path: '/readyz', operationId: 'ops.readyz' },
  { method: 'get', path: '/metrics', operationId: 'ops.metrics' },
];
