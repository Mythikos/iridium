/**
 * Spike S04 — Electron host, step 1: make the *product's own* main-process modules loadable by a
 * harness entry without touching them.
 *
 * `apps/desktop/src/main/{csp,scheme,web-preferences}.ts` are the modules under test: the harness
 * must exercise the real `protocol.handle`, the real traversal guard, the real per-load nonce and
 * the real `packagedCsp()` string rather than a re-implementation of them. They are copied here with
 * their types erased (`module.stripTypeScriptTypes`, whitespace-preserving, so every reported line
 * number still matches the product source) and their `./x.ts` specifiers pointed at the `.mjs`
 * copies. Nothing in `apps/desktop/src` is modified or read at runtime by the product.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const here = import.meta.dirname;
const src = path.resolve(here, '..', '..', 'src', 'main');
const out = path.join(here, 'generated');
mkdirSync(out, { recursive: true });

const MODULES = ['csp.ts', 'scheme.ts', 'web-preferences.ts'];

for (const file of MODULES) {
  const source = readFileSync(path.join(src, file), 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' }).replaceAll(
    /(['"])\.\/([A-Za-z0-9-]+)\.ts\1/g,
    '$1./$2.mjs$1',
  );
  writeFileSync(path.join(out, file.replace(/\.ts$/, '.mjs')), stripped);
  console.info(`generated ${file} -> ${file.replace(/\.ts$/, '.mjs')}`);
}
