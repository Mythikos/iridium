/** Static runtime edges after native TypeScript erasure, shared by architectural boundary proofs. */
import { stripTypeScriptTypes } from 'node:module';

/** Type-only edges disappear; named type bindings can still leave an empty runtime import. */
export function runtimeSpecifiers(source: string): readonly string[] {
  const erased = stripTypeScriptTypes(source, { mode: 'strip' });
  const imports = [
    ...erased.matchAll(/\b(?:import|export)\s+(?:[^;]*?\sfrom\s*)?['"]([^'"]+)['"]/g),
  ]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
  const dynamic = [...erased.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1])
    .filter((value) => value !== undefined);
  return [...imports, ...dynamic];
}
