/**
 * `iridium serve` uses the shared boot path. `--child` selects the harness's stdout handshake
 * and SIGTERM lifecycle; both modes honor PORT so a restart can retain its original origin.
 */
import { startServer } from '../app.ts';
import { EXIT } from './exit.ts';

/** Listen and install the mode's shutdown handlers; the open server owns the process lifetime. */
export async function runServe(mode: 'container' | 'child' = 'container'): Promise<number> {
  await startServer({ mode });
  return EXIT.success;
}
