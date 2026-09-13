/**
 * `scripts/check-openapi-coverage.ts` — run by ``ci.yml › merge-reports › `OpenAPI operation
 * coverage` ``, after the Vitest blob reports have been merged and the lane reports downloaded into
 * `reports/`.
 *
 * The rule is 10-testing-and-quality.md, "REST — OpenAPI contract" and decision D10-10: every
 * documented `(operationId, status)` pair must be exercised somewhere in the `integration` +
 * `contract` run. `apps/server/test/contract/openapi.coverage.contract.spec.ts` records each pair a
 * test asserted, its workers write to a shared file, and this script aggregates them in
 * `merge-reports` — the one job that sees every lane.
 *
 * That makes the OpenAPI document honest in **both** directions. The `static` job's Redocly lint and
 * the `pnpm gen` drift gate stop the code from diverging from the document; this stops the document
 * from describing responses nobody produces. An addition to the document therefore requires a test,
 * and a documented operation no milestone registers is a red lane rather than a harmless omission —
 * including the two documentation operations `meta.openapi` and `meta.docs`, which are in the
 * coverage list like every other operation (02-system-architecture.md ARCH-27).
 *
 * ## At M0 there are no operations, and that passes
 *
 * `packages/contracts/openapi/openapi.json` is generated from the server's own route table and
 * currently declares zero paths. Zero documented pairs means zero uncovered pairs, so the check
 * passes and says so. It starts biting at M1, the milestone the inventory row gives
 * `openapi.coverage.contract` — with no edit here, because the rule is a comparison and not a list.
 *
 * ## Where the exercised pairs come from
 *
 * `reports/openapi-coverage/*.json`, each file `{ "pairs": [{ "operationId": …, "status": … }] }`,
 * one per worker. The directory is overridable with `IRIDIUM_TEST_OPENAPI_COVERAGE_REPORTS`, which
 * mirrors `IRIDIUM_TEST_HOST_CONTRACT_REPORTS` in the same job: the plan fixes the mechanism ("a
 * shared JSON file that the `merge-reports` job aggregates") and not the path, so the path follows
 * the convention the neighbouring check already established — a directory under `reports/`, one file
 * per writer, because concurrent Vitest workers cannot share one file without losing records.
 *
 * `default` responses are not pairs. A `default` is the shape of *whatever else* an operation can
 * return, so "exercising the default" names no status a test could assert; every concrete status
 * beside it is in the list.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import {
  finding,
  repoPath,
  runAsMain,
  type Check,
  type CheckResult,
  type Finding,
} from './lib/check.ts';
import { filesWithSuffix, isDirectory, isFile } from './lib/files.ts';
import { arrayMember, isRecord, parseJson, stringMember } from './lib/json.ts';
import { ARTEFACTS, REPO_ROOT, REPORTS_ROOT } from './lib/paths.ts';

/** The HTTP methods an OpenAPI path item can carry. */
const METHODS: readonly string[] = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

/** Where the workers write, and the variable that moves it. Relative values are repository-relative. */
function reportsDirectory(): string {
  const configured = process.env['IRIDIUM_TEST_OPENAPI_COVERAGE_REPORTS']?.trim();
  if (configured === undefined || configured === '') return join(REPORTS_ROOT, 'openapi-coverage');
  return isAbsolute(configured) ? configured : join(REPO_ROOT, configured);
}

/** One documented `(operationId, status)` pair, with where it is documented. */
interface Pair {
  readonly operationId: string;
  readonly status: string;
  readonly path: string;
  readonly method: string;
}

interface Document {
  readonly pairs: readonly Pair[];
  /** Operations with no `operationId`, which cannot be covered by name. */
  readonly unnamed: readonly { readonly path: string; readonly method: string }[];
}

function readDocument(): Document {
  const parsed = parseJson(readFileSync(ARTEFACTS.openapi, 'utf8'));
  const paths = isRecord(parsed) ? parsed['paths'] : undefined;
  const pairs: Pair[] = [];
  const unnamed: { path: string; method: string }[] = [];
  if (!isRecord(paths)) return { pairs, unnamed };

  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isRecord(operation)) continue;
      const operationId = stringMember(operation, 'operationId');
      if (operationId === undefined) {
        unnamed.push({ path, method });
        continue;
      }
      const responses = operation['responses'];
      if (!isRecord(responses)) continue;
      for (const status of Object.keys(responses)) {
        if (status.toLowerCase() === 'default') continue;
        pairs.push({ operationId, status, path, method });
      }
    }
  }
  return {
    pairs: pairs.toSorted(
      (a, b) => a.operationId.localeCompare(b.operationId) || a.status.localeCompare(b.status),
    ),
    unnamed: unnamed.toSorted(
      (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
    ),
  };
}

/** What the lanes recorded, and the files that were unreadable. */
interface Exercised {
  readonly pairs: ReadonlySet<string>;
  readonly files: number;
  readonly unreadable: readonly { readonly path: string; readonly why: string }[];
}

function readExercised(directory: string): Exercised {
  const pairs = new Set<string>();
  const unreadable: { path: string; why: string }[] = [];
  const files = filesWithSuffix(directory, '.json');
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = parseJson(readFileSync(file, 'utf8'));
    } catch (error) {
      unreadable.push({
        path: file,
        why: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const list = arrayMember(parsed, 'pairs');
    if (list === undefined) {
      unreadable.push({ path: file, why: 'no `pairs` array' });
      continue;
    }
    for (const entry of list) {
      const operationId = stringMember(entry, 'operationId');
      const status = isRecord(entry) ? entry['status'] : undefined;
      if (operationId === undefined || (typeof status !== 'string' && typeof status !== 'number')) {
        continue;
      }
      pairs.add(`${operationId} ${String(status)}`);
    }
  }
  return { pairs, files: files.length, unreadable };
}

export const check: Check = {
  name: 'check-openapi-coverage',
  workflow: 'ci.yml › merge-reports › `OpenAPI operation coverage`',
  owns: '10-testing-and-quality.md, "REST — OpenAPI contract" (D10-10)',
  run(): CheckResult {
    const findings: Finding[] = [];
    const details: string[] = [];

    if (!isFile(ARTEFACTS.openapi)) {
      findings.push(
        finding(
          ARTEFACTS.openapi,
          'the OpenAPI document does not exist, so nothing can be compared against it.',
          "run `pnpm gen` to regenerate it from the server's route table.",
        ),
      );
      return { summary: 'the OpenAPI document is missing.', findings };
    }

    const document = readDocument();
    const directory = reportsDirectory();
    const exercised = readExercised(directory);

    details.push(
      `${String(document.pairs.length)} documented (operationId, status) pair(s) in ` +
        `${repoPath(ARTEFACTS.openapi)}.`,
    );
    if (isDirectory(directory)) {
      details.push(
        `${String(exercised.pairs.size)} pair(s) recorded across ${String(exercised.files)} report ` +
          `file(s) in ${repoPath(directory)}.`,
      );
    } else {
      details.push(
        `${repoPath(directory)} does not exist: no lane recorded an exercised pair. ` +
          '`openapi.coverage.contract` arrives at M1.',
      );
    }

    for (const operation of document.unnamed) {
      findings.push(
        finding(
          ARTEFACTS.openapi,
          `\`${operation.method.toUpperCase()} ${operation.path}\` has no \`operationId\`, so no test can ` +
            'record covering it.',
          'give the route an `operationId` in its Fastify schema and run `pnpm gen`; coverage is keyed on ' +
            'the operation id.',
        ),
      );
    }

    for (const file of exercised.unreadable) {
      findings.push(
        finding(
          file.path,
          `this coverage report could not be read (${file.why}), so the pairs it recorded are lost.`,
          'the writer is `apps/server/test/contract/openapi.coverage.contract.spec.ts`; each file is ' +
            '`{ "pairs": [{ "operationId": "…", "status": 200 }] }`.',
        ),
      );
    }

    const uncovered = document.pairs.filter(
      (pair) => !exercised.pairs.has(`${pair.operationId} ${pair.status}`),
    );
    for (const pair of uncovered) {
      findings.push(
        finding(
          ARTEFACTS.openapi,
          `\`${pair.operationId}\` documents a ${pair.status} response ` +
            `(\`${pair.method.toUpperCase()} ${pair.path}\`) that no test in the integration or contract ` +
            'run exercised.',
          'assert that response in a test, or stop documenting it — an addition to the document requires ' +
            'a test, and a documented response nobody produces is exactly what this check exists to find.',
        ),
      );
    }

    // Recorded pairs the document does not describe are a drift signal in the other direction: the
    // test asserted something the document has since dropped or renamed.
    const documented = new Set(document.pairs.map((pair) => `${pair.operationId} ${pair.status}`));
    const stale = [...exercised.pairs].filter((pair) => !documented.has(pair)).toSorted();
    if (stale.length > 0) {
      details.push(
        `${String(stale.length)} recorded pair(s) are not in the document any more: ${stale.join(', ')}. ` +
          'The document is the authority; a stale record means an operation was renamed or removed.',
      );
    }

    return {
      summary:
        findings.length === 0
          ? document.pairs.length === 0
            ? 'the OpenAPI document declares no operations yet; nothing to cover.'
            : `all ${String(document.pairs.length)} documented (operationId, status) pair(s) were exercised.`
          : `${String(uncovered.length)} of ${String(document.pairs.length)} documented ` +
            '(operationId, status) pair(s) were never exercised.',
      details,
      findings,
    };
  },
};

if (import.meta.main) await runAsMain(check);
