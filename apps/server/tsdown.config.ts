// Server bundle: dist/main.mjs with every @iridium/* workspace package inlined; native and
// worker-hosting modules stay external (02-system-architecture.md, "Build outputs and artifacts").
// M0 skeleton entry is src/index.ts; the server work item moves the CLI entry to src/main.ts.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  deps: {
    alwaysBundle: [/^@iridium\//],
    neverBundle: ['@node-rs/argon2', 'mysql2', 'piscina'],
  },
  sourcemap: true,
  dts: false,
  clean: true,
});
