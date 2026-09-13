/**
 * `pnpm --filter @iridium/desktop dev` — launches the shell against the Vite dev server
 * (07-client-applications.md §7.1).
 *
 * The three build configs stay plain and independent: `package.json` builds `main` and `preload` with
 * tsdown before this script runs, and this script starts the renderer's own Vite config through
 * Vite's Node API and then runs `electron .`, which reads `main` from `package.json`. No fuses are
 * applied — `onlyLoadAppFromAsar` makes unpackaged code unloadable — but the window still runs with
 * the full `webPreferences` set, the sandbox on, the deny-by-default permission handlers active and
 * the IPC origin check live (the dev origin is accepted only while `!app.isPackaged`), so a hardening
 * regression surfaces here rather than at packaging time.
 *
 * Swapping this orchestrator for `vite-plugin-electron` later is a change to this file only.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import process from 'node:process';

import { createServer } from 'vite';

const require = createRequire(import.meta.url);
/** The `electron` package's main export is the absolute path of the platform binary. */
const electronBinary = require('electron');

const server = await createServer({
  configFile: 'vite.renderer.config.ts',
  mode: 'development',
});
await server.listen();
server.printUrls();

const devServerUrl = server.resolvedUrls?.local?.[0];
if (devServerUrl === undefined) {
  await server.close();
  throw new Error('dev: the Vite dev server reported no local URL.');
}

const child = spawn(electronBinary, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl },
});

let closing = false;
const shutdown = async (code) => {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(code ?? 0);
};

child.on('exit', (code) => {
  void shutdown(code);
});
child.on('error', (error) => {
  console.error('dev: failed to start Electron', error);
  void shutdown(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill();
  });
}
