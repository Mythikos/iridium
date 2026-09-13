/**
 * Step 3 of `pnpm gen`: `openapi-typescript 7.13.0` → `packages/api-client/src/generated/paths.d.ts`
 * (12-milestones.md §4.3; 09-api-reference.md §6).
 *
 * These are the types the `openapi-fetch 0.17.0` client is parameterised by, so they are what makes a
 * removed response field a type error in `@iridium/ui` rather than a runtime `undefined`. The
 * generator is run with no `--output`, capturing stdout, so the bytes that land in the repository pass
 * through `writeOrCompare` like every other artefact: one normalisation, one comparison, one report.
 *
 * The file is a `.d.ts` under a `generated/` directory, which `.oxfmtrc.jsonc` and `oxlint.config.ts`
 * both exclude, and `.gitattributes` marks `packages/api-client/src/generated/**` as
 * `linguist-generated`. It is still type-checked, because the whole point is that the client compiles
 * against it.
 */
import { ARTEFACTS, API_CLIENT_ROOT } from './lib/paths.ts';
import { resolveTool, runToolOrThrow } from './lib/process.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { OPENAPI_TYPESCRIPT } from './lib/tools.ts';
import { generatedBanner, writeOrCompare } from './lib/write.ts';

export const step: Step = {
  name: 'api client types',
  produces: 'packages/api-client/src/generated/paths.d.ts',
  // The plan lints before it generates so a schema mistake is reported as a schema mistake; typing a
  // document that failed lint would report the same fault a second time, as a type error.
  dependsOn: ['openapi export', 'openapi lint'],
  run(context: StepContext): Promise<StepResult> {
    const tool = resolveTool(OPENAPI_TYPESCRIPT);
    const result = runToolOrThrow(
      tool,
      [
        ARTEFACTS.openapi,
        // Keep every schema's `additionalProperties: false` faithful rather than widening it, so the
        // generated request types reject the unknown fields `z.strictObject` rejects at runtime
        // (09-api-reference.md §1.1, "Unknown JSON fields").
        '--empty-objects-unknown',
        // `readonly` on generated response members: a client that mutates a response it did not
        // create is the bug this flag makes a type error.
        '--immutable',
        // Paths are sorted so the emitted order follows the document rather than the filesystem.
        '--alphabetize',
      ],
      { cwd: API_CLIENT_ROOT },
    );
    const banner = generatedBanner(
      'scripts/generate-api-types.ts',
      `\`openapi-typescript ${tool.version}\` over packages/contracts/openapi/openapi.json`,
    );
    const outcome = writeOrCompare(
      ARTEFACTS.apiClientPaths,
      `${banner}\n\n${result.stdout.trim()}`,
      context.check,
    );
    return Promise.resolve({
      summary: `${tool.pkg}@${tool.version}, ${String(outcome.bytes)} bytes`,
      writes: [outcome],
    });
  },
};

if (import.meta.main) await runAsMain(step);
