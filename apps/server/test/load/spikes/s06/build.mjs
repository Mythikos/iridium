/**
 * Bundle `src/s06-collab.js` for k6 with the register's exact esbuild flags:
 * `--format=cjs --platform=browser --external:k6*`.
 *
 *   node build.mjs
 *
 * esbuild, `yjs`, `lib0` and `y-protocols` are `devDependencies` of `@iridium/server` — the M8 load
 * lane is this package's (10-testing-and-quality.md L9, D10-14) — so the bundler and the CRDT
 * libraries both resolve from here and nothing is staged outside the repository. pnpm-workspace.yaml
 * pins all three libraries to `catalog:` in `overrides`, so the copy that lands in the bundle is the
 * single copy the lockfile resolves and the one `@iridium/crdt` compiles against (A14, one module
 * instance; `deps.single-instance.guard` asserts it).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, 'src', 's06-collab.js');
/**
 * The emit stays in `dist/`. `turbo boundaries` walks every file of a package whether git ignores it
 * or not — a probe file under `dist/` and the same file under a dot-prefixed `.bundle/` were both
 * reported — so no emit location keeps generated output out of its scan, and the `k6/*` modules the
 * bundle still requires are declared instead (`boundaries.implicitDependencies` in
 * apps/server/turbo.json). `dist/` is the one directory oxlint.config.ts and .oxfmtrc.jsonc already
 * exclude and .gitignore already covers, so the bundle stays out of the lint, format and review
 * lanes rather than carrying suppressions into generated output.
 */
const OUTFILE = join(HERE, 'dist', 's06-collab.bundle.js');
const METAFILE = join(HERE, 'results', 's06-bundle-meta.json');

/** What actually went into the bundle, read from the copies this package resolves. */
const bundledVersions = Object.fromEntries(
  ['yjs', 'lib0', 'y-protocols'].map((name) => [
    name,
    JSON.parse(readFileSync(fileURLToPath(import.meta.resolve(`${name}/package.json`)), 'utf8'))
      .version,
  ]),
);

mkdirSync(dirname(OUTFILE), { recursive: true });
mkdirSync(dirname(METAFILE), { recursive: true });

const result = await esbuild.build({
  entryPoints: [ENTRY],
  outfile: OUTFILE,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['k6*'],
  target: ['es2022'],
  metafile: true,
  logLevel: 'info',
  legalComments: 'none',
  // k6's Sobek has no `process`; lib0 guards every read with a `typeof` check, so leaving the
  // identifier undefined is correct and no shim is injected.
});

const output = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]];
const inputs = Object.entries(result.metafile.inputs)
  .map(([path, meta]) => ({ path: path.replaceAll('\\', '/'), bytes: meta.bytes }))
  .toSorted((a, b) => b.bytes - a.bytes);
const byPackage = {};
for (const input of inputs) {
  // The package is the segment after the *last* `node_modules/`: pnpm's store puts the real package
  // at `node_modules/.pnpm/<name>@<version>/node_modules/<name>/`, so matching the first occurrence
  // buckets every dependency under `.pnpm` and reports nothing.
  const match = /.*node_modules\/(?<name>(?:@[^/]+\/)?[^/]+)\//.exec(input.path);
  const key = match?.groups?.name ?? '(entry)';
  byPackage[key] = (byPackage[key] ?? 0) + input.bytes;
}

const summary = {
  esbuild: esbuild.version,
  bundledVersions,
  flags: ['--bundle', '--format=cjs', '--platform=browser', '--external:k6*', '--target=es2022'],
  entry: 'src/s06-collab.js',
  outfile: 's06-collab.bundle.js',
  bundleBytes: output.bytes,
  moduleCount: inputs.length,
  imports: [...new Set(output.imports.map((i) => i.path))].toSorted((a, b) => (a < b ? -1 : 1)),
  bytesByPackage: Object.fromEntries(Object.entries(byPackage).toSorted((a, b) => b[1] - a[1])),
  largestInputs: inputs.slice(0, 15),
};
writeFileSync(METAFILE, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.info(JSON.stringify(summary, null, 2));
