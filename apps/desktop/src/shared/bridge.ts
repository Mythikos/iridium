/**
 * The typed shape of `window.iridium`, shared by the preload that exposes it and the renderer host
 * that consumes it (07-client-applications.md §7.5).
 *
 * Types only — this module emits nothing, so the sandboxed preload bundle stays a single file.
 * 09-api-reference.md §5 is the normative contract for every channel; from M5
 * `@iridium/contracts/desktop-ipc.ts` generates these typings and `ipc-contract` asserts that the
 * registered `ipcMain` channels equal the contract set. At M0 exactly one channel exists.
 */

/** `iridium:app:info` (09-api-reference.md §5.7). Drives the About panel and the compatibility gate. */
export interface AppInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly arch: string;
  readonly packaged: boolean;
  /** Absolute path of the bundled `iridium-mcp.mjs`, or `null` when it is not packaged alongside. */
  readonly bridgePath: string | null;
  readonly updatesEnabled: boolean;
  readonly secureStorage: 'available' | 'weak' | 'unavailable';
}

/**
 * The whole surface the renderer sees. Fixed wrappers only: no `ipcRenderer` pass-through and no
 * channel parameter reaching `invoke` (hardening row H15), which is why this is a nested object of
 * zero-argument or plain-data functions rather than a generic `invoke`.
 */
export interface IridiumBridge {
  readonly app: {
    info(): Promise<AppInfo>;
  };
}

declare global {
  interface Window {
    /** Present only in the Electron renderer; `undefined` in the browser host. */
    readonly iridium?: IridiumBridge;
  }
}
