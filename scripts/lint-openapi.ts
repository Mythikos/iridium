/**
 * Step 2 of `pnpm gen`: `@redocly/cli 2.52.1 lint` over the document step 1 just exported
 * (12-milestones.md §4.3; 09-api-reference.md §6, the "Checked by" column).
 *
 * It runs before `openapi-typescript` deliberately. A document with an invalid schema still generates
 * types — wrong ones — so linting after the type generation would report the cause of a type error
 * that a reader has already spent time on. Linting here means a bad schema is named as a schema
 * problem.
 *
 * The ruleset is `packages/contracts/openapi/redocly.yaml`, next to the document, with the reason for
 * every relaxed rule written beside it. `spec` and `struct` stay errors, so an invalid OpenAPI 3.1
 * document fails the `static` job.
 *
 * This step writes nothing: it is a gate, not a generator, so it contributes no bytes to
 * `git diff --exit-code`.
 */
import { dirname } from 'node:path';

import { ARTEFACTS, CONTRACTS_ROOT } from './lib/paths.ts';
import { resolveTool, runTool } from './lib/process.ts';
import { runAsMain, type Step, type StepResult } from './lib/step.ts';
import { REDOCLY } from './lib/tools.ts';
import { repoRelative } from './lib/write.ts';

/** The ruleset that lints the document, beside the document it lints. */
const REDOCLY_CONFIG = `${dirname(ARTEFACTS.openapi).replaceAll('\\', '/')}/redocly.yaml`;

export const step: Step = {
  name: 'openapi lint',
  produces: '(gate only — no artefact)',
  dependsOn: ['openapi export'],
  run(): Promise<StepResult> {
    const tool = resolveTool(REDOCLY);
    const result = runTool(
      tool,
      [
        'lint',
        ARTEFACTS.openapi,
        '--config',
        REDOCLY_CONFIG,
        '--format',
        'stylish',
        // A warning is information; an error fails the job. Redocly's own exit code already
        // distinguishes them, so nothing here has to interpret the output text.
        '--max-problems',
        '100',
      ],
      { cwd: CONTRACTS_ROOT },
    );
    const output = [result.stdout, result.stderr]
      .map((stream) => stream.trim())
      .filter((stream) => stream !== '')
      .join('\n');
    if (result.exitCode !== 0) {
      throw new Error(
        `redocly lint reported errors in ${repoRelative(ARTEFACTS.openapi)}\n${output}`,
      );
    }
    const warnings = [...output.matchAll(/^\s*Warning/gm)].length;
    return Promise.resolve({
      summary:
        `${tool.pkg}@${tool.version} clean` +
        (warnings === 0 ? '' : ` (${String(warnings)} warning(s))`),
      details: warnings === 0 ? [] : output.split('\n'),
    });
  },
};

if (import.meta.main) await runAsMain(step);
