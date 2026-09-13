// Electron preload: single-file CJS (a sandboxed preload cannot be ESM and cannot require a second
// file — 07-client-applications.md §7.1, digest Topic 4), so code splitting is off and the build
// emits exactly one file: dist/preload/index.cjs.
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/preload/index.cts' },
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  outDir: 'dist/preload',
  outExtensions: () => ({ js: '.cjs' }),
  deps: { neverBundle: ['electron'] },
  outputOptions: { codeSplitting: false },
  sourcemap: 'hidden',
  dts: false,
  clean: true,
});
