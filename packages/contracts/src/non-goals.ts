/**
 * The declared non-goals (01-vision-scope-and-principles.md section 4.4).
 *
 * This module carries the **ids only**. The assertions live in
 * `apps/server/test/guards/non-goals.guard.spec.ts`, whose table is declared
 * `satisfies Record<NonGoalId, NonGoalAssertion>`, so adding a non-goal to section 4.4 without
 * writing its assertion does not compile and removing one fails until its assertion goes too.
 *
 * `scripts/build-non-goals.ts` parses section 4.4 into the committed `docs/non-goals.json`; the
 * guard's first assertion is that these ids and that file's ids are the same set. Crossing a
 * non-goal deliberately is therefore a three-part commit — edit section 4.4, regenerate the JSON,
 * change the assertion — which is exactly the review a scope change deserves.
 */

/**
 * Every declared non-goal, in the order of section 4.4: the deferral table first, then the
 * bullets that follow it.
 */
export const NON_GOAL_IDS = [
  // The deferral table
  'plugin-ecosystem',
  'graph-view',
  'advanced-wysiwyg',
  'automatic-link-rewriting',
  'full-obsidian-syntax-compatibility',
  'per-note-acl-overrides',
  'public-sharing',
  'cross-vault-moves',
  'filesystem-git-sync',
  'offline-first-editing',
  'mobile-clients',
  'enterprise-sso',
  'multi-server-collaboration',
  'built-in-ai-features',
  // The bullets the plan fixes beyond spec section 10
  'agent-write-access',
  'cross-browser-support',
  'mcp-notifications-and-sessions',
  'mcp-binary-resources',
  'comments-and-suggestions',
  'scim-mfa-passkeys',
  'external-search-engines',
  'attachment-encryption',
  'vault-hard-deletion',
  'math-and-mermaid-rendering',
  'email-delivery',
  'npm-publishing',
  'desktop-packaging-and-signing',
  // The two composite claims the guard asserts as single cases
  'not-a-complete-obsidian-replacement',
  'no-second-content-write-path',
] as const;

/** A declared non-goal. */
export type NonGoalId = (typeof NON_GOAL_IDS)[number];
