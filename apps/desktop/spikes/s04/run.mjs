/**
 * Spike S04 — Electron host runner. Regenerates the type-stripped product modules, then launches
 * `main.mjs` with the `electron` binary that `apps/desktop` already depends on. A separate
 * `userData` directory keeps the harness out of the real shell's profile.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const here = import.meta.dirname;

const generate = spawnSync(process.execPath, [path.join(here, 'generate.mjs')], {
  stdio: 'inherit',
});
if (generate.status !== 0) process.exit(generate.status ?? 1);

const require = createRequire(path.join(here, '..', '..', 'package.json'));
const electronBinary = require('electron');

const userData = mkdtempSync(path.join(os.tmpdir(), 'iridium-s04-'));

const run = spawnSync(electronBinary, [path.join(here, 'main.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, IRIDIUM_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' },
});

console.info(`electron exited with ${run.status}`);
process.exit(run.status ?? 1);
