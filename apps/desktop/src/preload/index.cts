/**
 * The sandboxed preload — the only file in the preload bundle (07-client-applications.md §7.5,
 * hardening row H15).
 *
 * It exposes a fixed object, never a channel-taking function: no `ipcRenderer` pass-through, no
 * channel parameter reaching `invoke` from the renderer, and the Electron `event` argument never
 * crosses into the renderer. `desktop.preload-surface.guard` snapshots the exposed keys and arity
 * from M5.
 *
 * A sandboxed preload cannot be ESM and cannot `require` a second file, which is why this is a
 * single `.cts` entry built as one CommonJS file (§7.1).
 *
 * M0 exposes exactly one channel: `iridium:app:info` (09-api-reference.md §D.4, §5.7).
 */
import type { AppInfo, IridiumBridge } from '../shared/bridge.ts';

const { contextBridge, ipcRenderer } = require('electron');

const bridge: IridiumBridge = {
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('iridium:app:info'),
  },
};

contextBridge.exposeInMainWorld('iridium', bridge);
