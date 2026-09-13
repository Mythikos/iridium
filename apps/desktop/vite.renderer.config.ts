// Electron renderer: the shared renderer configuration with base './' and Electron 44's Chromium target.
// M0 skeleton; packages/ui/vite.renderer.config.ts (07-client-applications.md section 6.1) is extended here later.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: { dedupe: ['yjs', 'lib0', 'y-protocols', '@codemirror/state', '@codemirror/view'] },
  build: {
    target: 'chrome152',
    sourcemap: 'hidden',
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
});
