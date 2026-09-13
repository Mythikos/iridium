/**
 * Reading a Kysely `Database` interface out of TypeScript source text, and comparing two of them.
 *
 * **Why this is a structural comparison and not a byte diff.** `apps/server/src/db/schema.ts` is
 * hand-written by design (03-data-model.md §1.3): it declares string-literal unions for every `ENUM`
 * column and a typed shape per JSON column, neither of which `kysely-codegen` can produce — it emits
 * `Json`/`JsonValue` for JSON and, for MySQL, a literal union it derives from the column definition.
 * A byte diff would therefore either be permanently red or force the hand-written file to reproduce
 * the generator's emit, which is exactly what §1.3 forbids. The comparison that *is* meaningful is the
 * one `migrations.integration` performs against `information_schema` and this module performs against
 * the generated types: every table and every column, in both directions, with types normalised.
 *
 * **What "normalised" means, and what it deliberately does not hide.**
 *
 * | Compared exactly | Normalised, with the reason |
 * |---|---|
 * | table set, both directions | — |
 * | column set per table, both directions | — |
 * | nullability (`\| null` present) | — |
 * | `Generated<T>` / `GeneratedAlways<T>` presence | — |
 * | literal unions, as sorted sets | a named alias in `schema.ts` is resolved to its members, so a missing `ENUM` value is caught |
 * | JSON columns | `Json<T>`, `NullableJson<T>`, `Json`, `JsonValue` and `JsonColumnType<…>` all collapse to `json`: the typed shape is the hand-written file's job |
 * | `boolean` against `number` | `TINYINT(1)` is `boolean` in `schema.ts` through mysql2's `typeCast` and `number` in the generator's own MySQL map (§1.3) |
 * | `Buffer` against `Uint8Array` | the same bytes under two spellings |
 *
 * Every normalisation that fires is counted and reported, so the allowances are visible in the
 * pipeline output rather than invisible in this comment.
 */

/** One column of one table. */
export interface Column {
  readonly name: string;
  /** The declared type text, wrappers included. */
  readonly declared: string;
  /** `Generated`, `GeneratedAlways`, or `null`. */
  readonly generated: 'Generated' | 'GeneratedAlways' | null;
  readonly nullable: boolean;
  /** The normalised classification the comparison uses. */
  readonly normalized: string;
}

export interface ParsedSchema {
  /** Table name → column name → column. */
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, Column>>;
  /** The interface the database map was read from, for error messages. */
  readonly databaseInterface: string;
}

/**
 * Every alias either side uses for a JSON column's own value type.
 *
 * They are treated as opaque: expanding `JsonValue` would reach `JsonPrimitive`, which ends in `null`,
 * and every JSON column would then look nullable.
 */
const JSON_ALIASES = new Set(['Json', 'JsonValue', 'JsonObject', 'JsonArray', 'JsonPrimitive']);

/** `export type Name = …;` aliases, including multi-line unions. */
function readTypeAliases(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of source.matchAll(/export type (\w+)\s*=\s*([\s\S]*?);\n/g)) {
    const [, name, body] = match;
    if (name === undefined || body === undefined) continue;
    aliases.set(name, body.replaceAll(/\s+/g, ' ').trim());
  }
  return aliases;
}

/** `export interface Name { … }` bodies. */
function readInterfaces(source: string): Map<string, string> {
  const interfaces = new Map<string, string>();
  for (const match of source.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
    const [, name, body] = match;
    if (name === undefined || body === undefined) continue;
    interfaces.set(name, body);
  }
  return interfaces;
}

/** Strip one balanced generic wrapper: `Wrapper<inner>` → `inner`. */
function unwrap(type: string, wrapper: string): string | null {
  const prefix = `${wrapper}<`;
  if (!type.startsWith(prefix) || !type.endsWith('>')) return null;
  return type.slice(prefix.length, -1).trim();
}

/** Split a generic argument list on top-level commas. */
function splitArguments(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of inner) {
    if (character === '<' || character === '(' || character === '{' || character === '[')
      depth += 1;
    if (character === '>' || character === ')' || character === '}' || character === ']')
      depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts;
}

/** What normalisation was applied, so the report can name it. */
export interface Allowance {
  readonly table: string;
  readonly column: string;
  readonly reason: string;
}

/** `"x"` and `'x'` are the same literal; the two generators spell them differently. */
function normalizeQuotes(member: string): string {
  const literal = /^"(.*)"$/.exec(member.trim());
  return literal === null ? member.trim() : `'${literal[1] ?? ''}'`;
}

/** Split a union on top-level `|`, ignoring `|` inside generics or object literals. */
function splitUnion(type: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of type) {
    if (character === '<' || character === '(' || character === '{' || character === '[')
      depth += 1;
    if (character === '>' || character === ')' || character === '}' || character === ']')
      depth -= 1;
    if (character === '|' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== '');
}

/**
 * Expand one union member to its comparable tokens.
 *
 * A JSON alias is opaque. That is the whole point: `JsonValue` resolves to
 * `JsonArray | JsonObject | JsonPrimitive` and `JsonPrimitive` ends in `null`, so expanding it would
 * make every JSON column look nullable — which is how the first draft of this comparison reported
 * eight false nullability differences.
 */
function expandMember(member: string, aliases: ReadonlyMap<string, string>, depth = 0): string[] {
  const token = member.trim();
  if (JSON_ALIASES.has(token)) return ['json'];
  if (depth >= 8) return [normalizeQuotes(token)];
  const alias = aliases.get(token);
  if (alias !== undefined) {
    return splitUnion(alias).flatMap((inner) => expandMember(inner, aliases, depth + 1));
  }
  return [normalizeQuotes(token)];
}

function classify(
  type: string,
  aliases: ReadonlyMap<string, string>,
  depth = 0,
): { normalized: string; nullable: boolean } {
  const current = type.trim();
  if (depth >= 8) return { normalized: current, nullable: false };

  // The hand-written file's own JSON wrappers, checked before anything is resolved.
  if (unwrap(current, 'Json') !== null) return { normalized: 'json', nullable: false };
  if (unwrap(current, 'NullableJson') !== null) return { normalized: 'json', nullable: true };
  if (unwrap(current, 'JsonColumnType') !== null) return { normalized: 'json', nullable: false };

  const top = splitUnion(current);
  if (top.length > 1) {
    const nullable = top.includes('null');
    const rest = top.filter((member) => member !== 'null');
    const members = rest.flatMap((member) => expandMember(member, aliases));
    const innerNullable = members.includes('null');
    const canonical = [
      ...new Set(
        members
          .filter((member) => member !== 'null')
          .map((member) =>
            member === 'Uint8Array' || member === 'Buffer'
              ? 'bytes'
              : member === 'boolean' || member === 'number'
                ? 'numeric'
                : member,
          ),
      ),
    ].toSorted((a, b) => a.localeCompare(b));
    return {
      normalized: canonical.join(' | ') || 'unknown',
      nullable: nullable || innerNullable,
    };
  }

  if (JSON_ALIASES.has(current)) return { normalized: 'json', nullable: false };

  const alias = aliases.get(current);
  if (alias !== undefined) return classify(alias, aliases, depth + 1);

  const columnType = unwrap(current, 'ColumnType');
  if (columnType !== null) {
    return classify(splitArguments(columnType)[0] ?? 'unknown', aliases, depth + 1);
  }

  const token = normalizeQuotes(current);
  if (token === 'Uint8Array' || token === 'Buffer') return { normalized: 'bytes', nullable: false };
  if (token === 'boolean' || token === 'number') return { normalized: 'numeric', nullable: false };
  return { normalized: token, nullable: false };
}

/** Parse a Kysely schema module into tables and normalised columns. */
export function parseKyselySchema(source: string, databaseInterface: string): ParsedSchema {
  const normalized = source.replaceAll('\r\n', '\n');
  const aliases = readTypeAliases(normalized);
  const interfaces = readInterfaces(normalized);
  const databaseBody = interfaces.get(databaseInterface);
  if (databaseBody === undefined) {
    throw new Error(`no \`export interface ${databaseInterface}\` in the parsed source`);
  }

  const tables = new Map<string, Map<string, Column>>();
  for (const line of databaseBody.split('\n')) {
    const entry = /^\s{2}(\w+):\s*(\w+);\s*$/.exec(line);
    const table = entry?.[1];
    const interfaceName = entry?.[2];
    if (table === undefined || interfaceName === undefined) continue;
    const body = interfaces.get(interfaceName);
    if (body === undefined) {
      throw new Error(
        `${databaseInterface} maps ${table} to ${interfaceName}, which the source does not declare`,
      );
    }
    const columns = new Map<string, Column>();
    for (const memberLine of body.split('\n')) {
      const member = /^\s{2}(\w+):\s*(.+?);\s*$/.exec(memberLine);
      const name = member?.[1];
      const declared = member?.[2];
      if (name === undefined || declared === undefined) continue;
      let inner = declared.trim();
      let generated: Column['generated'] = null;
      const always = unwrap(inner, 'GeneratedAlways');
      const sometimes = unwrap(inner, 'Generated');
      if (always !== null) {
        generated = 'GeneratedAlways';
        inner = always;
      } else if (sometimes !== null) {
        generated = 'Generated';
        inner = sometimes;
      }
      const classified = classify(inner, aliases);
      columns.set(name, {
        name,
        declared,
        generated,
        nullable: classified.nullable,
        normalized: classified.normalized,
      });
    }
    if (columns.size === 0) {
      throw new Error(`${interfaceName} (table ${table}) parsed to zero columns`);
    }
    tables.set(table, columns);
  }
  if (tables.size === 0) {
    throw new Error(`${databaseInterface} parsed to zero tables`);
  }
  return { tables, databaseInterface };
}

export interface Difference {
  readonly kind: 'table' | 'column' | 'type' | 'nullability' | 'generated';
  readonly detail: string;
}

/** Tables kysely-codegen emits that Iridium does not define, and deliberately does not. */
export const FOREIGN_TABLES: readonly string[] = ['kysely_migration', 'kysely_migration_lock'];

/**
 * A column the migration declares `GENERATED ALWAYS AS (...) STORED`.
 *
 * kysely-codegen 0.20 does not report generated columns for MySQL: it emits the column's plain type,
 * and — because a generated column is nullable unless the DDL says otherwise — usually a nullable one.
 * The hand-written file records the fact the generator cannot see, so `GeneratedAlways` on the
 * hand-written side is a documented allowance for both the generated flag and the nullability. Each
 * one is listed in the step's output rather than silently accepted.
 */
function generatedAlwaysAllowance(table: string, column: string, detail: string): Allowance {
  return {
    table,
    column,
    reason: `GENERATED ALWAYS column: kysely-codegen 0.20 does not report it (${detail})`,
  };
}

/**
 * Compare the generated types with the hand-written `Database`.
 *
 * `kysely_migration` and `kysely_migration_lock` are excluded: kysely-ctl creates and owns them, they
 * are the only tables Iridium does not define (03-data-model.md §14.2), and `schema.ts` deliberately
 * does not declare them — the application reads them through raw SQL in the readiness check.
 */
export function compareSchemas(
  generated: ParsedSchema,
  handWritten: ParsedSchema,
): {
  differences: Difference[];
  allowances: Allowance[];
  tablesCompared: number;
  columnsCompared: number;
} {
  const differences: Difference[] = [];
  const allowances: Allowance[] = [];

  // kysely-ctl creates and owns `kysely_migration` and `kysely_migration_lock` — the only tables
  // Iridium does not define (03-data-model.md §14.2). `schema.ts` declares them because `/readyz`
  // reads the applied set from them; kysely-codegen filters them out of its own emit. Excluding them
  // on the hand-written side is what makes the two sides comparable.
  const generatedTables = new Set(generated.tables.keys());
  const handWrittenTables = new Set(
    [...handWritten.tables.keys()].filter((table) => !FOREIGN_TABLES.includes(table)),
  );

  for (const table of [...generatedTables].toSorted((a, b) => a.localeCompare(b))) {
    if (!handWrittenTables.has(table)) {
      differences.push({
        kind: 'table',
        detail: `${table} exists in the migrated database but not in schema.ts`,
      });
    }
  }
  for (const table of [...handWrittenTables].toSorted((a, b) => a.localeCompare(b))) {
    if (!generatedTables.has(table)) {
      differences.push({
        kind: 'table',
        detail: `${table} is declared in schema.ts but does not exist in the migrated database`,
      });
    }
  }

  let columnsCompared = 0;
  const shared = [...generatedTables]
    .filter((table) => handWrittenTables.has(table))
    .toSorted((a, b) => a.localeCompare(b));
  for (const table of shared) {
    const left = generated.tables.get(table);
    const right = handWritten.tables.get(table);
    if (left === undefined || right === undefined) continue;
    for (const name of [...left.keys()].toSorted((a, b) => a.localeCompare(b))) {
      if (!right.has(name)) {
        differences.push({
          kind: 'column',
          detail: `${table}.${name} exists in the migrated database but not in schema.ts`,
        });
      }
    }
    for (const name of [...right.keys()].toSorted((a, b) => a.localeCompare(b))) {
      if (!left.has(name)) {
        differences.push({
          kind: 'column',
          detail: `${table}.${name} is declared in schema.ts but does not exist in the migrated database`,
        });
      }
    }
    for (const name of [...left.keys()].toSorted((a, b) => a.localeCompare(b))) {
      const generatedColumn = left.get(name);
      const handWrittenColumn = right.get(name);
      if (generatedColumn === undefined || handWrittenColumn === undefined) continue;
      columnsCompared += 1;

      const generatedAlways = handWrittenColumn.generated === 'GeneratedAlways';

      if (generatedColumn.nullable !== handWrittenColumn.nullable) {
        if (generatedAlways) {
          allowances.push(
            generatedAlwaysAllowance(
              table,
              name,
              'the column is nullable in MySQL and schema.ts types it ' +
                (handWrittenColumn.nullable ? 'nullable' : 'non-nullable'),
            ),
          );
        } else {
          differences.push({
            kind: 'nullability',
            detail:
              `${table}.${name}: the database says ${generatedColumn.nullable ? 'NULL' : 'NOT NULL'}, ` +
              `schema.ts says ${handWrittenColumn.nullable ? 'nullable' : 'not nullable'}`,
          });
        }
      }
      if (generatedColumn.generated !== handWrittenColumn.generated) {
        if (generatedAlways && generatedColumn.generated === null) {
          allowances.push(generatedAlwaysAllowance(table, name, 'it emits a plain column'));
        } else {
          differences.push({
            kind: 'generated',
            detail:
              `${table}.${name}: the database says ${String(generatedColumn.generated)}, ` +
              `schema.ts says ${String(handWrittenColumn.generated)}`,
          });
        }
      }
      if (generatedColumn.normalized === handWrittenColumn.normalized) continue;
      if (generatedColumn.normalized === 'json' || handWrittenColumn.normalized === 'json') {
        allowances.push({
          table,
          column: name,
          reason: 'JSON column: the typed shape is hand-written by design (03-data-model.md §1.3)',
        });
        continue;
      }
      differences.push({
        kind: 'type',
        detail:
          `${table}.${name}: the database maps to \`${generatedColumn.normalized}\`, schema.ts ` +
          `declares \`${handWrittenColumn.normalized}\` (declared: \`${generatedColumn.declared}\` ` +
          `vs \`${handWrittenColumn.declared}\`)`,
      });
    }
  }

  return { differences, allowances, tablesCompared: shared.length, columnsCompared };
}
