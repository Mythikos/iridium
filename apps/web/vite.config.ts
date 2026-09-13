/**
 * The web host's renderer build (07-client-applications.md §6.1).
 *
 * Everything that must not drift between the two hosts comes from
 * `@iridium/ui/vite.renderer.config.ts`; this file adds only what is web-specific: the plugin list,
 * `base: '/app/'` (the SPA is served from `/app/*`), the `dist/` output the server image copies to
 * `dist/public/`, and the development proxy.
 */
import { rendererConfig, WEB_BUILD_TARGET } from '@iridium/ui/vite.renderer.config.ts';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import pkg from './package.json' with { type: 'json' };

const shared = rendererConfig({
  base: '/app/',
  target: WEB_BUILD_TARGET,
  productVersion: pkg.version,
});

/** `vite dev` forwards the server's routes so the SPA runs against a local `apps/server` (§6.1). */
const devServerOrigin = 'http://localhost:4000';

export default defineConfig({
  ...shared,
  // React Compiler (`react({ compiler: true })`) needs `oxc-transform-react`, which the M0
  // dependency set does not carry; §6.1's documented babel fallback is the other route. Enabling it
  // is a one-line change here once the pin lands.
  plugins: [react(), tailwindcss()],
  build: {
    ...shared.build,
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': devServerOrigin,
      '/collab': { target: devServerOrigin, ws: true },
      '/desktop': devServerOrigin,
      '/openapi.json': devServerOrigin,
    },
  },
});
