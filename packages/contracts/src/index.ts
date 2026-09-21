/**
 * `@iridium/contracts` — the single wire-contract package: zod 4 schemas and inferred types for
 * REST, the collaboration channel, MCP, desktop IPC, audit, limits, ids, tokens and paths
 * (02-system-architecture.md, "Package responsibilities"). Its only runtime dependency is zod;
 * it contains no I/O and nothing platform-specific, which is what lets every other package —
 * browser, Node, Electron — depend on it.
 *
 * This barrel is the package's single `.` export, so a module that is not re-exported here does
 * not exist for consumers.
 */

export * from './audit.ts';
export * from './authz.ts';
export * from './collab.ts';
export * from './errors.ts';
export * from './ids.ts';
export * from './import-report.ts';
export * from './attachments.ts';
export * from './limits.ts';
export * from './markdown-limits.ts';
export * from './non-goals.ts';
export * from './paths.ts';
export * from './rest/index.ts';
export * from './schema.ts';
export * from './search-query.ts';
export * from './settings.ts';
export * from './time.ts';
export * from './tokens.ts';
