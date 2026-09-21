/** Private S11 build instrumentation: one admission call changes, no parser algorithm does. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative } from 'node:path';

import ts from 'typescript';

const require = createRequire(import.meta.url);
const packageDirectory = dirname(require.resolve('@iridium/markdown/package.json'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const uncappedAdmission =
  "({ status: 'ok', bytes: new TextEncoder().encode(text).length, lineCount: text.split('\\n').length })";

function replaceAdmission(source) {
  const tree = ts.createSourceFile(
    'parse.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  assert.equal(
    tree.parseDiagnostics.length,
    0,
    'The private experiment requires valid emitted JS.',
  );
  const functions = tree.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'parseNote' &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
  assert.equal(functions.length, 1, 'Expected exactly one exported parseNote function.');
  const definition = functions[0];
  assert.equal(definition.parameters[0]?.name.getText(tree), 'text');
  const bindings = definition.body.statements.flatMap((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.filter(
          (declaration) => declaration.name.getText(tree) === 'admission',
        )
      : [],
  );
  assert.equal(bindings.length, 1, 'Expected exactly one direct admission declaration.');
  const initializer = bindings[0].initializer;
  assert.ok(initializer !== undefined && ts.isCallExpression(initializer));
  assert.equal(
    initializer.getText(tree),
    'prescan(text)',
    'Admission changed; review this experiment before proceeding.',
  );
  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'prescan') calls.push(node);
    ts.forEachChild(node, visit);
  }
  visit(definition);
  assert.equal(calls.length, 1, 'Exactly one admission call may be replaced.');
  const start = initializer.getStart(tree);
  const end = initializer.getEnd();
  const code = source.slice(0, start) + uncappedAdmission + source.slice(end);
  assert.equal(code.slice(0, start), source.slice(0, start));
  assert.equal(code.slice(start + uncappedAdmission.length), source.slice(end));
  return { code, start, end, removed: source.slice(start, end) };
}

/** Fail closed if the function, binding, argument or number of admission calls changes. */
export function verifyAdmissionExperiment() {
  const valid =
    'export function parseNote(text) { const admission = prescan(text); return admission; }';
  assert.equal(replaceAdmission(valid).removed, 'prescan(text)');
  const invalid = [
    valid.replace('export ', ''),
    valid.replace('parseNote', 'other'),
    valid.replace('admission =', 'result ='),
    valid.replace('prescan(text)', 'prescan(other)'),
    valid.replace('prescan(text)', 'other(text)'),
    valid.replace('return admission;', 'prescan(text); return admission;'),
    valid + '\n' + valid,
  ];
  for (const source of invalid) assert.throws(() => replaceAdmission(source));
  return { validCases: 1, rejectedMutations: invalid.length };
}

/** Applied only to the explicitly uncapped build reached from the public package entry graph. */
export function admissionExperimentPlugin(evidence) {
  let replacement;
  return {
    name: 's11-private-admission-experiment',
    enforce: 'pre',
    transform(source, id) {
      const withinPackage = relative(packageDirectory, id).replaceAll('\\', '/');
      if (withinPackage.startsWith('../') || withinPackage.includes(':') || !id.endsWith('.js'))
        return null;
      if (!/export\s+function\s+parseNote\s*\(/.test(source)) return null;
      assert.equal(
        replacement,
        undefined,
        'The private build must replace admission in only one module.',
      );
      const result = replaceAdmission(source);
      const diskHash = sha(readFileSync(id));
      assert.equal(sha(source), diskHash, 'Instrumentation must run before other code transforms.');
      replacement = { id, diskHash };
      evidence.push({
        publicEntry: '@iridium/markdown',
        module: withinPackage,
        replacements: 1,
        removed: result.removed,
        replacement: uncappedAdmission,
        sourceSha256: diskHash,
        experimentSha256: sha(result.code),
      });
      return { code: result.code, map: null };
    },
    generateBundle() {
      assert.ok(replacement !== undefined, 'The public graph did not reach parseNote admission.');
      assert.equal(
        sha(readFileSync(replacement.id)),
        replacement.diskHash,
        'Product files must remain unchanged.',
      );
    },
  };
}
