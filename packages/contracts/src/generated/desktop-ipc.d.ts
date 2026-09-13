/**
 * GENERATED FILE — do not edit.
 *
 * Written by `scripts/generate-desktop-ipc.ts` from the `ipcMain.handle` registrations in apps/desktop/src/main/ipc.ts and the `AppInfo` interface in apps/desktop/src/shared/bridge.ts, checked against 09-api-reference.md §5.
 * Run `pnpm gen` to regenerate; `gen.drift.guard` fails the `static` job on any difference.
 */

/**
 * `iridium:app:info` (09-api-reference.md §5.7). Drives the About panel and the compatibility
 * gate.
 */
export interface AppInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
  readonly platform: 'win32' | 'darwin' | 'linux';
  readonly arch: string;
  readonly packaged: boolean;
  readonly bridgePath: string | null;
  readonly updatesEnabled: boolean;
  readonly secureStorage: 'available' | 'weak' | 'unavailable';
}

/** The request payload of a channel that takes no arguments (`parseEmptyPayload`). */
export type EmptyRequest = Record<string, never>;

/**
 * Every request/response channel, with its request and response types.
 *
 * `contracts.desktop-ipc.unit` asserts from M5 that this key set equals the set
 * `apps/desktop/src/main/ipc/index.ts` registers with `ipcMain.handle`.
 */
export interface IridiumIpcInvokeChannels {
  readonly 'iridium:app:info': {
    readonly request: EmptyRequest;
    readonly response: AppInfo;
  };
}

/** Main → renderer pushes, `iridium:event:<name>` (09-api-reference.md §5.8). None at M0. */
export type IridiumIpcEventChannels = Record<never, never>;

/** Every channel name the renderer may reach, as a closed union. */
export type IridiumIpcInvokeChannel = keyof IridiumIpcInvokeChannels;

/** Every event name the renderer may subscribe to, as a closed union. */
export type IridiumIpcEventChannel = keyof IridiumIpcEventChannels;

/**
 * The whole surface the renderer sees on `window.iridium`.
 *
 * Fixed wrappers only: no `ipcRenderer` pass-through and no channel parameter reaching `invoke`
 * (07-client-applications.md, hardening row H15), which is why this is a nested object of
 * zero-argument functions rather than a generic `invoke`.
 */
export interface IridiumBridge {
  readonly app: {
    /** `iridium:app:info` */
    info(): Promise<AppInfo>;
  };
}
