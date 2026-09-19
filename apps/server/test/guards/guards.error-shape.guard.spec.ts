/** Every literal ProblemDetails producer uses the shared closed wire vocabulary. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ERROR_CODES } from '@iridium/contracts';
import { parseSync, Visitor, type Node } from 'oxc-parser';
import { describe, expect, it } from 'vitest';

import {
  isTestPath,
  locate,
  REPO_ROOT,
  sourceOf,
  sourcesUnder,
  type Source,
} from './source-scan.ts';

const ALLOWED: ReadonlySet<string> = new Set(ERROR_CODES);
const SOURCES = sourcesUnder(['apps/server/src']).filter((source) => !isTestPath(source.path));

function name(node: Node): string | null {
  if (node.type === 'Identifier') return node.name;
  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}
function literals(node: Node | undefined): string[] {
  if (node === undefined) return [];
  if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  )
    return literals(node.expression);
  if (node.type === 'ConditionalExpression')
    return [...literals(node.consequent), ...literals(node.alternate)];
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis.flatMap((part) => (part.value.cooked === null ? [] : [part.value.cooked]));
  return []; // Dynamic ErrorCode values remain checked by the closed TypeScript union.
}
function unknownCodes(source: Source, allowed: ReadonlySet<string>): string[] {
  const parsed = parseSync(source.path, source.raw);
  if (parsed.errors.length > 0)
    return parsed.errors.map((error) => `${source.path}: parse failed: ${error.message}`);
  const constructors = new Set(['ProblemError']);
  const senders = new Set(['sendProblem']);
  new Visitor({
    ImportDeclaration(node) {
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportSpecifier') continue;
        if (name(specifier.imported) === 'ProblemError') constructors.add(specifier.local.name);
        if (name(specifier.imported) === 'sendProblem') senders.add(specifier.local.name);
      }
    },
  }).visit(parsed.program);
  const failures: string[] = [];
  const check = (node: Node | undefined): void => {
    if (node === undefined) return;
    for (const code of literals(node))
      if (!allowed.has(code))
        failures.push(`${locate(source, node.start)}: unknown ProblemDetails code ${code}`);
  };
  new Visitor({
    NewExpression(node) {
      if (constructors.has(name(node.callee) ?? '')) check(node.arguments[0]);
    },
    CallExpression(node) {
      if (senders.has(name(node.callee) ?? '')) check(node.arguments[2]);
    },
    ObjectExpression(node) {
      const properties = node.properties.filter((property) => property.type === 'Property');
      const keys = new Set(properties.map((property) => name(property.key)));
      if (
        !keys.has('code') ||
        !(keys.has('extensions') || (keys.has('type') && keys.has('status')))
      )
        return;
      check(properties.find((property) => name(property.key) === 'code')?.value);
    },
  }).visit(parsed.program);
  return failures;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Missing OpenAPI object');
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the decoded JSON object boundary was checked above.
  return value as Record<string, unknown>;
}
function wireCodes(value: unknown): unknown {
  return object(
    object(
      object(object(object(object(value)['components'])['schemas'])['ProblemDetails'])[
        'properties'
      ],
    )['code'],
  )['enum'];
}

describe('guards.error-shape.guard [area:contracts]', () => {
  it('keeps the complete generated ProblemDetails enum identical to the shared vocabulary', () => {
    const document: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/contracts/openapi/openapi.json'), 'utf8'),
    );
    expect(wireCodes(document)).toEqual(ERROR_CODES);
  });
  it('finds no unknown code in the real error producers', () => {
    expect(SOURCES.some((source) => source.path === 'apps/server/src/security/problem.ts')).toBe(
      true,
    );
    expect(SOURCES.flatMap((source) => unknownCodes(source, ALLOWED))).toEqual([]);
  });
  it.each([
    "throw new ProblemError('invented');",
    "import { ProblemError as Failure } from '../problem.ts'; throw new Failure('invented' as ErrorCode);",
    "await sendProblem(request, reply, ok ? 'forbidden' : 'invented');",
    "const result = { code: 'invented', extensions: {} };",
    "reply.send({ type: 'urn:iridium:problem:invented', status: 400, code: 'invented' });",
    'throw new ProblemError(`invented`);',
  ])('refuses a new producer outside the enum: %s', (code) => {
    expect(unknownCodes(sourceOf('fixture.ts', code), ALLOWED).join('\n')).not.toContain(
      'parse failed',
    );
    expect(unknownCodes(sourceOf('apps/server/src/example.ts', code), ALLOWED)).toHaveLength(1);
  });
  it('detects a code missing from the allowed wire vocabulary', () => {
    expect(
      unknownCodes(
        sourceOf('apps/server/src/example.ts', "throw new ProblemError('forbidden');"),
        new Set(['unavailable']),
      ),
    ).toHaveLength(1);
  });
  it('distinguishes validation issue codes, transport errors and inert fixture text', () => {
    expect(
      unknownCodes(
        sourceOf(
          'apps/server/src/example.ts',
          "const error = { code: 'ECONNRESET' }; const issue = { path: 'body', code: 'custom' }; const fixture = \"new ProblemError('invented')\";",
        ),
        ALLOWED,
      ),
    ).toEqual([]);
  });
  it('fails closed when source cannot be parsed', () => {
    expect(unknownCodes(sourceOf('apps/server/src/example.ts', 'throw new'), ALLOWED)[0]).toContain(
      'parse failed',
    );
  });
});
