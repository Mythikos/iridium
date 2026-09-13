/**
 * The `BrowserWindow` factory and the session hardening that goes with it
 * (07-client-applications.md §7.2, §7.4).
 *
 * Exactly one window exists in MVP (D07-16). Every control below is mandatory: the hardened
 * `webPreferences` (snapshot-tested by `desktop.web-preferences.guard`), the navigation lock (H9),
 * the window-open denial (H10), the external-URL validation (H11) and the deny-by-default
 * permission handlers (H12).
 */

import path from 'node:path';

import { BrowserWindow, shell } from 'electron';
import type { Session } from 'electron';

import { log } from './log.ts';
import { APP_ORIGIN } from './scheme.ts';
import { hardenedWebPreferences } from './web-preferences.ts';

/** The only permissions the renderer may ever be granted (H12). Everything else is denied. */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'notifications',
  'fullscreen',
]);

/**
 * Absolute path of the single-file preload bundle. `import.meta.dirname` rather than `__dirname`,
 * because the main bundle is ESM and `__dirname` is undefined there (§7.3).
 */
export function preloadPath(): string {
  return path.join(import.meta.dirname, '..', 'preload', 'index.cjs');
}

/** Absolute path of the built renderer. */
export function rendererRoot(): string {
  return path.join(import.meta.dirname, '..', 'renderer');
}

/**
 * H11 — `https:` and `mailto:` are opened externally; `file:`, `data:`, `javascript:`, `http:` and
 * everything else is refused. Note content is untrusted, so this is a refusal, not a fallback.
 */
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
}

/** H12 — deny-by-default permission, permission-check and device handlers on the app's session. */
export function hardenSession(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback) => {
    const granted = ALLOWED_PERMISSIONS.has(permission);
    if (!granted) log.warn({ permission }, 'permission request denied');
    callback(granted);
  });
  session.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
  session.setDevicePermissionHandler(() => false);
}

export interface MainWindowOptions {
  /** `!app.isPackaged` (H4). */
  readonly devTools: boolean;
  /** `app://iridium/` in every packaged build; the Vite dev server origin in development (§7.1). */
  readonly loadUrl: string;
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: '#111113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: hardenedWebPreferences({ preload: preloadPath(), devTools: options.devTools }),
  });

  // Pinch zoom off; the registry's zoom commands own the chords instead (§7.2).
  window.webContents.setVisualZoomLevelLimits(1, 1).catch((error: unknown) => {
    log.warn({ error }, 'setVisualZoomLevelLimits failed');
  });

  // H9 — the window navigates nowhere but its own origin.
  window.webContents.on('will-navigate', (event, url) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (`${target.protocol}//${target.host}` !== new URL(options.loadUrl).origin) {
      event.preventDefault();
      log.warn({ url }, 'navigation denied');
    }
  });

  // H10 — no new windows; an allowed external URL is handed to the validated opener instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url).catch((error: unknown) => {
        log.warn({ error }, 'openExternal failed');
      });
    } else {
      log.warn({ url }, 'window open denied');
    }
    return { action: 'deny' };
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.loadURL(options.loadUrl).catch((error: unknown) => {
    log.error({ error, url: options.loadUrl }, 'renderer failed to load');
  });

  return window;
}

/** The origin the renderer is expected to run at in a packaged build. */
export const PACKAGED_LOAD_URL = `${APP_ORIGIN}/`;
