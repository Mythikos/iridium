/**
 * `pnpm gen` — the codegen pipeline (12-milestones.md §4.3, "Codegen pipeline").
 *
 * The order below is the plan's, and it is an order rather than a set for three reasons it states:
 * the OpenAPI document is linted before anything is generated from it, so a schema mistake is reported
 * as a schema mistake; `scripts/build-non-goals.ts` runs immediately before the acceptance map; and
 * `scripts/build-acceptance-map.ts` runs **last**, because it references the operation and tool names
 * the earlier steps emit.
 *
 * ```
 * 1  server OpenAPI export      app.swagger() in `in-process` mode with database: 'none'
 * 2  redocly lint               @redocly/cli 2.52.1
 * 3  api client types           openapi-typescript 7.13.0
 * 4  kysely schema diff         kysely-codegen 0.20.0 vs apps/server/src/db/schema.ts
 * 5  mcp tool schema            packages/contracts/mcp/tools.schema.json
 * 6  desktop ipc typings        packages/contracts/src/generated/desktop-ipc.d.ts
 * 7  msw handler skeleton       packages/testkit/src/msw/generated/operations.ts
 * 8  declared non-goals         docs/non-goals.json
 * 9  acceptance map             docs/acceptance-map.json
 * ```
 *
 * `pnpm gen:check` is `pnpm gen && git diff --exit-code`, which is `gen.drift.guard`. `--check` on
 * this script is the same code path with every write suppressed: it reports which artefacts *would*
 * change and exits non-zero, so a contributor sees the artefact named before the drift gate reports
 * the diff.
 *
 * **One step needs Docker.** Step 4 starts a MySQL container, migrates it and compares the generated
 * types with the hand-written `Database`. It writes no artefact, so `git diff --exit-code` is
 * unaffected by it; `pnpm gen --skip-db` (or `IRIDIUM_GEN_SKIP_DB=1`) is what the `static` CI job,
 * which has no Docker, passes. The skip is printed with the lane that enforces the same invariant
 * (`migrations.integration`, on both required MySQL images) and is never silent.
 *
 * **A failing step does not stop the run.** `pnpm gen` exists to bring committed artefacts up to date,
 * and a tool missing from one step is no reason to leave the other eight stale — a half-regenerated
 * tree is exactly the state the drift gate is meant to catch, and it is worse to create it here. Each
 * step declares what it reads (`Step.dependsOn`), so a step whose input failed is *blocked* rather
 * than run: nobody reads a second, derived failure instead of the first real one. The run exits
 * non-zero with every failure named.
 */
import { step as acceptanceMap } from './build-acceptance-map.ts';
import { step as nonGoals } from './build-non-goals.ts';
import { step as kyselySchema } from './check-kysely-schema.ts';
import { step as mcpTools } from './export-mcp-tools.ts';
import { step as openapiExport } from './export-openapi.ts';
import { step as apiTypes } from './generate-api-types.ts';
import { step as desktopIpc } from './generate-desktop-ipc.ts';
import { step as mswHandlers } from './generate-msw-handlers.ts';
import { parseContext, type Step } from './lib/step.ts';
import type { WriteOutcome } from './lib/write.ts';
import { step as openapiLint } from './lint-openapi.ts';

/** The ordered pipeline of 12-milestones.md §4.3. */
export const STEPS: readonly Step[] = [
  openapiExport,
  openapiLint,
  apiTypes,
  kyselySchema,
  mcpTools,
  desktopIpc,
  mswHandlers,
  nonGoals,
  acceptanceMap,
];

async function main(): Promise<void> {
  const context = parseContext(process.argv.slice(2));
  const started = Date.now();
  const writes: WriteOutcome[] = [];
  const skipped: string[] = [];

  const failed = new Set<string>();
  const blocked = new Map<string, string>();

  console.info(context.check ? 'pnpm gen --check' : 'pnpm gen');
  for (const [index, step] of STEPS.entries()) {
    const label = `${String(index + 1)}/${String(STEPS.length)} ${step.name}`;
    const blocker = (step.dependsOn ?? []).find(
      (dependency) => failed.has(dependency) || blocked.has(dependency),
    );
    if (blocker !== undefined) {
      blocked.set(step.name, blocker);
      console.error(`  ${label}: BLOCKED by \`${blocker}\``);
      continue;
    }
    try {
      // The pipeline is an ordered sequence by specification (12-milestones.md §4.3): each step reads
      // what the previous ones wrote, and the acceptance map runs last because it references their
      // output. Parallelism would be the bug, not the fix.
      // eslint-disable-next-line no-await-in-loop -- see above
      const result = await step.run(context);
      if (result.skipped !== undefined) {
        skipped.push(step.name);
        console.warn(`  ${label}: SKIPPED`);
        console.warn(`      ${result.skipped}`);
        continue;
      }
      console.info(`  ${label}: ${result.summary}`);
      for (const line of result.details ?? []) console.info(`      ${line}`);
      writes.push(...(result.writes ?? []));
    } catch (error) {
      failed.add(step.name);
      console.error(`  ${label}: FAILED`);
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        message
          .split('\n')
          .map((line) => `      ${line}`)
          .join('\n'),
      );
    }
  }

  const changed = writes.filter((write) => write.changed);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  console.info('');
  console.info(`Artefacts (${String(writes.length)}):`);
  for (const write of writes) {
    const mark = write.changed ? (context.check ? 'STALE  ' : 'written') : 'current';
    console.info(`  ${mark}  ${String(write.bytes).padStart(8)} B  ${write.path}`);
  }
  if (skipped.length > 0) console.info(`Skipped: ${skipped.join(', ')}`);
  console.info(`Done in ${seconds}s.`);

  if (failed.size > 0 || blocked.size > 0) {
    console.error('');
    if (failed.size > 0) console.error(`Failed: ${[...failed].join(', ')}`);
    for (const [step, blocker] of blocked) console.error(`Blocked: ${step} (needs ${blocker})`);
    process.exitCode = 1;
  }

  if (context.check && changed.length > 0) {
    console.error('');
    console.error(
      `${String(changed.length)} artefact(s) are out of date. Run \`pnpm gen\` and commit the result.`,
    );
    process.exitCode = 1;
  }
}

await main();
