/** Closed authorization policy registry shared by routes and exhaustive security tests. */

/** Each operation declares its authorization exactly once. */
export const REST_ROUTE_POLICIES = {
  'auth.createSession': { public: true },
  'auth.deleteCurrentSession': { session: true },
  'auth.reauthenticate': { session: true },
  'auth.setPassword': { public: true },
  'auth.createCollabTickets': { session: true },
  'auth.me': { session: true, principalKinds: ['user', 'token'] },
  'meta.get': { public: true },
  'meta.openapi': { serverAdmin: true },
  'meta.docs': { serverAdmin: true },
  'me.sessions.list': { self: true },
  'me.sessions.revoke': { self: true },
  'me.update': { self: true },
  'me.changePassword': { self: true, stepUp: true },
  'vaults.list': { session: true, principalKinds: ['user', 'token'] },
  'vaults.create': { serverAdmin: true, permission: 'server:vaults:create' },
  'vaults.get': {
    permission: 'vault:read',
    vaultFrom: 'params.vaultId',
    principalKinds: ['user', 'token'],
  },
  'members.list': { permission: 'vault:read', vaultFrom: 'params.vaultId' },
  'members.put': { permission: 'vault:manage_members', vaultFrom: 'params.vaultId' },
  'members.delete': { permission: 'vault:manage_members', vaultFrom: 'params.vaultId' },
  'nodes.create': { permission: 'node:create', vaultFrom: 'params.vaultId' },
  'notes.get': {
    permission: 'note:read',
    vaultFrom: 'note:params.noteId',
    principalKinds: ['user', 'token'],
  },
  'notes.getMarkdown': {
    permission: 'note:read',
    vaultFrom: 'note:params.noteId',
    principalKinds: ['user', 'token'],
  },
  'notes.participants': { permission: 'note:read', vaultFrom: 'note:params.noteId' },
  'admin.users.list': { serverAdmin: true, permission: 'server:users' },
  'admin.users.create': { serverAdmin: true, permission: 'server:users', stepUp: true },
  'admin.users.resetPassword': { serverAdmin: true, permission: 'server:users', stepUp: true },
  'admin.users.disable': { serverAdmin: true, permission: 'server:users', stepUp: true },
  'admin.users.enable': { serverAdmin: true, permission: 'server:users', stepUp: true },
  'ops.healthz': { public: true },
  'ops.readyz': { public: true },
  'ops.metrics': { public: true },
  'notes.renameImpact': { permission: 'vault:read', vaultFrom: 'note:params.noteId' },
  'tree.listChildren': { permission: 'vault:read', vaultFrom: 'params.vaultId' },
  'nodes.list': {
    permission: 'vault:read',
    vaultFrom: 'params.vaultId',
    principalKinds: ['user', 'token'],
  },
  'nodes.get': { permission: 'vault:read', vaultFrom: 'node:params.nodeId' },
  'nodes.update': { permission: 'node:rename', vaultFrom: 'node:params.nodeId' },
  'nodes.trash': { permission: 'node:trash', vaultFrom: 'node:params.nodeId' },
  'nodes.restore': { permission: 'node:restore', vaultFrom: 'node:params.nodeId' },
  'nodes.purge': { permission: 'node:purge', vaultFrom: 'node:params.nodeId', stepUp: true },
  'nodes.inboundLinks': { permission: 'vault:read', vaultFrom: 'node:params.nodeId' },
  'trash.list': { permission: 'vault:read', vaultFrom: 'params.vaultId' },
  'vaults.update': { permission: 'vault:settings', vaultFrom: 'params.vaultId' },
  'vaults.archive': {
    permission: 'vault:archive',
    vaultFrom: 'params.vaultId',
    stepUp: true,
    allowArchived: true,
  },
  'vaults.unarchive': {
    permission: 'vault:archive',
    vaultFrom: 'params.vaultId',
    stepUp: true,
    allowArchived: true,
  },
  'attachments.list': {
    permission: 'attachment:read',
    vaultFrom: 'params.vaultId',
    principalKinds: ['user', 'token'],
  },
  'attachments.upload': { permission: 'attachment:write', vaultFrom: 'params.vaultId' },
  'attachments.download': {
    permission: 'attachment:read',
    vaultFrom: 'attachment:params.attachmentId',
    principalKinds: ['user', 'token'],
  },
  'attachments.getMeta': {
    permission: 'attachment:read',
    vaultFrom: 'attachment:params.attachmentId',
    principalKinds: ['user', 'token'],
  },
  'attachments.delete': {
    permission: 'attachment:write',
    vaultFrom: 'attachment:params.attachmentId',
  },
  'admin.attachments.unreferenced': { serverAdmin: true, permission: 'server:jobs' },
  'search.vault': {
    permission: 'search:read',
    vaultFrom: 'params.vaultId',
    principalKinds: ['user', 'token'],
  },
  'search.all': { session: true, principalKinds: ['user', 'token'] },
  'admin.jobs.list': { serverAdmin: true, permission: 'server:jobs' },
  'admin.jobs.get': { serverAdmin: true, permission: 'server:jobs' },
  'admin.jobs.run': { serverAdmin: true, permission: 'server:jobs', stepUp: true },
  'admin.jobs.cancel': { serverAdmin: true, permission: 'server:jobs', stepUp: true },
  'revisions.list': {
    permission: 'history:read',
    vaultFrom: 'note:params.noteId',
    principalKinds: ['user', 'token'],
  },
  'revisions.get': {
    permission: 'history:read',
    vaultFrom: 'note:params.noteId',
    principalKinds: ['user', 'token'],
  },
  'revisions.create': { permission: 'revision:name', vaultFrom: 'note:params.noteId' },
  'revisions.restore': {
    permission: 'history:restore',
    vaultFrom: 'note:params.noteId',
    stepUp: true,
  },
  'notes.links': { permission: 'vault:read', vaultFrom: 'note:params.noteId' },
  'notes.backlinks': { permission: 'vault:read', vaultFrom: 'note:params.noteId' },
} as const;

/** Every implemented REST operation. */
export type ApiOperationId = keyof typeof REST_ROUTE_POLICIES;

/** Every route that names a permission, derived from the actual policy registry. */
export type PermissionOperationId = {
  [Id in ApiOperationId]: (typeof REST_ROUTE_POLICIES)[Id] extends { readonly permission: string }
    ? Id
    : never;
}[ApiOperationId];
