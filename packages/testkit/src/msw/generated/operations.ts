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
  { method: 'get', path: '/vaults/:vaultId/members', operationId: 'members.list' },
  { method: 'put', path: '/vaults/:vaultId/members/:userId', operationId: 'members.put' },
  { method: 'delete', path: '/vaults/:vaultId/members/:userId', operationId: 'members.delete' },
  { method: 'post', path: '/vaults/:vaultId/nodes', operationId: 'nodes.create' },
  { method: 'get', path: '/notes/:noteId', operationId: 'notes.get' },
  { method: 'get', path: '/notes/:noteId/markdown', operationId: 'notes.getMarkdown' },
  { method: 'get', path: '/notes/:noteId/participants', operationId: 'notes.participants' },
  { method: 'get', path: '/docs', operationId: 'meta.docs' },
  { method: 'get', path: '/healthz', operationId: 'ops.healthz' },
  { method: 'get', path: '/readyz', operationId: 'ops.readyz' },
  { method: 'get', path: '/metrics', operationId: 'ops.metrics' },
];
