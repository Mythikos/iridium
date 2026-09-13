// The Electron renderer build (07-client-applications.md §7.1). One of the three plain, independent
// build configs: `base: './'` because the renderer is loaded from `app://iridium/`, and Electron 44's
// Chromium as the target. Everything else comes from the shared renderer configuration, so the
// dedupe list that `deps.single-instance.guard` checks cannot drift from the web host's.
import { DESKTOP_BUILD_TARGET, rendererConfig } from '@iridium/ui/vite.renderer.config.ts';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import pkg from './package.json' with { type: 'json' };

const shared = rendererConfig({
  base: './',
  target: DESKTOP_BUILD_TARGET,
  productVersion: pkg.version,
});

export default defineConfig({
  ...shared,
  root: 'src/renderer',
  plugins: [react(), tailwindcss()],
  build: {
    ...shared.build,
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
