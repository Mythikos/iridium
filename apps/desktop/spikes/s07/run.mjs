/**
 * Spike S07 — orchestrator for one phase.
 *
 *   node run.mjs <phase> <pkiDir> <outDir>
 *
 * Starts the four TLS endpoints, launches the Electron harness once with that phase, waits for it to
 * write its JSON, stops the endpoints and prints the server-side observations. The CA install and
 * removal are deliberately *not* automated here: they are run by hand so the note can record the
 * exact commands and their exact output.
 *
 * Throwaway harness for `docs/spikes/S07-electron-enterprise-ca.md`. Not part of the product build.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const [phase, pkiDir, outDir] = process.argv.slice(2);
if (phase === undefined || pkiDir === undefined || outDir === undefined) {
  throw new Error('usage: node run.mjs <phase> <pkiDir> <outDir>');
}
mkdirSync(outDir, { recursive: true });

const here = import.meta.dirname;
const outFile = path.join(outDir, `${phase}.json`);
const userData = path.join(outDir, `userdata-${phase}`);

const observationLog = path.join(outDir, `server-observations-${phase}.jsonl`);
const server = spawn(
  process.execPath,
  [path.join(here, 'tls-server.mjs'), pkiDir, observationLog],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
await new Promise((resolve, reject) => {
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes('ready')) resolve();
  });
  server.on('exit', (code) => {
    reject(new Error(`tls-server exited early with ${code}`));
  });
});

const electron = spawn(
  electronBinary,
  [
    path.join(here, 'main.mjs'),
    `--phase=${phase}`,
    `--pki=${pkiDir}`,
    `--out=${outFile}`,
    `--userdata=${userData}`,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

const exitCode = await new Promise((resolve) => {
  electron.on('exit', (code) => {
    resolve(code);
  });
});

server.kill('SIGTERM');

process.stdout.write(`\n=== phase ${phase}: electron exit ${exitCode} ===\n`);
process.stdout.write(readFileSync(outFile, 'utf8'));
