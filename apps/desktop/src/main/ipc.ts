/**
 * The `ipcMain.handle` registry (07-client-applications.md §7.5, hardening rows H13 and H14).
 *
 * Every channel goes through `handle`, and the handler shape is identical for all of them, which is
 * what makes the two controls auditable: the sender's origin is read **synchronously** at the top of
 * the callback (the frame may detach) and must be `app://iridium` — plus the Vite dev origin while
 * the build is unpackaged — and the payload is parsed before any service call.
 *
 * At M0 exactly one channel is registered: `iridium:app:info`. `ipc-contract` asserts from M5 that
 * the registered set equals the contract set in `@iridium/contracts/desktop-ipc.ts`, and the `parse`
 * parameter below is the seam that file's zod schemas drop into unchanged — `validation_failed`
 * already has its place in the shape.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { app, ipcMain, safeStorage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import type { AppInfo } from '../shared/bridge.ts';
import { log, redact } from './log.ts';
import { APP_ORIGIN } from './scheme.ts';

export interface IpcOriginPolicy {
  /** `app.isPackaged`. The dev origin is accepted only while this is `false` (§7.1). */
  readonly isPackaged: boolean;
  /** The Vite dev server origin, or `null` when the renderer runs from `app://iridium`. */
  readonly devServerOrigin: string | null;
}

export function isAllowedOrigin(origin: string | undefined, policy: IpcOriginPolicy): boolean {
  if (origin === undefined || origin === '') return false;
  if (origin === APP_ORIGIN) return true;
  if (policy.isPackaged || policy.devServerOrigin === null) return false;
  try {
    return origin === new URL(policy.devServerOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * The error every rejected channel throws. M5 replaces the payload with `ProblemDetails` from
 * `@iridium/contracts`; the code vocabulary is already the contracts one.
 */
export function ipcError(
  code: 'forbidden' | 'validation_failed' | 'server_error',
  detail?: string,
): Error {
  const error = new Error(detail === undefined ? code : `${code}: ${redact(detail)}`);
  error.name = 'IridiumIpcError';
  return error;
}

/** The `{}` request body of every channel that takes no arguments. */
export function parseEmptyPayload(raw: unknown): Record<string, never> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === 'object' && Object.keys(raw).length === 0) return {};
  throw new Error('expected an empty payload');
}

export function handle<Request, Response>(
  channel: string,
  policy: IpcOriginPolicy,
  parse: (raw: unknown) => Request,
  service: (request: Request) => Promise<Response>,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, raw: unknown) => {
    const origin = event.senderFrame?.origin; // read synchronously (the frame may detach)
    if (!isAllowedOrigin(origin, policy)) {
      log.warn({ channel, origin }, 'ipc origin rejected');
      throw ipcError('forbidden');
    }
    let request: Request;
    try {
      request = parse(raw);
    } catch (error: unknown) {
      throw ipcError('validation_failed', error instanceof Error ? error.message : String(error));
    }
    try {
      return await service(request);
    } catch (error: unknown) {
      log.error({ channel }, 'ipc handler failed');
      throw ipcError('server_error', error instanceof Error ? error.message : String(error));
    }
  });
}

function currentPlatform(): AppInfo['platform'] {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
    case 'win32':
      return process.platform;
    default:
      throw new Error(`Iridium does not run on ${process.platform}.`);
  }
}

/**
 * `safeStorage` availability (§7.6). `basic_text` on Linux is reported as `weak`, which is what puts
 * the shell into memory-only credential mode rather than writing a file that is not encrypted.
 */
function secureStorageState(): AppInfo['secureStorage'] {
  if (!safeStorage.isEncryptionAvailable()) return 'unavailable';
  if (process.platform === 'linux') {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === 'basic_text' || backend === 'unknown') return 'weak';
  }
  return 'available';
}

/**
 * The bundled stdio bridge, `resources/bin/iridium-mcp.mjs` (§7.14.3). `app.getAppPath()` is
 * `…/resources/app.asar` in a packaged build, so its parent is the resources directory.
 */
function bundledBridgePath(): string | null {
  const candidate = path.join(path.dirname(app.getAppPath()), 'bin', 'iridium-mcp.mjs');
  return existsSync(candidate) ? candidate : null;
}

export function appInfo(): AppInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? '',
    chromeVersion: process.versions.chrome ?? '',
    nodeVersion: process.versions.node,
    platform: currentPlatform(),
    arch: process.arch,
    packaged: app.isPackaged,
    bridgePath: bundledBridgePath(),
    // There is no in-application updater at 1.0 (§7.15, D07-44); M5 derives this from the policy.
    updatesEnabled: false,
    secureStorage: secureStorageState(),
  };
}

export const APP_INFO_CHANNEL = 'iridium:app:info';

export function registerIpcHandlers(policy: IpcOriginPolicy): void {
  handle(APP_INFO_CHANNEL, policy, parseEmptyPayload, () => Promise.resolve(appInfo()));
}
