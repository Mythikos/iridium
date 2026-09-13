// Single-file Node bundle with a shebang: dist/iridium-mcp.mjs (02-system-architecture.md, build outputs).
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { 'iridium-mcp': 'src/index.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  banner: { js: '#!/usr/bin/env node' },
  deps: { alwaysBundle: [/^@iridium\//] },
  sourcemap: true,
  dts: false,
  clean: true,
});
