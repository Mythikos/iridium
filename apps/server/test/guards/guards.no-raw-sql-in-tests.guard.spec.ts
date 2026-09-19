/** Named testkit helpers own raw writes; executable SQL is never hidden by comments or aliases. */
import {
  parseSync,
  Visitor,
  type ArrowFunctionExpression,
  type Function as FunctionNode,
  type Node,
} from 'oxc-parser';
import { describe, expect, it } from 'vitest';

import { isTestPath, locate, sourceOf, sourcesUnder, type Source } from './source-scan.ts';

const TEST_SOURCES = sourcesUnder(['apps', 'packages', 'tooling']).filter((source) =>
  isTestPath(source.path),
);
const SQL_METHODS = new Set(['run', 'rows', 'query', 'execute', 'executeQuery']);

function propertyName(node: Node): string | null {
  if (node.type === 'Identifier') return node.name;
  return node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
}

function unwrap(node: Node): Node {
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSTypeAssertion' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'ChainExpression'
  ) {
    return unwrap(node.expression);
  }
  return node;
}

interface Scope {
  readonly node: Node;
  readonly parent: Scope | null;
  readonly bindings: Map<string, Node | null>;
}

interface Bindings {
  readonly value: (node: Node) => Node | null | undefined;
  readonly sqlImports: ReadonlySet<Node>;
  readonly namespaceImports: ReadonlySet<Node>;
}

/** Keep shadowed names local, including statement arrays consumed by map/for-of callbacks. */
function bindingsFor(program: ReturnType<typeof parseSync>['program']): Bindings {
  const root: Scope = { node: program, parent: null, bindings: new Map() };
  const scopes = [root];
  let current = root;
  const mappedCallbacks = new Map<Node, Node>();
  const sqlImports = new Set<Node>();
  const namespaceImports = new Set<Node>();
  const enter = (node: Node): void => {
    current = { node, parent: current, bindings: new Map() };
    scopes.push(current);
  };
  const leave = (): void => {
    if (current.parent === null) throw new Error('Unbalanced SQL guard scope.');
    current = current.parent;
  };
  const enterFunction = (node: ArrowFunctionExpression | FunctionNode): void => {
    enter(node);
    for (const parameter of node.params) {
      if (parameter.type === 'Identifier') current.bindings.set(parameter.name, null);
    }
    const first = node.params[0];
    const values = mappedCallbacks.get(node);
    if (first?.type === 'Identifier' && values !== undefined) {
      current.bindings.set(first.name, values);
    }
  };
  new Visitor({
    BlockStatement: enter,
    'BlockStatement:exit': leave,
    ForStatement: enter,
    'ForStatement:exit': leave,
    SwitchStatement: enter,
    'SwitchStatement:exit': leave,
    ArrowFunctionExpression: enterFunction,
    'ArrowFunctionExpression:exit': leave,
    FunctionExpression: enterFunction,
    'FunctionExpression:exit': leave,
    FunctionDeclaration(node) {
      if (node.id !== null) current.bindings.set(node.id.name, null);
      enterFunction(node);
    },
    'FunctionDeclaration:exit': leave,
    CatchClause(node) {
      enter(node);
      if (node.param?.type === 'Identifier') current.bindings.set(node.param.name, null);
    },
    'CatchClause:exit': leave,
    ImportDeclaration(node) {
      for (const specifier of node.specifiers) {
        current.bindings.set(specifier.local.name, specifier);
        if (node.source.value !== 'kysely') continue;
        if (specifier.type === 'ImportNamespaceSpecifier') namespaceImports.add(specifier);
        if (specifier.type === 'ImportSpecifier' && propertyName(specifier.imported) === 'sql') {
          sqlImports.add(specifier);
        }
      }
    },
    VariableDeclarator(node) {
      if (node.id.type !== 'Identifier') return;
      if (node.init !== null || !current.bindings.has(node.id.name)) {
        current.bindings.set(node.id.name, node.init);
      }
    },
    ForOfStatement(node) {
      enter(node);
      if (node.left.type !== 'VariableDeclaration') return;
      const declaration = node.left.declarations[0];
      if (declaration?.id.type === 'Identifier') {
        current.bindings.set(declaration.id.name, node.right);
      }
    },
    'ForOfStatement:exit': leave,
    CallExpression(node) {
      const callee = unwrap(node.callee);
      if (
        callee.type !== 'MemberExpression' ||
        !['map', 'flatMap', 'forEach'].includes(propertyName(callee.property) ?? '')
      )
        return;
      const callback = node.arguments[0];
      if (callback?.type === 'ArrowFunctionExpression' || callback?.type === 'FunctionExpression') {
        mappedCallbacks.set(callback, callee.object);
      }
    },
  }).visit(program);
  return {
    sqlImports,
    namespaceImports,
    value(node) {
      if (node.type !== 'Identifier') return undefined;
      let scope: Scope | null =
        scopes.findLast(
          (candidate) => candidate.node.start <= node.start && node.end <= candidate.node.end,
        ) ?? root;
      while (scope !== null) {
        if (scope.bindings.has(node.name)) return scope.bindings.get(node.name);
        scope = scope.parent;
      }
      return undefined;
    },
  };
}

/** Resolve only static SQL and local bindings; no application or fixture code is evaluated. */
function statementStrings(
  input: Node,
  bindings: Bindings,
  seen: ReadonlySet<Node> = new Set(),
): string[] {
  const node = unwrap(input);
  if (seen.has(node)) return [];
  const visited = new Set([...seen, node]);
  if (node.type === 'Literal') return typeof node.value === 'string' ? [node.value] : [];
  if (node.type === 'TemplateLiteral') {
    return [node.quasis.map((part) => part.value.cooked ?? part.value.raw).join(' __parameter__ ')];
  }
  if (node.type === 'Identifier') {
    const value = bindings.value(node);
    return value === undefined || value === null ? [] : statementStrings(value, bindings, visited);
  }
  if (node.type === 'ArrayExpression') {
    return node.elements.flatMap((entry) =>
      entry === null ? [] : statementStrings(entry, bindings, visited),
    );
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = statementStrings(node.left, bindings, visited);
    const right = statementStrings(node.right, bindings, visited);
    return left.flatMap((prefix) =>
      (right.length === 0 ? [' __parameter__ '] : right).map((suffix) => prefix + suffix),
    );
  }
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    propertyName(node.callee.property) === 'raw'
  ) {
    const argument = node.arguments[0];
    return argument === undefined ? [] : statementStrings(argument, bindings, visited);
  }
  if (node.type === 'ObjectExpression') {
    return node.properties.flatMap((entry) =>
      entry.type === 'Property' && propertyName(entry.key) === 'sql'
        ? statementStrings(entry.value, bindings, visited)
        : [],
    );
  }
  return [];
}

function writesSql(statement: string): boolean {
  const code = statement
    .replace(/'(?:''|\\.|[^'])*'/gu, "''")
    .replace(/\x60[^\x60]*\x60/gu, 'identifier')
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/--[ \t][^\r\n]*/gu, '');
  if (
    /(?:^|;)\s*(?:WITH\b[^;]*?\b)?(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|KILL|FLUSH)(?=\s|$)/iu.test(
      code,
    )
  )
    return true;
  return code
    .split(';')
    .some(
      (part) =>
        /^\s*SET\b/iu.test(part) &&
        !/^\s*SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED\s*$/iu.test(part),
    );
}

function rawSqlViolations(source: Source): string[] {
  const parsed = parseSync(source.path, source.raw);
  if (parsed.errors.length > 0) {
    return parsed.errors.map((error) => source.path + ': parse failed: ' + error.message);
  }
  const bindings = bindingsFor(parsed.program);
  const findings = new Set<string>();
  const resolvesTo = (input: Node, origins: ReadonlySet<Node>, seen = new Set<Node>()): boolean => {
    const node = unwrap(input);
    if (origins.has(node)) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    const value = bindings.value(node);
    return value !== null && value !== undefined && resolvesTo(value, origins, seen);
  };
  const isSql = (input: Node, seen = new Set<Node>()): boolean => {
    const node = unwrap(input);
    if (bindings.sqlImports.has(node)) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'Identifier') {
      const value = bindings.value(node);
      if (value === undefined) return node.name === 'sql';
      return value !== null && isSql(value, seen);
    }
    return (
      node.type === 'MemberExpression' &&
      propertyName(node.property) === 'sql' &&
      resolvesTo(node.object, bindings.namespaceImports)
    );
  };
  const isRaw = (input: Node, seen = new Set<Node>()): boolean => {
    const node = unwrap(input);
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'Identifier') {
      const value = bindings.value(node);
      return value !== null && value !== undefined && isRaw(value, seen);
    }
    return (
      node.type === 'MemberExpression' &&
      propertyName(node.property) === 'raw' &&
      isSql(node.object)
    );
  };
  const isSqlCall = (input: Node, seen = new Set<Node>()): boolean => {
    const node = unwrap(input);
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.type === 'MemberExpression') return SQL_METHODS.has(propertyName(node.property) ?? '');
    if (node.type !== 'Identifier') return false;
    if (SQL_METHODS.has(node.name)) return true;
    const value = bindings.value(node);
    return value !== null && value !== undefined && isSqlCall(value, seen);
  };
  new Visitor({
    TaggedTemplateExpression(node) {
      if (isSql(node.tag)) findings.add(locate(source, node.start));
    },
    CallExpression(node) {
      if (isRaw(node.callee)) findings.add(locate(source, node.start));
      if (
        isSqlCall(node.callee) &&
        node.arguments.some((argument) => statementStrings(argument, bindings).some(writesSql))
      ) {
        findings.add(locate(source, node.start));
      }
    },
  }).visit(parsed.program);
  return [...findings];
}

function readOnlyProbeViolations(source: Source): {
  readonly reads: number;
  readonly findings: string[];
} {
  const parsed = parseSync(source.path, source.raw);
  const findings = parsed.errors.map((error) => error.message);
  const bindings = bindingsFor(parsed.program);
  let reads = 0;
  new Visitor({
    TaggedTemplateExpression(node) {
      const statement = node.quasi.quasis
        .map((part) => part.value.cooked ?? part.value.raw)
        .join(' ? ');
      if (/^\s*(?:SELECT|SHOW)\b/iu.test(statement) && !writesSql(statement)) reads += 1;
      else findings.push(locate(source, node.start));
    },
    CallExpression(node) {
      const callee = unwrap(node.callee);
      if (
        callee.type === 'MemberExpression' &&
        ([
          'raw',
          'insertInto',
          'updateTable',
          'deleteFrom',
          'createTable',
          'alterTable',
          'dropTable',
        ].includes(propertyName(callee.property) ?? '') ||
          (SQL_METHODS.has(propertyName(callee.property) ?? '') &&
            node.arguments.some((argument) =>
              statementStrings(argument, bindings).some(writesSql),
            )))
      ) {
        findings.push(locate(source, node.start));
      }
    },
  }).visit(parsed.program);
  return { reads, findings };
}

describe('guards.no-raw-sql-in-tests.guard [area:testing]', () => {
  it('scans actual specs and support files without a spec allowlist', () => {
    const paths = TEST_SOURCES.map((source) => source.path);
    expect(paths).toContain('apps/server/test/integration/db-grants.integration.spec.ts');
    expect(paths).toContain('apps/server/test/integration/db.lock-timeout.integration.spec.ts');
    expect(paths).toContain('apps/server/src/db/query-deadline.unit.spec.ts');
    expect(paths).toContain('apps/server/test/support/collab-harness.ts');
    expect(TEST_SOURCES.flatMap(rawSqlViolations)).toEqual([]);
  });

  it.each([
    'import { sql } from "kysely"; await sql\x60DELETE FROM users\x60.execute(transaction);',
    'import { sql as query } from "kysely"; await query<number>\x60SELECT 1\x60.execute(database);',
    'import * as database from "kysely"; database.sql.raw("UPDATE users SET disabled=1");',
    'import { sql } from "kysely"; const alias = sql; alias\x60SELECT 1\x60;',
    'import { sql } from "kysely"; const raw = sql.raw; raw("DELETE FROM users");',
    'await admin.run("UPDATE users SET disabled=1");',
    'await client.query("app", "START TRANSACTION; DELETE FROM notes; ROLLBACK");',
    'await admin.rows("REVOKE INSERT ON iridium.audit_events FROM app");',
    'const statement = "DROP " + "TABLE notes"; await client.execute("app", statement);',
    'for (const statement of ["DELETE FROM notes"]) await client.query("app", statement);',
    'await database.executeQuery(CompiledQuery.raw("DELETE FROM notes"));',
    'await connection.query("SET @iridium_audit_archive=1");',
    'query(connection, "DELETE FROM login_throttle");',
    'const execute = admin.run; execute("/* deliberate */ DELETE FROM notes");',
    'const statements = ["DELETE FROM notes"]; statements.map((statement) => client.query("app", statement));',
    '{ const statement = "DELETE FROM notes"; await admin.run(statement); } { const statement = "SELECT 1"; await admin.run(statement); }',
  ])('rejects an executable bypass: %s', (source) => {
    expect(rawSqlViolations(sourceOf('example.unit.spec.ts', source))).toHaveLength(1);
  });

  it.each([
    '// sql\x60DELETE FROM users\x60\nconst fixture = "sql\x60SELECT 1\x60";',
    'expect(query.sql).toBe("UPDATE users SET disabled=1");',
    'await admin.rows("SELECT id FROM notes");',
    'await connection.query("SELECT head_seq FROM note_docs FOR UPDATE");',
    'await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");',
    'await admin.rows("START TRANSACTION WITH CONSISTENT SNAPSHOT; SELECT id FROM notes; COMMIT");',
    'await application.jobs.run("update_log_prune");',
    'await run(["admin", "create-user", "--display-name", "help", "--email"]); await run(["sessions", "revoke-all", "everyone"]);',
    'await database.updateTable("schema_meta").set({ value: "probe" }).execute();',
    '{ const statements = ["SELECT 1"]; statements.map((statement) => reader.query("backup", statement)); } { const statements = ["DELETE FROM notes"]; expect(statements).toHaveLength(1); }',
    'for (const statement of ["SELECT 1"]) await admin.rows(statement); for (const statement of ["DROP TABLE notes"]) expect(statement).toBeDefined();',
  ])(
    'preserves non-SQL fixtures, typed builders, and explicit read/session coordination: %s',
    (source) => {
      expect(rawSqlViolations(sourceOf('example.unit.spec.ts', source))).toEqual([]);
    },
  );

  it('keeps the actual inspection seam nonempty and read-only', () => {
    const sources = sourcesUnder(['packages/testkit/src/db/inspect.ts']);
    expect(sources).toHaveLength(1);
    const result = readOnlyProbeViolations(sources[0]!);
    expect(result.reads).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });

  it.each([
    'sql\x60DELETE FROM notes\x60.execute(database);',
    'sql\x60SELECT 1; UPDATE users SET disabled=1\x60.execute(database);',
    'sql.raw("SELECT 1").execute(database);',
    'database.updateTable("notes").set({ name: "changed" }).execute();',
    'connection.query("DELETE FROM notes");',
    'database.schema.dropTable("notes").execute();',
  ])('rejects a write or dynamic escape in the inspection seam: %s', (source) => {
    expect(readOnlyProbeViolations(sourceOf('inspect.ts', source)).findings).toHaveLength(1);
  });

  it('fails closed when a test cannot be parsed', () => {
    expect(rawSqlViolations(sourceOf('broken.unit.spec.ts', 'const ='))).not.toEqual([]);
  });
});
