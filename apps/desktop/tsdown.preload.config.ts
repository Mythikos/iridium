// Electron preload: single-file CJS (a sandboxed preload cannot be ESM and cannot require a second file).
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/preload/index.cts' },
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  outDir: 'dist/preload',
  outExtensions: () => ({ js: '.cjs' }),
  deps: { neverBundle: ['electron'] },
  outputOptions: { inlineDynamicImports: true },
  sourcemap: 'hidden',
  dts: false,
  clean: true,
});
