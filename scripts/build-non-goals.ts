/**
 * Step 8 of `pnpm gen`: `docs/non-goals.json`
 * (12-milestones.md §3, "Generated artefacts"; 10-testing-and-quality.md, "The non-goal guard").
 *
 * `guards.non-goals.guard` reads this file, asserts that its ids equal the hand-written `NonGoalId`
 * union of `packages/contracts/src/non-goals.ts`, and then runs one absence assertion per id against
 * the built inventories. That equality is asserted **here** too, at generation time, so a §4.4 edit
 * that would break the guard fails the pipeline with the exact difference instead of failing a test
 * run later.
 *
 * ## Where each entry comes from
 *
 * | Source | Count | What it contributes |
 * |---|---|---|
 * | 01-vision-scope-and-principles.md §4.4, the deferral table | 14 | `title`, `whatTheMvpDoesInstead`, `seamKept`, `section` |
 * | 01-vision-scope-and-principles.md §4.4, the bullet list below it | 13 | `title` and the bullet's own statement |
 * | 10-testing-and-quality.md, "What each declared non-goal asserts" | 2 | the two composite claims, which §4.4 does not carry |
 *
 * Twenty-nine entries. The bullet list has fourteen items, not thirteen: *Enterprise single sign-on*
 * restates the deferral table's *Enterprise SSO* row rather than declaring a new non-goal, so it is
 * merged into that entry instead of producing a second id. `ALIASES` below records that, so the merge
 * is a declared fact rather than a silent de-duplication.
 *
 * The two composite claims — *Not a complete Obsidian replacement* and *No second content write path*
 * — are the spec §1 sentences that 10-testing-and-quality.md turns into single guard cases. They have
 * no §4.4 row, which is why the same section's assertion table is the third source.
 *
 * ## Why the slugs are a table rather than a slugifier
 *
 * `NonGoalId` is hand-written, and several of its members are deliberately shorter than the prose
 * they name: *Advanced WYSIWYG / live-preview editing* is `advanced-wysiwyg`, *Per-note /
 * per-category ACL overrides* is `per-note-acl-overrides`, *Bidirectional filesystem / Git sync* is
 * `filesystem-git-sync`, *Firefox, WebKit and any browser outside current Chrome and Edge* is
 * `cross-browser-support`. No slugifier produces those, and inventing one that did would make the id
 * a function of the wording — so renaming a row for clarity would rename an id that
 * `satisfies Record<NonGoalId, NonGoalAssertion>` has already frozen. The mapping is therefore data,
 * `SLUGS` is asserted to cover exactly the parsed headings, and a new §4.4 row fails this step
 * naming the heading it could not place.
 *
 * ## `sinceMilestone`
 *
 * 10-testing-and-quality.md's "Milestone phasing" paragraph states the *rule* — absence claims are
 * satisfiable from M0 except where the inventory the assertion reads does not exist yet, and it names
 * the four inventories that arrive later (the route walk at M1, the MCP artefact at M3, the router
 * route tree and the `IridiumHost` member list at M4, the Electron entries at M5) plus one explicit
 * value (*Cross-browser support* is M0). It states no per-id table. `SINCE_MILESTONE` below is that
 * rule applied id by id, with the inventory that fixes each value named beside it, so the derivation
 * is reviewable rather than implied.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { isRecord } from './lib/json.ts';
import {
  plainText,
  readBoldBullets,
  readSections,
  requireSection,
  requireTable,
} from './lib/markdown.ts';
import { ARTEFACTS, PLAN_DOCUMENTS, SOURCES } from './lib/paths.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { writeJsonOrCompare } from './lib/write.ts';

/** Heading or bullet lead-in, in plain text, mapped to the `NonGoalId` it declares. */
const SLUGS: Readonly<Record<string, string>> = {
  // 01 §4.4, the deferral table, in table order.
  'Plugin ecosystem': 'plugin-ecosystem',
  'Graph view': 'graph-view',
  'Advanced WYSIWYG / live-preview editing': 'advanced-wysiwyg',
  'Automatic link rewriting': 'automatic-link-rewriting',
  'Full Obsidian syntax compatibility': 'full-obsidian-syntax-compatibility',
  'Per-note / per-category ACL overrides': 'per-note-acl-overrides',
  'Public sharing': 'public-sharing',
  'Cross-vault moves': 'cross-vault-moves',
  'Bidirectional filesystem / Git sync': 'filesystem-git-sync',
  'Offline-first editing': 'offline-first-editing',
  'Mobile clients': 'mobile-clients',
  'Enterprise SSO': 'enterprise-sso',
  'Multi-server collaboration': 'multi-server-collaboration',
  'Built-in AI features': 'built-in-ai-features',
  // 01 §4.4, the bullet list, in bullet order.
  'Agent write access of any kind': 'agent-write-access',
  'Firefox, WebKit and any browser outside current Chrome and Edge': 'cross-browser-support',
  'MCP notifications, subscriptions/listen, SSE streams and Mcp-Session-Id':
    'mcp-notifications-and-sessions',
  'MCP binary resources for attachments': 'mcp-binary-resources',
  'Comments and suggestions': 'comments-and-suggestions',
  'SCIM, MFA and passkeys': 'scim-mfa-passkeys',
  'External search engines': 'external-search-engines',
  'Application-level attachment encryption': 'attachment-encryption',
  'Vault hard deletion': 'vault-hard-deletion',
  'Rendering of math, Mermaid, Dataview and query blocks': 'math-and-mermaid-rendering',
  'E-mail delivery': 'email-delivery',
  'Publishing @iridium/mcp-bridge to npm': 'npm-publishing',
  'Signed desktop installers and in-application updates': 'desktop-packaging-and-signing',
  // 10, "What each declared non-goal asserts" — the two composite claims, which §4.4 does not carry.
  'Not a complete Obsidian replacement': 'not-a-complete-obsidian-replacement',
  'No second content write path': 'no-second-content-write-path',
  // 10's assertion table spells two §4.4 rows slightly differently; both name the same non-goal.
  'Cross-browser support': 'cross-browser-support',
  'Enterprise SSO (assertion table)': 'enterprise-sso',
};

/**
 * Bullet lead-ins that restate a deferral-table row rather than declaring a new non-goal. Their text
 * is merged into the table row's entry, and they produce no id of their own.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'Enterprise single sign-on': 'enterprise-sso',
};

/**
 * `sinceMilestone` per id, and the inventory that fixes it
 * (10-testing-and-quality.md, "The non-goal guard", *Milestone phasing*).
 *
 * M0 means "assertable from the first milestone"; the guard itself is merge-blocking from M1.
 */
const SINCE_MILESTONE: Readonly<Record<string, string>> = {
  // Source trees and dependency closure only — all present at M0.
  'plugin-ecosystem': 'M0',
  'advanced-wysiwyg': 'M0',
  'filesystem-git-sync': 'M0',
  'offline-first-editing': 'M0',
  // playwright.config.ts is an M0 deliverable; 10 states this value explicitly.
  'cross-browser-support': 'M0',
  'agent-write-access': 'M0',
  'comments-and-suggestions': 'M0',
  'scim-mfa-passkeys': 'M0',
  'external-search-engines': 'M0',
  'attachment-encryption': 'M0',
  'vault-hard-deletion': 'M0',
  'email-delivery': 'M0',
  'npm-publishing': 'M0',
  // The route walk and the CLI command table: the first routes and commands land at M1.
  'automatic-link-rewriting': 'M1',
  'per-note-acl-overrides': 'M1',
  'public-sharing': 'M1',
  'cross-vault-moves': 'M1',
  'enterprise-sso': 'M1',
  'multi-server-collaboration': 'M1',
  // The registered remark/rehype plugin lists: the markdown pipeline lands at M2.
  'full-obsidian-syntax-compatibility': 'M2',
  // The MCP artefact: tools.schema.json is empty until M3.
  'mcp-notifications-and-sessions': 'M3',
  'mcp-binary-resources': 'M3',
  'built-in-ai-features': 'M3',
  // The router route tree, the IridiumHost member list and packages/ui/src/styles/tokens.css: M4.
  'graph-view': 'M4',
  'mobile-clients': 'M4',
  'math-and-mermaid-rendering': 'M4',
  'not-a-complete-obsidian-replacement': 'M4',
  // The Electron entries: electron-builder.yml's 1.0 target set and the absent updater call sites.
  'desktop-packaging-and-signing': 'M5',
  // `iridium mirror` is the last content-adjacent writer to exist; it lands at M6.
  'no-second-content-write-path': 'M6',
};

/**
 * Decisions recorded on a non-goal's entry rather than left as an open question
 * (10-testing-and-quality.md records G2's shape change explicitly).
 */
const DECISIONS: Readonly<Record<string, string>> = {
  'full-obsidian-syntax-compatibility': 'G2 answered no, 2026-09-12',
};

/** One entry of `docs/non-goals.json`. */
export interface NonGoalEntry {
  readonly id: string;
  readonly title: string;
  readonly whatTheMvpDoesInstead: string;
  readonly seamKept: string | null;
  readonly section: string | null;
  readonly sinceMilestone: string;
  /** Where the generator read this entry, so a reader can go back to the prose. */
  readonly source: string;
  /** The absence assertion of 10-testing-and-quality.md, where that section states one. */
  readonly absenceAssertion: string | null;
  /** A recorded owner decision, where one applies. */
  readonly decision?: string;
}

function slugFor(title: string, where: string): string {
  const slug = SLUGS[title];
  if (slug === undefined) {
    throw new Error(
      `${where}: no NonGoalId is recorded for ${JSON.stringify(title)}.\n` +
        '  Add it to SLUGS in scripts/build-non-goals.ts and to NON_GOAL_IDS in ' +
        'packages/contracts/src/non-goals.ts, together with its assertion in ' +
        'apps/server/test/guards/non-goals.guard.spec.ts. Crossing or declaring a non-goal is a ' +
        'three-part commit by design.',
    );
  }
  return slug;
}

/** The absence assertions of 10-testing-and-quality.md, keyed by id. */
function readAbsenceAssertions(): Map<string, { title: string; assertion: string }> {
  const source = readFileSync(PLAN_DOCUMENTS.testing, 'utf8');
  const sections = readSections(source);
  const section = requireSection(sections, 'The non-goal guard', '10-testing-and-quality.md');
  const table = requireTable(
    section.body,
    ['Non-goal', 'Absence assertion'],
    '10-testing-and-quality.md § The non-goal guard',
    section.line + 1,
  );
  const assertions = new Map<string, { title: string; assertion: string }>();
  for (const row of table.rows) {
    const title = plainText(row[0] ?? '');
    const assertion = (row[1] ?? '').trim();
    if (title === '') continue;
    assertions.set(slugFor(title, '10-testing-and-quality.md § The non-goal guard'), {
      title,
      assertion,
    });
  }
  return assertions;
}

/** The hand-written union the generated ids must equal. */
async function readDeclaredIds(): Promise<readonly string[]> {
  const module: unknown = await import(pathToFileURL(SOURCES.nonGoalIds).href);
  const exported = isRecord(module) ? module['NON_GOAL_IDS'] : undefined;
  if (!Array.isArray(exported) || !exported.every((id) => typeof id === 'string')) {
    throw new Error(
      `${SOURCES.nonGoalIds} exports no \`NON_GOAL_IDS\` array of strings. That union is what the ` +
        'generated ids are asserted against.',
    );
  }
  return exported;
}

/** Build every entry, in document order: the deferral table, then the bullets, then the composites. */
export function buildEntries(): NonGoalEntry[] {
  const vision = readFileSync(PLAN_DOCUMENTS.vision, 'utf8');
  const sections = readSections(vision);
  const section = requireSection(
    sections,
    '4.4 Explicit non-goals',
    '01-vision-scope-and-principles.md',
  );
  const where = '01-vision-scope-and-principles.md §4.4';
  const assertions = readAbsenceAssertions();

  const table = requireTable(
    section.body,
    ['Deferred capability', 'What the MVP does instead', 'Seam kept in the MVP', 'Section'],
    where,
    section.line + 1,
  );

  const entries = new Map<string, NonGoalEntry>();
  const order: string[] = [];

  const push = (entry: NonGoalEntry): void => {
    if (entries.has(entry.id)) {
      throw new Error(`${where}: ${entry.id} is declared twice.`);
    }
    entries.set(entry.id, entry);
    order.push(entry.id);
  };

  for (const row of table.rows) {
    const title = plainText(row[0] ?? '');
    if (title === '') continue;
    const id = slugFor(title, `${where} (deferral table)`);
    const entry: NonGoalEntry = {
      id,
      title,
      whatTheMvpDoesInstead: plainText(row[1] ?? ''),
      seamKept: plainText(row[2] ?? '') || null,
      section: plainText(row[3] ?? '') || null,
      sinceMilestone: milestoneFor(id),
      source: `${where} (deferral table)`,
      absenceAssertion: assertions.get(id)?.assertion ?? null,
      ...(DECISIONS[id] === undefined ? {} : { decision: DECISIONS[id] }),
    };
    push(entry);
  }

  for (const bullet of readBoldBullets(section.body, section.line + 1)) {
    const title = plainText(bullet.lead);
    const aliasOf = ALIASES[title];
    const statement = plainText(bullet.text.replace(/^\*\*.+?\*\*\s*/, ''));
    if (aliasOf !== undefined) {
      const existing = entries.get(aliasOf);
      if (existing === undefined) {
        throw new Error(
          `${where}: the bullet ${JSON.stringify(title)} aliases ${aliasOf}, which the deferral ` +
            'table did not declare.',
        );
      }
      entries.set(aliasOf, {
        ...existing,
        whatTheMvpDoesInstead: `${existing.whatTheMvpDoesInstead} ${statement}`.trim(),
        source: `${existing.source}; ${where} (bullet)`,
      });
      continue;
    }
    const id = slugFor(title, `${where} (bullet list)`);
    push({
      id,
      title,
      whatTheMvpDoesInstead: statement,
      // The bullets state their seam inline rather than in a column of their own.
      seamKept: null,
      section: null,
      sinceMilestone: milestoneFor(id),
      source: `${where} (bullet list)`,
      absenceAssertion: assertions.get(id)?.assertion ?? null,
      ...(DECISIONS[id] === undefined ? {} : { decision: DECISIONS[id] }),
    });
  }

  for (const [id, assertion] of assertions) {
    if (entries.has(id)) continue;
    push({
      id,
      title: assertion.title,
      whatTheMvpDoesInstead:
        'A composite claim of spec §1 rather than a §4.4 row: the assertion holds only when every ' +
        'assertion it composes holds, so the scope sentence has one failing test rather than four ' +
        'partial ones.',
      seamKept: null,
      section: '01-vision-scope-and-principles.md §1.3',
      sinceMilestone: milestoneFor(id),
      source: '10-testing-and-quality.md § The non-goal guard (composite claim)',
      absenceAssertion: assertion.assertion,
      ...(DECISIONS[id] === undefined ? {} : { decision: DECISIONS[id] }),
    });
  }

  return order.map((id) => {
    const entry = entries.get(id);
    if (entry === undefined) throw new Error(`internal: ${id} vanished from the entry map`);
    return entry;
  });
}

function milestoneFor(id: string): string {
  const milestone = SINCE_MILESTONE[id];
  if (milestone === undefined) {
    throw new Error(
      `No sinceMilestone is recorded for ${id}. Add it to SINCE_MILESTONE in ` +
        'scripts/build-non-goals.ts, naming the inventory that fixes the value ' +
        '(10-testing-and-quality.md § The non-goal guard, *Milestone phasing*).',
    );
  }
  return milestone;
}

/** The equality `guards.non-goals.guard` asserts first, asserted here at generation time. */
export function assertIdsMatchUnion(
  generated: readonly string[],
  declared: readonly string[],
): void {
  const generatedSet = new Set(generated);
  const declaredSet = new Set(declared);
  const missing = declared.filter((id) => !generatedSet.has(id));
  const extra = generated.filter((id) => !declaredSet.has(id));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    'docs/non-goals.json ids do not equal the NonGoalId union of ' +
      'packages/contracts/src/non-goals.ts.\n' +
      (missing.length > 0
        ? `  declared but not generated: ${missing.join(', ')}\n` +
          '    → the union names a non-goal 01 §4.4 does not declare, or SLUGS maps its heading to ' +
          'a different id.\n'
        : '') +
      (extra.length > 0
        ? `  generated but not declared: ${extra.join(', ')}\n` +
          '    → 01 §4.4 declares a non-goal the union does not. Add it to NON_GOAL_IDS and write ' +
          "its assertion; the guard's `satisfies Record<NonGoalId, NonGoalAssertion>` will not " +
          'compile until you do.\n'
        : ''),
  );
}

export const step: Step = {
  name: 'declared non-goals',
  produces: 'docs/non-goals.json',
  async run(context: StepContext): Promise<StepResult> {
    const entries = buildEntries();
    const declared = await readDeclaredIds();
    assertIdsMatchUnion(
      entries.map((entry) => entry.id),
      declared,
    );

    const document = {
      generatedBy: 'scripts/build-non-goals.ts',
      source: '01-vision-scope-and-principles.md §4.4',
      description:
        'Every declared non-goal, in the order 01-vision-scope-and-principles.md §4.4 states them: ' +
        'the deferral table, then the bullet list, then the two composite claims of spec §1. ' +
        '`guards.non-goals.guard` asserts that these ids equal the `NonGoalId` union of ' +
        '`packages/contracts/src/non-goals.ts` and then runs one absence assertion per id.',
      nonGoals: entries,
    };
    const outcome = writeJsonOrCompare(ARTEFACTS.nonGoals, document, context.check);

    const orderMatches = entries.every((entry, index) => entry.id === declared[index]);
    return {
      summary: `${String(entries.length)} non-goal(s), ${String(outcome.bytes)} bytes`,
      writes: [outcome],
      details: orderMatches
        ? []
        : [
            'ids match as a set but not in order: the generated order follows 01 §4.4, while ' +
              'NON_GOAL_IDS declares a different one. The guard compares sets, so this is a ' +
              "documentation mismatch in that file's header comment, not a failure.",
          ],
    };
  },
};

if (import.meta.main) await runAsMain(step);
