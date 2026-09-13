/**
 * Step 7 of `pnpm gen`: the msw handler skeleton,
 * `packages/testkit/src/msw/generated/operations.ts`
 * (12-milestones.md §4.3; 09-api-reference.md §6, "`packages/testkit/src/msw/handlers.ts` — Skeleton
 * generated from `openapi.json`").
 *
 * **What is generated and what is not.** The testkit already owns the hand-written half in
 * `packages/testkit/src/msw/handlers.ts`: the origin convention, the RFC 9457 `ProblemDetails` shape
 * and the rule that an operation with no stub answers `501 not_implemented` rather than escaping to
 * the network. Those are decisions. What is derived is the *operation list* — one entry per
 * `(method, path, operationId)` in the committed document — because that is the part that must follow
 * the contract, and `operationsFromOpenApi` reading the document at runtime would make a component
 * test's stub set depend on a file the component project has no reason to load.
 *
 * The emitted paths are msw patterns, not OpenAPI templates: `{noteId}` becomes `:noteId`, which is
 * the substitution `handlers.ts` already performs, kept here so the two spellings cannot diverge.
 */
import { readFileSync } from 'node:fs';

import { ARTEFACTS } from './lib/paths.ts';
import { runAsMain, type Step, type StepContext, type StepResult } from './lib/step.ts';
import { generatedBanner, repoRelative, writeOrCompare } from './lib/write.ts';

/** The methods msw's `http` object exposes, which is also the set `handlers.ts` types. */
const METHODS: readonly string[] = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `(method, path, operationId)` triples out of the committed document, in document order. */
export function operationsFrom(document: unknown): Operation[] {
  if (!isRecord(document)) throw new Error('the OpenAPI document is not an object');
  const paths = document['paths'];
  if (paths !== undefined && !isRecord(paths)) {
    throw new Error('the OpenAPI document declares a non-object `paths`');
  }
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(paths ?? {})) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const operationId = operation['operationId'];
      if (typeof operationId !== 'string') {
        throw new Error(
          `${method.toUpperCase()} ${path} has no \`operationId\`. Every route carries one ` +
            '(09-api-reference.md §6, D09-4), and the msw stub set is keyed on it.',
        );
      }
      operations.push({
        method,
        // OpenAPI templates `{id}`; msw matches `:id`.
        path: path.replaceAll(/\{([^}]+)\}/g, ':$1'),
        operationId,
      });
    }
  }
  return operations;
}

function render(operations: readonly Operation[]): string {
  const entries = operations.map(
    (operation) =>
      `  { method: '${operation.method}', path: '${operation.path}', ` +
      `operationId: '${operation.operationId}' },`,
  );
  const body =
    entries.length === 0
      ? 'export const GENERATED_OPERATIONS: readonly OperationStub[] = [];'
      : ['export const GENERATED_OPERATIONS: readonly OperationStub[] = [', ...entries, '];'].join(
          '\n',
        );

  return [
    generatedBanner('scripts/generate-msw-handlers.ts', 'packages/contracts/openapi/openapi.json'),
    '',
    "import type { OperationStub } from '../handlers.ts';",
    '',
    '/**',
    ' * Every REST operation the committed OpenAPI document declares, in document order.',
    ' *',
    ' * Pass it to `notImplementedHandlers` to get one `501 not_implemented` stub per operation, then',
    ' * override the handful a suite cares about with `server.use(...)`. Anything the suite forgot then',
    ' * fails naming the operation, instead of reaching a real socket.',
    ' */',
    body,
    '',
  ].join('\n');
}

export const step: Step = {
  name: 'msw handler skeleton',
  produces: 'packages/testkit/src/msw/generated/operations.ts',
  dependsOn: ['openapi export'],
  run(context: StepContext): Promise<StepResult> {
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(ARTEFACTS.openapi, 'utf8'));
    } catch (error) {
      throw new Error(
        `${repoRelative(ARTEFACTS.openapi)} could not be read; step 1 of \`pnpm gen\` writes it.`,
        { cause: error },
      );
    }
    const operations = operationsFrom(document);
    const outcome = writeOrCompare(ARTEFACTS.mswOperations, render(operations), context.check);
    return Promise.resolve({
      summary: `${String(operations.length)} operation stub(s), ${String(outcome.bytes)} bytes`,
      writes: [outcome],
    });
  },
};

if (import.meta.main) await runAsMain(step);
