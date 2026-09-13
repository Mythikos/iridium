// M0 skeleton. The shared renderer configuration (packages/ui/vite.renderer.config.ts, 07-client-applications.md
// section 6.1) replaces this file's body when the web host work item lands; the dedupe list is load-bearing now.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  resolve: { dedupe: ['yjs', 'lib0', 'y-protocols', '@codemirror/state', '@codemirror/view'] },
  build: { target: 'chrome150', sourcemap: 'hidden', outDir: 'dist', emptyOutDir: true },
});
