// Electron main: ESM, Node 24, electron never bundled, workspace packages inlined (07-client-applications.md 7.x).
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/main/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist/main',
  outExtensions: () => ({ js: '.mjs' }),
  deps: { neverBundle: ['electron'], alwaysBundle: [/^@iridium\//] },
  sourcemap: 'hidden',
  dts: false,
  clean: true,
});
