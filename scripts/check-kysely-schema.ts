/**
 * Step 4 of `pnpm gen`: the `kysely-codegen 0.20.0` diff against `apps/server/src/db/schema.ts`
 * (12-milestones.md §4.3; 09-api-reference.md §6; 03-data-model.md §1.3; decision A7).
 *
 * This step **writes nothing**. `schema.ts` is hand-written by design, so the only thing a generator
 * can do with it is compare — which is why it contributes no bytes to `git diff --exit-code` and why
 * `gen.drift.guard` is still honest without it.
 *
 * ## What it does
 *
 * 1. Starts the harness's own MySQL fixture (`@iridium/testkit`'s `startMysql`, reached through
 *    `apps/server/test/db-mysql-container.ts` for its per-role URLs) on the image
 *    `IRIDIUM_MYSQL_IMAGE` selects, defaulting to the compatibility floor `mysql:8.4.11`.
 * 2. Migrates it with the **server's own migrator** — `createMaintDb` + `migrateToLatest` over the
 *    bundled migration list — so the schema under comparison is the schema a deployment gets, not a
 *    filesystem scan of whatever `.ts` files happen to sit next to it.
 * 3. Runs `kysely-codegen --print` against it.
 * 4. Compares the emitted `DB` interface with the hand-written `Database` structurally: every table
 *    and every column in both directions, nullability, `Generated`/`GeneratedAlways`, and types under
 *    the documented normalisation of `scripts/lib/kysely-schema.ts`.
 *
 * ## Why a structural comparison rather than a byte diff
 *
 * 03-data-model.md §1.3 requires two things of the hand-written file that no generator emits:
 * string-literal unions for every `ENUM` column and a typed shape per JSON column. A byte diff would
 * be permanently red, or would force `schema.ts` to reproduce the generator's output and give up both.
 * So the comparison normalises exactly the differences the plan asks for and compares everything else
 * exactly — including the enum members, resolved through `schema.ts`'s own type aliases, so a missing
 * `ENUM` value is still caught. Every normalisation that fires is counted in the output.
 *
 * `migrations.integration` asserts the same invariant from the other side, against
 * `information_schema`, on both merge-blocking MySQL matrix entries.
 *
 * ## The one step that needs Docker
 *
 * `pnpm gen --skip-db` (or `IRIDIUM_GEN_SKIP_DB=1`) skips it, which is what the `static` CI job does:
 * that job has no Docker, and this step writes no artefact, so skipping it cannot hide a drift in any
 * committed file. The skip is printed, never silent, and it names `migrations.integration` as the lane
 * that enforces the same invariant.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMaintDb, migrateToLatest } from '../apps/server/src/db/migrator.ts';
import { IRIDIUM_SCHEMA, startIridiumMysql } from '../apps/server/test/db-mysql-container.ts';
import { compareSchemas, parseKyselySchema } from './lib/kysely-schema.ts';
import { ARTEFACTS, SERVER_ROOT } from './lib/paths.ts';
import { resolveTool, runToolOrThrow } from './lib/process.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { KYSELY_CODEGEN } from './lib/tools.ts';

/** The interface `kysely-codegen` emits, and the one `schema.ts` hand-writes. */
const GENERATED_INTERFACE = 'DB';
const HAND_WRITTEN_INTERFACE = 'Database';

export const step: Step = {
  name: 'kysely schema diff',
  produces: '(comparison only — schema.ts is hand-written)',
  async run(context: StepContext): Promise<StepResult> {
    if (context.skipDatabase) {
      return {
        summary: '',
        skipped:
          'no database requested (--skip-db / IRIDIUM_GEN_SKIP_DB=1). This step writes no artefact, ' +
          'so the drift gate is unaffected; `migrations.integration` asserts the same invariant ' +
          'against information_schema on both required MySQL images.',
      };
    }

    const tool = resolveTool(KYSELY_CODEGEN);
    const mysql = await startIridiumMysql();
    try {
      const maint = createMaintDb(mysql.migratorUrl(IRIDIUM_SCHEMA));
      try {
        const outcome = await migrateToLatest({
          db: maint.db,
          target: maint.target,
          allowLongRunning: true,
        });
        if (outcome.error !== undefined) throw outcome.error;
      } finally {
        await maint.db.destroy();
      }

      // `--print` writes the module to stdout, so the bytes never touch the repository — this step
      // compares, it does not generate. The temporary directory is only kysely-codegen's own default
      // output location, which `--print` makes unused; naming it keeps the tool from writing into
      // `node_modules`.
      const scratch = mkdtempSync(join(tmpdir(), 'iridium-kysely-'));
      const result = runToolOrThrow(
        tool,
        [
          '--print',
          '--dialect',
          'mysql',
          '--url',
          mysql.rootUrl(IRIDIUM_SCHEMA),
          '--log-level',
          'silent',
          '--out-file',
          join(scratch, 'db.d.ts'),
        ],
        { cwd: SERVER_ROOT },
      );

      // `IRIDIUM_GEN_DUMP_KYSELY=<path>` writes the generator's own module out, which is how a new
      // normalisation is justified against the real emit rather than against a guess about it.
      const dump = process.env['IRIDIUM_GEN_DUMP_KYSELY'];
      if (dump !== undefined && dump !== '') writeFileSync(dump, result.stdout, 'utf8');

      const generated = parseKyselySchema(result.stdout, GENERATED_INTERFACE);
      const handWritten = parseKyselySchema(
        readFileSync(ARTEFACTS.kyselySchema, 'utf8'),
        HAND_WRITTEN_INTERFACE,
      );
      const comparison = compareSchemas(generated, handWritten);

      if (comparison.differences.length > 0) {
        throw new Error(
          `kysely-codegen output and apps/server/src/db/schema.ts disagree on ` +
            `${String(comparison.differences.length)} item(s), against ${mysql.image}:\n` +
            comparison.differences
              .map((difference) => `  [${difference.kind}] ${difference.detail}`)
              .join('\n') +
            '\n  schema.ts is hand-written by design (03-data-model.md §1.3): fix whichever side is ' +
            'wrong. A migration that forgets its type change and a type change with no migration ' +
            'both land here.',
        );
      }

      return {
        summary:
          `${tool.pkg}@${tool.version} against ${mysql.image}: ` +
          `${String(comparison.tablesCompared)} tables, ${String(comparison.columnsCompared)} columns, ` +
          'no difference',
        details: [
          `${String(comparison.allowances.length)} documented normalisation(s) applied`,
          ...comparison.allowances
            .slice(0, 8)
            .map((allowance) => `  ${allowance.table}.${allowance.column}: ${allowance.reason}`),
          ...(comparison.allowances.length > 8
            ? [`  … and ${String(comparison.allowances.length - 8)} more`]
            : []),
        ],
      };
    } finally {
      await mysql.stop();
    }
  },
};

if (import.meta.main) await runAsMain(step);
