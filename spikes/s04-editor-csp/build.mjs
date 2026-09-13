/**
 * Spike S04 — builds the harness page once. All three hosts serve the *same* artefact, so the only
 * variable between them is how the Content-Security-Policy header and the nonce are produced.
 *
 * `base: './'` and `cssCodeSplit: false`: the page must load from `app://iridium/` as well as from
 * an HTTP origin, and every stylesheet must arrive as a same-origin `<link>` so that `style-src
 * 'self'` covers it — a JS-injected stylesheet would be indistinguishable from the runtime `<style>`
 * elements this spike is measuring.
 */
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const DEDUPE = [
  'yjs',
  'lib0',
  'y-protocols',
  '@codemirror/state',
  '@codemirror/view',
  'react',
  'react-dom',
];

await build({
  root: new URL('./src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  base: './',
  logLevel: 'info',
  plugins: [react()],
  resolve: { dedupe: DEDUPE },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    // Electron 44's Chromium, the narrower of the two product targets.
    target: 'chrome152',
    outDir: new URL('./dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    sourcemap: false,
    minify: false,
  },
});
