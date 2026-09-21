/**
 * The REST contract: the shared DTOs, one module per route family, and `API_ROUTES`.
 *
 * 09-api-reference.md section 2 places these schemas in `@iridium/contracts/rest/<domain>.ts`, and the
 * package's single `.` export means a consumer reaches them through the root barrel rather than through
 * a deep import — so this file is what makes `rest/` a unit instead of nine loose modules.
 */

export * from './admin-users.ts';
export * from './auth.ts';
export * from './common.ts';
export * from './me.ts';
export * from './members.ts';
export * from './meta.ts';
export * from './nodes.ts';
export * from './notes.ts';
export * from './ops.ts';
export * from './params.ts';
export * from './routes.ts';
export * from './route-policies.ts';
export * from './tree.ts';
export * from './attachments.ts';
export * from './attachment-routes.ts';
export * from './tree-routes.ts';
export * from './revisions.ts';
export * from './revision-routes.ts';
export * from './links.ts';
export * from './link-routes.ts';
export * from './search.ts';
export * from './search-routes.ts';
export * from './jobs.ts';
export * from './job-routes.ts';
export * from './vaults.ts';
